import {
  ipcToTable,
  tableToIpc,
  type BatchTransfer,
  type FormatPack,
  type ParseProgress as PackProgress,
  type TableOverview,
  type TableSchema,
} from '@byteql/core';
import type { ByteqlDatabase, IngestOptions, IngestSession, TableSummary } from '@byteql/db';
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

const { sweepSpillOrphansMock } = vi.hoisted(() => ({
  sweepSpillOrphansMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@byteql/db', () => ({ sweepSpillOrphans: sweepSpillOrphansMock }));

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

const streamedResult = (name: string, rowCount = 1): StreamedParseResult => ({
  format: { id: 'standard_midi_file', title: 'Standard MIDI file' },
  tables: [{ name, rowCount, columns: [] }],
  issues: [],
  queries: [{ id: 'overview', title: 'Overview', kind: 'grid', sql: 'select 1 limit 1;' }],
  capabilities: { audio: { enabled: true, reason: null } },
  schemas: [],
});

interface FakeParseCall {
  readonly name: string;
  readonly blob: Blob;
  readonly formatId: string | undefined;
  emitProgress(progress: ParseProgress): void;
  emitBatch(batch: BatchMessage): Promise<void>;
  finish(result: StreamedParseResult): void;
  reject(error: unknown): void;
}

/**
 * Stands in for the streaming `ParseClientPort`. `cancel()` rejects whichever call is still
 * outstanding with an AbortError — mirroring `ParseWorkerClient.cancel()` — so controller tests
 * exercising supersession/cancel don't need to hand-simulate that cascade. `emitBatch` likewise
 * propagates an `onBatch` rejection into the call's own rejection, mirroring the real client's
 * ack-chain `.catch` that cancels the whole task when a single batch handler throws.
 */
class FakeParser implements ParseClientPort {
  readonly calls: FakeParseCall[] = [];
  private active: FakeParseCall | null = null;
  cancel = vi.fn(() => {
    this.active?.reject(new DOMException('The parse was cancelled.', 'AbortError'));
  });
  dispose = vi.fn();

  parse(
    input: { name: string; blob: Blob; formatId?: string },
    handlers: ParseHandlers,
  ): Promise<StreamedParseResult> {
    let settled = false;
    let resolveTask!: (value: StreamedParseResult) => void;
    let rejectTask!: (error: unknown) => void;
    const promise = new Promise<StreamedParseResult>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const call: FakeParseCall = {
      name: input.name,
      blob: input.blob,
      formatId: input.formatId,
      emitProgress: (progress) => handlers.onProgress(progress),
      emitBatch: (batch) => {
        const outcome = handlers.onBatch(batch);
        outcome.catch((error: unknown) => call.reject(error));
        return outcome;
      },
      finish: (result) => {
        if (settled) return;
        settled = true;
        if (this.active === call) this.active = null;
        resolveTask(result);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        if (this.active === call) this.active = null;
        rejectTask(error);
      },
    };
    this.active = call;
    this.calls.push(call);
    return promise;
  }
}

/** A recorded `IngestSession` whose `appendBatch` stays pending until the test resolves it. */
class FakeIngestSession implements IngestSession {
  readonly appendCalls: Array<{
    table: string;
    ipc: Uint8Array;
    resolve(): void;
    reject(error: unknown): void;
  }> = [];
  finalizeCalls = 0;
  abortCalls = 0;
  finalizeResult: readonly TableSummary[] = [];
  /** Every `backfillSchemas` argument `finalize()` was called with, in call order. */
  readonly finalizeSchemaCalls: Array<readonly TableSchema[] | undefined> = [];
  private finalizeGate: Deferred<void> | null = null;

  /**
   * Fires once this session is fully settled (its `finalize()`/`abort()` call has resolved or
   * rejected) — mirrors `BrowserDatabase`'s real `onSettled` callback, which is what clears
   * `activeIngest` and lets the next `beginIngest` proceed. Set by `fakeDatabase()` so it can
   * enforce the real single-open-session invariant (see that function's comment).
   */
  onSettled: () => void = () => undefined;

  constructor(readonly options: IngestOptions) {}

  appendBatch(table: string, ipc: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.appendCalls.push({ table, ipc, resolve, reject });
    });
  }

  /** Test hook: block `finalize()` from resolving until the returned deferred is resolved. */
  holdFinalize(): Deferred<void> {
    this.finalizeGate = deferred<void>();
    return this.finalizeGate;
  }

  async finalize(backfillSchemas?: readonly TableSchema[]): Promise<readonly TableSummary[]> {
    this.finalizeCalls += 1;
    this.finalizeSchemaCalls.push(backfillSchemas);
    try {
      if (this.finalizeGate) await this.finalizeGate.promise;
      return this.finalizeResult;
    } finally {
      this.onSettled();
    }
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    this.onSettled();
  }

  readonly beginFileCalls: string[] = [];
  discardCalls = 0;
  beginFile = vi.fn(async (file: string) => {
    this.beginFileCalls.push(file);
  });
  discardCurrentFile = vi.fn(async () => {
    this.discardCalls += 1;
  });
}

const queryTable = (value: number): Table => tableFromArrays({ value: [value] });

/**
 * The real `BrowserDatabase.beginIngest` throws 'An ingest session is already open.' while a
 * prior session's `finalize()`/`abort()` hasn't resolved yet (`activeIngest` only clears in that
 * call's `onSettled`) — this fake enforces the identical invariant, so controller tests exercise
 * the real race instead of a laxer stand-in that always allows a second `beginIngest` through.
 */
const fakeDatabase = (): { database: ByteqlDatabase; sessions: FakeIngestSession[] } => {
  const sessions: FakeIngestSession[] = [];
  let active: FakeIngestSession | null = null;
  const database: ByteqlDatabase = {
    initialize: vi.fn().mockResolvedValue(undefined),
    beginIngest: vi.fn(async (options: IngestOptions) => {
      if (active) {
        throw new Error('An ingest session is already open.');
      }
      const session = new FakeIngestSession(options);
      session.onSettled = () => {
        if (active === session) active = null;
      };
      active = session;
      sessions.push(session);
      return session;
    }),
    query: vi.fn().mockResolvedValue({ table: queryTable(1), elapsedMs: 2 }),
    cancelQuery: vi.fn().mockResolvedValue(false),
    listTables: vi.fn().mockResolvedValue([]),
    collectFileStatistics: vi.fn().mockResolvedValue(undefined),
    exportFileStatistics: vi.fn().mockResolvedValue({
      totalFileReadsCold: 0,
      totalFileReadsAhead: 0,
      totalFileReadsCached: 0,
      totalFileWrites: 0,
      totalPageAccesses: 0,
      totalPageLoads: 0,
      blockSize: 0,
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  return { database, sessions };
};

const MIDI_MAGIC = [0x4d, 0x54, 0x68, 0x64] as const;

/** A minimal recognizable MIDI head (`MThd`) plus distinguishing filler — `openFiles` probes head
 * bytes via `planBatch`, so every test file must carry real format magic to be accepted. */
const midiFile = (name: string, ...extra: number[]): File =>
  new File([new Uint8Array([...MIDI_MAGIC, ...extra])], name);

const midiBlob = (): Blob => new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6])]);

/**
 * Every batch open now appends a `_files` catalog row before `finalize()`, and
 * `FakeIngestSession.appendBatch` never auto-resolves — so any test driving an open through to
 * `ready` must resolve this trailing append, or the awaited `opening` promise hangs forever.
 */
const resolveFilesAppend = async (session: FakeIngestSession): Promise<void> => {
  await vi.waitFor(() => expect(session.appendCalls.some((call) => call.table === '_files')).toBe(true));
  session.appendCalls.find((call) => call.table === '_files')!.resolve();
};

/** The `_files` overview entry every ready batch appends to `tables` (spec-documented columns). */
const filesOverview = (rowCount: number): TableOverview => ({
  name: '_files',
  rowCount,
  columns: [
    { name: 'file', type: 'Utf8', nullable: false },
    { name: 'original_name', type: 'Utf8', nullable: false },
    { name: 'size', type: 'Uint64', nullable: false },
    { name: 'ingest_order', type: 'Int32', nullable: false },
    { name: 'status', type: 'Utf8', nullable: false },
    { name: 'error', type: 'Utf8', nullable: true },
  ],
});

describe('SessionController', () => {
  let parser: FakeParser;
  let database: ByteqlDatabase;
  let sessions: FakeIngestSession[];
  let stopViewer: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    sweepSpillOrphansMock.mockClear();
    parser = new FakeParser();
    ({ database, sessions } = fakeDatabase());
    stopViewer = vi.fn<() => void>();
  });

  it('fetches the midi sample lazily on open and caches it across opens', async () => {
    const sample = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 1, 2, 3]);
    const fetchSample = vi.fn().mockResolvedValue(new Response(sample));
    const controller = new SessionController({
      database,
      parser,
      fetch: fetchSample,
      sampleUrlOverrides: { midi: ['/assets/fur_Elise_opening.mid'] },
      stopViewer,
    });

    await controller.initialize();
    // Init no longer fetches any sample.
    expect(fetchSample).not.toHaveBeenCalled();

    const opening = controller.openSample('midi');
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    expect(fetchSample).toHaveBeenCalledWith(
      '/assets/fur_Elise_opening.mid',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(parser.calls[0]?.name).toBe('fur_Elise_opening.mid');
    expect(Array.from(new Uint8Array(await parser.calls[0]!.blob.arrayBuffer()))).toEqual(Array.from(sample));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'events', rowCount: 3 }];
    parser.calls[0]!.finish(streamedResult('events', 3));
    await resolveFilesAppend(sessions[0]!);
    await opening;

    // Second open reuses the cache — no second fetch for the same url.
    const reopening = controller.openSample('midi');
    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    expect(fetchSample).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[1]!.finalizeResult = [{ name: 'events', rowCount: 3 }];
    parser.calls[1]!.finish(streamedResult('events', 3));
    await resolveFilesAppend(sessions[1]!);
    await reopening;
  });

  it('opens the pcap sample as a two-file batch', async () => {
    const sample = new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1, 1, 2, 3]);
    // A fresh Response per call: two distinct urls are fetched, and a Response body can only be read once.
    const fetchSample = vi.fn().mockImplementation(() => Promise.resolve(new Response(sample)));
    const controller = new SessionController({
      database,
      parser,
      fetch: fetchSample,
      sampleUrlOverrides: { pcap: ['/assets/SkypeIRC.cap', '/assets/v6.pcap'] },
      stopViewer,
    });
    await controller.initialize();

    const opening = controller.openSample('pcap');
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    expect(fetchSample).toHaveBeenCalledTimes(2);
    expect(parser.calls[0]!.name).toBe('SkypeIRC.cap');
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'packets', rowCount: 2 }];
    parser.calls[0]!.finish(streamedResult('packets', 1));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    expect(parser.calls[1]!.name).toBe('v6.pcap');
    parser.calls[1]!.finish(streamedResult('packets', 1));
    await resolveFilesAppend(sessions[0]!);
    await opening;
  });

  it('publishes UI-safe source metadata and progress without exposing the file', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const observed = vi.fn();
    const unsubscribe = controller.subscribe(observed);
    const file = midiFile('private.mid', 1, 2);

    const opening = controller.openFile(file);
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    parser.calls[0]!.emitProgress({ stage: 'parsing', completed: 1, total: 3, label: 'Parsing track 1' });

    expect(controller.getState()).toMatchObject({
      phase: 'parsing',
      source: { files: [{ name: 'private.mid', size: 6 }], totalSize: 6 },
    });
    expect(JSON.stringify(controller.getState())).not.toContain('File');
    expect(observed).toHaveBeenCalled();

    unsubscribe();
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'events', rowCount: 3 }];
    parser.calls[0]!.finish(streamedResult('events', 3));
    await resolveFilesAppend(sessions[0]!);
    await opening;
    const result = streamedResult('events', 3);
    expect(controller.getState().queries).toEqual(result.queries);
    expect(controller.getState().capabilities).toEqual(result.capabilities);
  });

  it('finalizes with the pack schemas and backfills zero-row tables the capture never populated', async () => {
    // C1 regression: a table the pack declares but this file never populated (e.g. no `tcp`
    // packets) must still be listed for the Explorer/UNION-ALL-overview to work — it is backfilled
    // as a rowCount-0 entry from `result.schemas`, not silently dropped.
    const controller = new SessionController({ database, parser, stopViewer });
    const opening = controller.openFile(midiFile('capture.pcap', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0]!;
    session.finalizeResult = [{ name: 'packets', rowCount: 2 }];

    const schemas: TableSchema[] = [
      { name: 'packets', columns: [{ name: 'packet_id', type: 'int64', nullable: false }] },
      { name: 'tcp', columns: [{ name: 'tcp_id', type: 'int64', nullable: false }] },
    ];
    parser.calls[0]!.finish({
      format: { id: 'pcap', title: 'PCAP capture' },
      tables: [{ name: 'packets', rowCount: 2, columns: schemas[0]!.columns }],
      issues: [],
      queries: [],
      capabilities: {},
      schemas,
    });
    await resolveFilesAppend(session);
    await opening;

    expect(session.finalizeSchemaCalls).toEqual([schemas]);
    expect(controller.getState().tables).toEqual([
      { name: 'packets', rowCount: 2, columns: schemas[0]!.columns },
      { name: 'tcp', rowCount: 0, columns: schemas[1]!.columns },
      filesOverview(1),
    ]);
  });

  it('cancels parse, query, and viewer immediately and ignores stale ingest results', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const first = controller.openFile(midiFile('old.mid', 1));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const oldSession = sessions[0]!;
    const second = controller.openFile(midiFile('new.mid', 2));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));

    expect(parser.cancel).toHaveBeenCalledTimes(2);
    expect(database.cancelQuery).toHaveBeenCalledTimes(2);
    expect(stopViewer).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({
      source: { files: [{ name: 'new.mid', size: 5 }], totalSize: 5 },
    });

    await first;
    expect(oldSession.abortCalls).toBe(1);
    expect(oldSession.finalizeCalls).toBe(0);

    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[1]!.finalizeResult = [{ name: 'new', rowCount: 1 }];
    parser.calls[1]!.finish(streamedResult('new', 1));
    await resolveFilesAppend(sessions[1]!);
    await second;
    expect(controller.getState()).toMatchObject({
      phase: 'ready',
      source: { files: [{ name: 'new.mid', size: 5 }], totalSize: 5 },
      tables: [...streamedResult('new', 1).tables, filesOverview(1)],
    });
  });

  it('does not finalize the ingest until the complete parse result arrives', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const opening = controller.openFile(midiFile('wait.mid', 1));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    parser.calls[0]!.emitProgress({
      stage: 'projecting',
      completed: 1,
      total: 2,
      label: 'Projecting track 1',
    });
    expect(sessions[0]!.finalizeCalls).toBe(0);

    sessions[0]!.finalizeResult = [{ name: 'complete', rowCount: 3 }];
    parser.calls[0]!.finish(streamedResult('complete', 3));
    await resolveFilesAppend(sessions[0]!);
    await opening;
    expect(sessions[0]!.finalizeCalls).toBe(1);
  });

  it('ignores stale query completion after a replacement session begins', async () => {
    const query = deferred<{ table: Table; elapsedMs: number }>();
    vi.mocked(database.query).mockReturnValueOnce(query.promise);
    const controller = new SessionController({ database, parser, stopViewer });

    const firstOpen = controller.openFile(midiFile('first.mid', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'first', rowCount: 1 }];
    parser.calls[0]!.finish(streamedResult('first', 1));
    await resolveFilesAppend(sessions[0]!);
    await firstOpen;

    const runningQuery = controller.runQuery('select * from first');
    const replacement = controller.openFile(midiFile('second.mid', 2));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    query.resolve({ table: queryTable(99), elapsedMs: 50 });
    await runningQuery;
    expect(controller.getState().result).toBeNull();
    expect(controller.getState().source?.files[0]?.name).toBe('second.mid');

    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[1]!.finalizeResult = [{ name: 'second', rowCount: 1 }];
    parser.calls[1]!.finish(streamedResult('second', 1));
    await resolveFilesAppend(sessions[1]!);
    await replacement;
  });

  it('retains a successful result when a later SQL query fails', async () => {
    const prior = queryTable(7);
    vi.mocked(database.query)
      .mockResolvedValueOnce({ table: prior, elapsedMs: 3 })
      .mockRejectedValueOnce(new Error('syntax error'));
    const controller = new SessionController({ database, parser, stopViewer });
    const opening = controller.openFile(midiFile('query.mid', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'events', rowCount: 3 }];
    parser.calls[0]!.finish(streamedResult('events', 3));
    await resolveFilesAppend(sessions[0]!);
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
    const controller = new SessionController({
      database,
      parser,
      stopViewer,
    });
    const listener = vi.fn();
    controller.subscribe(listener);

    const initialization = controller.initialize();
    const disposal = controller.dispose();
    await Promise.allSettled([initialization, disposal]);

    expect(parser.dispose).toHaveBeenCalledOnce();
    expect(database.cancelQuery).toHaveBeenCalled();
    expect(database.dispose).toHaveBeenCalledOnce();
    expect(stopViewer).toHaveBeenCalled();
    expect(() => controller.openSample('midi')).toThrow(/disposed/i);
    expect(() => controller.subscribe(vi.fn())).toThrow(/disposed/i);
  });

  it('does not let a fetch implementation that ignores abort block disposal', async () => {
    const response = deferred<Response>();
    const controller = new SessionController({
      database,
      parser,
      fetch: vi.fn().mockReturnValue(response.promise),
      sampleUrlOverrides: { midi: ['/assets/fur_Elise_opening.mid'] },
      stopViewer,
    });
    await controller.initialize();
    // The only startup fetch is now the sample fetch; kick it off so a hanging,
    // abort-ignoring fetch is genuinely in flight.
    const opening = controller.openSample('midi');
    await Promise.resolve();

    const disposal = controller.dispose();
    const outcome = await Promise.race([
      disposal.then(() => 'disposed'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 20)),
    ]);
    expect(outcome).toBe('disposed');

    response.resolve(new Response(new Uint8Array([1])));
    await Promise.allSettled([opening]);
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
    const opening = controller.openFile(midiFile('private.mid', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'events', rowCount: 3 }];
    parser.calls[0]!.finish({
      ...streamedResult('events', 3),
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
    await resolveFilesAppend(sessions[0]!);
    await opening;
    await controller.runQuery('select * from events');
    expect(controller.getState()).toMatchObject({
      source: { files: [{ name: 'private.mid', size: 5 }], totalSize: 5 },
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

    const opening = controller.openFile(midiFile('listeners.mid', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'events', rowCount: 3 }];
    parser.calls[0]!.finish(streamedResult('events', 3));
    await resolveFilesAppend(sessions[0]!);
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

  it('opens a file through ingest: begin → per-batch append+ack → finalize → ready', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const file = midiFile('song.mid', 1, 2, 3);

    const opening = controller.openFile(file);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    expect(database.beginIngest).toHaveBeenCalledWith({
      schemas: 'discover',
      tier: 'memory',
      generation: 1,
    });
    const session = sessions[0]!;

    const ipc1 = new Uint8Array([9]);
    const emit1 = parser.calls[0]!.emitBatch({ seq: 1, table: 'events', ipc: ipc1, rowCount: 1 });
    await vi.waitFor(() => expect(session.appendCalls).toHaveLength(1));
    expect(session.appendCalls[0]).toMatchObject({ table: 'events', ipc: ipc1 });
    let firstAcked = false;
    void emit1.then(() => {
      firstAcked = true;
    });
    await flush();
    expect(firstAcked).toBe(false);
    session.appendCalls[0]!.resolve();
    await emit1;
    expect(firstAcked).toBe(true);

    const ipc2 = new Uint8Array([10]);
    const emit2 = parser.calls[0]!.emitBatch({ seq: 2, table: 'events', ipc: ipc2, rowCount: 1 });
    await vi.waitFor(() => expect(session.appendCalls).toHaveLength(2));
    expect(session.finalizeCalls).toBe(0);
    session.appendCalls[1]!.resolve();
    await emit2;

    session.finalizeResult = [{ name: 'events', rowCount: 2 }];
    parser.calls[0]!.finish({
      format: { id: 'standard_midi_file', title: 'Standard MIDI file' },
      tables: [{ name: 'events', rowCount: 0, columns: [] }],
      issues: [],
      queries: [],
      capabilities: {},
      schemas: [],
    });
    await vi.waitFor(() => expect(session.appendCalls).toHaveLength(3));
    expect(session.appendCalls[2]!.table).toBe('_files');
    session.appendCalls[2]!.resolve();
    await opening;

    expect(session.finalizeCalls).toBe(1);
    expect(controller.getState()).toMatchObject({
      phase: 'ready',
      tables: [{ name: 'events', rowCount: 2, columns: [] }, filesOverview(1)],
    });
  });

  it('waits for a straggling append to settle before finalizing, even if finish arrives first', async () => {
    // Regression: the real ParseWorkerClient resolves `parse()` as soon as the worker's `finish`
    // message arrives, and the worker sends `finish` without waiting for the last batch's ack —
    // so `finish` can race ahead of an in-flight `appendBatch`. Finalizing before that append
    // settles would silently drop rows.
    const controller = new SessionController({ database, parser, stopViewer });
    const opening = controller.openFile(midiFile('race.mid', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0]!;

    const emit = parser.calls[0]!.emitBatch({
      seq: 1,
      table: 'events',
      ipc: new Uint8Array([1]),
      rowCount: 1,
    });
    await vi.waitFor(() => expect(session.appendCalls).toHaveLength(1));

    // `finish` arrives while the append above is still pending.
    session.finalizeResult = [{ name: 'events', rowCount: 1 }];
    parser.calls[0]!.finish(streamedResult('events', 1));
    await flush();
    expect(session.finalizeCalls).toBe(0);

    session.appendCalls[0]!.resolve();
    await emit;
    await resolveFilesAppend(session);
    await opening;

    expect(session.finalizeCalls).toBe(1);
    expect(controller.getState().phase).toBe('ready');
  });

  it('chooses the spill tier at the threshold and fails fast when unsupported', async () => {
    vi.mocked(database.beginIngest).mockRejectedValueOnce(
      new Error('SPILL_UNSUPPORTED: OPFS storage is not available in this environment.'),
    );
    const tierThresholdBytes = 2 * 1024 * 1024;
    const controller = new SessionController({
      database,
      parser,
      stopViewer,
      tiering: { tierThresholdBytes },
    });
    const bytes = new Uint8Array(tierThresholdBytes);
    bytes.set(MIDI_MAGIC);
    const file = new File([bytes], 'huge.mid');

    await controller.openFile(file);

    expect(database.beginIngest).toHaveBeenCalledOnce();
    expect(database.beginIngest).toHaveBeenCalledWith(expect.objectContaining({ tier: 'spill' }));
    expect(parser.calls).toHaveLength(0);
    expect(parser.cancel).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({
      phase: 'failed',
      fatalError: 'This browser cannot analyze files over 2 MB.',
    });
  });

  it('supersession mid-ingest aborts the new generation and leaves state on the new open', async () => {
    const controller = new SessionController({ database, parser, stopViewer });

    const first = controller.openFile(midiFile('old.mid', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const oldSession = sessions[0]!;

    const second = controller.openFile(midiFile('new.mid', 2));
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    const newSession = sessions[1]!;

    await first;
    expect(oldSession.abortCalls).toBe(1);
    expect(oldSession.finalizeCalls).toBe(0);

    newSession.finalizeResult = [{ name: 'events', rowCount: 5 }];
    parser.calls[1]!.finish(streamedResult('events', 5));
    await resolveFilesAppend(newSession);
    await second;

    expect(controller.getState()).toMatchObject({
      phase: 'ready',
      source: { files: [{ name: 'new.mid', size: 5 }], totalSize: 5 },
    });
    expect(newSession.finalizeCalls).toBe(1);
  });

  it('aborts (never finalizes) a superseded generation whose straggling append was still pending', async () => {
    // Regression: a generation superseded while `Promise.all(pendingAppends)` is still in flight
    // must never reach `finalize()` — committing a superseded generation's staging tables would
    // clobber catalog state the new generation assumes.
    const controller = new SessionController({ database, parser, stopViewer });
    const first = controller.openFile(midiFile('first.mid', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const firstSession = sessions[0]!;

    const emit = parser.calls[0]!.emitBatch({
      seq: 1,
      table: 'events',
      ipc: new Uint8Array([9]),
      rowCount: 1,
    });
    await vi.waitFor(() => expect(firstSession.appendCalls).toHaveLength(1));

    // `finish` races ahead of the still-pending append (mirrors the real client's behavior,
    // exercised in "waits for a straggling append to settle..." above).
    firstSession.finalizeResult = [{ name: 'first', rowCount: 1 }];
    parser.calls[0]!.finish(streamedResult('first', 1));
    await flush();
    expect(firstSession.finalizeCalls).toBe(0);

    // Supersede while the append is still pending. Gen 1's ingest session is still open (its
    // eventual abort hasn't happened yet), and the real DB refuses a second `beginIngest` while a
    // prior session is open (I1) — so the controller's own `beginIngest` for gen 2 is blocked
    // awaiting gen 1's settlement, and no second `FakeIngestSession` exists yet. Dispatching
    // 'opening' happens once gen 2's `planBatch` probe resolves (an async head-bytes read, no
    // longer synchronous) — it never touches the ingest session.
    const second = controller.openFile(midiFile('second.mid', 2));
    await vi.waitFor(() =>
      expect(controller.getState()).toMatchObject({
        phase: 'opening',
        source: { files: [{ name: 'second.mid', size: 5 }], totalSize: 5 },
      }),
    );
    expect(sessions).toHaveLength(1);

    // Now let the straggling append settle; gen 1 then notices it's superseded and aborts,
    // which settles gen 1 and unblocks gen 2's blocked `beginIngest`.
    firstSession.appendCalls[0]!.resolve();
    await emit;
    await first;

    expect(firstSession.finalizeCalls).toBe(0);
    expect(firstSession.abortCalls).toBe(1);

    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[1]!.finalizeResult = [{ name: 'second', rowCount: 1 }];
    parser.calls[1]!.finish(streamedResult('second', 1));
    await resolveFilesAppend(sessions[1]!);
    await second;
    expect(controller.getState()).toMatchObject({
      phase: 'ready',
      source: { files: [{ name: 'second.mid', size: 5 }], totalSize: 5 },
    });
  });

  it('suppresses a stale ready dispatch when finalize resolves after supersession, without aborting the committed ingest', async () => {
    // Regression: a generation superseded while `finalize()` is still in flight has already
    // committed its staging tables by the time it resolves — aborting it would be wrong (nothing
    // left to roll back) but dispatching `ready` for it would clobber the new generation's state
    // with the stale file's tables.
    const controller = new SessionController({ database, parser, stopViewer });
    const first = controller.openFile(midiFile('first.mid', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const firstSession = sessions[0]!;
    const finalizeGate = firstSession.holdFinalize();
    firstSession.finalizeResult = [{ name: 'first', rowCount: 1 }];

    parser.calls[0]!.finish(streamedResult('first', 1));
    await resolveFilesAppend(firstSession);
    await vi.waitFor(() => expect(firstSession.finalizeCalls).toBe(1));
    expect(controller.getState().phase).not.toBe('ready');

    // Supersede while gen 1's finalize is still in flight (I1: the real DB refuses a second
    // `beginIngest` while gen 1's session is still open, since `finalize()` hasn't resolved yet).
    // The controller's own `beginIngest` for gen 2 is now blocked awaiting gen 1's settlement, so
    // no second `FakeIngestSession` exists yet even though 'opening' dispatches once gen 2's own
    // `planBatch` probe resolves.
    const second = controller.openFile(midiFile('second.mid', 2));
    await vi.waitFor(() =>
      expect(controller.getState()).toMatchObject({
        phase: 'opening',
        source: { files: [{ name: 'second.mid', size: 5 }], totalSize: 5 },
      }),
    );
    expect(sessions).toHaveLength(1);

    finalizeGate.resolve();
    await first;

    expect(controller.getState()).toMatchObject({
      source: { files: [{ name: 'second.mid', size: 5 }], totalSize: 5 },
    });
    expect(controller.getState().tables).not.toEqual(streamedResult('first', 1).tables);
    expect(firstSession.abortCalls).toBe(0);

    // gen 1 settling (its finalize resolved) unblocks gen 2's blocked `beginIngest`.
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    const secondSession = sessions[1]!;
    secondSession.finalizeResult = [{ name: 'second', rowCount: 1 }];
    parser.calls[1]!.finish(streamedResult('second', 1));
    await resolveFilesAppend(secondSession);
    await second;
    expect(controller.getState()).toMatchObject({
      phase: 'ready',
      source: { files: [{ name: 'second.mid', size: 5 }], totalSize: 5 },
    });
  });

  it('skips ingest claim for generations superseded while awaiting settlement', async () => {
    // Regression: generation B (open while A awaits `ingestSettlement`) supersedes A, then gets
    // superseded by C. When A's settlement finally resolves, B is stale but tries to call
    // `beginIngest`, which would throw 'An ingest session is already open.' if C's session is still
    // open. The guard `if (!this.isCurrent(generation)) return;` after `await
    // this.ingestSettlement` prevents B from claiming the ingest slot.
    const controller = new SessionController({ database, parser, stopViewer });

    // Open A, hold its finalize to keep its ingest session open.
    const openA = controller.openFile(midiFile('first.mid', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const sessionA = sessions[0]!;
    const gateA = sessionA.holdFinalize();
    sessionA.finalizeResult = [{ name: 'first', rowCount: 1 }];
    parser.calls[0]!.finish(streamedResult('first', 1));
    await resolveFilesAppend(sessionA);
    await vi.waitFor(() => expect(sessionA.finalizeCalls).toBe(1));

    // Open B while A's finalize is pending. B's `completeBatchOpen` is now blocked waiting on A's
    // `ingestSettlement` to resolve (it awaits ingestSettlement before calling beginIngest).
    void controller.openFile(midiFile('second.mid', 2));
    await vi.waitFor(() => expect(controller.getState().source?.files[0]?.name).toBe('second.mid'));
    expect(sessions).toHaveLength(1);

    // Open C to supersede B. C's `completeBatchOpen` is also blocked on A's settlement.
    const openC = controller.openFile(midiFile('third.mid', 3));
    await vi.waitFor(() => expect(controller.getState().source?.files[0]?.name).toBe('third.mid'));
    expect(sessions).toHaveLength(1);

    // Release A's finalize. A settles and unblocks both B and C's waiting `completeBatchOpen`.
    // B is stale by now (C superseded it), so after A's ingestSettlement resolves,
    // B's isCurrent check should return false and skip the beginIngest call.
    // Only C should reach `beginIngest` and create a session.
    gateA.resolve();
    await openA;

    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    const sessionC = sessions[1]!;
    expect(sessionC.options.generation).toBe(3);
    sessionC.finalizeResult = [{ name: 'third', rowCount: 1 }];

    // C's parse finishes and it reaches ready state.
    parser.calls[1]!.finish(streamedResult('third', 1));
    await resolveFilesAppend(sessionC);
    await openC;

    expect(controller.getState()).toMatchObject({
      phase: 'ready',
      source: { files: [{ name: 'third.mid', size: 5 }], totalSize: 5 },
    });
  });

  it('parse failure and quota failure abort the ingest session', async () => {
    const parseFailure = new FakeParser();
    const { database: databaseA, sessions: sessionsA } = fakeDatabase();
    const controllerA = new SessionController({ database: databaseA, parser: parseFailure, stopViewer });
    const openingA = controllerA.openFile(midiFile('broken.mid', 1));
    await vi.waitFor(() => expect(sessionsA).toHaveLength(1));
    parseFailure.calls[0]!.reject(new Error('Unexpected end of track data.'));
    await openingA;
    expect(sessionsA[0]!.abortCalls).toBe(1);
    expect(controllerA.getState()).toMatchObject({
      phase: 'failed',
      fatalError: 'Unexpected end of track data.',
    });

    const quotaParser = new FakeParser();
    const { database: databaseB, sessions: sessionsB } = fakeDatabase();
    const controllerB = new SessionController({ database: databaseB, parser: quotaParser, stopViewer });
    const openingB = controllerB.openFile(midiFile('huge.mid', 1));
    await vi.waitFor(() => expect(sessionsB).toHaveLength(1));
    const sessionB = sessionsB[0]!;
    const emit = quotaParser.calls[0]!.emitBatch({
      seq: 1,
      table: 'events',
      ipc: new Uint8Array([1]),
      rowCount: 1,
    });
    await vi.waitFor(() => expect(sessionB.appendCalls).toHaveLength(1));
    sessionB.appendCalls[0]!.reject(new Error('SPILL_QUOTA_EXCEEDED: failed to spill "events" to OPFS.'));
    await expect(emit).rejects.toThrow('SPILL_QUOTA_EXCEEDED');
    await openingB;
    expect(sessionB.abortCalls).toBe(1);
    expect(controllerB.getState()).toMatchObject({
      phase: 'failed',
      fatalError: 'Local storage ran out of space while analyzing this file. Free up space and try again.',
    });
  });

  it('cancel aborts ingest and dispatches cancelled', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const opening = controller.openFile(midiFile('song.mid', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0]!;

    const cancellation = controller.cancel();
    expect(controller.getState()).toEqual(initialSessionState);
    await Promise.all([cancellation, opening]);
    await vi.waitFor(() => expect(session.abortCalls).toBe(1));
    expect(session.finalizeCalls).toBe(0);
  });

  it('openSample wraps sampleBytes in a Blob and parses through the same path', async () => {
    const sample = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 1, 2, 3]);
    const fetchSample = vi.fn().mockResolvedValue(new Response(sample));
    const controller = new SessionController({
      database,
      parser,
      fetch: fetchSample,
      sampleUrlOverrides: { midi: ['/assets/fur_Elise_opening.mid'] },
      stopViewer,
    });
    await controller.initialize();

    const opening = controller.openSample('midi');
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    expect(parser.calls[0]!.name).toBe('fur_Elise_opening.mid');
    expect(parser.calls[0]!.blob).toBeInstanceOf(Blob);
    expect(parser.calls[0]!.blob.size).toBe(sample.byteLength);
    expect(Array.from(new Uint8Array(await parser.calls[0]!.blob.arrayBuffer()))).toEqual(Array.from(sample));

    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'events', rowCount: 1 }];
    parser.calls[0]!.finish(streamedResult('events', 1));
    await resolveFilesAppend(sessions[0]!);
    await opening;
    expect(controller.getState().phase).toBe('ready');
  });

  it('sweeps spill orphans once at initialization', async () => {
    const controller = new SessionController({
      database,
      parser,
      stopViewer,
    });

    await Promise.all([controller.initialize(), controller.initialize()]);

    expect(sweepSpillOrphansMock).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('progress dispatches bytes and openStartedAt enables rate computation', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const opening = controller.openFile(midiFile('song.mid', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0]!;
    const openStartedAt = controller.getState().openStartedAt;
    expect(openStartedAt).toEqual(expect.any(Number));

    parser.calls[0]!.emitProgress({ stage: 'parsing', completed: 1, total: 3, label: 'Parsing track 1' });
    expect(controller.getState()).toMatchObject({
      phase: 'parsing',
      progress: { completed: 1, total: 3, bytes: 0 },
      openStartedAt,
    });

    const emit = parser.calls[0]!.emitBatch({
      seq: 1,
      table: 'events',
      ipc: new Uint8Array(10),
      rowCount: 1,
    });
    await vi.waitFor(() => expect(session.appendCalls).toHaveLength(1));
    expect(controller.getState()).toMatchObject({ progress: { bytes: 10 }, openStartedAt });

    session.appendCalls[0]!.resolve();
    await emit;
    session.finalizeResult = [{ name: 'events', rowCount: 1 }];
    parser.calls[0]!.finish(streamedResult('events', 1));
    await resolveFilesAppend(session);
    await opening;
    expect(controller.getState().openStartedAt).toBeNull();
  });

  it('retains the source blob for the session and exposes byte selection', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    expect(controller.getSourceBlob('x.mid')).toBeNull();

    const file = midiFile('x.mid', 1, 2, 3);
    const opening = controller.openFile(file);
    await vi.waitFor(() => expect(controller.getSourceBlob('x.mid')).toBe(file));

    controller.selectByteRange({ file: 'x.mid', start: 0, end: 2 });
    expect(controller.getState().byteSelection).toEqual({ file: 'x.mid', start: 0, end: 2 });
    controller.selectByteRange(null);
    expect(controller.getState().byteSelection).toBeNull();

    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'events', rowCount: 1 }];
    parser.calls[0]!.finish(streamedResult('events', 1));
    await resolveFilesAppend(sessions[0]!);
    await opening;
  });

  it('retains the sample blob across openSample and clears it on dispose', async () => {
    const sample = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 1, 2, 3]);
    const fetchSample = vi.fn().mockResolvedValue(new Response(sample));
    const controller = new SessionController({
      database,
      parser,
      fetch: fetchSample,
      sampleUrlOverrides: { midi: ['/assets/fur_Elise_opening.mid'] },
      stopViewer,
    });
    await controller.initialize();

    const opening = controller.openSample('midi');
    await vi.waitFor(() => expect(controller.getSourceBlob('fur_Elise_opening.mid')).toBeInstanceOf(Blob));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'events', rowCount: 1 }];
    parser.calls[0]!.finish(streamedResult('events', 1));
    await resolveFilesAppend(sessions[0]!);
    await opening;

    await controller.dispose();
    expect(controller.getSourceBlob('fur_Elise_opening.mid')).toBeNull();
  });

  it('batch happy path: two files parse sequentially into one ingest with a _files batch', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const fileA = new File([midiBlob()], 'a.mid');
    const fileB = new File([midiBlob()], 'b.mid');

    const opening = controller.openFiles([fileA, fileB]);
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    expect(parser.calls[0]!.name).toBe('a.mid');
    expect(parser.calls[0]!.formatId).toBe('standard_midi_file');
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0]!;

    session.finalizeResult = [{ name: 'notes', rowCount: 2 }];
    parser.calls[0]!.finish(streamedResult('notes', 1));

    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    expect(parser.calls[1]!.name).toBe('b.mid');
    parser.calls[1]!.finish(streamedResult('notes', 1));

    await resolveFilesAppend(session);
    await opening;

    expect(session.beginFileCalls).toEqual(['a.mid', 'b.mid']);
    const filesAppend = session.appendCalls.find((call) => call.table === '_files')!;
    const filesTable = ipcToTable(filesAppend.ipc);
    expect(filesTable.numRows).toBe(2);
    expect(filesTable.getChild('status')!.get(0)).toBe('ok');
    expect(filesTable.getChild('status')!.get(1)).toBe('ok');

    expect(controller.getState().phase).toBe('ready');
    expect(controller.getState().source?.files.map((file) => file.name)).toEqual(['a.mid', 'b.mid']);
    expect(controller.getState().tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['notes', '_files']),
    );
  });

  it('mid-parse failure discards the file and continues with the rest', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const fileA = new File([midiBlob()], 'a.mid');
    const fileB = new File([midiBlob()], 'b.mid');

    const opening = controller.openFiles([fileA, fileB]);
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0]!;

    parser.calls[0]!.reject(new Error('truncated'));

    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    expect(parser.calls[1]!.name).toBe('b.mid');
    session.finalizeResult = [{ name: 'notes', rowCount: 1 }];
    parser.calls[1]!.finish(streamedResult('notes', 1));

    await resolveFilesAppend(session);
    await opening;

    expect(session.discardCalls).toBe(1);
    expect(controller.getState().phase).toBe('ready');
    expect(controller.getState().source?.files).toEqual([{ name: 'b.mid', size: 8 }]);
    expect(controller.getState().issues).toContainEqual(
      expect.objectContaining({
        code: 'FILE_SKIPPED',
        message: expect.stringMatching(/a\.mid was skipped: truncated/),
      }),
    );

    const filesAppend = session.appendCalls.find((call) => call.table === '_files')!;
    const filesTable = ipcToTable(filesAppend.ipc);
    expect(filesTable.getChild('file')!.get(0)).toBe('a.mid');
    expect(filesTable.getChild('file')!.get(1)).toBe('b.mid');
    expect(filesTable.getChild('status')!.get(0)).toBe('skipped');
    expect(filesTable.getChild('status')!.get(1)).toBe('ok');
    expect(filesTable.getChild('error')!.get(0)).toBe('truncated');
    expect(filesTable.getChild('error')!.get(1)).toBeNull();
  });

  it('all files failing rejects the open with abort, not finalize', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const fileA = new File([midiBlob()], 'a.mid');
    const fileB = new File([midiBlob()], 'b.mid');

    const opening = controller.openFiles([fileA, fileB]);
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0]!;

    parser.calls[0]!.reject(new Error('truncated a'));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    parser.calls[1]!.reject(new Error('truncated b'));

    await opening;

    expect(controller.getState().phase).toBe('failed');
    expect(session.abortCalls).toBe(1);
    expect(session.finalizeCalls).toBe(0);
  });

  it('a second openFiles supersedes an in-flight batch', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const first = controller.openFiles([new File([midiBlob()], 'a.mid'), new File([midiBlob()], 'b.mid')]);
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    expect(parser.calls[0]!.name).toBe('a.mid');
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const firstSession = sessions[0]!;

    const second = controller.openFiles([new File([midiBlob()], 'c.mid')]);
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    const secondSession = sessions[1]!;

    await first;
    expect(firstSession.abortCalls).toBe(1);
    expect(firstSession.finalizeCalls).toBe(0);

    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    expect(parser.calls[1]!.name).toBe('c.mid');
    secondSession.finalizeResult = [{ name: 'notes', rowCount: 1 }];
    parser.calls[1]!.finish(streamedResult('notes', 1));
    await resolveFilesAppend(secondSession);
    await second;

    expect(controller.getState()).toMatchObject({
      phase: 'ready',
      source: { files: [{ name: 'c.mid', size: 8 }], totalSize: 8 },
    });
  });

  it('cancel() mid-batch abandons the whole batch', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const opening = controller.openFiles([new File([midiBlob()], 'a.mid'), new File([midiBlob()], 'b.mid')]);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0]!;

    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    expect(parser.calls[0]!.name).toBe('a.mid');
    session.finalizeResult = [{ name: 'notes', rowCount: 1 }];
    parser.calls[0]!.finish(streamedResult('notes', 1));

    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    expect(parser.calls[1]!.name).toBe('b.mid');

    const cancellation = controller.cancel();
    expect(controller.getState().phase).toBe('idle');
    await Promise.all([cancellation, opening]);

    await vi.waitFor(() => expect(session.abortCalls).toBe(1));
    expect(session.finalizeCalls).toBe(0);
    expect(parser.calls).toHaveLength(2);
  });

  it('unrecognized-only batches fail without touching the database', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    await controller.openFiles([new File([new Uint8Array([0, 0, 0, 0])], 'junk.bin')]);

    expect(controller.getState().phase).toBe('failed');
    expect(database.beginIngest).not.toHaveBeenCalled();
  });

  it('progress events carry the batch position', async () => {
    const controller = new SessionController({ database, parser, stopViewer });
    const opening = controller.openFiles([new File([midiBlob()], 'a.mid'), new File([midiBlob()], 'b.mid')]);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const session = sessions[0]!;

    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    session.finalizeResult = [{ name: 'notes', rowCount: 1 }];
    parser.calls[0]!.finish(streamedResult('notes', 1));

    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    parser.calls[1]!.emitProgress({ stage: 'parsing', completed: 1, total: 2, label: 'Parsing track 1' });

    expect(controller.getState().progress).toMatchObject({ fileIndex: 2, fileCount: 2 });

    parser.calls[1]!.finish(streamedResult('notes', 1));
    await resolveFilesAppend(session);
    await opening;
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

  it('does not resolve on finish until every outstanding onBatch call has settled', async () => {
    // Regression: the worker sends `finish` right after its last `nextBatch()`, without waiting
    // for that batch's ack — so `finish` can arrive while an `onBatch` call (e.g. a slow DB
    // append) is still pending. A caller must never observe a resolved `parse()` while a batch it
    // handed off is still being processed.
    const workers: FakeWorker[] = [];
    const client = new ParseWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const gate = deferred<void>();
    const onBatch = vi.fn(async () => {
      await gate.promise;
    });
    const parsing = client.parse(
      { name: 'race.mid', blob: new Blob([new Uint8Array([1])]) },
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

    // `finish` arrives while the batch above is still mid-flight.
    workers[0]!.emit({ type: 'finish', taskId: 1, ...streamedResult('events') });
    await flush();

    let settled = false;
    void parsing.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    gate.resolve();
    await expect(parsing).resolves.toEqual(streamedResult('events'));
  });

  it('rejects with the real error when a batch fails after finish has already arrived', async () => {
    const workers: FakeWorker[] = [];
    const client = new ParseWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const gate = deferred<void>();
    const onBatch = vi.fn(async () => {
      await gate.promise;
      throw new Error('append failed');
    });
    const parsing = client.parse(
      { name: 'race-fail.mid', blob: new Blob([new Uint8Array([1])]) },
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
    workers[0]!.emit({ type: 'finish', taskId: 1, ...streamedResult('events') });
    await flush();

    gate.resolve();
    await expect(parsing).rejects.toThrow('append failed');
  });

  it('drains queued onBatch calls before rejecting on a worker error', async () => {
    // Regression: up to BATCH_CREDIT_WINDOW `batch` messages can be in flight when the worker
    // posts `error`. A queued-but-not-yet-started `onBatch` must still run before the task
    // rejects — otherwise a caller's failure cleanup (e.g. deleting a failed file's rows) can run
    // before that handler fires and leak the failed file's rows into the dataset afterward.
    const workers: FakeWorker[] = [];
    const client = new ParseWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const appended: number[] = [];
    const gates = [deferred<void>(), deferred<void>()];
    const onBatch = vi.fn(async (batch: BatchMessage) => {
      await gates[batch.seq - 1]!.promise;
      appended.push(batch.seq);
    });
    const parsing = client.parse(
      { name: 'error-mid-parse.mid', blob: new Blob([new Uint8Array([1])]) },
      { onProgress: vi.fn(), onBatch },
    );

    // Two batches followed immediately by `error`, with no acks in between — mirrors the worker
    // posting `error` while several batches are still outstanding.
    workers[0]!.emit({
      type: 'batch',
      taskId: 1,
      seq: 1,
      table: 'events',
      ipc: new Uint8Array([9]),
      rowCount: 1,
    });
    workers[0]!.emit({
      type: 'batch',
      taskId: 1,
      seq: 2,
      table: 'events',
      ipc: new Uint8Array([9]),
      rowCount: 1,
    });
    workers[0]!.emit({ type: 'error', taskId: 1, message: 'boom' });
    await flush();

    let settled = false;
    void parsing.catch(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    expect(appended).toEqual([]);

    // Batch 1's onBatch completes; batch 2's is still queued behind it on the ack chain.
    gates[0]!.resolve();
    await flush();
    expect(appended).toEqual([1]);
    expect(settled).toBe(false);

    // Only once batch 2's onBatch has also run does the task reject.
    gates[1]!.resolve();
    await expect(parsing).rejects.toThrow('boom');
    expect(appended).toEqual([1, 2]);
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

  it('carries the pack schemas in finish, for backfilling tables the capture never populated', async () => {
    // C1 regression: the DB needs every declared table's schema at finalize time to backfill
    // zero-row tables (e.g. no `tcp` packets in this capture) as empty tables, so a UNION ALL
    // overview query over all pack tables does not hit a Catalog Error.
    const scope = new FakeWorkerScope();
    const packSchemas = [
      { name: 'events', columns: [{ name: 'id', type: 'int32', nullable: false }] },
      { name: 'errors', columns: [{ name: 'code', type: 'utf8', nullable: false }] },
    ];
    const pack = fakePack({ schemas: () => packSchemas });
    installParseWorker(scope, [pack]);

    scope.receive({
      type: 'parse',
      taskId: 4,
      name: 'demo.mid',
      blob: new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64])]),
    });
    await flush();

    const finishMessage = postsOfType(scope, 'finish').at(-1)?.message as { schemas?: unknown };
    // Every declared schema also carries the stamped `_src_file` provenance column.
    expect(finishMessage?.schemas).toEqual(
      packSchemas.map((schema) => ({
        ...schema,
        columns: [...schema.columns, { name: '_src_file', type: 'utf8', nullable: false }],
      })),
    );
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
          // The stamped `_src_file` column is absent from the fake pack's schemas() above, but
          // deriveColumns forces it to non-nullable since the provenance column is always populated.
          { name: '_src_file', type: 'Utf8', nullable: false },
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
      {
        name: 'events',
        rowCount: totalBatches,
        columns: [
          { name: 'id', type: 'Int32', nullable: false },
          { name: '_src_file', type: 'Utf8', nullable: false },
        ],
      },
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

  it('stamps every batch with _src_file and extends finish schemas with the _src_file column', async () => {
    const scope = new FakeWorkerScope();
    const eventsIpc = arrowIpc([1, 2, 3]);
    const pack = fakePack({
      schemas: () => [{ name: 'events', columns: [{ name: 'value', type: 'int32', nullable: false }] }],
      open: () => {
        const batches: BatchTransfer[] = [{ table: 'events', ipc: eventsIpc, rowCount: 3 }];
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
      taskId: 13,
      name: 'capture (2).pcap',
      blob: new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64])]),
    });
    await flush();

    const batchMessage = postsOfType(scope, 'batch').at(-1)?.message as { ipc: Uint8Array } | undefined;
    const stampedTable = ipcToTable(batchMessage!.ipc);
    expect(stampedTable.schema.fields.map((field) => field.name)).toEqual(['value', '_src_file']);
    expect([0, 1, 2].map((row) => stampedTable.getChild('_src_file')!.get(row))).toEqual([
      'capture (2).pcap',
      'capture (2).pcap',
      'capture (2).pcap',
    ]);

    const finishMessage = postsOfType(scope, 'finish').at(-1)?.message as
      { schemas?: readonly TableSchema[] } | undefined;
    expect(finishMessage?.schemas?.[0]?.columns.at(-1)).toEqual({
      name: '_src_file',
      type: 'utf8',
      nullable: false,
    });
  });
});
