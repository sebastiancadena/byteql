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
import type { TableSchema, TableTransfer } from '@byteql/core';
import { tableFromIPC } from 'apache-arrow';
import { RecordBatchStreamWriter } from 'apache-arrow-duckdb';

import type { ByteqlDatabase, IngestOptions, IngestSession, QueryResult, TableSummary } from './types.js';

const HARDENING_STATEMENTS = [
  'SET enable_external_access = false;',
  'SET autoinstall_known_extensions = false;',
  'SET autoload_known_extensions = false;',
  'SET allow_community_extensions = false;',
  'SET lock_configuration = true;',
] as const;

/** @internal exported for reuse by the OPFS spill capability probe. */
export const LOCAL_BUNDLES: DuckDBBundles = {
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

const ARROW_TYPE_TO_DUCKDB_TYPE: Readonly<Record<string, string>> = {
  int8: 'TINYINT',
  int16: 'SMALLINT',
  int32: 'INTEGER',
  int64: 'BIGINT',
  uint16: 'USMALLINT',
  uint32: 'UINTEGER',
  uint64: 'UBIGINT',
  float64: 'DOUBLE',
  bool: 'BOOLEAN',
  utf8: 'VARCHAR',
  binary: 'BLOB',
  timestamp_us: 'TIMESTAMP',
};

const duckdbColumnType = (type: string): string => {
  const mapped = ARROW_TYPE_TO_DUCKDB_TYPE[type];
  if (!mapped) {
    throw new Error(`Unsupported ingest column type: ${JSON.stringify(type)}`);
  }
  return mapped;
};

const stagingTableName = (generation: number, table: string): string => `__ingest_${generation}_${table}`;

/** Validates ingest schema table names exactly as `snapshotTables` does for `replaceTables`. */
const validateIngestSchemas = (schemas: readonly TableSchema[]): ReadonlyMap<string, TableSchema> => {
  const schemasByName = new Map<string, TableSchema>();
  const canonicalNames = new Set<string>();
  for (const schema of schemas) {
    if (!IDENTIFIER.test(schema.name)) {
      throw new Error(`Invalid table identifier: ${JSON.stringify(schema.name)}`);
    }
    const canonicalName = schema.name.toLowerCase();
    if (canonicalNames.has(canonicalName)) {
      throw new Error(`Duplicate table identifier: ${JSON.stringify(schema.name)}`);
    }
    canonicalNames.add(canonicalName);
    schemasByName.set(schema.name, schema);
  }
  return schemasByName;
};

type IngestState = 'open' | 'finalized' | 'aborted' | 'failed';

type SchemaMode =
  | { readonly kind: 'declared'; readonly schemas: ReadonlyMap<string, TableSchema> }
  | { readonly kind: 'discover' };

type EnqueueFn = <T>(operation: (connection: AsyncDuckDBConnection) => Promise<T>) => Promise<T>;

class IngestSessionImpl implements IngestSession {
  private state: IngestState = 'open';
  private readonly created = new Set<string>();
  private readonly rowCounts = new Map<string, number>();

  constructor(
    private readonly generation: number,
    private readonly schemaMode: SchemaMode,
    private readonly enqueue: EnqueueFn,
    private readonly getFinalTableNames: () => readonly string[],
    private readonly setFinalTableNames: (names: readonly string[]) => void,
    private readonly onSettled: () => void,
  ) {}

  /** The set of tables this session is responsible for finalizing/aborting. */
  private sessionTables(): readonly string[] {
    return this.schemaMode.kind === 'declared' ? [...this.schemaMode.schemas.keys()] : [...this.created];
  }

  async appendBatch(table: string, ipc: Uint8Array): Promise<void> {
    if (this.state !== 'open') {
      throw new Error(`Ingest session is ${this.state}; cannot append to ${JSON.stringify(table)}.`);
    }
    if (this.schemaMode.kind === 'declared') {
      if (!this.schemaMode.schemas.has(table)) {
        throw new Error(`Undeclared ingest table: ${JSON.stringify(table)}`);
      }
    } else if (!IDENTIFIER.test(table)) {
      throw new Error(`Invalid table identifier: ${JSON.stringify(table)}`);
    }

    const rowCount = tableFromIPC(ipc).numRows;
    const copy = ipc.slice();
    const stagingName = stagingTableName(this.generation, table);
    const create = !this.created.has(table);

    await this.enqueue(async (connection) => {
      if (this.state !== 'open') {
        throw new Error(`Ingest session is ${this.state}; cannot append to ${JSON.stringify(table)}.`);
      }
      await connection.insertArrowFromIPCStream(copy, { name: stagingName, create });
      this.created.add(table);
      this.rowCounts.set(table, (this.rowCounts.get(table) ?? 0) + rowCount);
    });
  }

  async finalize(): Promise<readonly TableSummary[]> {
    if (this.state !== 'open') {
      throw new Error(`Ingest session is ${this.state}; cannot finalize.`);
    }
    this.state = 'finalized';
    try {
      return await this.enqueue(async (connection) => {
        await connection.query('BEGIN TRANSACTION;');
        try {
          for (const name of this.getFinalTableNames()) {
            await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(name)};`);
          }

          const declaredSchemas = this.schemaMode.kind === 'declared' ? this.schemaMode.schemas : null;
          const finalNames: string[] = [];
          const summaries: TableSummary[] = [];
          for (const table of this.sessionTables()) {
            const stagingName = stagingTableName(this.generation, table);
            if (!this.created.has(table)) {
              // discover-mode session tables come only from `created`, so every discover-mode
              // table has already been appended; only declared schemas reach this branch.
              const schema = declaredSchemas?.get(table);
              if (!schema) {
                throw new Error(`Missing schema for never-appended ingest table: ${JSON.stringify(table)}`);
              }
              const columnsDdl = schema.columns
                .map((column) => `${quoteIdentifier(column.name)} ${duckdbColumnType(column.type)}`)
                .join(', ');
              await connection.query(`CREATE TABLE ${quoteIdentifier(stagingName)} (${columnsDdl});`);
            }
            await connection.query(
              `ALTER TABLE ${quoteIdentifier(stagingName)} RENAME TO ${quoteIdentifier(table)};`,
            );
            finalNames.push(table);
            summaries.push({ name: table, rowCount: this.rowCounts.get(table) ?? 0 });
          }

          await connection.query('COMMIT;');
          this.setFinalTableNames(finalNames);
          return summaries;
        } catch (error) {
          try {
            await connection.query('ROLLBACK;');
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Ingest finalize and rollback failed.', {
              cause: rollbackError,
            });
          }
          throw error;
        }
      });
    } catch (error) {
      this.state = 'failed';
      throw error;
    } finally {
      this.onSettled();
    }
  }

  async abort(): Promise<void> {
    if (this.state !== 'open' && this.state !== 'failed') {
      return;
    }
    this.state = 'aborted';
    try {
      await this.enqueue(async (connection) => {
        for (const table of this.sessionTables()) {
          const stagingName = stagingTableName(this.generation, table);
          try {
            await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(stagingName)};`);
          } catch {
            // Best-effort cleanup outside a transaction; ignore failures dropping staging tables.
          }
        }
      });
    } finally {
      this.onSettled();
    }
  }
}

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
  private activeIngest: IngestSessionImpl | null = null;

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

  async beginIngest(options: IngestOptions): Promise<IngestSession> {
    if (this.disposeRequested) {
      throw new Error('ByteQL database has been disposed.');
    }
    if (options.tier === 'spill') {
      throw new Error('Spill tier ingest is not implemented until Task 7.');
    }
    if (!Number.isInteger(options.generation) || options.generation < 0) {
      throw new Error(
        `Ingest generation must be a non-negative integer: ${JSON.stringify(options.generation)}`,
      );
    }
    if (this.activeIngest) {
      throw new Error('An ingest session is already open.');
    }

    const schemaMode: SchemaMode =
      options.schemas === 'discover'
        ? { kind: 'discover' }
        : { kind: 'declared', schemas: validateIngestSchemas(options.schemas) };

    const session: IngestSessionImpl = new IngestSessionImpl(
      options.generation,
      schemaMode,
      (operation) => this.enqueue(operation),
      () => this.tableNames,
      (names) => {
        this.tableNames = names;
      },
      () => {
        if (this.activeIngest === session) {
          this.activeIngest = null;
        }
      },
    );
    this.activeIngest = session;
    return session;
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
