import type { TableSchema, TableTransfer } from '@byteql/core';
import { Table } from 'apache-arrow';
import {
  Int32 as DuckdbInt32,
  Table as DuckdbTable,
  Utf8 as DuckdbUtf8,
  tableToIPC as duckdbTableToIPC,
  vectorFromArray as duckdbVectorFromArray,
} from 'apache-arrow-duckdb';
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

import { createBrowserDatabase } from './browser.js';

const HARDENING_STATEMENTS = [
  'SET enable_external_access = false;',
  'SET autoinstall_known_extensions = false;',
  'SET autoload_known_extensions = false;',
  'SET allow_community_extensions = false;',
  'SET lock_configuration = true;',
] as const;

const transfer = (name: string, bytes = [1, 2, 3]): TableTransfer => ({
  name,
  ipc: new Uint8Array(bytes),
  rowCount: 0,
  columns: [],
});

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

    duckdbMocks.selectBundle.mockResolvedValue({
      mainModule: '/assets/duckdb-eh.wasm',
      mainWorker: '/assets/duckdb-browser-eh.worker.js',
      pthreadWorker: null,
    });
    duckdbMocks.AsyncDuckDB.mockReturnValue(duckdbMocks.database);
    duckdbMocks.database.instantiate.mockResolvedValue(null);
    duckdbMocks.database.connect.mockResolvedValue(duckdbMocks.connection);
    duckdbMocks.database.terminate.mockResolvedValue(undefined);
    duckdbMocks.connection.query.mockResolvedValue({} as Table);
    duckdbMocks.connection.send.mockResolvedValue(resultTable().batches);
    duckdbMocks.connection.insertArrowFromIPCStream.mockResolvedValue(undefined);
    duckdbMocks.connection.cancelSent.mockResolvedValue(true);
    duckdbMocks.connection.close.mockResolvedValue(undefined);
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

  it('runs all hardening statements in exact order before user SQL and initializes once', async () => {
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

  it.each(['9events', 'bad-name', 'has space', 'semi;drop', 'quote"name', ''])(
    'rejects invalid table identifier %j before touching DuckDB',
    async (name) => {
      const database = await createBrowserDatabase();

      await expect(database.replaceTables([transfer(name)])).rejects.toThrow('Invalid table identifier');

      expect(duckdbMocks.database.instantiate).not.toHaveBeenCalled();
      expect(duckdbMocks.connection.query).not.toHaveBeenCalled();
      expect(duckdbMocks.connection.insertArrowFromIPCStream).not.toHaveBeenCalled();
    },
  );

  it('rejects duplicate table names before touching DuckDB', async () => {
    const database = await createBrowserDatabase();

    await expect(database.replaceTables([transfer('events'), transfer('events')])).rejects.toThrow(
      'Duplicate table identifier',
    );

    expect(duckdbMocks.database.instantiate).not.toHaveBeenCalled();
  });

  it('rejects table names that differ only by ASCII case as duplicates', async () => {
    const database = await createBrowserDatabase();

    await expect(database.replaceTables([transfer('Events'), transfer('events')])).rejects.toThrow(
      'Duplicate table identifier',
    );

    expect(duckdbMocks.database.instantiate).not.toHaveBeenCalled();
  });

  it('transactionally replaces only registered tables and copies IPC buffers', async () => {
    const database = await createBrowserDatabase();
    const original = transfer('events', [4, 5, 6]);

    await database.replaceTables([original, transfer('_errors')]);
    await database.replaceTables([transfer('tempo')]);

    expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      ...HARDENING_STATEMENTS,
      'BEGIN TRANSACTION;',
      'COMMIT;',
      'BEGIN TRANSACTION;',
      'DROP TABLE IF EXISTS "events";',
      'DROP TABLE IF EXISTS "_errors";',
      'COMMIT;',
    ]);
    expect(duckdbMocks.connection.insertArrowFromIPCStream).toHaveBeenCalledTimes(3);
    expect(duckdbMocks.connection.insertArrowFromIPCStream).toHaveBeenNthCalledWith(
      1,
      expect.any(Uint8Array),
      { name: 'events', create: true },
    );
    const inserted = duckdbMocks.connection.insertArrowFromIPCStream.mock.calls[0]?.[0] as Uint8Array;
    expect(inserted).not.toBe(original.ipc);
    expect([...inserted]).toEqual([4, 5, 6]);
    expect([...original.ipc]).toEqual([4, 5, 6]);
    expect(await database.listTables()).toEqual(['tempo']);
  });

  it('rolls back a failed replacement and preserves the previous registry', async () => {
    const database = await createBrowserDatabase();
    await database.replaceTables([transfer('events')]);
    duckdbMocks.connection.insertArrowFromIPCStream.mockRejectedValueOnce(new Error('bad IPC'));

    await expect(database.replaceTables([transfer('tempo')])).rejects.toThrow('bad IPC');

    expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql).slice(-3)).toEqual([
      'BEGIN TRANSACTION;',
      'DROP TABLE IF EXISTS "events";',
      'ROLLBACK;',
    ]);
    expect(await database.listTables()).toEqual(['events']);
  });

  it('preserves both the replacement and rollback failures', async () => {
    const database = await createBrowserDatabase();
    const insertionError = new Error('bad IPC');
    const rollbackError = new Error('rollback failed');
    duckdbMocks.connection.insertArrowFromIPCStream.mockRejectedValueOnce(insertionError);
    duckdbMocks.connection.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK;') {
        throw rollbackError;
      }
      return {} as Table;
    });

    const replacement = database.replaceTables([transfer('events')]);

    await expect(replacement).rejects.toMatchObject({
      errors: [insertionError, rollbackError],
      cause: rollbackError,
    });
    expect(await database.listTables()).toEqual([]);
  });

  it('measures query time and serializes queries and replacements', async () => {
    const database = await createBrowserDatabase();
    await database.initialize();
    const pending = deferred<readonly unknown[]>();
    const table = resultTable();
    duckdbMocks.connection.send.mockImplementationOnce(() => pending.promise);
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(10).mockReturnValueOnce(16.25);

    const query = database.query('SELECT * FROM events;');
    const replacement = database.replaceTables([transfer('tempo')]);
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
    await replacement;
    expect(duckdbMocks.connection.insertArrowFromIPCStream).toHaveBeenCalledOnce();
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
    await expect(database.replaceTables([])).rejects.toThrow('disposed');
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

  it('does not start a replacement after disposal is requested during cold initialization', async () => {
    const initialization = deferred<null>();
    duckdbMocks.database.instantiate.mockImplementationOnce(() => initialization.promise);
    const database = await createBrowserDatabase();

    const replacement = database.replaceTables([transfer('events')]);
    await vi.waitFor(() => expect(duckdbMocks.database.instantiate).toHaveBeenCalledOnce());
    const disposal = database.dispose();
    initialization.resolve(null);

    await expect(replacement).rejects.toThrow('disposed');
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

  it('snapshots names and IPC bytes before queued replacement work', async () => {
    const database = await createBrowserDatabase();
    await database.initialize();
    const pending = deferred<readonly unknown[]>();
    duckdbMocks.connection.send.mockImplementationOnce(() => pending.promise);
    const activeQuery = database.query('SELECT 1;');
    await vi.waitFor(() => expect(duckdbMocks.connection.send).toHaveBeenCalledOnce());

    const original = transfer('events', [4, 5, 6]);
    const input = [original];
    const replacement = database.replaceTables(input);
    original.name = 'mutated';
    original.ipc[0] = 99;
    input[0] = transfer('other', [8, 8, 8]);
    input.push(transfer('late', [7, 7, 7]));
    pending.resolve(resultTable().batches);
    await activeQuery;
    await replacement;

    expect(duckdbMocks.connection.insertArrowFromIPCStream).toHaveBeenCalledOnce();
    const [inserted, options] = duckdbMocks.connection.insertArrowFromIPCStream.mock.calls[0]!;
    expect(options).toEqual({ name: 'events', create: true });
    expect([...inserted]).toEqual([4, 5, 6]);
    expect(await database.listTables()).toEqual(['events']);
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
      const [firstInserted] = duckdbMocks.connection.insertArrowFromIPCStream.mock.calls[0]!;
      const [secondInserted] = duckdbMocks.connection.insertArrowFromIPCStream.mock.calls[1]!;
      expect(firstInserted).not.toBe(ipcA);
      expect(secondInserted).not.toBe(ipcB);
      expect([...(firstInserted as Uint8Array)]).toEqual([...ipcA]);
      expect([...(secondInserted as Uint8Array)]).toEqual([...ipcB]);
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

    it('rejects a spill-tier ingest as not implemented', async () => {
      const database = await createBrowserDatabase();

      await expect(
        database.beginIngest({ schemas: [eventsSchema], tier: 'spill', generation: 1 }),
      ).rejects.toThrow('Task 7');
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
  });
});
