import type { TableSchema } from '@byteql/core';
import { Table } from 'apache-arrow';
import {
  Int32 as DuckdbInt32,
  Table as DuckdbTable,
  Utf8 as DuckdbUtf8,
  tableToIPC as duckdbTableToIPC,
  vectorFromArray as duckdbVectorFromArray,
} from 'apache-arrow-duckdb';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const duckdbMocks = vi.hoisted(() => {
  const connection = {
    query: vi.fn(),
    send: vi.fn(),
    insertArrowFromIPCStream: vi.fn(),
    cancelSent: vi.fn(),
    close: vi.fn(),
  };
  const database = {
    instantiate: vi.fn(),
    connect: vi.fn(),
    terminate: vi.fn(),
    registerOPFSFileName: vi.fn(),
    collectFileStatistics: vi.fn(),
    exportFileStatistics: vi.fn(),
  };

  return {
    connection,
    database,
    selectBundle: vi.fn(),
    AsyncDuckDB: vi.fn(),
    VoidLogger: vi.fn(),
  };
});

vi.mock('@duckdb/duckdb-wasm', () => ({
  AsyncDuckDB: class {
    constructor(...args: unknown[]) {
      duckdbMocks.AsyncDuckDB(...args);
      return duckdbMocks.database;
    }
  },
  selectBundle: duckdbMocks.selectBundle,
  VoidLogger: class {
    constructor() {
      return duckdbMocks.VoidLogger();
    }
  },
}));

// Real spillPath/isQuotaError logic is exercised as-is; only deleteSpillGeneration and
// deleteSpillChunks are spied on so tests can assert OPFS cleanup without touching real OPFS APIs.
vi.mock('./spill-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./spill-files.js')>();
  return {
    ...actual,
    deleteSpillGeneration: vi.fn().mockResolvedValue(undefined),
    deleteSpillChunks: vi.fn().mockResolvedValue(undefined),
  };
});

import { createBrowserDatabase } from './browser.js';
import { deleteSpillChunks, deleteSpillGeneration } from './spill-files.js';

const deleteSpillGenerationMock = vi.mocked(deleteSpillGeneration);
const deleteSpillChunksMock = vi.mocked(deleteSpillChunks);

// The local parquet extension must be loaded before extension loading is disabled and the
// configuration is locked below — see the same-origin repository comment in browser.ts.
const HARDENING_STATEMENTS = [
  "LOAD 'http://localhost/duckdb-extensions/v1.5.4/wasm_eh/parquet.duckdb_extension.wasm';",
  "SET allowed_directories = ['opfs://byteql-spill/'];",
  'SET enable_external_access = false;',
  'SET autoinstall_known_extensions = false;',
  'SET autoload_known_extensions = false;',
  'SET allow_community_extensions = false;',
  'SET lock_configuration = true;',
] as const;

const resultTable = () =>
  new DuckdbTable({
    note: duckdbVectorFromArray([60], new DuckdbInt32()),
    label: duckdbVectorFromArray(['kick'], new DuckdbUtf8()),
  }).concat(
    new DuckdbTable({
      note: duckdbVectorFromArray([64], new DuckdbInt32()),
      label: duckdbVectorFromArray(['snare'], new DuckdbUtf8()),
    }),
  );

/** A valid Arrow IPC payload with `rows` rows, parseable via `tableFromIPC(...).numRows`. */
const ipcBatch = (rows: number): Uint8Array =>
  duckdbTableToIPC(
    new DuckdbTable({
      value: duckdbVectorFromArray(
        Array.from({ length: rows }, (_, index) => index),
        new DuckdbInt32(),
      ),
    }),
  );

const eventsSchema: TableSchema = {
  name: 'events',
  columns: [{ name: 'note', type: 'int32', nullable: false }],
};

const errorsSchema: TableSchema = {
  name: 'errors',
  columns: [
    { name: 'code', type: 'utf8', nullable: false },
    { name: 'seen_at', type: 'timestamp_us', nullable: true },
  ],
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly terminate = vi.fn();

  constructor(readonly url: string | URL) {
    FakeWorker.instances.push(this);
  }
}

describe('createBrowserDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });

    duckdbMocks.selectBundle.mockResolvedValue({
      mainModule: '/assets/duckdb-eh.wasm',
      mainWorker: '/assets/duckdb-browser-eh.worker.js',
      pthreadWorker: null,
    });
    duckdbMocks.AsyncDuckDB.mockReturnValue(duckdbMocks.database);
    duckdbMocks.database.instantiate.mockResolvedValue(null);
    duckdbMocks.database.connect.mockResolvedValue(duckdbMocks.connection);
    duckdbMocks.database.terminate.mockResolvedValue(undefined);
    duckdbMocks.database.registerOPFSFileName.mockResolvedValue(undefined);
    duckdbMocks.database.collectFileStatistics.mockResolvedValue(undefined);
    duckdbMocks.database.exportFileStatistics.mockResolvedValue({
      totalFileReadsCold: 0,
      totalFileReadsAhead: 0,
      totalFileReadsCached: 0,
      totalFileWrites: 0,
      totalPageAccesses: 0,
      totalPageLoads: 0,
      blockSize: 0,
      blockStats: new Uint8Array(),
    });
    duckdbMocks.connection.query.mockResolvedValue({} as Table);
    duckdbMocks.connection.send.mockResolvedValue(resultTable().batches);
    // Track copies of inserted data for test inspection (since the buffer gets detached in the mock).
    const insertedDataCopies: Uint8Array[] = [];
    duckdbMocks.connection.insertArrowFromIPCStream.mockImplementation(async (ipc: Uint8Array) => {
      // Save a copy before detaching so tests can inspect the content.
      insertedDataCopies.push(ipc.slice());
      // Mirror duckdb-wasm's real transfer semantics: the caller's buffer is detached.
      structuredClone(ipc.buffer, { transfer: [ipc.buffer] });
    });
    // Expose copies via a property for test access.
    duckdbMocks.connection.insertArrowFromIPCStream._insertedCopies = insertedDataCopies;
    duckdbMocks.connection.cancelSent.mockResolvedValue(true);
    duckdbMocks.connection.close.mockResolvedValue(undefined);
    deleteSpillGenerationMock.mockClear();
    deleteSpillGenerationMock.mockResolvedValue(undefined);
    deleteSpillChunksMock.mockClear();
    deleteSpillChunksMock.mockResolvedValue(undefined);
  });

  it('selects only Vite-local MVP and EH bundles and accepts an injected logger', async () => {
    const logger = { log: vi.fn() };

    await createBrowserDatabase({ logger });

    expect(duckdbMocks.selectBundle).toHaveBeenCalledOnce();
    const bundles = duckdbMocks.selectBundle.mock.calls[0]?.[0] as Record<
      string,
      { mainModule: string; mainWorker: string }
    >;
    expect(Object.keys(bundles)).toEqual(['mvp', 'eh']);
    expect(bundles.mvp?.mainModule).toMatch(/duckdb-mvp\.wasm/);
    expect(bundles.mvp?.mainWorker).toMatch(/duckdb-browser-mvp\.worker\.js/);
    expect(bundles.eh?.mainModule).toMatch(/duckdb-eh\.wasm/);
    expect(bundles.eh?.mainWorker).toMatch(/duckdb-browser-eh\.worker\.js/);
    expect(JSON.stringify(bundles)).not.toMatch(/https?:|jsdelivr|unpkg/i);
    expect(FakeWorker.instances[0]?.url).toBe('/assets/duckdb-browser-eh.worker.js');
    expect(duckdbMocks.AsyncDuckDB).toHaveBeenCalledWith(logger, FakeWorker.instances[0]);
    expect(duckdbMocks.VoidLogger).not.toHaveBeenCalled();
  });

  it('uses VoidLogger by default', async () => {
    const logger = { log: vi.fn() };
    duckdbMocks.VoidLogger.mockReturnValue(logger);

    await createBrowserDatabase();

    expect(duckdbMocks.VoidLogger).toHaveBeenCalledOnce();
    expect(duckdbMocks.AsyncDuckDB).toHaveBeenCalledWith(logger, FakeWorker.instances[0]);
  });

  it('runs hardening in order with the spill whitelist before locking', async () => {
    const database = await createBrowserDatabase();

    await Promise.all([database.initialize(), database.initialize()]);
    await database.query('SELECT 42;');

    expect(duckdbMocks.database.instantiate).toHaveBeenCalledOnce();
    expect(duckdbMocks.database.instantiate).toHaveBeenCalledWith('/assets/duckdb-eh.wasm', null);
    expect(duckdbMocks.database.connect).toHaveBeenCalledOnce();
    expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).toEqual([...HARDENING_STATEMENTS]);
    expect(duckdbMocks.connection.send).toHaveBeenCalledWith('SELECT 42;');
    expect(duckdbMocks.connection.query.mock.invocationCallOrder.at(-1)).toBeLessThan(
      duckdbMocks.connection.send.mock.invocationCallOrder[0]!,
    );
  });

  it('loads the local MVP parquet extension when the MVP bundle is selected', async () => {
    duckdbMocks.selectBundle.mockResolvedValueOnce({
      mainModule: '/assets/duckdb-mvp.wasm',
      mainWorker: '/assets/duckdb-browser-mvp.worker.js',
      pthreadWorker: null,
    });
    const database = await createBrowserDatabase();

    await database.initialize();

    expect(duckdbMocks.connection.query).toHaveBeenCalledWith(
      "LOAD 'http://localhost/duckdb-extensions/v1.5.4/wasm_mvp/parquet.duckdb_extension.wasm';",
    );
  });

  it('decompresses a prepared gzip module into a typed blob URL for instantiation', async () => {
    const wasm = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const compressed = gzipSync(wasm);
    const originalFetch = globalThis.fetch;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeObjectUrl = vi.fn((url: string) => originalRevokeObjectUrl.call(URL, url));
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === '/assets/duckdb-eh.wasm.gz') {
        return new Response(compressed);
      }
      return originalFetch(input);
    });
    vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: revokeObjectUrl }));
    duckdbMocks.selectBundle.mockResolvedValueOnce({
      mainModule: '/assets/duckdb-eh.wasm.gz',
      mainWorker: '/assets/duckdb-browser-eh.worker.js',
      pthreadWorker: null,
    });
    duckdbMocks.database.instantiate.mockImplementationOnce(async (url: string) => {
      expect(url).toMatch(/^blob:/u);
      const response = await originalFetch(url);
      expect(response.headers.get('content-type')).toBe('application/wasm');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(wasm);
    });

    try {
      const database = await createBrowserDatabase();
      await database.initialize();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: originalRevokeObjectUrl }));
    }

    expect(revokeObjectUrl).toHaveBeenCalledOnce();
  });

  it('measures query time and serializes queries and ingest appends', async () => {
    const database = await createBrowserDatabase();
    await database.initialize();
    const pending = deferred<readonly unknown[]>();
    const table = resultTable();
    duckdbMocks.connection.send.mockImplementationOnce(() => pending.promise);
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(10).mockReturnValueOnce(16.25);

    const query = database.query('SELECT * FROM events;');
    const session = await database.beginIngest({ schemas: [eventsSchema], tier: 'memory', generation: 1 });
    const append = session.appendBatch('events', ipcBatch(1));
    await vi.waitFor(() => expect(duckdbMocks.connection.send).toHaveBeenCalledOnce());
    expect(duckdbMocks.connection.insertArrowFromIPCStream).not.toHaveBeenCalled();
    pending.resolve(table.batches);

    const result = await query;
    expect(result.elapsedMs).toBe(6.25);
    expect(result.table).toBeInstanceOf(Table);
    expect(result.table).not.toBe(table);
    expect(result.table.schema.fields.map(({ name, type }) => [name, type.toString()])).toEqual([
      ['note', 'Int32'],
      ['label', 'Utf8'],
    ]);
    expect(result.table.toArray().map((row) => ({ ...row }))).toEqual([
      { note: 60, label: 'kick' },
      { note: 64, label: 'snare' },
    ]);
    await append;
    expect(duckdbMocks.connection.insertArrowFromIPCStream).toHaveBeenCalledOnce();
  });

  describe('file statistics pass-through', () => {
    it('collectFileStatistics forwards the path and enable flag to AsyncDuckDB, after initializing', async () => {
      const database = await createBrowserDatabase();

      await database.collectFileStatistics('opfs://byteql-spill/1/packets/0.parquet', true);

      expect(duckdbMocks.database.instantiate).toHaveBeenCalledOnce();
      expect(duckdbMocks.database.collectFileStatistics).toHaveBeenCalledExactlyOnceWith(
        'opfs://byteql-spill/1/packets/0.parquet',
        true,
      );
    });

    it('exportFileStatistics forwards the path and returns the plain numeric summary', async () => {
      duckdbMocks.database.exportFileStatistics.mockResolvedValueOnce({
        totalFileReadsCold: 3,
        totalFileReadsAhead: 1,
        totalFileReadsCached: 5,
        totalFileWrites: 2,
        totalPageAccesses: 9,
        totalPageLoads: 4,
        blockSize: 262_144,
        // The raw duckdb-wasm FileStatistics class also carries a blockStats Uint8Array and a
        // getBlockStats() method — the narrow ByteqlDatabase surface deliberately omits both, so
        // this mock proves the pass-through only forwards the plain numeric fields it declares.
        blockStats: new Uint8Array([1, 2, 3]),
        getBlockStats: vi.fn(),
      });
      const database = await createBrowserDatabase();

      const summary = await database.exportFileStatistics('opfs://byteql-spill/1/packets/0.parquet');

      expect(duckdbMocks.database.exportFileStatistics).toHaveBeenCalledExactlyOnceWith(
        'opfs://byteql-spill/1/packets/0.parquet',
      );
      expect(summary).toEqual({
        totalFileReadsCold: 3,
        totalFileReadsAhead: 1,
        totalFileReadsCached: 5,
        totalFileWrites: 2,
        totalPageAccesses: 9,
        totalPageLoads: 4,
        blockSize: 262_144,
      });
    });

    it('serializes behind other queued operations, like every other pass-through', async () => {
      const database = await createBrowserDatabase();
      await database.initialize();
      const pending = deferred<readonly unknown[]>();
      duckdbMocks.connection.send.mockImplementationOnce(() => pending.promise);

      const query = database.query('SELECT * FROM events;');
      await vi.waitFor(() => expect(duckdbMocks.connection.send).toHaveBeenCalledOnce());
      const stats = database.exportFileStatistics('opfs://byteql-spill/1/packets/0.parquet');
      expect(duckdbMocks.database.exportFileStatistics).not.toHaveBeenCalled();

      pending.resolve(resultTable().batches);
      await query;
      await stats;
      expect(duckdbMocks.database.exportFileStatistics).toHaveBeenCalledOnce();
    });

    it('rejects after disposal, like every other operation', async () => {
      const database = await createBrowserDatabase();
      await database.initialize();

      await database.dispose();

      await expect(
        database.collectFileStatistics('opfs://byteql-spill/1/packets/0.parquet', true),
      ).rejects.toThrow('disposed');
      await expect(database.exportFileStatistics('opfs://byteql-spill/1/packets/0.parquet')).rejects.toThrow(
        'disposed',
      );
    });
  });

  it('cancels without waiting behind the active query', async () => {
    const database = await createBrowserDatabase();
    await database.initialize();
    const pending = deferred<readonly unknown[]>();
    duckdbMocks.connection.send.mockImplementationOnce(() => pending.promise);

    const query = database.query('SELECT * FROM events;');
    await vi.waitFor(() => expect(duckdbMocks.connection.send).toHaveBeenCalledOnce());

    await expect(database.cancelQuery()).resolves.toBe(true);
    expect(duckdbMocks.connection.cancelSent).toHaveBeenCalledOnce();

    pending.resolve(resultTable().batches);
    await query;
  });

  it('disposes safely once and rejects later operations', async () => {
    const database = await createBrowserDatabase();
    await database.initialize();

    await Promise.all([database.dispose(), database.dispose()]);

    expect(duckdbMocks.connection.close).toHaveBeenCalledOnce();
    expect(duckdbMocks.database.terminate).toHaveBeenCalledOnce();
    await expect(database.query('SELECT 1;')).rejects.toThrow('disposed');
    await expect(
      database.beginIngest({ schemas: 'discover', tier: 'memory', generation: 1 }),
    ).rejects.toThrow('disposed');
    await expect(database.cancelQuery()).resolves.toBe(false);
  });

  it('cancels an active query before waiting for safe disposal', async () => {
    const database = await createBrowserDatabase();
    await database.initialize();
    const cancellation = deferred<void>();
    let cancelled = false;
    async function* pendingBatches() {
      yield resultTable().batches[0]!;
      await cancellation.promise;
      if (cancelled) {
        throw new Error('query cancelled');
      }
    }
    duckdbMocks.connection.send.mockResolvedValueOnce(pendingBatches());
    duckdbMocks.connection.cancelSent.mockImplementationOnce(async () => {
      cancelled = true;
      cancellation.resolve();
      return true;
    });

    const query = database.query('SELECT * FROM events;');
    await vi.waitFor(() => expect(duckdbMocks.connection.send).toHaveBeenCalledOnce());
    const disposal = database.dispose();

    await vi.waitFor(() => expect(duckdbMocks.connection.cancelSent).toHaveBeenCalledOnce());
    expect(duckdbMocks.connection.close).not.toHaveBeenCalled();
    await expect(query).rejects.toThrow('query cancelled');
    await disposal;
    expect(duckdbMocks.connection.close).toHaveBeenCalledOnce();
    expect(duckdbMocks.database.terminate).toHaveBeenCalledOnce();
  });

  it('does not start a query after disposal is requested during cold initialization', async () => {
    const initialization = deferred<null>();
    duckdbMocks.database.instantiate.mockImplementationOnce(() => initialization.promise);
    const database = await createBrowserDatabase();

    const query = database.query('SELECT 1;');
    await vi.waitFor(() => expect(duckdbMocks.database.instantiate).toHaveBeenCalledOnce());
    const disposal = database.dispose();
    initialization.resolve(null);

    await expect(query).rejects.toThrow('disposed');
    await disposal;
    expect(duckdbMocks.connection.send).not.toHaveBeenCalled();
    expect(duckdbMocks.connection.close).toHaveBeenCalledOnce();
    expect(duckdbMocks.database.terminate).toHaveBeenCalledOnce();
  });

  it('does not start an ingest append after disposal is requested during cold initialization', async () => {
    const initialization = deferred<null>();
    duckdbMocks.database.instantiate.mockImplementationOnce(() => initialization.promise);
    const database = await createBrowserDatabase();

    const session = await database.beginIngest({ schemas: [eventsSchema], tier: 'memory', generation: 1 });
    const append = session.appendBatch('events', ipcBatch(1));
    await vi.waitFor(() => expect(duckdbMocks.database.instantiate).toHaveBeenCalledOnce());
    const disposal = database.dispose();
    initialization.resolve(null);

    await expect(append).rejects.toThrow('disposed');
    await disposal;
    expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).toEqual([...HARDENING_STATEMENTS]);
    expect(duckdbMocks.connection.insertArrowFromIPCStream).not.toHaveBeenCalled();
    expect(duckdbMocks.connection.close).toHaveBeenCalledOnce();
    expect(duckdbMocks.database.terminate).toHaveBeenCalledOnce();
  });

  it('cleans up the worker and connection after partial initialization failure', async () => {
    duckdbMocks.connection.query.mockRejectedValueOnce(new Error('hardening failed'));
    const database = await createBrowserDatabase();

    await expect(database.initialize()).rejects.toThrow('hardening failed');

    expect(duckdbMocks.connection.close).toHaveBeenCalledOnce();
    expect(duckdbMocks.database.terminate).toHaveBeenCalledOnce();
    await database.dispose();
    expect(duckdbMocks.connection.close).toHaveBeenCalledOnce();
    expect(duckdbMocks.database.terminate).toHaveBeenCalledOnce();
  });

  describe('beginIngest', () => {
    it('appends into generation-scoped staging tables, create-then-append', async () => {
      const database = await createBrowserDatabase();
      const session = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'memory',
        generation: 7,
      });
      const ipcA = ipcBatch(2);
      const ipcB = ipcBatch(3);
      // Capture copies before appendBatch transfers the buffers (the mock detaches them).
      const ipcACopy = ipcA.slice();
      const ipcBCopy = ipcB.slice();

      await session.appendBatch('events', ipcA);
      await session.appendBatch('events', ipcB);

      expect(duckdbMocks.connection.insertArrowFromIPCStream).toHaveBeenNthCalledWith(
        1,
        expect.any(Uint8Array),
        { name: '__ingest_7_events', create: true },
      );
      expect(duckdbMocks.connection.insertArrowFromIPCStream).toHaveBeenNthCalledWith(
        2,
        expect.any(Uint8Array),
        { name: '__ingest_7_events', create: false },
      );
      // Access the copies saved by the mock before buffer detach (mock.calls would have detached buffers).
      const insertedCopies = (
        duckdbMocks.connection.insertArrowFromIPCStream as unknown as {
          _insertedCopies: Uint8Array[];
        }
      )._insertedCopies;
      expect(insertedCopies).toHaveLength(2);
      expect([...insertedCopies[0]!]).toEqual([...ipcACopy]);
      expect([...insertedCopies[1]!]).toEqual([...ipcBCopy]);
    });

    it('finalize drops old finals, renames staging, updates listTables, in one transaction', async () => {
      const database = await createBrowserDatabase();

      const first = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'memory',
        generation: 7,
      });
      await first.appendBatch('events', ipcBatch(2));
      await first.finalize();
      duckdbMocks.connection.query.mockClear();

      const second = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'memory',
        generation: 8,
      });
      await second.appendBatch('events', ipcBatch(3));
      const summaries = await second.finalize();

      expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).toEqual([
        'BEGIN TRANSACTION;',
        'DROP TABLE IF EXISTS "events";',
        'ALTER TABLE "__ingest_8_events" RENAME TO "events";',
        'COMMIT;',
      ]);
      expect(summaries).toEqual([{ name: 'events', rowCount: 3 }]);
      expect(await database.listTables()).toEqual(['events']);
    });

    it('tables never appended still finalize as empty tables from their schema', async () => {
      const database = await createBrowserDatabase();

      const session = await database.beginIngest({
        schemas: [eventsSchema, errorsSchema],
        tier: 'memory',
        generation: 8,
      });
      await session.appendBatch('events', ipcBatch(1));

      const summaries = await session.finalize();

      const calls = duckdbMocks.connection.query.mock.calls.map(([sql]) => sql);
      const createIndex = calls.indexOf(
        'CREATE TABLE "__ingest_8_errors" ("code" VARCHAR, "seen_at" TIMESTAMP);',
      );
      const renameIndex = calls.indexOf('ALTER TABLE "__ingest_8_errors" RENAME TO "errors";');
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(renameIndex).toBeGreaterThan(createIndex);
      expect(summaries).toEqual(
        expect.arrayContaining([
          { name: 'events', rowCount: 1 },
          { name: 'errors', rowCount: 0 },
        ]),
      );
      expect(await database.listTables()).toEqual(expect.arrayContaining(['events', 'errors']));
    });

    it('abort drops only its own staging and leaves committed finals untouched', async () => {
      const database = await createBrowserDatabase();

      const committed = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'memory',
        generation: 7,
      });
      await committed.appendBatch('events', ipcBatch(1));
      await committed.finalize();
      duckdbMocks.connection.query.mockClear();

      const session = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'memory',
        generation: 8,
      });
      await session.appendBatch('events', ipcBatch(1));

      await session.abort();

      expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).toEqual([
        'DROP TABLE IF EXISTS "__ingest_8_events";',
      ]);
      await expect(session.appendBatch('events', ipcBatch(1))).rejects.toThrow();
      await expect(session.finalize()).rejects.toThrow();
      expect(await database.listTables()).toEqual(['events']);
    });

    it('rejects appends to undeclared tables and after finalize', async () => {
      const database = await createBrowserDatabase();
      const session = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'memory',
        generation: 9,
      });

      await expect(session.appendBatch('unknown', ipcBatch(1))).rejects.toThrow('Undeclared');
      expect(duckdbMocks.connection.insertArrowFromIPCStream).not.toHaveBeenCalled();

      await session.appendBatch('events', ipcBatch(1));
      await session.finalize();

      await expect(session.appendBatch('events', ipcBatch(1))).rejects.toThrow();
    });

    it('a failed finalize rolls back and preserves the previous registry', async () => {
      const database = await createBrowserDatabase();

      const first = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'memory',
        generation: 7,
      });
      await first.appendBatch('events', ipcBatch(1));
      await first.finalize();

      const second = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'memory',
        generation: 8,
      });
      await second.appendBatch('events', ipcBatch(1));

      duckdbMocks.connection.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('ALTER TABLE')) {
          throw new Error('rename failed');
        }
        return {} as Table;
      });

      await expect(second.finalize()).rejects.toThrow('rename failed');
      expect(await database.listTables()).toEqual(['events']);
    });

    it('preserves both the finalize and rollback failures', async () => {
      const database = await createBrowserDatabase();
      const session = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'memory',
        generation: 1,
      });
      await session.appendBatch('events', ipcBatch(1));
      const renameError = new Error('rename failed');
      const rollbackError = new Error('rollback failed');
      duckdbMocks.connection.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('ALTER TABLE')) {
          throw renameError;
        }
        if (sql === 'ROLLBACK;') {
          throw rollbackError;
        }
        return {} as Table;
      });

      await expect(session.finalize()).rejects.toMatchObject({
        errors: [renameError, rollbackError],
        cause: rollbackError,
      });
    });

    it('abort reclaims staging tables after a failed finalize', async () => {
      const database = await createBrowserDatabase();

      const session = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'memory',
        generation: 8,
      });
      await session.appendBatch('events', ipcBatch(1));

      duckdbMocks.connection.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('ALTER TABLE')) {
          throw new Error('rename failed');
        }
        return {} as Table;
      });

      await expect(session.finalize()).rejects.toThrow('rename failed');

      await session.abort();

      const calls = duckdbMocks.connection.query.mock.calls.map(([sql]) => sql);
      const rollbackIndex = calls.indexOf('ROLLBACK;');
      const dropIndex = calls.indexOf('DROP TABLE IF EXISTS "__ingest_8_events";');
      expect(rollbackIndex).toBeGreaterThanOrEqual(0);
      expect(dropIndex).toBeGreaterThan(rollbackIndex);
    });

    it('rejects a second finalize and further appends after a failed finalize', async () => {
      const database = await createBrowserDatabase();

      const session = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'memory',
        generation: 8,
      });
      await session.appendBatch('events', ipcBatch(1));

      duckdbMocks.connection.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('ALTER TABLE')) {
          throw new Error('rename failed');
        }
        return {} as Table;
      });

      await expect(session.finalize()).rejects.toThrow('rename failed');

      await expect(session.finalize()).rejects.toThrow(/failed/i);
      await expect(session.appendBatch('events', ipcBatch(1))).rejects.toThrow(/failed/i);
    });

    it('rejects invalid or duplicate schema table identifiers before creating a session', async () => {
      const database = await createBrowserDatabase();

      await expect(
        database.beginIngest({
          schemas: [{ name: 'bad-name', columns: [] }],
          tier: 'memory',
          generation: 1,
        }),
      ).rejects.toThrow('Invalid table identifier');

      await expect(
        database.beginIngest({
          schemas: [
            { name: 'Events', columns: [] },
            { name: 'events', columns: [] },
          ],
          tier: 'memory',
          generation: 1,
        }),
      ).rejects.toThrow('Duplicate table identifier');

      expect(duckdbMocks.database.instantiate).not.toHaveBeenCalled();
    });

    it('rejects beginIngest while another ingest session is open', async () => {
      const database = await createBrowserDatabase();
      await database.beginIngest({ schemas: [eventsSchema], tier: 'memory', generation: 1 });

      await expect(
        database.beginIngest({ schemas: [eventsSchema], tier: 'memory', generation: 2 }),
      ).rejects.toThrow(/already open/i);
    });

    it('discover mode registers tables lazily and does not reject undeclared names', async () => {
      const database = await createBrowserDatabase();
      const session = await database.beginIngest({ schemas: 'discover', tier: 'memory', generation: 3 });

      await session.appendBatch('events', ipcBatch(2));
      await session.appendBatch('events', ipcBatch(1));
      await session.appendBatch('errors', ipcBatch(4));

      expect(duckdbMocks.connection.insertArrowFromIPCStream).toHaveBeenNthCalledWith(
        1,
        expect.any(Uint8Array),
        { name: '__ingest_3_events', create: true },
      );
      expect(duckdbMocks.connection.insertArrowFromIPCStream).toHaveBeenNthCalledWith(
        2,
        expect.any(Uint8Array),
        { name: '__ingest_3_events', create: false },
      );
      expect(duckdbMocks.connection.insertArrowFromIPCStream).toHaveBeenNthCalledWith(
        3,
        expect.any(Uint8Array),
        { name: '__ingest_3_errors', create: true },
      );

      const summaries = await session.finalize();
      expect(summaries).toEqual(
        expect.arrayContaining([
          { name: 'events', rowCount: 3 },
          { name: 'errors', rowCount: 4 },
        ]),
      );
      expect(summaries).toHaveLength(2);
    });

    it('discover mode finalizes exactly the discovered set with no empty tables', async () => {
      const database = await createBrowserDatabase();
      const session = await database.beginIngest({ schemas: 'discover', tier: 'memory', generation: 4 });
      await session.appendBatch('events', ipcBatch(2));

      const summaries = await session.finalize();

      expect(summaries).toEqual([{ name: 'events', rowCount: 2 }]);
      expect(await database.listTables()).toEqual(['events']);
      expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^CREATE TABLE/)]),
      );
    });

    it('discover mode backfills schema tables that never received an append as empty tables', async () => {
      // Regression (C1): zero-row tables never appended in discover mode used to simply not
      // exist after finalize, so a query assuming every pack table exists (e.g. a UNION ALL
      // overview) hit a Catalog Error. Passing the pack's full schema list to finalize backfills
      // any table discover-mode never saw an appendBatch for, as an empty table.
      const database = await createBrowserDatabase();
      const session = await database.beginIngest({ schemas: 'discover', tier: 'memory', generation: 6 });
      await session.appendBatch('events', ipcBatch(2));

      const summaries = await session.finalize([eventsSchema, errorsSchema]);

      const calls = duckdbMocks.connection.query.mock.calls.map(([sql]) => sql);
      const createIndex = calls.indexOf(
        'CREATE TABLE "__ingest_6_errors" ("code" VARCHAR, "seen_at" TIMESTAMP);',
      );
      const renameIndex = calls.indexOf('ALTER TABLE "__ingest_6_errors" RENAME TO "errors";');
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(renameIndex).toBeGreaterThan(createIndex);
      expect(summaries).toEqual(
        expect.arrayContaining([
          { name: 'events', rowCount: 2 },
          { name: 'errors', rowCount: 0 },
        ]),
      );
      expect(await database.listTables()).toEqual(expect.arrayContaining(['events', 'errors']));
    });

    it('maps uint8 columns to UTINYINT in backfill DDL', async () => {
      const database = await createBrowserDatabase();
      const uint8Schema: TableSchema = {
        name: 'bytes',
        columns: [{ name: 'value', type: 'uint8', nullable: false }],
      };
      const session = await database.beginIngest({ schemas: [uint8Schema], tier: 'memory', generation: 7 });

      const summaries = await session.finalize();

      const calls = duckdbMocks.connection.query.mock.calls.map(([sql]) => sql);
      const createTable = calls.find((sql) => sql.includes('CREATE TABLE "__ingest_7_bytes"'));
      expect(createTable).toBe('CREATE TABLE "__ingest_7_bytes" ("value" UTINYINT);');
      expect(summaries).toEqual([{ name: 'bytes', rowCount: 0 }]);
    });

    describe('spill tier', () => {
      it('rejects with SPILL_UNSUPPORTED when spillSupported is false', async () => {
        const database = await createBrowserDatabase({ spillSupported: false });

        await expect(
          database.beginIngest({ schemas: [eventsSchema], tier: 'spill', generation: 1 }),
        ).rejects.toThrow('SPILL_UNSUPPORTED');
      });

      it('defaults spillSupported from navigator.storage.getDirectory availability', async () => {
        vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn() } });
        try {
          const database = await createBrowserDatabase();
          await expect(
            database.beginIngest({ schemas: [eventsSchema], tier: 'spill', generation: 1 }),
          ).resolves.toBeDefined();
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('defaults spillSupported to false without navigator.storage.getDirectory', async () => {
        vi.stubGlobal('navigator', {});
        try {
          const database = await createBrowserDatabase();
          await expect(
            database.beginIngest({ schemas: [eventsSchema], tier: 'spill', generation: 1 }),
          ).rejects.toThrow('SPILL_UNSUPPORTED');
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('rotates a staging table to parquet when staged bytes cross the threshold', async () => {
        const database = await createBrowserDatabase({ spillSupported: true });
        const batch1 = ipcBatch(2);
        const batch2 = ipcBatch(3);
        const rotationBytes = batch1.byteLength + 1;
        const session = await database.beginIngest({
          schemas: 'discover',
          tier: 'spill',
          generation: 9,
          rotationBytes,
        });

        await session.appendBatch('events', batch1);
        expect(duckdbMocks.database.registerOPFSFileName).not.toHaveBeenCalled();
        expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^COPY/)]),
        );

        await session.appendBatch('events', batch2);

        expect(duckdbMocks.database.registerOPFSFileName).toHaveBeenCalledExactlyOnceWith(
          'opfs://byteql-spill/9/events/0.parquet',
        );
        const calls = duckdbMocks.connection.query.mock.calls.map(([sql]) => sql);
        const copyIndex = calls.indexOf(
          'COPY "__ingest_9_events" TO \'opfs://byteql-spill/9/events/0.parquet\' (FORMAT parquet);',
        );
        const deleteIndex = calls.indexOf('DELETE FROM "__ingest_9_events";');
        expect(copyIndex).toBeGreaterThanOrEqual(0);
        expect(deleteIndex).toBeGreaterThan(copyIndex);

        duckdbMocks.connection.query.mockClear();
        duckdbMocks.database.registerOPFSFileName.mockClear();

        await session.appendBatch('events', batch1);

        expect(duckdbMocks.database.registerOPFSFileName).not.toHaveBeenCalled();
        expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^COPY/)]),
        );
      });

      it('finalize flushes residual staging as a final chunk and creates parquet_scan views', async () => {
        const database = await createBrowserDatabase({ spillSupported: true });

        const previous = await database.beginIngest({
          schemas: 'discover',
          tier: 'spill',
          generation: 5,
        });
        await previous.appendBatch('events', ipcBatch(1));
        await previous.finalize();
        duckdbMocks.connection.query.mockClear();
        duckdbMocks.database.registerOPFSFileName.mockClear();
        deleteSpillGenerationMock.mockClear();

        const batch1 = ipcBatch(2);
        const batch2 = ipcBatch(3);
        const rotationBytes = batch1.byteLength + 1;
        const session = await database.beginIngest({
          schemas: 'discover',
          tier: 'spill',
          generation: 9,
          rotationBytes,
        });
        await session.appendBatch('events', batch1);
        await session.appendBatch('events', batch2); // rotates -> chunk 0
        await session.appendBatch('events', ipcBatch(1)); // residual, stays staged

        const summaries = await session.finalize();

        const calls = duckdbMocks.connection.query.mock.calls.map(([sql]) => sql);
        const beginIndex = calls.indexOf('BEGIN TRANSACTION;');
        const residualCopyIndex = calls.indexOf(
          'COPY "__ingest_9_events" TO \'opfs://byteql-spill/9/events/1.parquet\' (FORMAT parquet);',
        );
        expect(residualCopyIndex).toBeGreaterThanOrEqual(0);
        expect(residualCopyIndex).toBeLessThan(beginIndex);
        expect(calls.slice(beginIndex)).toEqual([
          'BEGIN TRANSACTION;',
          'DROP VIEW IF EXISTS "events";',
          'CREATE VIEW "events" AS SELECT * FROM parquet_scan([' +
            "'opfs://byteql-spill/9/events/0.parquet', 'opfs://byteql-spill/9/events/1.parquet']);",
          'DROP TABLE IF EXISTS "__ingest_9_events";',
          'COMMIT;',
        ]);
        expect(duckdbMocks.database.registerOPFSFileName).toHaveBeenNthCalledWith(
          1,
          'opfs://byteql-spill/9/events/0.parquet',
        );
        expect(duckdbMocks.database.registerOPFSFileName).toHaveBeenNthCalledWith(
          2,
          'opfs://byteql-spill/9/events/1.parquet',
        );
        expect(summaries).toEqual([{ name: 'events', rowCount: 6 }]);
        expect(await database.listTables()).toEqual(['events']);

        expect(deleteSpillGenerationMock).toHaveBeenCalledExactlyOnceWith(5);
        const commitOrder = duckdbMocks.connection.query.mock.invocationCallOrder[calls.indexOf('COMMIT;')]!;
        expect(deleteSpillGenerationMock.mock.invocationCallOrder[0]).toBeGreaterThan(commitOrder);
      });

      it('a quota error flushing residual staging at finalize rejects SPILL_QUOTA_EXCEEDED and fails the session', async () => {
        // Trivia (2): the residual-flush COPY at finalize used to reject with the raw quota
        // error, unlike appendBatch's mid-ingest rotation, which tags it SPILL_QUOTA_EXCEEDED so
        // the controller can show a clear message instead of a raw DB/OS error string.
        const database = await createBrowserDatabase({ spillSupported: true });
        const quotaError = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        const session = await database.beginIngest({ schemas: 'discover', tier: 'spill', generation: 12 });
        await session.appendBatch('events', ipcBatch(1)); // stays staged as a residual

        duckdbMocks.connection.query.mockImplementation(async (sql: string) => {
          if (sql.startsWith('COPY')) {
            throw quotaError;
          }
          return {} as Table;
        });

        await expect(session.finalize()).rejects.toThrow('SPILL_QUOTA_EXCEEDED');
        await expect(session.appendBatch('events', ipcBatch(1))).rejects.toThrow(/failed/i);
      });

      it('a table with zero rows in spill tier finalizes as an empty TABLE, not a view', async () => {
        const database = await createBrowserDatabase({ spillSupported: true });
        const session = await database.beginIngest({
          schemas: [eventsSchema, errorsSchema],
          tier: 'spill',
          generation: 4,
        });
        await session.appendBatch('events', ipcBatch(1));

        const summaries = await session.finalize();

        const calls = duckdbMocks.connection.query.mock.calls.map(([sql]) => sql);
        expect(calls).not.toEqual(expect.arrayContaining([expect.stringMatching(/^CREATE VIEW "errors"/)]));
        const createIndex = calls.indexOf(
          'CREATE TABLE "__ingest_4_errors" ("code" VARCHAR, "seen_at" TIMESTAMP);',
        );
        const renameIndex = calls.indexOf('ALTER TABLE "__ingest_4_errors" RENAME TO "errors";');
        expect(createIndex).toBeGreaterThanOrEqual(0);
        expect(renameIndex).toBeGreaterThan(createIndex);
        expect(summaries).toEqual(expect.arrayContaining([{ name: 'errors', rowCount: 0 }]));
        expect(await database.listTables()).toEqual(expect.arrayContaining(['events', 'errors']));
      });

      it('discover mode backfills a never-appended schema table as an empty TABLE in the spill tier', async () => {
        // Same C1 regression as the memory-tier case above, exercised in the spill tier: a
        // discover-mode table the pack declares but that never rotated or staged any residual
        // bytes must still exist as an empty table, not a dangling view over nothing.
        const database = await createBrowserDatabase({ spillSupported: true });
        const session = await database.beginIngest({ schemas: 'discover', tier: 'spill', generation: 11 });
        await session.appendBatch('events', ipcBatch(1));

        const summaries = await session.finalize([eventsSchema, errorsSchema]);

        const calls = duckdbMocks.connection.query.mock.calls.map(([sql]) => sql);
        expect(calls).not.toEqual(expect.arrayContaining([expect.stringMatching(/^CREATE VIEW "errors"/)]));
        const createIndex = calls.indexOf(
          'CREATE TABLE "__ingest_11_errors" ("code" VARCHAR, "seen_at" TIMESTAMP);',
        );
        const renameIndex = calls.indexOf('ALTER TABLE "__ingest_11_errors" RENAME TO "errors";');
        expect(createIndex).toBeGreaterThanOrEqual(0);
        expect(renameIndex).toBeGreaterThan(createIndex);
        expect(summaries).toEqual(expect.arrayContaining([{ name: 'errors', rowCount: 0 }]));
        expect(await database.listTables()).toEqual(expect.arrayContaining(['events', 'errors']));
      });

      it('a second finalize drops each old final by its recorded catalog kind, not a blind double drop', async () => {
        const database = await createBrowserDatabase({ spillSupported: true });

        const spillSession = await database.beginIngest({
          schemas: [eventsSchema, errorsSchema],
          tier: 'spill',
          generation: 4,
        });
        await spillSession.appendBatch('events', ipcBatch(1));
        // errors is never appended, so it finalizes as an empty TABLE fallback, not a view.
        await spillSession.finalize();
        duckdbMocks.connection.query.mockClear();
        duckdbMocks.database.registerOPFSFileName.mockClear();

        const memorySession = await database.beginIngest({
          schemas: [eventsSchema, errorsSchema],
          tier: 'memory',
          generation: 10,
        });
        await memorySession.appendBatch('events', ipcBatch(2));
        await memorySession.appendBatch('errors', ipcBatch(1));

        await memorySession.finalize();

        const calls = duckdbMocks.connection.query.mock.calls.map(([sql]) => sql);
        const beginIndex = calls.indexOf('BEGIN TRANSACTION;');
        expect(calls.slice(beginIndex)).toEqual([
          'BEGIN TRANSACTION;',
          'DROP VIEW IF EXISTS "events";',
          'DROP TABLE IF EXISTS "errors";',
          'ALTER TABLE "__ingest_10_events" RENAME TO "events";',
          'ALTER TABLE "__ingest_10_errors" RENAME TO "errors";',
          'COMMIT;',
        ]);
      });

      it('abort deletes the new generation spill directory and staging, never the committed one', async () => {
        const database = await createBrowserDatabase({ spillSupported: true });

        const committed = await database.beginIngest({
          schemas: 'discover',
          tier: 'spill',
          generation: 5,
        });
        await committed.appendBatch('events', ipcBatch(1));
        await committed.finalize();
        deleteSpillGenerationMock.mockClear();

        const session = await database.beginIngest({
          schemas: 'discover',
          tier: 'spill',
          generation: 9,
        });
        await session.appendBatch('events', ipcBatch(1));

        await session.abort();

        expect(deleteSpillGenerationMock).toHaveBeenCalledExactlyOnceWith(9);
        expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).toEqual(
          expect.arrayContaining(['DROP TABLE IF EXISTS "__ingest_9_events";']),
        );
      });

      it('quota errors from COPY reject appendBatch with a QUOTA-tagged error after aborting', async () => {
        const database = await createBrowserDatabase({ spillSupported: true });
        const quotaError = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        duckdbMocks.connection.query.mockImplementation(async (sql: string) => {
          if (sql.startsWith('COPY')) {
            throw quotaError;
          }
          return {} as Table;
        });

        const session = await database.beginIngest({
          schemas: 'discover',
          tier: 'spill',
          generation: 9,
          rotationBytes: 1,
        });

        await expect(session.appendBatch('events', ipcBatch(1))).rejects.toThrow('SPILL_QUOTA_EXCEEDED');

        expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).toEqual(
          expect.arrayContaining(['DROP TABLE IF EXISTS "__ingest_9_events";']),
        );
        expect(deleteSpillGenerationMock).toHaveBeenCalledWith(9);
        await expect(session.appendBatch('events', ipcBatch(1))).rejects.toThrow(/aborted/i);
        await expect(session.finalize()).rejects.toThrow(/aborted/i);
      });

      it('dispose best-effort deletes the current generation spill directory', async () => {
        const database = await createBrowserDatabase({ spillSupported: true });
        const session = await database.beginIngest({ schemas: 'discover', tier: 'spill', generation: 6 });
        await session.appendBatch('events', ipcBatch(1));
        await session.finalize();
        deleteSpillGenerationMock.mockClear();

        await database.dispose();

        expect(deleteSpillGenerationMock).toHaveBeenCalledExactlyOnceWith(6);
      });

      it('dispose resolves even if best-effort spill cleanup fails', async () => {
        const database = await createBrowserDatabase({ spillSupported: true });
        const session = await database.beginIngest({ schemas: 'discover', tier: 'spill', generation: 6 });
        await session.appendBatch('events', ipcBatch(1));
        await session.finalize();
        deleteSpillGenerationMock.mockRejectedValueOnce(new Error('opfs down'));

        await expect(database.dispose()).resolves.toBeUndefined();
      });

      it('dispose reclaims an in-flight (never finalized or aborted) spill generation immediately', async () => {
        // Trivia (3): dispose() only reclaimed a *committed* spill generation (`spillGeneration`,
        // set at a successful finalize). A dispose mid-spill-ingest — the session still open,
        // never finalized or aborted — left that generation's already-rotated OPFS parquet chunks
        // around until the next launch's orphan sweep instead of being reclaimed immediately.
        const database = await createBrowserDatabase({ spillSupported: true });
        const session = await database.beginIngest({ schemas: 'discover', tier: 'spill', generation: 15 });
        await session.appendBatch('events', ipcBatch(1));
        deleteSpillGenerationMock.mockClear();

        await database.dispose();

        expect(deleteSpillGenerationMock).toHaveBeenCalledExactlyOnceWith(15);
      });

      it('dispose does not reclaim any spill generation for an in-flight memory-tier ingest', async () => {
        const database = await createBrowserDatabase({ spillSupported: true });
        const session = await database.beginIngest({ schemas: 'discover', tier: 'memory', generation: 2 });
        await session.appendBatch('events', ipcBatch(1));
        deleteSpillGenerationMock.mockClear();

        await database.dispose();

        expect(deleteSpillGenerationMock).not.toHaveBeenCalled();
      });

      it('abort after a failed spill finalize also deletes the new generation spill directory', async () => {
        const database = await createBrowserDatabase({ spillSupported: true });
        const session = await database.beginIngest({ schemas: 'discover', tier: 'spill', generation: 9 });
        await session.appendBatch('events', ipcBatch(1));
        duckdbMocks.connection.query.mockImplementation(async (sql: string) => {
          if (sql.startsWith('CREATE VIEW')) {
            throw new Error('view creation failed');
          }
          return {} as Table;
        });

        await expect(session.finalize()).rejects.toThrow('view creation failed');
        deleteSpillGenerationMock.mockClear();

        await session.abort();

        expect(deleteSpillGenerationMock).toHaveBeenCalledExactlyOnceWith(9);
        expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).toEqual(
          expect.arrayContaining(['DROP TABLE IF EXISTS "__ingest_9_events";']),
        );
      });
    });

    describe('per-file ingest boundaries', () => {
      it('beginFile on the spill tier rotates residual staged rows before switching files', async () => {
        const database = await createBrowserDatabase({ spillSupported: true });
        const session = await database.beginIngest({ schemas: 'discover', tier: 'spill', generation: 9 });
        // Small batch stays well under the default rotation threshold, so it remains a residual
        // staged row rather than triggering appendBatch's own rotation.
        await session.appendBatch('events', ipcBatch(2));
        expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^COPY/)]),
        );

        await session.beginFile('b.pcap');

        const calls = duckdbMocks.connection.query.mock.calls.map(([sql]) => sql);
        const copyIndex = calls.indexOf(
          'COPY "__ingest_9_events" TO \'opfs://byteql-spill/9/events/0.parquet\' (FORMAT parquet);',
        );
        const deleteIndex = calls.indexOf('DELETE FROM "__ingest_9_events";');
        expect(copyIndex).toBeGreaterThanOrEqual(0);
        expect(deleteIndex).toBeGreaterThan(copyIndex);
      });

      it('a quota error rotating residual staging at beginFile rejects SPILL_QUOTA_EXCEEDED and aborts the session', async () => {
        const database = await createBrowserDatabase({ spillSupported: true });
        const session = await database.beginIngest({ schemas: 'discover', tier: 'spill', generation: 9 });
        // Small batch stays well under the default rotation threshold, so it remains a residual
        // staged row that beginFile's boundary rotation must flush.
        await session.appendBatch('events', ipcBatch(2));

        const quotaError = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        duckdbMocks.connection.query.mockImplementation(async (sql: string) => {
          if (sql.startsWith('COPY')) {
            throw quotaError;
          }
          return {} as Table;
        });

        await expect(session.beginFile('b.pcap')).rejects.toThrow(/SPILL_QUOTA_EXCEEDED/);

        await expect(session.appendBatch('events', ipcBatch(1))).rejects.toThrow(/aborted/i);
        expect(deleteSpillGenerationMock).toHaveBeenCalledWith(9);
      });

      it('discardCurrentFile on the memory tier deletes by _src_file with an escaped literal', async () => {
        const database = await createBrowserDatabase();
        const session = await database.beginIngest({
          schemas: [eventsSchema],
          tier: 'memory',
          generation: 1,
        });

        await session.beginFile("it's.pcap");
        await session.appendBatch('events', ipcBatch(2));

        await session.discardCurrentFile();

        expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).toContain(
          `DELETE FROM "__ingest_1_events" WHERE _src_file = 'it''s.pcap';`,
        );

        const summaries = await session.finalize();
        expect(summaries).toEqual([{ name: 'events', rowCount: 0 }]);
      });

      it("discardCurrentFile on the spill tier truncates staging and forgets this file's chunks", async () => {
        const database = await createBrowserDatabase({ spillSupported: true });
        const batch1 = ipcBatch(2);
        const batch2 = ipcBatch(3);
        const rotationBytes = batch1.byteLength + 1;
        const session = await database.beginIngest({
          schemas: 'discover',
          tier: 'spill',
          generation: 9,
          rotationBytes,
        });

        await session.beginFile('a.pcap');
        await session.appendBatch('events', batch1);
        await session.appendBatch('events', batch2); // rotates -> chunk 0, attributed to 'a.pcap'

        await session.discardCurrentFile();

        expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).toContain(
          'DELETE FROM "__ingest_9_events";',
        );
        expect(deleteSpillChunksMock).toHaveBeenCalledExactlyOnceWith([
          'opfs://byteql-spill/9/events/0.parquet',
        ]);

        const summaries = await session.finalize();
        const calls = duckdbMocks.connection.query.mock.calls.map(([sql]) => sql);
        expect(calls).not.toEqual(expect.arrayContaining([expect.stringMatching(/^CREATE VIEW "events"/)]));
        expect(calls).toEqual(
          expect.arrayContaining(['ALTER TABLE "__ingest_9_events" RENAME TO "events";']),
        );
        expect(summaries).toEqual([{ name: 'events', rowCount: 0 }]);
      });

      it('discardCurrentFile without beginFile is a no-op', async () => {
        const database = await createBrowserDatabase();
        const session = await database.beginIngest({
          schemas: [eventsSchema],
          tier: 'memory',
          generation: 1,
        });
        await session.appendBatch('events', ipcBatch(2));
        duckdbMocks.connection.query.mockClear();

        await session.discardCurrentFile();

        expect(duckdbMocks.connection.query).not.toHaveBeenCalled();

        const summaries = await session.finalize();
        expect(summaries).toEqual([{ name: 'events', rowCount: 2 }]);
      });
    });

    it('a memory-tier finalize after a spill-tier generation reclaims the old spill directory', async () => {
      // I2 regression: `finalize()` only reclaimed the previous generation's OPFS spill
      // directory in the spill-tier branch. A spill capture followed by a memory-tier open left
      // the old parquet payload on OPFS for the rest of the session (only cleaned up by the
      // startup orphan sweep on next launch, or session dispose).
      const database = await createBrowserDatabase({ spillSupported: true });
      const spillSession = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'spill',
        generation: 3,
      });
      await spillSession.appendBatch('events', ipcBatch(1));
      await spillSession.finalize();
      deleteSpillGenerationMock.mockClear();

      const memorySession = await database.beginIngest({
        schemas: [eventsSchema],
        tier: 'memory',
        generation: 4,
      });
      await memorySession.appendBatch('events', ipcBatch(1));
      await memorySession.finalize();

      expect(deleteSpillGenerationMock).toHaveBeenCalledExactlyOnceWith(3);
    });

    it('a memory-tier finalize with no prior spill generation does not call deleteSpillGeneration', async () => {
      const database = await createBrowserDatabase();
      const session = await database.beginIngest({ schemas: [eventsSchema], tier: 'memory', generation: 1 });
      await session.appendBatch('events', ipcBatch(1));

      await session.finalize();

      expect(deleteSpillGenerationMock).not.toHaveBeenCalled();
    });
  });
});
