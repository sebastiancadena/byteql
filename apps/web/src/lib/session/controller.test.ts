import type { ParseResult, TableTransfer } from '@byteql/core';
import type { ByteqlDatabase, QueryResult } from '@byteql/db';
import type { MidiParseProgress } from '@byteql/midi';
import { tableFromArrays, type Table } from 'apache-arrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ParseWorkerClient,
  type ParseClientPort,
  type ParseProgress,
  type WorkerPort,
} from '../parse-worker-client.js';
import { installParseWorker, type ParseWorkerScope } from '../../workers/parse.worker.js';
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

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
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

  parse(
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

describe('ParseWorkerClient', () => {
  it('transfers input bytes, kills on cancellation, and recreates the worker', async () => {
    const workers: FakeWorker[] = [];
    const client = new ParseWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const bytes = new Uint8Array([1, 2, 3]);

    const parsing = client.parse({ name: 'private.mid', bytes }, vi.fn());
    expect(bytes.byteLength).toBe(0);
    expect(workers[0]?.posts[0]?.transfer).toHaveLength(1);

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
    const parsing = client.parse({ name: 'private.mid', bytes: new Uint8Array([1]) }, vi.fn());
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
    const parsing = client.parse({ name: 'x.mid', bytes: new Uint8Array([1]) }, vi.fn());

    if (kind === 'error') workers[0]!.onerror?.({ type: 'error' } as ErrorEvent);
    else workers[0]!.onmessageerror?.(new MessageEvent('messageerror'));

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
    const first = client.parse({ name: 'first.mid', bytes: new Uint8Array([1]) }, vi.fn());
    const oldWorker = workers[0]!;
    client.cancel();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    const second = client.parse({ name: 'second.mid', bytes: new Uint8Array([2]) }, vi.fn());
    oldWorker.emit({ type: 'result', taskId: 1, result: parseResult('stale') });
    workers[1]!.emit({ type: 'result', taskId: 2, result: parseResult('current') });
    await expect(second).resolves.toEqual(parseResult('current'));
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

describe('parse worker boundary', () => {
  it('rejects non-MIDI headers before invoking the parser', async () => {
    const scope = new FakeWorkerScope();
    const parse = vi.fn();
    installParseWorker(scope, parse);
    scope.receive({ type: 'parse', taskId: 1, name: 'bad.mid', bytes: new Uint8Array([1, 2, 3, 4]) });
    await flush();

    expect(parse).not.toHaveBeenCalled();
    expect(scope.posts.at(-1)?.message).toMatchObject({
      type: 'error',
      taskId: 1,
      code: 'INVALID_MIDI_HEADER',
      stage: 'framing',
    });
  });

  it('transfers every distinct IPC ArrayBuffer with the completed result', async () => {
    const scope = new FakeWorkerScope();
    const result = parseResult('events');
    const second = transfer('tempo', [4, 5]);
    const parse = vi.fn().mockResolvedValue({ ...result, tables: [...result.tables, second] });
    installParseWorker(scope, parse);

    scope.receive({
      type: 'parse',
      taskId: 7,
      name: 'demo.mid',
      bytes: new Uint8Array([0x4d, 0x54, 0x68, 0x64]),
    });
    await flush();

    const completed = scope.posts.find((post) => (post.message as { type?: string }).type === 'result');
    expect(completed?.transfer).toEqual([result.tables[0]!.ipc.buffer, second.ipc.buffer]);
  });

  it('forwards only progress reported at real MIDI orchestrator boundaries', async () => {
    const scope = new FakeWorkerScope();
    const progress: MidiParseProgress[] = [
      { stage: 'normalizing', completed: 0, total: 1, label: 'Normalizing MIDI tracks' },
      { stage: 'normalizing', completed: 1, total: 1, label: 'Normalized track 1 of 1' },
      { stage: 'parsing', completed: 0, total: 1, label: 'Parsing MIDI tracks' },
      { stage: 'parsing', completed: 1, total: 1, label: 'Processed track 1 of 1' },
      { stage: 'projecting', completed: 0, total: 1, label: 'Projecting MIDI tracks' },
      { stage: 'projecting', completed: 1, total: 1, label: 'Processed track 1 of 1' },
    ];
    installParseWorker(scope, async (_bytes, _signal, onProgress) => {
      for (const update of progress) onProgress?.(update);
      return parseResult('events');
    });

    scope.receive({
      type: 'parse',
      taskId: 8,
      name: 'demo.mid',
      bytes: new Uint8Array([0x4d, 0x54, 0x68, 0x64]),
    });
    await flush();

    expect(
      scope.posts
        .map((post) => post.message as { type?: string })
        .filter((message) => message.type === 'progress'),
    ).toEqual(progress.map((update) => ({ type: 'progress', taskId: 8, ...update })));
  });

  it('aborts a task when its cancellation message arrives', async () => {
    const scope = new FakeWorkerScope();
    const operation = deferred<ParseResult>();
    let signal: AbortSignal | undefined;
    installParseWorker(scope, (_bytes, receivedSignal) => {
      signal = receivedSignal;
      return operation.promise;
    });

    scope.receive({
      type: 'parse',
      taskId: 9,
      name: 'demo.mid',
      bytes: new Uint8Array([0x4d, 0x54, 0x68, 0x64]),
    });
    scope.receive({ type: 'cancel', taskId: 9 });
    expect(signal?.aborted).toBe(true);
    operation.reject(new DOMException('aborted', 'AbortError'));
    await flush();
    expect(scope.posts.at(-1)?.message).toEqual({ type: 'cancelled', taskId: 9 });
  });
});
