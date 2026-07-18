import type { TableTransfer } from '@byteql/core';
import type { Table } from 'apache-arrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const duckdbMocks = vi.hoisted(() => {
  const connection = {
    query: vi.fn(),
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
    expect(duckdbMocks.connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      ...HARDENING_STATEMENTS,
      'SELECT 42;',
    ]);
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
    const pending = deferred<Table>();
    const table = {} as Table;
    duckdbMocks.connection.query.mockImplementationOnce(() => pending.promise);
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(10).mockReturnValueOnce(16.25);

    const query = database.query('SELECT * FROM events;');
    const replacement = database.replaceTables([transfer('tempo')]);
    await vi.waitFor(() => expect(duckdbMocks.connection.query).toHaveBeenCalledTimes(6));
    expect(duckdbMocks.connection.insertArrowFromIPCStream).not.toHaveBeenCalled();
    pending.resolve(table);

    await expect(query).resolves.toEqual({ table, elapsedMs: 6.25 });
    await replacement;
    expect(duckdbMocks.connection.insertArrowFromIPCStream).toHaveBeenCalledOnce();
  });

  it('cancels without waiting behind the active query', async () => {
    const database = await createBrowserDatabase();
    await database.initialize();
    const pending = deferred<Table>();
    duckdbMocks.connection.query.mockImplementationOnce(() => pending.promise);

    const query = database.query('SELECT * FROM events;');
    await vi.waitFor(() => expect(duckdbMocks.connection.query).toHaveBeenCalledTimes(6));

    await expect(database.cancelQuery()).resolves.toBe(true);
    expect(duckdbMocks.connection.cancelSent).toHaveBeenCalledOnce();

    pending.resolve({} as Table);
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
    const pending = deferred<Table>();
    duckdbMocks.connection.query.mockImplementationOnce(() => pending.promise);

    const query = database.query('SELECT * FROM events;');
    await vi.waitFor(() => expect(duckdbMocks.connection.query).toHaveBeenCalledTimes(6));
    const disposal = database.dispose();

    await vi.waitFor(() => expect(duckdbMocks.connection.cancelSent).toHaveBeenCalledOnce());
    expect(duckdbMocks.connection.close).not.toHaveBeenCalled();
    pending.resolve({} as Table);
    await query;
    await disposal;
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
});
