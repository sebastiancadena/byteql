/// <reference types="vite/client" />

import {
  AsyncDuckDB,
  VoidLogger,
  selectBundle,
  type AsyncDuckDBConnection,
  type DuckDBBundle,
  type DuckDBBundles,
  type Logger,
} from '@duckdb/duckdb-wasm';
import duckdbEhWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import duckdbEhWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import duckdbMvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdbMvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import type { TableTransfer } from '@byteql/core';
import { tableFromIPC } from 'apache-arrow';
import { RecordBatchStreamWriter } from 'apache-arrow-duckdb';

import type { ByteqlDatabase, QueryResult } from './types.js';

const HARDENING_STATEMENTS = [
  'SET enable_external_access = false;',
  'SET autoinstall_known_extensions = false;',
  'SET autoload_known_extensions = false;',
  'SET allow_community_extensions = false;',
  'SET lock_configuration = true;',
] as const;

const LOCAL_BUNDLES: DuckDBBundles = {
  mvp: {
    mainModule: duckdbMvpWasm,
    mainWorker: duckdbMvpWorker,
  },
  eh: {
    mainModule: duckdbEhWasm,
    mainWorker: duckdbEhWorker,
  },
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface TableSnapshot {
  readonly name: string;
  readonly ipc: Uint8Array;
}

export interface BrowserDatabaseOptions {
  logger?: Logger;
}

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const snapshotTables = (tables: readonly TableTransfer[]): readonly TableSnapshot[] => {
  const names = new Set<string>();
  return tables.map((table) => {
    if (!IDENTIFIER.test(table.name)) {
      throw new Error(`Invalid table identifier: ${JSON.stringify(table.name)}`);
    }
    const canonicalName = table.name.toLowerCase();
    if (names.has(canonicalName)) {
      throw new Error(`Duplicate table identifier: ${JSON.stringify(table.name)}`);
    }
    names.add(canonicalName);
    return { name: table.name, ipc: table.ipc.slice() };
  });
};

class BrowserDatabase implements ByteqlDatabase {
  private connection: AsyncDuckDBConnection | null = null;
  private initializePromise: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private tableNames: readonly string[] = [];
  private disposePromise: Promise<void> | null = null;
  private disposeRequested = false;
  private closePromise: Promise<void> | null = null;
  private terminatePromise: Promise<void> | null = null;
  private queryInFlight = false;

  constructor(
    private readonly database: AsyncDuckDB,
    private readonly bundle: DuckDBBundle,
  ) {}

  initialize(): Promise<void> {
    if (this.disposeRequested) {
      return Promise.reject(new Error('ByteQL database has been disposed.'));
    }
    this.initializePromise ??= this.initializeInternal();
    return this.initializePromise;
  }

  private async initializeInternal(): Promise<void> {
    try {
      await this.database.instantiate(this.bundle.mainModule, this.bundle.pthreadWorker);
      const connection = await this.database.connect();
      this.connection = connection;
      for (const statement of HARDENING_STATEMENTS) {
        await connection.query(statement);
      }
    } catch (error) {
      await this.cleanupAfterInitializationFailure();
      throw error;
    }
  }

  async replaceTables(tables: readonly TableTransfer[]): Promise<void> {
    const snapshots = snapshotTables(tables);
    return this.enqueue(async (connection) => {
      await connection.query('BEGIN TRANSACTION;');
      try {
        for (const name of this.tableNames) {
          await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(name)};`);
        }
        for (const table of snapshots) {
          await connection.insertArrowFromIPCStream(table.ipc, {
            name: table.name,
            create: true,
          });
        }
        await connection.query('COMMIT;');
        this.tableNames = snapshots.map(({ name }) => name);
      } catch (error) {
        try {
          await connection.query('ROLLBACK;');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Table replacement and rollback failed.', {
            cause: rollbackError,
          });
        }
        throw error;
      }
    });
  }

  query(sql: string): Promise<QueryResult> {
    return this.enqueue(async (connection) => {
      const startedAt = performance.now();
      this.queryInFlight = true;
      try {
        const reader = await connection.send(sql);
        const writer = await RecordBatchStreamWriter.writeAll(reader);
        const ipc = await writer.toUint8Array();
        const table = tableFromIPC(ipc);
        return { table, elapsedMs: performance.now() - startedAt };
      } finally {
        this.queryInFlight = false;
      }
    });
  }

  async cancelQuery(): Promise<boolean> {
    if (this.disposeRequested) {
      return false;
    }
    await this.initialize();
    return this.getConnection().cancelSent();
  }

  async listTables(): Promise<readonly string[]> {
    return [...this.tableNames];
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposeRequested = true;
    this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    const errors: unknown[] = [];

    if (this.queryInFlight && this.connection) {
      try {
        await this.connection.cancelSent();
      } catch (error) {
        errors.push(error);
      }
    }
    await this.operationTail;
    if (this.initializePromise) {
      try {
        await this.initializePromise;
      } catch {
        // Initialization performs its own best-effort cleanup.
      }
    }

    try {
      await this.closeConnection();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.terminateDatabase();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Failed to dispose the ByteQL database.');
    }
  }

  private enqueue<T>(operation: (connection: AsyncDuckDBConnection) => Promise<T>): Promise<T> {
    if (this.disposeRequested) {
      return Promise.reject(new Error('ByteQL database has been disposed.'));
    }

    const result = this.operationTail.then(async () => {
      if (this.disposeRequested) {
        throw new Error('ByteQL database has been disposed.');
      }
      await this.initialize();
      if (this.disposeRequested) {
        throw new Error('ByteQL database has been disposed.');
      }
      return operation(this.getConnection());
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private getConnection(): AsyncDuckDBConnection {
    if (!this.connection) {
      throw new Error('ByteQL database is not initialized.');
    }
    return this.connection;
  }

  private async cleanupAfterInitializationFailure(): Promise<void> {
    try {
      await this.closeConnection();
    } catch {
      // Preserve the initialization error.
    }
    try {
      await this.terminateDatabase();
    } catch {
      // Preserve the initialization error.
    }
  }

  private closeConnection(): Promise<void> {
    if (!this.connection) {
      return Promise.resolve();
    }
    this.closePromise ??= this.connection.close();
    return this.closePromise;
  }

  private terminateDatabase(): Promise<void> {
    this.terminatePromise ??= this.database.terminate();
    return this.terminatePromise;
  }
}

export const createBrowserDatabase = async (
  options: BrowserDatabaseOptions = {},
): Promise<ByteqlDatabase> => {
  const bundle = await selectBundle(LOCAL_BUNDLES);
  if (!bundle.mainWorker) {
    throw new Error('DuckDB-WASM did not select a browser worker.');
  }

  const worker = new Worker(bundle.mainWorker);
  try {
    const database = new AsyncDuckDB(options.logger ?? new VoidLogger(), worker);
    return new BrowserDatabase(database, bundle);
  } catch (error) {
    worker.terminate();
    throw error;
  }
};
