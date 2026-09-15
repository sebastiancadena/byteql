import {
  ipcToTable,
  tableToIpc,
  type BatchTransfer,
  type FormatPack,
  type ParseProgress as PackProgress,
  type TableOverview,
  type TableSchema,
} from '@byteql/core';
import {
  QUERY_INITIAL_ROWS,
  QUERY_PAGE_ROWS,
  QUERY_RESULT_MEMORY_BYTES,
  type ByteqlDatabase,
  type IngestOptions,
  type IngestSession,
  type QueryPage,
  type QueryPageSummary,
  type QueryResultView,
  type QuerySession,
  type QueryStatus,
  type TableSummary,
} from '@byteql/db';
import { RecordBatch, Table, tableFromArrays } from 'apache-arrow';
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
import type { CsvClientPort } from '../export/csv-client.js';
import type { ExportDestination } from '../export/destination.js';
import type { ExportDestinationFactory } from '../export/operation.js';
import {
  BATCH_CREDIT_WINDOW,
  installParseWorker,
  type ParseWorkerScope,
} from '../../workers/parse.worker.js';
import { SessionController } from './controller.js';
import type { SampleId } from './samples.js';
import { initialSessionState } from './state.js';

const {
  sweepQueryPageOrphansMock,
  sweepSpillOrphansMock,
  queryInitialRows,
  queryPageRows,
  queryResultMemoryBytes,
} = vi.hoisted(() => ({
  sweepQueryPageOrphansMock: vi.fn().mockResolvedValue(undefined),
  sweepSpillOrphansMock: vi.fn().mockResolvedValue(undefined),
  queryInitialRows: 1_024,
  queryPageRows: 8_192,
  queryResultMemoryBytes: 64 * 1024 * 1024,
}));
vi.mock('@byteql/db', () => ({
  QUERY_INITIAL_ROWS: queryInitialRows,
  QUERY_PAGE_ROWS: queryPageRows,
  QUERY_RESULT_MEMORY_BYTES: queryResultMemoryBytes,
  sweepQueryPageOrphans: sweepQueryPageOrphansMock,
  sweepSpillOrphans: sweepSpillOrphansMock,
  isSupportedParquetType: () => true,
  unsupportedParquetTypeMessage: (column: string, type: unknown) =>
    `Column "${column}" has unsupported Parquet type ${String(type)}.`,
  // The real policy is exercised in the db package and in result-sort.test.ts; here every schema
  // is eligible so these tests are about the controller's coordination, not its type rules.
  resultSortEligibility: () => ({ supported: true }),
}));

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

const nextTask = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
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

const rangeValues = (count: number, start = 0): number[] =>
  Array.from({ length: count }, (_, offset) => start + offset);

const page = (index: number, startRow: number, values: readonly number[]): QueryPage => ({
  index,
  startRow,
  rowCount: values.length,
  table: tableFromArrays({ value: Int32Array.from(values) }),
});

class FakeQuerySession implements QuerySession {
  readonly schema = tableFromArrays({ value: Int32Array.from([0]) }).schema;
  readonly fetchCalls: number[] = [];
  readonly readCalls: number[] = [];
  pagesValue: QueryPageSummary[] = [];
  nextPages: QueryPage[] = [page(0, 0, rangeValues(QUERY_INITIAL_ROWS))];
  complete = false;
  completeAfterPage = false;
  disposed = 0;
  cancelled = 0;
  retryPage: QueryPage | null = null;
  fetchError: Error | null = null;
  retryError: Error | null = null;
  readError: Error | null = null;
  readGate: Promise<void> | null = null;
  materializeValue: Table | null | undefined;
  readonly materializeCalls: Array<number | undefined> = [];
  readonly fetched = new Map<number, QueryPage>();
  fetchGate: Promise<void> | null = null;

  async fetchNext(targetRows = QUERY_PAGE_ROWS): Promise<QueryPage | null> {
    this.fetchCalls.push(targetRows);
    if (this.fetchGate) await this.fetchGate;
    if (this.fetchError) {
      const error = this.fetchError;
      this.fetchError = null;
      if (!error.message.includes('RESULT_SPILL_QUOTA_EXCEEDED')) this.cancelled += 1;
      throw error;
    }
    const nextPage = this.nextPages.shift() ?? null;
    if (nextPage) {
      this.fetched.set(nextPage.index, nextPage);
      this.pagesValue.push({
        index: nextPage.index,
        startRow: nextPage.startRow,
        rowCount: nextPage.rowCount,
      });
      if (this.completeAfterPage) this.complete = true;
    } else {
      this.complete = true;
    }
    return nextPage;
  }

  status(): QueryStatus {
    return {
      loadedRows: this.pagesValue.reduce((sum, summary) => sum + summary.rowCount, 0),
      complete: this.complete,
      elapsedMs: 2,
      storedBytes: 0,
      decodedBytes: 0,
      sendCount: 1,
    };
  }

  pages(): readonly QueryPageSummary[] {
    return this.pagesValue;
  }

  pinPages(): void {}

  async retryPending(): Promise<QueryPage> {
    if (this.retryError) throw this.retryError;
    if (!this.retryPage) throw new Error('no pending page');
    const retryPage = this.retryPage;
    this.retryPage = null;
    this.fetched.set(retryPage.index, retryPage);
    this.pagesValue.push({
      index: retryPage.index,
      startRow: retryPage.startRow,
      rowCount: retryPage.rowCount,
    });
    return retryPage;
  }

  async readPage(index: number): Promise<QueryPage> {
    this.readCalls.push(index);
    if (this.readGate) {
      const gate = this.readGate;
      this.readGate = null;
      await gate;
    }
    if (this.readError) {
      const error = this.readError;
      this.readError = null;
      throw error;
    }
    const stored = this.fetched.get(index);
    if (!stored) throw new Error(`missing page ${index}`);
    return stored;
  }

  async materialize(maxBytes?: number): Promise<Table | null> {
    this.materializeCalls.push(maxBytes);
    if (this.materializeValue !== undefined) return this.materializeValue;
    if (!this.complete) return null;
    const pages = [...this.fetched.values()].sort((left, right) => left.index - right.index);
    return pages.length === 0
      ? null
      : pages[0]!.table.concat(...pages.slice(1).map((stored) => stored.table));
  }

  async cancel(): Promise<boolean> {
    this.cancelled += 1;
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

class FakeCsvClient implements CsvClientPort {
  initialize = vi.fn().mockResolvedValue(undefined);
  dispose = vi.fn().mockResolvedValue(undefined);
  encode = vi.fn(
    async (
      ipc: Uint8Array,
      _columns: readonly number[],
      _header: boolean,
      write: (chunk: Uint8Array) => Promise<void>,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
      await write(ipc);
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
    },
  );
}

class FakeDestination implements ExportDestination {
  readonly chunks: Uint8Array[] = [];
  commits = 0;
  aborts = 0;
  disposals = 0;
  saves = 0;
  commitResult: 'saved' | 'ready-to-save' = 'saved';
  abortGate: Promise<void> | null = null;
  commitGate: Promise<void> | null = null;

  async write(bytes: Uint8Array): Promise<void> {
    this.chunks.push(bytes.slice());
  }

  async commit(): Promise<'saved' | 'ready-to-save'> {
    this.commits += 1;
    if (this.commitGate) await this.commitGate;
    return this.commitResult;
  }

  save(): void {
    this.saves += 1;
  }

  async abort(): Promise<void> {
    this.aborts += 1;
    if (this.abortGate) await this.abortGate;
  }

  async dispose(): Promise<void> {
    this.disposals += 1;
  }
}

/**
 * The real `BrowserDatabase.beginIngest` throws 'An ingest session is already open.' while a
 * prior session's `finalize()`/`abort()` hasn't resolved yet (`activeIngest` only clears in that
 * call's `onSettled`) — this fake enforces the identical invariant, so controller tests exercise
 * the real race instead of a laxer stand-in that always allows a second `beginIngest` through.
 */
const fakeDatabase = (): {
  database: ByteqlDatabase;
  sessions: FakeIngestSession[];
  querySessions: FakeQuerySession[];
} => {
  const sessions: FakeIngestSession[] = [];
  const querySessions: FakeQuerySession[] = [];
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
    startQuery: vi.fn(async () => {
      const session = new FakeQuerySession();
      querySessions.push(session);
      return session;
    }),
    exportParquet: vi.fn(),
    createSortedView: vi.fn(),
    resultSortCapability: vi.fn(() => ({ supported: true as const })),
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
  return { database, sessions, querySessions };
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
  let querySessions: FakeQuerySession[];
  let stopViewer: ReturnType<typeof vi.fn<() => void>>;
  let csvClient: FakeCsvClient;
  let destinations: FakeDestination[];
  let prepareDestination: ReturnType<
    typeof vi.fn<(filename: string, format: 'csv' | 'parquet') => Promise<ExportDestination>>
  >;

  beforeEach(() => {
    sweepSpillOrphansMock.mockClear();
    parser = new FakeParser();
    ({ database, sessions, querySessions } = fakeDatabase());
    stopViewer = vi.fn<() => void>();
    csvClient = new FakeCsvClient();
    destinations = [];
    prepareDestination = vi.fn(async () => {
      const destination = new FakeDestination();
      destinations.push(destination);
      return destination;
    });
  });

  const readyController = async (
    destinationFactory: ExportDestinationFactory = prepareDestination,
  ): Promise<SessionController> => {
    const controller = new SessionController({
      database,
      parser,
      csvClient,
      prepareDestination: destinationFactory,
      stopViewer,
    });
    const opening = controller.openFile(midiFile('query.mid', 1));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'events', rowCount: 30_000 }];
    parser.calls[0]!.finish(streamedResult('events', 30_000));
    await resolveFilesAppend(sessions[0]!);
    await opening;
    return controller;
  };

  it('initializes and disposes the CSV client with the controller lifecycle', async () => {
    const ready = deferred<void>();
    csvClient.initialize.mockReturnValueOnce(ready.promise);
    const controller = new SessionController({
      database,
      parser,
      csvClient,
      prepareDestination,
      stopViewer,
    });

    let initialized = false;
    const initialization = controller.initialize().then(() => {
      initialized = true;
    });
    await flush();
    expect(initialized).toBe(false);

    ready.resolve(undefined);
    await initialization;
    expect(csvClient.initialize).toHaveBeenCalledOnce();

    await controller.dispose();
    expect(csvClient.dispose).toHaveBeenCalledOnce();
  });

  it('releases the CSV client exactly once when initialization fails and disposal follows', async () => {
    csvClient.initialize.mockRejectedValueOnce(new Error('CSV startup failed'));
    const controller = new SessionController({
      database,
      parser,
      csvClient,
      prepareDestination,
      stopViewer,
    });

    await expect(controller.initialize()).rejects.toThrow('CSV startup failed');
    await controller.dispose();

    expect(csvClient.dispose).toHaveBeenCalledOnce();
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it('exports the captured result pages as CSV once and preserves the visible window and selection', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    query.nextPages.push(page(1, 1_024, [1_024, 1_025]));
    controller.selectResultRow(500);
    const before = controller.getState().result!;

    await controller.downloadResults({ format: 'csv', includeProvenance: true });

    expect(prepareDestination).toHaveBeenCalledWith('query-results.csv', 'csv');
    expect(query.fetchCalls).toEqual([QUERY_INITIAL_ROWS, QUERY_PAGE_ROWS, QUERY_PAGE_ROWS]);
    expect(csvClient.encode.mock.calls.map((call) => call[2])).toEqual([true, false]);
    expect(query.materializeCalls).toEqual([]);
    expect(controller.getState().result).toMatchObject({
      complete: true,
      loadedRows: 1_026,
      windowStart: before.windowStart,
      window: before.window,
    });
    expect(controller.getState().selectedRow).toBe(500);
    expect(controller.getState().download).toMatchObject({
      phase: 'saved',
      rows: 1_026,
      totalRows: 1_026,
    });
    expect(destinations[0]!.commits).toBe(1);
  });

  it('cancels an export waiting for existing result demand without cancelling the query or committing', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    const gate = deferred<void>();
    query.fetchGate = gate.promise;
    query.nextPages.push(page(1, 1_024, [1_024]));

    const demand = controller.loadMoreResults();
    const download = controller.downloadResults({ format: 'csv', includeProvenance: true });
    const cancellation = controller.cancelResultsDownload();
    expect(controller.getState().download?.phase).toBe('cancelling');

    gate.resolve(undefined);
    await Promise.all([demand, download, cancellation]);

    expect(query.cancelled).toBe(0);
    expect(query.disposed).toBe(0);
    expect(await query.readPage(0)).toMatchObject({ rowCount: QUERY_INITIAL_ROWS });
    expect(destinations[0]!.commits).toBe(0);
    expect(controller.getState().download?.phase).toBe('cancelled');
  });

  it('settles joined demand before export cleanup and closes a query only after sink abort', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    const fetchGate = deferred<void>();
    const abortGate = deferred<void>();
    const order: string[] = [];
    query.fetchGate = fetchGate.promise;
    query.nextPages.push(page(1, 1_024, [1_024]));
    query.readError = new Error('stored result page could not be read');
    vi.spyOn(query, 'dispose').mockImplementation(async () => {
      query.disposed += 1;
      order.push('query cleanup');
    });
    prepareDestination.mockImplementationOnce(async () => {
      const destination = new FakeDestination();
      destination.abortGate = abortGate.promise;
      vi.spyOn(destination, 'abort').mockImplementation(async () => {
        destination.aborts += 1;
        await abortGate.promise;
        order.push('sink abort');
      });
      destinations.push(destination);
      return destination;
    });

    const demand = controller.loadMoreResults().then(() => {
      order.push('demand');
    });
    const download = controller.downloadResults({ format: 'csv', includeProvenance: true }).then(() => {
      order.push('download');
    });
    fetchGate.resolve(undefined);

    await vi.waitFor(() => expect(destinations[0]?.aborts).toBe(1));
    await expect(demand).resolves.toBeUndefined();
    expect(controller.getState().result).toMatchObject({
      pageError: 'stored result page could not be read Run the query again to load more rows.',
      pageErrorRetryable: false,
    });
    expect(order).toEqual(['demand']);
    expect(query.disposed).toBe(0);

    abortGate.resolve(undefined);
    await expect(download).resolves.toBeUndefined();
    await vi.waitFor(() => expect(query.disposed).toBe(1));

    expect(order).toEqual(['demand', 'sink abort', 'download', 'query cleanup']);
  });

  it('suspends new tail demand synchronously when download starts', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    const fetchGate = deferred<void>();
    query.fetchGate = fetchGate.promise;
    query.nextPages.push(page(1, 1_024, [1_024]));

    const download = controller.downloadResults({ format: 'csv', includeProvenance: true });
    const gridDemand = controller.loadMoreResults();

    expect(controller.getState().result?.loadingMore).toBe(false);
    await gridDemand;
    fetchGate.resolve(undefined);
    await download;
    expect(query.fetchCalls).toEqual([QUERY_INITIAL_ROWS, QUERY_PAGE_ROWS, QUERY_PAGE_ROWS]);
  });

  it('waits for export sink abort before disposing a query on replacement', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    const abortGate = deferred<void>();
    prepareDestination.mockImplementationOnce(async () => {
      const destination = new FakeDestination();
      destination.abortGate = abortGate.promise;
      destinations.push(destination);
      return destination;
    });
    const fetchGate = deferred<void>();
    query.fetchGate = fetchGate.promise;

    const download = controller.downloadResults({ format: 'csv', includeProvenance: true });
    await vi.waitFor(() => expect(destinations).toHaveLength(1));
    const replacement = controller.runQuery('select 2');
    fetchGate.resolve(undefined);
    await flush();
    expect(destinations[0]!.aborts).toBe(1);
    expect(query.disposed).toBe(0);

    abortGate.resolve(undefined);
    await Promise.all([download, replacement]);
    expect(query.disposed).toBe(1);
  });

  it('invokes the destination factory synchronously and aborts a picker result acquired after replacement', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    const picker = deferred<ExportDestination>();
    prepareDestination.mockReturnValueOnce(picker.promise);

    const download = controller.downloadResults({ format: 'csv', includeProvenance: true });
    expect(prepareDestination).toHaveBeenCalledOnce();

    const replacement = controller.runQuery('select 2');
    await flush();
    expect(query.disposed).toBe(0);

    const lateDestination = new FakeDestination();
    picker.resolve(lateDestination);
    await Promise.all([download, replacement]);

    expect(lateDestination.aborts).toBe(1);
    expect(lateDestination.disposals).toBe(1);
    expect(lateDestination.commits).toBe(0);
    expect(query.disposed).toBe(1);
  });

  it('encodes a zero-row CSV once with the captured schema and header enabled', async () => {
    const query = new FakeQuerySession();
    query.nextPages = [];
    vi.mocked(database.startQuery).mockImplementationOnce(async () => {
      querySessions.push(query);
      return query;
    });
    const controller = await readyController();
    await controller.runQuery('select value from events where false');

    await controller.downloadResults({ format: 'csv', includeProvenance: true });

    expect(csvClient.encode).toHaveBeenCalledOnce();
    expect(csvClient.encode.mock.calls[0]![2]).toBe(true);
    expect(ipcToTable(csvClient.encode.mock.calls[0]![0]).schema.fields.map((field) => field.name)).toEqual([
      'value',
    ]);
    expect(controller.getState().download).toMatchObject({ phase: 'saved', rows: 0, totalRows: 0 });
  });

  it('exports a complete result through Parquet and disposes the owned artifact after streaming', async () => {
    const query = new FakeQuerySession();
    query.completeAfterPage = true;
    vi.mocked(database.startQuery).mockImplementationOnce(async () => {
      querySessions.push(query);
      return query;
    });
    const disposeArtifact = vi.fn().mockResolvedValue(undefined);
    vi.mocked(database.exportParquet).mockResolvedValueOnce({
      file: new File([Uint8Array.of(1, 2, 3)], 'result.parquet'),
      dispose: disposeArtifact,
    });
    const controller = await readyController();
    await controller.runQuery('select * from events');

    await controller.downloadResults({ format: 'parquet', includeProvenance: true });

    expect(database.exportParquet).toHaveBeenCalledWith(
      query,
      expect.objectContaining({ columns: [0], signal: expect.any(AbortSignal) }),
    );
    expect(destinations[0]!.chunks).toEqual([Uint8Array.of(1, 2, 3)]);
    expect(disposeArtifact).toHaveBeenCalledOnce();
    expect(controller.getState().download).toMatchObject({ phase: 'saved', bytes: 3 });
  });

  it('retains a fallback destination for synchronous Save until dismissal', async () => {
    prepareDestination.mockImplementationOnce(async () => {
      const destination = new FakeDestination();
      destination.commitResult = 'ready-to-save';
      destinations.push(destination);
      return destination;
    });
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    query.nextPages = [];

    await controller.downloadResults({ format: 'csv', includeProvenance: true });
    expect(controller.getState().download?.phase).toBe('ready-to-save');
    expect(destinations[0]!.disposals).toBe(0);

    controller.saveResultsDownload();
    expect(destinations[0]!.saves).toBe(1);
    expect(controller.getState().download?.phase).toBe('saved');

    await controller.dismissResultsDownload();
    expect(destinations[0]!.disposals).toBe(1);
    expect(controller.getState().download).toBeNull();
  });

  it('invokes a second picker immediately and disposes the retained fallback before re-exporting', async () => {
    prepareDestination.mockImplementationOnce(async () => {
      const destination = new FakeDestination();
      destination.commitResult = 'ready-to-save';
      destinations.push(destination);
      return destination;
    });
    const controller = await readyController();
    await controller.runQuery('select * from events');
    querySessions[0]!.nextPages = [];
    await controller.downloadResults({ format: 'csv', includeProvenance: true });

    const second = controller.downloadResults({ format: 'csv', includeProvenance: true });
    expect(prepareDestination).toHaveBeenCalledTimes(2);
    await second;

    expect(destinations[0]!.disposals).toBe(1);
    expect(destinations[1]!.commits).toBe(1);
    expect(controller.getState().download?.phase).toBe('saved');
  });

  it('routes result-store quota failure to the existing retry path and leaves the query readable', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    query.fetchError = new Error('RESULT_SPILL_QUOTA_EXCEEDED: local result storage is full.');
    query.retryPage = page(1, 1_024, [1_024]);

    await controller.downloadResults({ format: 'csv', includeProvenance: true });

    expect(controller.getState().result).toMatchObject({
      loadedRows: 1_024,
      pageErrorRetryable: true,
    });
    expect(controller.getState().download).toMatchObject({
      phase: 'failed',
      message: 'Local result storage is full. Free local storage, then retry loading rows.',
    });
    expect(query.cancelled).toBe(0);
    expect(query.disposed).toBe(0);

    await controller.retryResultPage();
    expect(controller.getState().result).toMatchObject({ loadedRows: 1_025, pageError: null });
  });

  it('treats picker dismissal as cancellation without an unhandled rejection', async () => {
    prepareDestination.mockRejectedValueOnce(new DOMException('dismissed', 'AbortError'));
    const controller = await readyController();
    await controller.runQuery('select * from events');

    await expect(
      controller.downloadResults({ format: 'csv', includeProvenance: true }),
    ).resolves.toBeUndefined();
    expect(controller.getState().download).toMatchObject({ phase: 'cancelled' });
  });

  it('observes a rejected second picker while prior export cleanup is still held', async () => {
    let pickerCalls = 0;
    let secondPicker: Promise<ExportDestination> | null = null;
    const fetchGate = deferred<void>();
    const abortGate = deferred<void>();
    const controller = await readyController(() => {
      pickerCalls += 1;
      if (secondPicker) return secondPicker;
      const destination = new FakeDestination();
      destination.abortGate = abortGate.promise;
      destinations.push(destination);
      return Promise.resolve(destination);
    });
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    query.fetchGate = fetchGate.promise;

    const first = controller.downloadResults({ format: 'csv', includeProvenance: true });
    await vi.waitFor(() => expect(destinations).toHaveLength(1));
    await vi.waitFor(() => expect(controller.getState().download?.phase).toBe('loading'));

    const dismissed = new DOMException('dismissed', 'AbortError');
    secondPicker = Promise.reject(dismissed);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    const existing = process.listeners('unhandledRejection');
    existing.forEach((listener) => process.off('unhandledRejection', listener));
    process.on('unhandledRejection', onRejection);
    try {
      const second = controller.downloadResults({ format: 'csv', includeProvenance: true });
      expect(pickerCalls).toBe(2);
      await nextTask();
      const rejectionsBeforeCleanup = [...rejections];

      abortGate.resolve(undefined);
      fetchGate.resolve(undefined);
      await Promise.all([first, second]);
      await nextTask();
      expect(rejectionsBeforeCleanup).toEqual([]);
      expect(controller.getState().download).toMatchObject({ phase: 'cancelled' });
    } finally {
      process.off('unhandledRejection', onRejection);
      existing.forEach((listener) => process.on('unhandledRejection', listener as (reason: unknown) => void));
    }
  });

  it('cancels encoding without cancelling the query and aborts the destination once', async () => {
    const encodeStarted = deferred<void>();
    csvClient.encode.mockImplementationOnce(
      (_ipc, _columns, _header, _write, signal) =>
        new Promise<void>((_resolve, reject) => {
          encodeStarted.resolve(undefined);
          signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {
            once: true,
          });
        }),
    );
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    query.nextPages = [];

    const download = controller.downloadResults({ format: 'csv', includeProvenance: true });
    await encodeStarted.promise;
    await Promise.all([download, controller.cancelResultsDownload()]);

    expect(query.cancelled).toBe(0);
    expect(query.disposed).toBe(0);
    expect(destinations[0]!.aborts).toBe(1);
    expect(destinations[0]!.commits).toBe(0);
    expect(controller.getState().download?.phase).toBe('cancelled');
  });

  it('waits for an already-started destination commit before disposing a completed query', async () => {
    const query = new FakeQuerySession();
    query.completeAfterPage = true;
    vi.mocked(database.startQuery).mockImplementationOnce(async () => {
      querySessions.push(query);
      return query;
    });
    const commitGate = deferred<void>();
    prepareDestination.mockImplementationOnce(async () => {
      const destination = new FakeDestination();
      destination.commitGate = commitGate.promise;
      destinations.push(destination);
      return destination;
    });
    const controller = await readyController();
    await controller.runQuery('select * from events');

    const download = controller.downloadResults({ format: 'csv', includeProvenance: true });
    await vi.waitFor(() => expect(destinations[0]?.commits).toBe(1));
    const replacement = controller.runQuery('select 2');
    await flush();
    expect(query.disposed).toBe(0);

    commitGate.resolve(undefined);
    await Promise.all([download, replacement]);
    expect(destinations[0]!.aborts).toBe(1);
    expect(query.disposed).toBe(1);
  });

  it('fetches the midi sample lazily on open and caches it across opens', async () => {
    const sample = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 1, 2, 3]);
    const fetchSample = vi.fn().mockResolvedValue(new Response(sample));
    const controller = new SessionController({
      database,
      parser,
      csvClient,
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

  it('opens the pcap sample as a three-file batch', async () => {
    const sample = new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1, 1, 2, 3]);
    // A fresh Response per call: three distinct urls are fetched, and a Response body can only be read once.
    const fetchSample = vi.fn().mockImplementation(() => Promise.resolve(new Response(sample)));
    const controller = new SessionController({
      database,
      parser,
      csvClient,
      fetch: fetchSample,
      sampleUrlOverrides: {
        pcap: ['/assets/SkypeIRC.cap', '/assets/v6.pcap', '/assets/dns-stream.pcap'],
      },
      stopViewer,
    });
    await controller.initialize();

    const opening = controller.openSample('pcap');
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    expect(fetchSample).toHaveBeenCalledTimes(3);
    expect(parser.calls[0]!.name).toBe('SkypeIRC.cap');
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'packets', rowCount: 3 }];
    parser.calls[0]!.finish(streamedResult('packets', 1));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    expect(parser.calls[1]!.name).toBe('v6.pcap');
    parser.calls[1]!.finish(streamedResult('packets', 1));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(3));
    expect(parser.calls[2]!.name).toBe('dns-stream.pcap');
    parser.calls[2]!.finish(streamedResult('packets', 1));
    await resolveFilesAppend(sessions[0]!);
    await opening;
  });

  it('rejects openSample with an unknown sample id', async () => {
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
    await controller.initialize();

    await expect(controller.openSample('bogus' as SampleId)).rejects.toThrow(/unknown sample/i);
  });

  it('rejects opening a bundled sample when the fetch response is not ok', async () => {
    const fetchSample = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const controller = new SessionController({
      database,
      parser,
      csvClient,
      fetch: fetchSample,
      sampleUrlOverrides: { midi: ['/assets/fur_Elise_opening.mid'] },
      stopViewer,
    });
    await controller.initialize();

    await expect(controller.openSample('midi')).rejects.toThrow(/could not be loaded/i);
  });

  it('publishes UI-safe source metadata and progress without exposing the file', async () => {
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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

  it('publishes the first page without draining the cursor', async () => {
    const controller = await readyController();

    await controller.runQuery('select * from events');
    const query = querySessions[0]!;

    expect(query.fetchCalls).toEqual([QUERY_INITIAL_ROWS]);
    expect(controller.getState().result).toMatchObject({ loadedRows: 1_024, complete: false });
    expect(database.startQuery).toHaveBeenCalledExactlyOnceWith('select * from events');
  });

  it('coalesces repeated tail demand into one fetch and appends global rows once', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    const gate = deferred<void>();
    query.fetchGate = gate.promise;
    query.nextPages.push(page(1, 1_024, rangeValues(QUERY_PAGE_ROWS, 1_024)));

    const first = controller.loadMoreResults();
    const second = controller.loadMoreResults();
    expect(first).toBe(second);
    gate.resolve(undefined);
    await first;

    expect(query.fetchCalls.filter((rows) => rows === QUERY_PAGE_ROWS)).toHaveLength(1);
    expect(controller.getState().result).toMatchObject({ loadedRows: 9_216, complete: false });
  });

  it('loads an evicted prior window from stored pages without starting SQL again', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    query.nextPages.push(
      page(1, 1_024, rangeValues(8_192, 1_024)),
      page(2, 9_216, rangeValues(8_192, 9_216)),
      page(3, 17_408, rangeValues(8_192, 17_408)),
    );
    await controller.loadMoreResults();
    await controller.loadMoreResults();
    await controller.loadMoreResults();

    await controller.loadResultWindow(500);

    expect(database.startQuery).toHaveBeenCalledOnce();
    expect(query.readCalls).toContain(0);
    expect(controller.getState().result!.windowStart).toBe(0);
  });

  it('disposes a stale cursor and never publishes its late page', async () => {
    const controller = await readyController();
    await controller.runQuery('select 1');
    const firstQuery = querySessions[0]!;
    const firstGeneration = controller.getState().result!.generation;
    const gate = deferred<void>();
    firstQuery.fetchGate = gate.promise;
    firstQuery.nextPages.push(page(1, 1_024, rangeValues(8_192, 1_024)));

    const staleLoad = controller.loadMoreResults();
    const replacement = controller.runQuery('select 2');
    gate.resolve(undefined);
    await Promise.allSettled([staleLoad, replacement]);

    expect(firstQuery.disposed).toBe(1);
    expect(controller.getState().sql).toBe('select 2');
    expect(controller.getState().result).toMatchObject({ loadedRows: 1_024 });
    expect(controller.getState().result!.generation).not.toBe(firstGeneration);
  });

  it('retries the same pending storage page without advancing the cursor', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    const storedPage = page(1, 1_024, rangeValues(8_192, 1_024));
    query.fetchError = new Error('RESULT_SPILL_QUOTA_EXCEEDED: local result storage is full.');
    query.retryPage = storedPage;

    await controller.loadMoreResults();
    expect(controller.getState().result).toMatchObject({
      loadedRows: 1_024,
      pageError: 'Local result storage is full. Free local storage, then retry loading rows.',
      pageErrorRetryable: true,
    });

    await controller.retryResultPage();
    expect(query.fetchCalls).toEqual([QUERY_INITIAL_ROWS, QUERY_PAGE_ROWS]);
    expect(controller.getState().result).toMatchObject({
      loadedRows: 9_216,
      pageError: null,
      pageErrorRetryable: false,
    });
  });

  it('marks cursor failures terminal while retaining already loaded rows', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    query.fetchError = new Error('DuckDB cursor stopped unexpectedly.');

    await controller.loadMoreResults();

    expect(controller.getState().result).toMatchObject({
      loadedRows: 1_024,
      loadingMore: false,
      pageError: 'DuckDB cursor stopped unexpectedly. Run the query again to load more rows.',
      pageErrorRetryable: false,
    });
    expect(query.cancelled).toBe(1);
    expect(query.disposed).toBe(0);
  });

  it('stops an unsupported in-memory result with a narrower-SQL diagnostic', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    query.fetchError = new Error('RESULT_SPILL_UNSUPPORTED: page budget exceeded.');

    await controller.loadMoreResults();

    expect(controller.getState().result).toMatchObject({
      loadedRows: 1_024,
      loadingMore: false,
      pageError:
        'This browser cannot retain more local result pages. Narrow the SQL and run the query again.',
      pageErrorRetryable: false,
    });
    expect(query.cancelled).toBe(1);
    expect(query.disposed).toBe(0);
  });

  it('retains terminal pages so an earlier window can be restored', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    query.nextPages.push(
      page(1, 1_024, rangeValues(8_192, 1_024)),
      page(2, 9_216, rangeValues(8_192, 9_216)),
    );
    await controller.loadMoreResults();
    await controller.loadMoreResults();
    expect(controller.getState().result).toMatchObject({ loadedRows: 17_408 });

    query.fetchError = new Error('DuckDB cursor stopped unexpectedly.');
    await controller.loadMoreResults();

    expect(query.disposed).toBe(0);
    await controller.loadResultWindow(500);
    expect(query.readCalls).toContain(0);
    expect(controller.getState().result).toMatchObject({
      windowStart: 0,
      pageError: 'DuckDB cursor stopped unexpectedly. Run the query again to load more rows.',
      pageErrorRetryable: false,
    });
  });

  it('cancels demand without publishing its late page', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;
    const gate = deferred<void>();
    query.fetchGate = gate.promise;
    query.nextPages.push(page(1, 1_024, rangeValues(8_192, 1_024)));

    const demand = controller.loadMoreResults();
    await controller.cancel();
    gate.resolve(undefined);
    await demand;

    expect(query.cancelled).toBe(1);
    expect(query.disposed).toBe(1);
    expect(controller.getState().result).toMatchObject({
      loadedRows: 1_024,
      complete: false,
      loadingMore: false,
      pageError: 'Query result loading was cancelled. Run the query again to load more rows.',
      pageErrorRetryable: false,
    });
  });

  it('retains the previous incomplete window as a stopped static result after initial failure', async () => {
    const controller = await readyController();
    await controller.runQuery('select 7');
    const prior = controller.getState().result;
    vi.mocked(database.startQuery).mockRejectedValueOnce(new Error('syntax error'));

    await controller.runQuery('select broken');

    expect(querySessions[0]!.cancelled).toBe(1);
    expect(querySessions[0]!.disposed).toBe(1);
    expect(controller.getState()).toMatchObject({
      phase: 'ready',
      result: {
        window: prior!.window,
        loadedRows: 1_024,
        complete: false,
        pageError: 'Run the prior query again to load more rows.',
        pageErrorRetryable: false,
      },
      queryError: 'syntax error',
    });
  });

  it('materializes a complete result for viewers when it fits the bounded budget', async () => {
    const query = new FakeQuerySession();
    query.completeAfterPage = true;
    vi.mocked(database.startQuery).mockImplementationOnce(async () => {
      querySessions.push(query);
      return query;
    });
    const controller = await readyController();

    await controller.runQuery('select * from events');

    expect(controller.getState().result).toMatchObject({
      complete: true,
      completeTable: expect.objectContaining({ numRows: 1_024 }),
    });
    expect(query.materializeCalls).toEqual([QUERY_RESULT_MEMORY_BYTES]);
  });

  it('does not expose a complete table to viewers when materialization exceeds the budget', async () => {
    const query = new FakeQuerySession();
    query.completeAfterPage = true;
    query.materializeValue = null;
    vi.mocked(database.startQuery).mockImplementationOnce(async () => {
      querySessions.push(query);
      return query;
    });
    const controller = await readyController();

    await controller.runQuery('select * from wide_events');

    expect(controller.getState().result).toMatchObject({ complete: true, completeTable: null });
  });

  it('closes the active query before opening a replacement file', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;

    const opening = controller.openFile(midiFile('replacement.mid', 2));
    await vi.waitFor(() => expect(query.disposed).toBe(1));
    expect(query.cancelled).toBe(1);

    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[1]!.finalizeResult = [{ name: 'events', rowCount: 1 }];
    parser.calls[1]!.finish(streamedResult('events', 1));
    await resolveFilesAppend(sessions[1]!);
    await opening;
  });

  it('closes the active query exactly once during idempotent controller disposal', async () => {
    const controller = await readyController();
    await controller.runQuery('select * from events');
    const query = querySessions[0]!;

    await Promise.all([controller.dispose(), controller.dispose()]);

    expect(query.cancelled).toBe(1);
    expect(query.disposed).toBe(1);
  });

  it('propagates cancellation and disposes safely during initialization', async () => {
    const controller = new SessionController({
      database,
      parser,
      csvClient,
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
      csvClient,
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });

    await expect(controller.dispose()).resolves.toBeUndefined();
    expect(parser.dispose).toHaveBeenCalledOnce();
    expect(database.cancelQuery).toHaveBeenCalled();
    expect(database.dispose).toHaveBeenCalledOnce();
  });

  it('releases all state-held local data during idempotent disposal', async () => {
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
    const listener = vi.fn(() => {
      throw new Error('listener failed');
    });

    expect(() => controller.subscribe(listener)).toThrow('listener failed');
    controller.selectResultRow(null);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('opens a file through ingest: begin → per-batch append+ack → finalize → ready', async () => {
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
      csvClient,
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });

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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });

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
    const controllerA = new SessionController({
      database: databaseA,
      parser: parseFailure,
      csvClient,
      stopViewer,
    });
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
    const controllerB = new SessionController({
      database: databaseB,
      parser: quotaParser,
      csvClient,
      stopViewer,
    });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
      csvClient,
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
      csvClient,
      stopViewer,
    });

    await Promise.all([controller.initialize(), controller.initialize()]);

    expect(sweepSpillOrphansMock).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('progress dispatches bytes and openStartedAt enables rate computation', async () => {
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
      csvClient,
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
    await controller.openFiles([new File([new Uint8Array([0, 0, 0, 0])], 'junk.bin')]);

    expect(controller.getState().phase).toBe('failed');
    expect(database.beginIngest).not.toHaveBeenCalled();
  });

  it('progress events carry the batch position', async () => {
    const controller = new SessionController({ database, parser, csvClient, stopViewer });
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

  describe('result column sorting', () => {
    /**
     * A complete, immutable stand-in for a sorted view over `values`.
     *
     * It carries the BASE's schema object, exactly as the real writer does: an order commit
     * requires the schema to be unchanged, and identity is what proves that.
     */
    const sortedView = (
      values: readonly number[],
      schema = querySessions.at(-1)!.schema,
    ): QueryResultView & { disposed: number } => {
      const built = tableFromArrays({ value: Int32Array.from(values) });
      const table = new Table(
        schema,
        built.batches.map((batch) => new RecordBatch(schema, batch.data)),
      );
      const view = {
        disposed: 0,
        schema,
        status: () => ({
          loadedRows: values.length,
          complete: true,
          elapsedMs: 9,
          storedBytes: 1,
          decodedBytes: 1,
          sendCount: 1,
        }),
        pages: () => [{ index: 0, startRow: 0, rowCount: values.length }],
        readPage: async () => ({ index: 0, startRow: 0, rowCount: values.length, table }),
        pinPages: () => undefined,
        materialize: async () => table,
        dispose: async () => {
          view.disposed += 1;
        },
      };
      return view as unknown as QueryResultView & { disposed: number };
    };

    /**
     * A ready controller whose first query returned [3, 1] with [2] still unfetched — the shape
     * that proves a sort drains the rest before reordering.
     */
    const sortableController = async (): Promise<{
      controller: SessionController;
      base: FakeQuerySession;
    }> => {
      const controller = await readyController();
      const base = new FakeQuerySession();
      base.nextPages = [page(0, 0, [3, 1]), page(1, 2, [2])];
      vi.mocked(database.startQuery).mockImplementationOnce(async () => {
        querySessions.push(base);
        return base;
      });
      await controller.runQuery('select value from events');
      return { controller, base };
    };

    it('sorts the whole result without re-running the query or disposing the base', async () => {
      const { controller, base } = await sortableController();
      const sqlBefore = controller.getState().sql;
      const generation = controller.getState().result!.generation;
      controller.selectResultRow(0);
      const view = sortedView([1, 2, 3]);
      vi.mocked(database.createSortedView).mockResolvedValue(view);

      await controller.sortResults({ columnIndex: 0, direction: 'asc' });

      expect(database.startQuery).toHaveBeenCalledTimes(1);
      expect(database.createSortedView).toHaveBeenCalledWith(
        base,
        expect.objectContaining({ sort: { columnIndex: 0, direction: 'asc' } }),
      );
      expect(controller.getState().result).toMatchObject({
        generation,
        orderRevision: 1,
        complete: true,
        sort: { columnIndex: 0, direction: 'asc' },
      });
      expect(controller.getState().sql).toBe(sqlBefore);
      expect(controller.getState().selectedRow).toBeNull();
      expect(base.disposed).toBe(0);
      expect(base.cancelled).toBe(0);
      expect(Array.from(controller.getState().result!.window.getChildAt(0)!)).toEqual([1, 2, 3]);
    });

    it('drains the remaining rows first, so the order covers the whole result', async () => {
      const { controller, base } = await sortableController();
      expect(controller.getState().result!.complete).toBe(false);
      vi.mocked(database.createSortedView).mockImplementation(async () => {
        // The base must already be complete by the time the writer is asked for a view.
        expect(base.status().complete).toBe(true);
        expect(base.status().loadedRows).toBe(3);
        return sortedView([1, 2, 3]);
      });

      await controller.sortResults({ columnIndex: 0, direction: 'asc' });
      expect(database.createSortedView).toHaveBeenCalledOnce();
      expect(controller.getState().result!.loadedRows).toBe(3);
    });

    it('restores the original order from the retained base, disposing only the derived view', async () => {
      const { controller, base } = await sortableController();
      const view = sortedView([1, 2, 3]);
      vi.mocked(database.createSortedView).mockResolvedValue(view);
      await controller.sortResults({ columnIndex: 0, direction: 'asc' });
      const sendsBefore = vi.mocked(database.startQuery).mock.calls.length;

      await controller.sortResults(null);

      expect(vi.mocked(database.startQuery).mock.calls.length).toBe(sendsBefore);
      expect(database.createSortedView).toHaveBeenCalledOnce();
      expect(view.disposed).toBe(1);
      expect(base.disposed).toBe(0);
      expect(controller.getState().result).toMatchObject({ orderRevision: 2, sort: null });
      expect(Array.from(controller.getState().result!.window.getChildAt(0)!)).toEqual([3, 1, 2]);
    });

    it('does nothing when the requested order is the one already committed', async () => {
      const { controller } = await sortableController();
      vi.mocked(database.createSortedView).mockResolvedValue(sortedView([1, 2, 3]));
      await controller.sortResults({ columnIndex: 0, direction: 'asc' });
      controller.selectResultRow(1);

      await controller.sortResults({ columnIndex: 0, direction: 'asc' });

      expect(database.createSortedView).toHaveBeenCalledOnce();
      expect(controller.getState().result!.orderRevision).toBe(1);
      expect(controller.getState().selectedRow).toBe(1);
      expect(controller.getState().sorting).toBeNull();
    });

    it('never hands a sorted table to trusted viewers', async () => {
      const { controller } = await sortableController();
      await controller.drainQueryResult();
      const original = controller.getState().result!.completeTable;
      expect(original).not.toBeNull();
      vi.mocked(database.createSortedView).mockResolvedValue(sortedView([1, 2, 3]));

      await controller.sortResults({ columnIndex: 0, direction: 'asc' });
      expect(controller.getState().result!.completeTable).toBe(original);
      await controller.sortResults({ columnIndex: 0, direction: 'desc' });
      expect(controller.getState().result!.completeTable).toBe(original);
      await controller.sortResults(null);
      expect(controller.getState().result!.completeTable).toBe(original);
      expect(Array.from(original!.getChildAt(0)!)).toEqual([3, 1, 2]);
    });

    it('lets an in-flight window read finish first, then ignores reads made during the sort', async () => {
      const { controller, base } = await sortableController();
      await controller.drainQueryResult();
      const gate = deferred<void>();
      base.readGate = gate.promise;
      const inFlight = controller.loadResultWindow(2);
      vi.mocked(database.createSortedView).mockResolvedValue(sortedView([1, 2, 3]));

      // The sort waits for demand that was already running rather than racing it.
      const sorting = controller.sortResults({ columnIndex: 0, direction: 'asc' });
      expect(database.createSortedView).not.toHaveBeenCalled();
      gate.resolve();
      await inFlight;
      await sorting;

      // Once the sorted view is on display, reads go to it rather than back to the base. Demand
      // suppression DURING the sort is covered by the pending-sort test below.
      const readsBefore = base.readCalls.length;
      await controller.loadResultWindow(0);
      expect(base.readCalls.length).toBe(readsBefore);
      expect(controller.getState().result).toMatchObject({ orderRevision: 1 });
      expect(Array.from(controller.getState().result!.window.getChildAt(0)!)).toEqual([1, 2, 3]);
    });

    it('rejects a second sort while one is pending, and suspends demand meanwhile', async () => {
      const { controller } = await sortableController();
      const gate = deferred<QueryResultView>();
      vi.mocked(database.createSortedView).mockReturnValue(gate.promise);

      const first = controller.sortResults({ columnIndex: 0, direction: 'asc' });
      expect(controller.getState().sorting).toMatchObject({ requestId: 1 });
      await expect(controller.sortResults({ columnIndex: 0, direction: 'desc' })).rejects.toThrow(
        /already running/iu,
      );
      // Demand and selection are inert while the order is about to change.
      await controller.loadResultWindow(0);
      controller.selectResultRow(1);
      expect(controller.getState().selectedRow).toBeNull();

      gate.resolve(sortedView([1, 2, 3]));
      await first;
      expect(controller.getState().sorting).toBeNull();
    });

    it('cancels a sort without destroying the retained base or the visible order', async () => {
      const { controller, base } = await sortableController();
      await controller.drainQueryResult();
      const before = Array.from(controller.getState().result!.window.getChildAt(0)!);
      let observed: AbortSignal | null = null;
      vi.mocked(database.createSortedView).mockImplementation(
        (_base: unknown, options: { signal: AbortSignal }) =>
          new Promise<QueryResultView>((_resolve, reject) => {
            observed = options.signal;
            options.signal.addEventListener('abort', () =>
              reject(new DOMException('cancelled', 'AbortError')),
            );
          }),
      );

      const sorting = controller.sortResults({ columnIndex: 0, direction: 'asc' });
      await vi.waitFor(() => expect(observed).not.toBeNull());
      await controller.cancelResultSort();
      await sorting.catch(() => undefined);

      expect(base.cancelled).toBe(0);
      expect(base.disposed).toBe(0);
      expect(controller.getState().sorting).toBeNull();
      expect(controller.getState().result).toMatchObject({ orderRevision: 0, sort: null });
      expect(Array.from(controller.getState().result!.window.getChildAt(0)!)).toEqual(before);
    });

    it('cancels between page fetches while draining, leaving the base intact', async () => {
      const { controller, base } = await sortableController();
      const gate = deferred<void>();
      base.fetchGate = gate.promise;

      const sorting = controller.sortResults({ columnIndex: 0, direction: 'asc' });
      await vi.waitFor(() => expect(controller.getState().sorting).not.toBeNull());
      const cancelling = controller.cancelResultSort();
      gate.resolve();
      await Promise.allSettled([sorting, cancelling]);

      expect(base.cancelled).toBe(0);
      expect(base.disposed).toBe(0);
      expect(database.createSortedView).not.toHaveBeenCalled();
      expect(controller.getState().sorting).toBeNull();
    });

    it('keeps the previous order and reports the failure inline when the sort fails', async () => {
      const { controller, base } = await sortableController();
      await controller.drainQueryResult();
      vi.mocked(database.createSortedView).mockRejectedValue(new Error('local storage is full'));

      await controller.sortResults({ columnIndex: 0, direction: 'asc' }).catch(() => undefined);

      expect(controller.getState().sorting).toMatchObject({
        phase: 'failed',
        message: 'local storage is full',
      });
      expect(controller.getState().result).toMatchObject({ orderRevision: 0, sort: null });
      expect(base.disposed).toBe(0);

      // A failed sort must not block the next attempt.
      vi.mocked(database.createSortedView).mockResolvedValue(sortedView([1, 2, 3]));
      await controller.sortResults({ columnIndex: 0, direction: 'asc' });
      expect(controller.getState().result).toMatchObject({ orderRevision: 1 });
    });

    it('publishes the next query result after an order has been committed', async () => {
      const { controller } = await sortableController();
      await controller.drainQueryResult();
      vi.mocked(database.createSortedView).mockResolvedValue(sortedView([1, 2, 3]));
      await controller.sortResults({ columnIndex: 0, direction: 'asc' });
      expect(controller.getState().result).toMatchObject({ orderRevision: 1 });

      const replacement = new FakeQuerySession();
      replacement.nextPages = [page(0, 0, [7])];
      replacement.completeAfterPage = true;
      vi.mocked(database.startQuery).mockImplementationOnce(async () => {
        querySessions.push(replacement);
        return replacement;
      });
      await controller.runQuery('select 7 as other');

      // A committed order belongs to the result that committed it; the next query starts over in
      // its own query order rather than being fenced out by the previous result's revision.
      expect(controller.getState().result).toMatchObject({ orderRevision: 0, sort: null });
      expect(controller.getState().result!.loadedRows).toBe(1);
      expect(Array.from(controller.getState().result!.window.getChildAt(0)!)).toEqual([7]);
    });

    it('refuses to sort a result left visible after a failed query', async () => {
      const { controller } = await sortableController();
      await controller.drainQueryResult();
      vi.mocked(database.startQuery).mockRejectedValueOnce(new Error('syntax error'));
      await controller.runQuery('select bad');

      expect(controller.getState().result).not.toBeNull();
      await expect(controller.sortResults({ columnIndex: 0, direction: 'asc' })).rejects.toThrow(
        /run the query again/iu,
      );
      expect(database.createSortedView).not.toHaveBeenCalled();
      expect(controller.getState().result).not.toBeNull();
    });

    it('refuses to sort while a download owns the result', async () => {
      const { controller } = await sortableController();
      await controller.drainQueryResult();
      const download = controller.downloadResults({ format: 'csv', includeProvenance: true });
      await vi.waitFor(() => expect(controller.getState().download).not.toBeNull());

      await expect(controller.sortResults({ columnIndex: 0, direction: 'asc' })).rejects.toThrow(
        /download/iu,
      );
      await controller.cancelResultsDownload();
      await download.catch(() => undefined);
    });

    it('downloads the committed display order, without draining the derived view', async () => {
      const { controller, base } = await sortableController();
      await controller.drainQueryResult();
      vi.mocked(database.createSortedView).mockResolvedValue(sortedView([1, 2, 3]));
      await controller.sortResults({ columnIndex: 0, direction: 'asc' });
      const fetchesBefore = base.fetchCalls.length;

      await controller.downloadResults({ format: 'csv', includeProvenance: true });

      const encoded = csvClient.encode.mock.calls.map((call) => ipcToTable(call[0]));
      expect(encoded.flatMap((table) => Array.from(table.getChildAt(0)!))).toEqual([1, 2, 3]);
      // The derived view is complete by construction; asking its base for more rows would be
      // reaching past the order being exported.
      expect(base.fetchCalls.length).toBe(fetchesBefore);
      expect(controller.getState().download).toMatchObject({ phase: 'saved' });
    });

    it('drains the original view exactly once when downloading in query order', async () => {
      const { controller, base } = await sortableController();
      expect(controller.getState().result!.complete).toBe(false);

      await controller.downloadResults({ format: 'csv', includeProvenance: true });

      expect(base.status().complete).toBe(true);
      const encoded = csvClient.encode.mock.calls.map((call) => ipcToTable(call[0]));
      expect(encoded.flatMap((table) => Array.from(table.getChildAt(0)!))).toEqual([3, 1, 2]);
      expect(base.fetchCalls.length).toBeGreaterThan(0);
    });

    it('refuses to start a download while a sort owns the result', async () => {
      const { controller } = await sortableController();
      await controller.drainQueryResult();
      const gate = deferred<QueryResultView>();
      vi.mocked(database.createSortedView).mockReturnValue(gate.promise);
      const sorting = controller.sortResults({ columnIndex: 0, direction: 'asc' });
      await vi.waitFor(() => expect(controller.getState().sorting).not.toBeNull());

      await controller.downloadResults({ format: 'csv', includeProvenance: true });
      expect(controller.getState().download).toMatchObject({ phase: 'failed' });
      expect(prepareDestination).not.toHaveBeenCalled();

      gate.resolve(sortedView([1, 2, 3]));
      await sorting;
    });

    it('releases a ready-to-save artifact built from the previous order', async () => {
      const { controller } = await sortableController();
      await controller.drainQueryResult();
      vi.mocked(database.createSortedView).mockResolvedValue(sortedView([1, 2, 3]));
      await controller.downloadResults({ format: 'csv', includeProvenance: true });
      expect(controller.getState().download).not.toBeNull();

      await controller.sortResults({ columnIndex: 0, direction: 'asc' });

      // An obsolete file built from the old order must not still be offered for saving.
      expect(controller.getState().download).toBeNull();
    });

    it.each([
      ['a replacement query', (controller: SessionController) => controller.runQuery('select 2')],
      ['a file open', (controller: SessionController) => controller.openFile(midiFile('next.mid', 2))],
      ['disposal', (controller: SessionController) => controller.dispose()],
    ])('invalidates a pending sort when %s takes over', async (_label, takeOver) => {
      const { controller } = await sortableController();
      await controller.drainQueryResult();
      const gate = deferred<QueryResultView>();
      const view = sortedView([1, 2, 3]);
      vi.mocked(database.createSortedView).mockReturnValue(gate.promise);

      const sorting = controller.sortResults({ columnIndex: 0, direction: 'asc' });
      await vi.waitFor(() => expect(database.createSortedView).toHaveBeenCalled());
      // The takeover is not awaited: a file open needs its parse driven, and what matters here is
      // that it invalidates the sort the moment it starts.
      void takeOver(controller).catch(() => undefined);
      gate.resolve(view);
      await sorting.catch(() => undefined);

      // The late view is released rather than published over a family that has moved on.
      expect(view.disposed).toBe(1);
    });
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
