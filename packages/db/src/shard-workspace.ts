import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { tableToIPC, type Table } from 'apache-arrow';
import type { RecordBatch as DuckdbRecordBatch, Schema as DuckdbSchema } from 'apache-arrow-duckdb';

import type { ExportFiles } from './export-files.js';
import { quoteIdentifier, quoteString } from './sql.js';

export interface ShardWorkspaceDependencies {
  readonly database: Pick<AsyncDuckDB, 'registerOPFSFileName' | 'dropFile'>;
  connect(): Promise<AsyncDuckDBConnection>;
  createFiles(): Promise<ExportFiles>;
  /**
   * Called for every resource that could not be released, with a closure that retries it, so the
   * caller can attempt it again later. A resource is never silently declared released.
   */
  onCleanupFailure?(retry: () => Promise<void>, error: unknown): void;
}

/**
 * How each page reaches DuckDB before it is copied to its shard.
 *
 * - `table-per-shard`: every page is imported into a freshly created table under `table`, copied,
 *   and dropped again, so each shard's column types come from its own page.
 * - `temp-table`: one connection-local TEMP table under `table`, whose exact column types are
 *   established once from a zero-row insert into a seed table with a generated name (`seedPrefix`
 *   plus a UUID), then reused page after page through TRUNCATE. TEMP keeps it invisible to the
 *   rest of the database and disposed of by closing the connection.
 */
export type ShardStaging =
  | { readonly kind: 'table-per-shard'; readonly table: string }
  | { readonly kind: 'temp-table'; readonly table: string; readonly seedPrefix: string };

export interface ShardWorkspaceOptions {
  readonly staging: ShardStaging;
  /** Names the operation in combined error messages, e.g. `Parquet export`. */
  readonly label: string;
  /** Cancels this workspace's statements, and only this workspace's connection. */
  readonly signal: AbortSignal;
}

/**
 * Wraps a primary failure together with the cleanup failures it caused, keeping the primary first
 * and as the cause. Without cleanup failures the primary is returned unchanged.
 */
export const combineErrors = (primary: unknown, cleanup: readonly unknown[], message: string): unknown => {
  if (cleanup.length === 0) return primary;
  return new AggregateError([primary, ...cleanup], message, { cause: primary });
};

/**
 * The private scratch an operation stages retained result pages into as Parquet shards: owned OPFS
 * files, a dedicated DuckDB connection, and the file names registered with DuckDB.
 *
 * Release order is load-bearing: the connection is closed before registered paths are dropped (a
 * live connection can still hold a shard open), and every cleanup is attempted even when an earlier
 * one fails. Every failure is both returned to the caller and handed to `onCleanupFailure`.
 */
export class ShardWorkspace {
  private readonly registeredPaths: string[] = [];
  private connection: AsyncDuckDBConnection | null = null;
  private filesDisposed = false;
  private stagingReady = false;

  private constructor(
    private readonly dependencies: ShardWorkspaceDependencies,
    private readonly options: ShardWorkspaceOptions,
    readonly files: ExportFiles,
  ) {}

  /** Allocates the scratch files. The connection is opened separately, by {@link connect}. */
  static async open(
    dependencies: ShardWorkspaceDependencies,
    options: ShardWorkspaceOptions,
  ): Promise<ShardWorkspace> {
    return new ShardWorkspace(dependencies, options, await dependencies.createFiles());
  }

  async connect(): Promise<void> {
    this.connection = await this.dependencies.connect();
  }

  private get activeConnection(): AsyncDuckDBConnection {
    if (!this.connection) throw new Error('The shard workspace has no open connection.');
    return this.connection;
  }

  /** Registers an owned file name with DuckDB and tracks it for release. */
  async register(name: string): Promise<string> {
    const path = this.files.path(name);
    await this.dependencies.database.registerOPFSFileName(path);
    this.registeredPaths.push(path);
    return path;
  }

  /** Stages `table` through the configured staging table and copies it to a new shard `name`. */
  writeShard(table: Table, name: string): Promise<string> {
    return this.options.staging.kind === 'temp-table'
      ? this.writeTempTableShard(this.options.staging, table, name)
      : this.writeTablePerShard(this.options.staging.table, table, name);
  }

  private async writeTablePerShard(stagingTable: string, table: Table, name: string): Promise<string> {
    this.options.signal.throwIfAborted();
    const connection = this.activeConnection;
    await connection.insertArrowFromIPCStream(tableToIPC(table, 'stream').slice(), {
      name: stagingTable,
      create: true,
    });
    const path = await this.register(name);
    let primary: unknown = null;
    try {
      await this.runStatement(
        `COPY ${quoteIdentifier(stagingTable)} TO ${quoteString(path)} (FORMAT PARQUET, COMPRESSION SNAPPY)`,
      );
    } catch (error) {
      primary = error;
    }
    let cleanupError: unknown = null;
    try {
      await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(stagingTable)}`);
    } catch (error) {
      cleanupError = error;
    }
    if (primary !== null && cleanupError !== null) {
      throw new AggregateError(
        [primary, cleanupError],
        `${this.options.label} shard COPY and temporary-table cleanup failed.`,
        { cause: primary },
      );
    }
    if (cleanupError !== null) throw cleanupError;
    if (primary !== null) throw primary;
    return path;
  }

  private async writeTempTableShard(
    staging: Extract<ShardStaging, { kind: 'temp-table' }>,
    table: Table,
    name: string,
  ): Promise<string> {
    const connection = this.activeConnection;
    if (!this.stagingReady) {
      const seed = `${staging.seedPrefix}${crypto.randomUUID().replaceAll('-', '')}`;
      const empty = tableToIPC(table.slice(0, 0), 'stream').slice();
      await connection.insertArrowFromIPCStream(empty, { name: seed, create: true });
      this.options.signal.throwIfAborted();
      await connection.query(
        `CREATE TEMP TABLE ${quoteIdentifier(staging.table)} AS ` +
          `SELECT * FROM ${quoteIdentifier(seed)} WHERE false`,
      );
      await connection.query(`DROP TABLE ${quoteIdentifier(seed)}`);
      this.stagingReady = true;
    }
    // insertArrowFromIPCStream is not a cancellable SQL cursor: let it settle, then recheck.
    await connection.insertArrowFromIPCStream(tableToIPC(table, 'stream').slice(), {
      name: staging.table,
      create: false,
    });
    this.options.signal.throwIfAborted();
    const path = await this.register(name);
    await this.runStatement(
      `COPY ${quoteIdentifier(staging.table)} TO ${quoteString(path)} (FORMAT PARQUET, COMPRESSION SNAPPY)`,
    );
    await connection.query(`TRUNCATE ${quoteIdentifier(staging.table)}`);
    return path;
  }

  /** Runs one statement to completion, discarding its output. */
  runStatement(sql: string): Promise<void> {
    return this.stream(sql);
  }

  /**
   * Runs one statement and hands every result batch to `onBatch`, cancelling only this connection
   * if the signal aborts. A cancellation that was sent is always joined before this returns, and a
   * cancellation failure is reported (combined with the primary failure when there is one), never
   * swallowed.
   */
  async stream(
    sql: string,
    onBatch?: (schema: DuckdbSchema, batch: DuckdbRecordBatch) => Promise<void>,
  ): Promise<void> {
    const { signal } = this.options;
    signal.throwIfAborted();
    const connection = this.activeConnection;
    let cancel: Promise<boolean> | null = null;
    const abort = (): void => {
      cancel ??= connection.cancelSent();
    };
    signal.addEventListener('abort', abort, { once: true });
    let primary: unknown = null;
    let iterator: AsyncIterator<DuckdbRecordBatch> | null = null;
    try {
      const reader = await connection.send(sql, true);
      iterator = reader[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) break;
        if (onBatch) await onBatch(reader.schema, next.value);
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
    } catch (error) {
      primary = error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
    let cancelError: unknown = null;
    if (cancel) {
      try {
        await cancel;
      } catch (error) {
        cancelError = error;
      }
    }
    if (primary !== null && iterator) {
      try {
        await iterator.return?.();
      } catch {
        // The reader is already finished or cancelled; that must not mask the primary failure.
      }
    }
    if (cancelError !== null) {
      if (primary !== null) {
        throw combineErrors(primary, [cancelError], `${this.options.label} statement cancellation failed.`);
      }
      throw cancelError;
    }
    if (primary !== null) throw primary;
  }

  /** Closes the connection, then drops every registered path. Idempotent. */
  async releaseHandles(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try {
        // Closing also removes a TEMP staging table; a seed table is dropped during staging.
        await connection.close();
      } catch (error) {
        this.reportCleanupFailure(errors, () => connection.close(), error);
      }
    }
    const paths = [...this.registeredPaths];
    this.registeredPaths.length = 0;
    for (const path of paths) {
      try {
        await this.dependencies.database.dropFile(path);
      } catch (error) {
        this.reportCleanupFailure(
          errors,
          async () => {
            await this.dependencies.database.dropFile(path);
          },
          error,
        );
      }
    }
    return errors;
  }

  /** Releases the handles, then deletes the scratch files. Idempotent. */
  async release(): Promise<unknown[]> {
    const errors = await this.releaseHandles();
    if (!this.filesDisposed) {
      this.filesDisposed = true;
      const files = this.files;
      try {
        await files.dispose();
      } catch (error) {
        this.reportCleanupFailure(errors, () => files.dispose(), error);
      }
    }
    return errors;
  }

  private reportCleanupFailure(errors: unknown[], retry: () => Promise<void>, error: unknown): void {
    errors.push(error);
    this.dependencies.onCleanupFailure?.(retry, error);
  }
}
