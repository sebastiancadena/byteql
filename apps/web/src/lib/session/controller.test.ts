import {
  tableToIpc,
  type BatchTransfer,
  type FormatPack,
  type ParseProgress as PackProgress,
  type ParseResult,
  type TableTransfer,
} from '@byteql/core';
import type { ByteqlDatabase, QueryResult } from '@byteql/db';
import { tableFromArrays, type Table } from 'apache-arrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ParseWorkerClient,
  type BatchMessage,
  type ParseClientPort,
  type ParseHandlers,
  type ParseProgress,
  type StreamedParseResult,
  type WorkerPort,
} from '../parse-worker-client.js';
import {
  BATCH_CREDIT_WINDOW,
  installParseWorker,
  type ParseWorkerScope,
} from '../../workers/parse.worker.js';
import { SessionController } from './controller.js';
import { initialSessionState } from './state.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
};

// 32 ticks: Node's real Blob#arrayBuffer() takes ~3 microtask hops (used once per parse to probe
// the head, plus per credit-gated pull loop iteration), well beyond a handful of Promise.resolve()
// hops. Generous so credit-window tests spanning several pull iterations settle within one flush.
const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 32; tick += 1) await Promise.resolve();
};

const transfer = (name: string, values: readonly number[]): TableTransfer => ({
  name,
  ipc: new Uint8Array(values),
  rowCount: 1,
  columns: [],
});

const parseResult = (name: string, values: readonly number[] = [1, 2, 3]): ParseResult => ({
  format: { id: 'standard_midi_file', title: 'Standard MIDI file' },
  tables: [transfer(name, values)],
  issues: [],
  queries: [{ id: 'overview', title: 'Overview', kind: 'grid', sql: 'select 1 limit 1;' }],
  capabilities: { audio: { enabled: true, reason: null } },
});

class FakeParser implements ParseClientPort {
  readonly calls: Array<{
    name: string;
    bytes: Uint8Array;
    onProgress: (progress: ParseProgress) => void;
    operation: Deferred<ParseResult>;
  }> = [];
  cancel = vi.fn();
  dispose = vi.fn();

  // The controller calls only `parseToResult` (Task 9 migrates it to the streaming `parse`); this
  // stub keeps FakeParser assignable to ParseClientPort without exercising the streaming path.
  parse(): Promise<StreamedParseResult> {
    throw new Error('FakeParser.parse is not exercised by SessionController tests.');
  }

  parseToResult(
    input: { name: string; bytes: Uint8Array },
    onProgress: (progress: ParseProgress) => void,
  ): Promise<ParseResult> {
    const operation = deferred<ParseResult>();
    this.calls.push({ ...input, onProgress, operation });
    return operation.promise;
  }
}

const queryTable = (value: number): Table => tableFromArrays({ value: [value] });

const fakeDatabase = (): ByteqlDatabase => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  // Minimal stub until the controller migrates to ingest sessions; the ingest-path
  // controller tests replace this fake wholesale.
  beginIngest: vi.fn().mockRejectedValue(new Error('beginIngest is not faked yet')),
  replaceTables: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({ table: queryTable(1), elapsedMs: 2 }),
  cancelQuery: vi.fn().mockResolvedValue(false),
  listTables: vi.fn().mockResolvedValue([]),
  dispose: vi.fn().mockResolvedValue(undefined),
});

describe('SessionController', () => {
  let parser: FakeParser;
  let database: ByteqlDatabase;
  let stopViewer: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    parser = new FakeParser();
    database = fakeDatabase();
    stopViewer = vi.fn<() => void>();
  });

  it('fetches and retains the bundled sample during initialize and never refetches it to open', async () => {
    const sample = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 1, 2, 3]);
    const fetchSample = vi.fn().mockResolvedValue(new Response(sample));
    const controller = new SessionController({
      database,
      parser,
      fetch: fetchSample,
      demoUrl: '/assets/demo.mid',
      stopViewer,
    });

    await Promise.all([controller.initialize(), controller.initialize()]);
    expect(fetchSample).toHaveBeenCalledTimes(1);
    expect(fetchSample).toHaveBeenCalledWith(
      '/assets/demo.mid',
      expect.objectContaining({ signal: expect.anything() }),
    );

    const opening = controller.openSample();
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    expect(parser.calls[0]?.name).toBe('demo.mid');
    expect(Array.from(parser.calls[0]!.bytes)).toEqual(Array.from(sample));
    parser.calls[0]!.operation.resolve(parseResult('events'));
    await opening;

    const reopened = controller.openSample();
    expect(fetchSample).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    expect(Array.from(parser.calls[1]!.bytes)).toEqual(Array.from(sample));
    parser.calls[1]!.operation.resolve(parseResult('events'));
    await reopened;
  });

  it('publishes UI-safe source metadata and progress without exposing the file', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const observed = vi.fn();
    const unsubscribe = controller.subscribe(observed);
    const file = new File([new Uint8Array([1, 2])], 'private.mid');

    const opening = controller.openFile(file);
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    parser.calls[0]!.onProgress({
      stage: 'parsing',
      completed: 1,
      total: 3,
      label: 'Parsing track 1',
    });

    expect(controller.getState()).toMatchObject({
      phase: 'parsing',
      source: { name: 'private.mid', size: 2 },
    });
    expect(JSON.stringify(controller.getState())).not.toContain('File');
    expect(observed).toHaveBeenCalled();

    unsubscribe();
    parser.calls[0]!.operation.resolve(parseResult('events'));
    await opening;
    expect(controller.getState().queries).toEqual(parseResult('events').queries);
    expect(controller.getState().capabilities).toEqual(parseResult('events').capabilities);
  });

  it('cancels parse, query, and viewer immediately and ignores stale replacement results', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const first = controller.openFile(new File([new Uint8Array([1])], 'old.mid'));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    const second = controller.openFile(new File([new Uint8Array([2])], 'new.mid'));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));

    expect(parser.cancel).toHaveBeenCalledTimes(2);
    expect(database.cancelQuery).toHaveBeenCalledTimes(2);
    expect(stopViewer).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({ source: { name: 'new.mid', size: 1 } });

    parser.calls[0]!.operation.resolve(parseResult('old'));
    await first;
    expect(database.replaceTables).not.toHaveBeenCalled();

    parser.calls[1]!.operation.resolve(parseResult('new'));
    await second;
    expect(database.replaceTables).toHaveBeenCalledTimes(1);
    expect(database.replaceTables).toHaveBeenCalledWith(parseResult('new').tables);
    expect(controller.getState()).toMatchObject({ phase: 'ready', tables: parseResult('new').tables });
  });

  it('does not replace database tables until the complete parse result arrives', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const opening = controller.openFile(new File([new Uint8Array([1])], 'wait.mid'));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));

    parser.calls[0]!.onProgress({
      stage: 'projecting',
      completed: 1,
      total: 2,
      label: 'Projecting track 1',
    });
    expect(database.replaceTables).not.toHaveBeenCalled();

    parser.calls[0]!.operation.resolve(parseResult('complete'));
    await opening;
    expect(database.replaceTables).toHaveBeenCalledOnce();
  });

  it('restores the prior committed tables when registration is cancelled after it starts', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const firstResult = parseResult('prior', [8, 9]);
    const first = controller.openFile(new File([new Uint8Array([1])], 'prior.mid'));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    parser.calls[0]!.operation.resolve(firstResult);
    await first;

    const registration = deferred<void>();
    vi.mocked(database.replaceTables).mockReturnValueOnce(registration.promise);
    const replacement = controller.openFile(new File([new Uint8Array([2])], 'cancelled.mid'));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    parser.calls[1]!.operation.resolve(parseResult('cancelled'));
    await vi.waitFor(() => expect(database.replaceTables).toHaveBeenCalledTimes(2));

    const cancellation = controller.cancel();
    registration.resolve();
    await Promise.all([replacement, cancellation]);
    await vi.waitFor(() => expect(database.replaceTables).toHaveBeenCalledTimes(3));

    expect(database.replaceTables).toHaveBeenLastCalledWith(firstResult.tables);
    expect(controller.getState()).toEqual(initialSessionState);
  });

  it('ignores stale query completion after a replacement session begins', async () => {
    const query = deferred<QueryResult>();
    vi.mocked(database.query).mockReturnValueOnce(query.promise);
    const controller = new SessionController({ database, parser, stopViewer });

    const firstOpen = controller.openFile(new File([new Uint8Array([1])], 'first.mid'));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    parser.calls[0]!.operation.resolve(parseResult('first'));
    await firstOpen;

    const runningQuery = controller.runQuery('select * from first');
    const replacement = controller.openFile(new File([new Uint8Array([2])], 'second.mid'));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    query.resolve({ table: queryTable(99), elapsedMs: 50 });
    await runningQuery;
    expect(controller.getState().result).toBeNull();
    expect(controller.getState().source?.name).toBe('second.mid');

    parser.calls[1]!.operation.resolve(parseResult('second'));
    await replacement;
  });

  it('retains a successful result when a later SQL query fails', async () => {
    const prior = queryTable(7);
    vi.mocked(database.query)
      .mockResolvedValueOnce({ table: prior, elapsedMs: 3 })
      .mockRejectedValueOnce(new Error('syntax error'));
    const controller = new SessionController({ database, parser, stopViewer });
    const opening = controller.openFile(new File([new Uint8Array([1])], 'query.mid'));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    parser.calls[0]!.operation.resolve(parseResult('events'));
    await opening;

    await controller.runQuery('select 7');
    await controller.runQuery('select broken');
    expect(controller.getState()).toMatchObject({
      phase: 'ready',
      result: prior,
      queryError: 'syntax error',
    });
  });

  it('propagates cancellation and disposes safely during initialization', async () => {
    const response = deferred<Response>();
    const fetchSample = vi.fn().mockReturnValue(response.promise);
    const controller = new SessionController({
      database,
      parser,
      fetch: fetchSample,
      demoUrl: '/demo.mid',
      stopViewer,
    });
    const listener = vi.fn();
    controller.subscribe(listener);

    const initialization = controller.initialize();
    const disposal = controller.dispose();
    response.resolve(new Response(new Uint8Array([1])));
    await Promise.allSettled([initialization, disposal]);

    expect(parser.dispose).toHaveBeenCalledOnce();
    expect(database.cancelQuery).toHaveBeenCalled();
    expect(database.dispose).toHaveBeenCalledOnce();
    expect(stopViewer).toHaveBeenCalled();
    expect(() => controller.openSample()).toThrow(/disposed/i);
    expect(() => controller.subscribe(vi.fn())).toThrow(/disposed/i);
  });

  it('does not let a fetch implementation that ignores abort block disposal', async () => {
    const response = deferred<Response>();
    const controller = new SessionController({
      database,
      parser,
      fetch: vi.fn().mockReturnValue(response.promise),
      demoUrl: '/demo.mid',
      stopViewer,
    });
    const initialization = controller.initialize();

    const disposal = controller.dispose();
    const outcome = await Promise.race([
      disposal.then(() => 'disposed'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 20)),
    ]);
    expect(outcome).toBe('disposed');

    response.resolve(new Response(new Uint8Array([1])));
    await Promise.allSettled([initialization]);
  });

  it('continues disposal when parser and viewer cleanup callbacks throw', async () => {
    parser.cancel.mockImplementation(() => {
      throw new Error('cancel failed');
    });
    parser.dispose.mockImplementation(() => {
      throw new Error('dispose failed');
    });
    stopViewer.mockImplementation(() => {
      throw new Error('viewer failed');
    });
    const controller = new SessionController({ database, parser, stopViewer });

    await expect(controller.dispose()).resolves.toBeUndefined();
    expect(parser.dispose).toHaveBeenCalledOnce();
    expect(database.cancelQuery).toHaveBeenCalled();
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it('releases all state-held local data during idempotent disposal', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const opening = controller.openFile(new File([new Uint8Array([1])], 'private.mid'));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    parser.calls[0]!.operation.resolve({
      ...parseResult('events'),
      issues: [
        {
          stage: 'parsing',
          track: 0,
          code: 'PARTIAL',
          message: 'partial issue',
          recoverable: true,
          sourceStart: 1,
          sourceEnd: 2,
        },
      ],
    });
    await opening;
    await controller.runQuery('select * from events');
    expect(controller.getState()).toMatchObject({
      source: { name: 'private.mid', size: 1 },
      sql: 'select * from events',
      result: expect.anything(),
    });

    await Promise.all([controller.dispose(), controller.dispose()]);
    expect(controller.getState()).toEqual(initialSessionState);
    expect(database.dispose).toHaveBeenCalledOnce();
    expect(parser.dispose).toHaveBeenCalledOnce();
  });

  it('isolates a failing subscriber from later subscribers and state transitions', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
      if (notifications > 1) throw new Error('listener failed');
    });
    const healthy = vi.fn();
    controller.subscribe(healthy);

    const opening = controller.openFile(new File([new Uint8Array([1])], 'listeners.mid'));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    parser.calls[0]!.operation.resolve(parseResult('events'));
    await opening;

    expect(controller.getState().phase).toBe('ready');
    expect(healthy).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ready' }));
  });

  it('removes a subscriber that throws during its initial notification', () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const listener = vi.fn(() => {
      throw new Error('listener failed');
    });

    expect(() => controller.subscribe(listener)).toThrow('listener failed');
    controller.selectResultRow(null);
    expect(listener).toHaveBeenCalledOnce();
  });
});

class FakeWorker implements WorkerPort {
  readonly posts: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
  terminated = false;
  failNextPost = false;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    if (this.failNextPost) {
      this.failNextPost = false;
      throw new Error('post failed');
    }
    const clone = structuredClone(message, { transfer: [...transfer] });
    this.posts.push({ message: clone, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: message }));
  }
}

const streamedResult = (name: string, rowCount = 1): StreamedParseResult => ({
  format: { id: 'standard_midi_file', title: 'Standard MIDI file' },
  tables: [{ name, rowCount, columns: [] }],
  issues: [],
  queries: [{ id: 'overview', title: 'Overview', kind: 'grid', sql: 'select 1 limit 1;' }],
  capabilities: { audio: { enabled: true, reason: null } },
});

const noopHandlers = (): ParseHandlers => ({
  onProgress: vi.fn(),
  onBatch: vi.fn().mockResolvedValue(undefined),
});

describe('ParseWorkerClient', () => {
  it('clones the input blob without transferring it, kills on cancellation, and recreates the worker', async () => {
    const workers: FakeWorker[] = [];
    const client = new ParseWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const blob = new Blob([new Uint8Array([1, 2, 3])]);

    const parsing = client.parse({ name: 'private.mid', blob }, noopHandlers());
    expect(workers[0]?.posts[0]?.message).toMatchObject({ type: 'parse', name: 'private.mid' });
    expect(workers[0]?.posts[0]?.transfer).toHaveLength(0);

    client.cancel();
    await expect(parsing).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]?.posts[1]?.message).toMatchObject({ type: 'cancel' });
    expect(workers[0]?.terminated).toBe(true);
    expect(workers).toHaveLength(2);
  });

  it('still kills and recreates when posting cancellation fails', async () => {
    const workers: FakeWorker[] = [];
    const client = new ParseWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const parsing = client.parse(
      { name: 'private.mid', blob: new Blob([new Uint8Array([1])]) },
      noopHandlers(),
    );
    workers[0]!.failNextPost = true;

    expect(() => client.cancel()).not.toThrow();
    await expect(parsing).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]?.terminated).toBe(true);
    expect(workers).toHaveLength(2);
  });

  it.each(['error', 'messageerror'] as const)('rejects active work and recreates after %s', async (kind) => {
    const workers: FakeWorker[] = [];
    const client = new ParseWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const parsing = client.parse({ name: 'x.mid', blob: new Blob([new Uint8Array([1])]) }, noopHandlers());

    if (kind === 'error') workers[0]!.onerror?.({ type: 'error' } as ErrorEvent);
    else workers[0]!.onmessageerror?.(new MessageEvent('messageerror'));

    await expect(parsing).rejects.toThrow('worker stopped unexpectedly');
    expect(workers[0]?.terminated).toBe(true);
    expect(workers).toHaveLength(2);
  });

  it('rejects on worker crash mid-stream and replaces the worker', async () => {
    const workers: FakeWorker[] = [];
    const client = new ParseWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const handlers = noopHandlers();
    const parsing = client.parse({ name: 'mid-stream.mid', blob: new Blob([new Uint8Array([1])]) }, handlers);

    workers[0]!.emit({
      type: 'batch',
      taskId: 1,
      seq: 1,
      table: 'events',
      ipc: new Uint8Array([1]),
      rowCount: 1,
    });
    await flush();
    expect(handlers.onBatch).toHaveBeenCalledOnce();

    workers[0]!.onerror?.({ type: 'error' } as ErrorEvent);
    await expect(parsing).rejects.toThrow('worker stopped unexpectedly');
    expect(workers[0]?.terminated).toBe(true);
    expect(workers).toHaveLength(2);
  });

  it('ignores messages from replaced workers and resolves only the current task id', async () => {
    const workers: FakeWorker[] = [];
    const client = new ParseWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const first = client.parse({ name: 'first.mid', blob: new Blob([new Uint8Array([1])]) }, noopHandlers());
    const oldWorker = workers[0]!;
    client.cancel();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    const second = client.parse(
      { name: 'second.mid', blob: new Blob([new Uint8Array([2])]) },
      noopHandlers(),
    );
    oldWorker.emit({ type: 'finish', taskId: 1, ...streamedResult('stale') });
    workers[1]!.emit({ type: 'finish', taskId: 2, ...streamedResult('current') });
    await expect(second).resolves.toEqual(streamedResult('current'));
  });

  it('acks a batch only after the caller onBatch promise resolves', async () => {
    const workers: FakeWorker[] = [];
    const client = new ParseWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const gate = deferred<void>();
    const onBatch = vi.fn(async (batch: BatchMessage) => {
      if (batch.seq === 1) await gate.promise;
    });
    const parsing = client.parse(
      { name: 'ack-order.mid', blob: new Blob([new Uint8Array([1])]) },
      { onProgress: vi.fn(), onBatch },
    );

    workers[0]!.emit({
      type: 'batch',
      taskId: 1,
      seq: 1,
      table: 'events',
      ipc: new Uint8Array([9]),
      rowCount: 1,
    });
    await flush();
    expect(onBatch).toHaveBeenCalledOnce();
    expect(workers[0]!.posts.some((post) => (post.message as { type?: string }).type === 'batchAck')).toBe(
      false,
    );

    gate.resolve();
    await flush();
    expect(workers[0]!.posts.at(-1)?.message).toEqual({ type: 'batchAck', taskId: 1, seq: 1 });

    workers[0]!.emit({ type: 'finish', taskId: 1, ...streamedResult('events') });
    await expect(parsing).resolves.toEqual(streamedResult('events'));
  });
});

class FakeWorkerScope implements ParseWorkerScope {
  readonly posts: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
  private listener: ((event: MessageEvent<unknown>) => void) | null = null;

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listener = listener;
  }

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    this.posts.push({ message, transfer });
  }

  receive(message: unknown): void {
    this.listener?.(new MessageEvent('message', { data: message }));
  }
}

const arrowIpc = (values: readonly number[]): Uint8Array => tableToIpc(tableFromArrays({ value: values }));

const fakePack = (overrides: Partial<FormatPack> = {}): FormatPack => ({
  id: 'fake_format',
  title: 'Fake format',
  probe: () => 1,
  schemas: () => [],
  queries: [],
  open: () => ({
    nextBatch: async () => null,
    finish: () => ({ issues: [], capabilities: {} }),
  }),
  ...overrides,
});

type PostedMessage = { type?: string; [key: string]: unknown };

const postsOfType = (scope: FakeWorkerScope, type: string) =>
  scope.posts.filter((post) => (post.message as PostedMessage).type === type);

describe('parse worker boundary', () => {
  it('rejects unrecognized formats before opening a source', async () => {
    const scope = new FakeWorkerScope();
    const open = vi.fn(fakePack().open);
    const pack = fakePack({ probe: () => null, open });
    installParseWorker(scope, [pack]);
    scope.receive({
      type: 'parse',
      taskId: 1,
      name: 'bad.mid',
      blob: new Blob([new Uint8Array([1, 2, 3, 4])]),
    });
    await flush();

    expect(open).not.toHaveBeenCalled();
    expect(scope.posts.at(-1)?.message).toMatchObject({
      type: 'error',
      taskId: 1,
      code: 'UNRECOGNIZED_FORMAT',
      stage: 'framing',
    });
  });

  it('probes with the blob head and errors UNRECOGNIZED_FORMAT without draining', async () => {
    const scope = new FakeWorkerScope();
    const probe = vi.fn<FormatPack['probe']>(() => null);
    const open = vi.fn(fakePack().open);
    const pack = fakePack({ probe, open });
    installParseWorker(scope, [pack]);
    const bytes = new Uint8Array(10_000).fill(7);
    scope.receive({ type: 'parse', taskId: 1, name: 'huge.bin', blob: new Blob([bytes]) });
    await flush();

    expect(probe).toHaveBeenCalledTimes(1);
    const head = probe.mock.calls[0]![0];
    expect(head.byteLength).toBeLessThanOrEqual(4096);
    expect(open).not.toHaveBeenCalled();
    expect(scope.posts.at(-1)?.message).toMatchObject({
      type: 'error',
      taskId: 1,
      code: 'UNRECOGNIZED_FORMAT',
      stage: 'framing',
    });
  });

  it('streams each batch as its own message with a transferred IPC buffer', async () => {
    const scope = new FakeWorkerScope();
    const eventsIpc = arrowIpc([1, 2, 3]);
    const tempoIpc = arrowIpc([4, 5]);
    const batches: BatchTransfer[] = [
      { table: 'events', ipc: eventsIpc, rowCount: 3 },
      { table: 'tempo', ipc: tempoIpc, rowCount: 2 },
    ];
    const pack = fakePack({
      open: () => {
        let index = 0;
        return {
          nextBatch: async () => (index < batches.length ? batches[index++]! : null),
          finish: () => ({ issues: [], capabilities: {} }),
        };
      },
    });
    installParseWorker(scope, [pack]);

    scope.receive({
      type: 'parse',
      taskId: 7,
      name: 'demo.mid',
      blob: new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64])]),
    });
    await flush();

    const batchMessages = postsOfType(scope, 'batch');
    expect(batchMessages).toHaveLength(2);
    expect(batchMessages[0]).toMatchObject({
      message: { type: 'batch', taskId: 7, seq: 1, table: 'events', rowCount: 3 },
      transfer: [eventsIpc.buffer],
    });
    expect(batchMessages[1]).toMatchObject({
      message: { type: 'batch', taskId: 7, seq: 2, table: 'tempo', rowCount: 2 },
      transfer: [tempoIpc.buffer],
    });
    expect(postsOfType(scope, 'finish')).toHaveLength(1);
  });

  it('derives a table columns once from its first batch, in first-arrival order, using pack.schemas() nullability', async () => {
    const scope = new FakeWorkerScope();
    // `flag` is absent from the fake pack's schemas() below, so its reported nullability must come
    // from the first batch's own Arrow field; it already carries a null in that batch alone.
    const firstBatch = tableToIpc(
      tableFromArrays({
        id: Int32Array.from([1, 2]),
        value: Int32Array.from([10, 20]),
        flag: [1, null],
      }),
    );
    const secondBatch = tableToIpc(
      tableFromArrays({ id: Int32Array.from([3]), value: Int32Array.from([30]), flag: [null] }),
    );
    const batches: BatchTransfer[] = [
      { table: 'notes', ipc: firstBatch, rowCount: 2 },
      { table: 'notes', ipc: secondBatch, rowCount: 1 },
    ];
    const pack = fakePack({
      schemas: () => [
        {
          name: 'notes',
          columns: [
            { name: 'id', type: 'int32', nullable: false },
            { name: 'value', type: 'int32', nullable: true },
          ],
        },
      ],
      open: () => {
        let index = 0;
        return {
          nextBatch: async () => (index < batches.length ? batches[index++]! : null),
          finish: () => ({ issues: [], capabilities: {} }),
        };
      },
    });
    installParseWorker(scope, [pack]);

    scope.receive({
      type: 'parse',
      taskId: 12,
      name: 'demo.mid',
      blob: new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64])]),
    });
    await flush();

    const finishMessage = postsOfType(scope, 'finish').at(-1)?.message as
      { tables?: readonly { name: string; rowCount: number; columns: unknown }[] } | undefined;
    expect(finishMessage?.tables).toEqual([
      {
        name: 'notes',
        rowCount: 3,
        columns: [
          { name: 'id', type: 'Int32', nullable: false },
          { name: 'value', type: 'Int32', nullable: true },
          { name: 'flag', type: 'Float64', nullable: true },
        ],
      },
    ]);
  });

  it('streams batches and stalls at the credit window until acks arrive', async () => {
    const scope = new FakeWorkerScope();
    const rowIpc = (id: number): Uint8Array => tableToIpc(tableFromArrays({ id: Int32Array.from([id]) }));
    const totalBatches = 6;
    const pack = fakePack({
      schemas: () => [{ name: 'events', columns: [{ name: 'id', type: 'int32', nullable: false }] }],
      open: () => {
        let index = 0;
        return {
          nextBatch: async () =>
            index < totalBatches ? { table: 'events', ipc: rowIpc(++index), rowCount: 1 } : null,
          finish: () => ({ issues: [], capabilities: {} }),
        };
      },
    });
    installParseWorker(scope, [pack]);

    scope.receive({
      type: 'parse',
      taskId: 5,
      name: 'stream.mid',
      blob: new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64])]),
    });
    await flush();

    expect(postsOfType(scope, 'batch')).toHaveLength(BATCH_CREDIT_WINDOW);
    expect(postsOfType(scope, 'finish')).toHaveLength(0);

    scope.receive({ type: 'batchAck', taskId: 5, seq: 1 });
    await flush();
    expect(postsOfType(scope, 'batch')).toHaveLength(5);
    expect(postsOfType(scope, 'finish')).toHaveLength(0);

    for (let seq = 2; seq <= totalBatches; seq += 1) {
      scope.receive({ type: 'batchAck', taskId: 5, seq });
    }
    await flush();

    expect(postsOfType(scope, 'batch')).toHaveLength(totalBatches);
    const finishMessage = postsOfType(scope, 'finish').at(-1)?.message as
      { tables?: readonly { name: string; rowCount: number; columns: unknown }[] } | undefined;
    expect(finishMessage?.tables).toEqual([
      { name: 'events', rowCount: totalBatches, columns: [{ name: 'id', type: 'Int32', nullable: false }] },
    ]);
  });

  it('cancel mid-stream produces cancelled, not finish, and stops pulling nextBatch', async () => {
    const scope = new FakeWorkerScope();
    let index = 0;
    const nextBatch = vi.fn(async () =>
      index < 6
        ? {
            table: 'events',
            ipc: tableToIpc(tableFromArrays({ id: Int32Array.from([++index]) })),
            rowCount: 1,
          }
        : null,
    );
    const pack = fakePack({ open: () => ({ nextBatch, finish: () => ({ issues: [], capabilities: {} }) }) });
    installParseWorker(scope, [pack]);

    scope.receive({
      type: 'parse',
      taskId: 6,
      name: 'cancel-mid-stream.mid',
      blob: new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64])]),
    });
    await flush();
    expect(nextBatch).toHaveBeenCalledTimes(BATCH_CREDIT_WINDOW);

    scope.receive({ type: 'cancel', taskId: 6 });
    await flush();

    expect(nextBatch).toHaveBeenCalledTimes(BATCH_CREDIT_WINDOW);
    expect(scope.posts.at(-1)?.message).toEqual({ type: 'cancelled', taskId: 6 });
    expect(postsOfType(scope, 'finish')).toHaveLength(0);
  });

  it('forwards progress reported by the format pack', async () => {
    const scope = new FakeWorkerScope();
    const progress: PackProgress[] = [
      { stage: 'normalizing', completed: 0, total: 1, label: 'Normalizing MIDI tracks' },
      { stage: 'normalizing', completed: 1, total: 1, label: 'Normalized track 1 of 1' },
      { stage: 'parsing', completed: 0, total: 1, label: 'Parsing MIDI tracks' },
      { stage: 'parsing', completed: 1, total: 1, label: 'Processed track 1 of 1' },
      { stage: 'projecting', completed: 0, total: 1, label: 'Projecting MIDI tracks' },
      { stage: 'projecting', completed: 1, total: 1, label: 'Processed track 1 of 1' },
    ];
    const pack = fakePack({
      open: (_source, opts) => ({
        nextBatch: async () => {
          for (const update of progress) opts.onProgress?.(update);
          return null;
        },
        finish: () => ({ issues: [], capabilities: {} }),
      }),
    });
    installParseWorker(scope, [pack]);

    scope.receive({
      type: 'parse',
      taskId: 8,
      name: 'demo.mid',
      blob: new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64])]),
    });
    await flush();

    expect(
      scope.posts
        .map((post) => post.message as { type?: string })
        .filter((message) => message.type === 'progress'),
    ).toEqual(progress.map((update) => ({ type: 'progress', taskId: 8, ...update })));
  });

  it('honors a cancellation that arrives before its parse request', async () => {
    const scope = new FakeWorkerScope();
    let signal: AbortSignal | undefined;
    const pack = fakePack({
      open: (_source, opts) => {
        signal = opts.signal;
        return { nextBatch: async () => null, finish: () => ({ issues: [], capabilities: {} }) };
      },
    });
    installParseWorker(scope, [pack]);

    scope.receive({ type: 'cancel', taskId: 3 });
    scope.receive({
      type: 'parse',
      taskId: 3,
      name: 'demo.mid',
      blob: new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64])]),
    });
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(scope.posts.at(-1)?.message).toMatchObject({ type: 'cancelled', taskId: 3 });
  });

  it('aborts a task when its cancellation message arrives', async () => {
    const scope = new FakeWorkerScope();
    const operation = deferred<BatchTransfer | null>();
    let signal: AbortSignal | undefined;
    const pack = fakePack({
      open: (_source, opts) => {
        signal = opts.signal;
        return { nextBatch: () => operation.promise, finish: () => ({ issues: [], capabilities: {} }) };
      },
    });
    installParseWorker(scope, [pack]);

    scope.receive({
      type: 'parse',
      taskId: 9,
      name: 'demo.mid',
      blob: new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64])]),
    });
    // The head probe reads the blob asynchronously, so `open()` (and thus `signal`) is only set
    // once that settles; the cancellation below must still synchronously abort it once it is.
    await flush();
    expect(signal).toBeDefined();

    scope.receive({ type: 'cancel', taskId: 9 });
    expect(signal?.aborted).toBe(true);
    operation.reject(new DOMException('aborted', 'AbortError'));
    await flush();
    expect(scope.posts.at(-1)?.message).toEqual({ type: 'cancelled', taskId: 9 });
  });
});
