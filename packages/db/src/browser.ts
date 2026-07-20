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
import type { TableSchema } from '@byteql/core';
import { tableFromIPC } from 'apache-arrow';
import { RecordBatchStreamWriter } from 'apache-arrow-duckdb';

import type {
  ByteqlDatabase,
  FileStatisticsSummary,
  IngestOptions,
  IngestSession,
  QueryResult,
  TableSummary,
} from './types.js';
import { deleteSpillGeneration, isQuotaError, spillPath } from './spill-files.js';

// DuckDB-WASM loads parquet dynamically. ByteQL mirrors both signed platform variants under this
// same-origin repository; letting LOAD use DuckDB's default would leak a request to
// extensions.duckdb.org during startup. Set the repository before LOAD, then disable all further
// extension loading below.
const LOCAL_EXTENSION_REPOSITORY_PATH = '/duckdb-extensions';

// Order matters: the spill whitelist must be set BEFORE external access is disabled
// (DuckDB rejects changing allowed_directories once external access is off), then lock.
// Task 1 spike rung 1 — allowed_directories works with external access disabled.
const HARDENING_STATEMENTS = [
  "SET allowed_directories = ['opfs://byteql-spill/'];",
  'SET enable_external_access = false;',
  'SET autoinstall_known_extensions = false;',
  'SET autoload_known_extensions = false;',
  'SET allow_community_extensions = false;',
  'SET lock_configuration = true;',
] as const;

/** Spill-tier rotation threshold: flush a table's staged batches to parquet past this size. */
const ROTATION_THRESHOLD_BYTES = 96 * 1024 * 1024;

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

/** The DuckDB catalog kind a committed final was created as; drives which typed DROP applies. */
type CatalogKind = 'table' | 'view';

export interface BrowserDatabaseOptions {
  logger?: Logger;
  /** Whether the spill tier's OPFS-backed persistence is available. Defaults to feature-detection. */
  spillSupported?: boolean;
}

const defaultSpillSupported = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const loadLocalParquetStatement = (moduleUrl: string): string => {
  const base = typeof location === 'undefined' ? 'http://localhost' : location.origin;
  const platform = moduleUrl.includes('mvp') ? 'wasm_mvp' : 'wasm_eh';
  const extension = new URL(
    `${LOCAL_EXTENSION_REPOSITORY_PATH}/v1.5.4/${platform}/parquet.duckdb_extension.wasm`,
    base,
  ).href;
  return `LOAD '${extension.replaceAll("'", "''")}';`;
};

const prepareWasmModule = async (
  moduleUrl: string,
): Promise<{ readonly url: string; readonly release: () => void }> => {
  if (!moduleUrl.endsWith('.wasm.gz')) {
    return { url: moduleUrl, release: () => undefined };
  }

  const response = await fetch(moduleUrl);
  if (!response.ok) {
    throw new Error(`Failed to load compressed DuckDB-WASM module: HTTP ${response.status}.`);
  }
  if (!response.body) {
    throw new Error('Failed to load compressed DuckDB-WASM module: response body is unavailable.');
  }

  const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'));
  const blob = await new Response(decompressed, {
    headers: { 'Content-Type': 'application/wasm' },
  }).blob();
  const url = URL.createObjectURL(blob);
  return { url, release: () => URL.revokeObjectURL(url) };
};

/**
 * Issues exactly one type-correct drop for a recorded final. DuckDB (even pinned 1.33.1-dev57.0)
 * throws a Catalog Error on `DROP VIEW IF EXISTS t` when `t` is a table (and vice versa), so the
 * blind "drop both" pattern is never safe against a real database — only a single, kind-correct
 * drop is.
 */
const dropFinal = async (
  connection: AsyncDuckDBConnection,
  name: string,
  kind: CatalogKind,
): Promise<void> => {
  const keyword = kind === 'view' ? 'DROP VIEW IF EXISTS' : 'DROP TABLE IF EXISTS';
  await connection.query(`${keyword} ${quoteIdentifier(name)};`);
};

const ARROW_TYPE_TO_DUCKDB_TYPE: Readonly<Record<string, string>> = {
  int8: 'TINYINT',
  int16: 'SMALLINT',
  int32: 'INTEGER',
  int64: 'BIGINT',
  uint8: 'UTINYINT',
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

/** Validates ingest schema table names: identifier syntax and case-insensitive uniqueness. */
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

/** The subset of `AsyncDuckDB` the spill tier needs: whitelisting an OPFS path as writable. */
interface OpfsFileRegistrar {
  registerOPFSFileName(path: string): Promise<void>;
}

class IngestSessionImpl implements IngestSession {
  private state: IngestState = 'open';
  private readonly created = new Set<string>();
  private readonly rowCounts = new Map<string, number>();
  // Spill tier only: bytes staged since the last rotation, the next chunk index to write, and
  // every chunk path written so far. `chunkPaths` becomes the explicit `parquet_scan([...])`
  // array at finalize — never a glob (the Task 1 spike found opfs:// globs do not enumerate in
  // this duckdb-wasm build).
  private readonly stagedBytes = new Map<string, number>();
  private readonly chunkIndex = new Map<string, number>();
  private readonly chunkPaths = new Map<string, string[]>();

  constructor(
    private readonly generation: number,
    private readonly schemaMode: SchemaMode,
    private readonly tier: 'memory' | 'spill',
    private readonly rotationBytes: number,
    private readonly opfs: OpfsFileRegistrar,
    private readonly enqueue: EnqueueFn,
    private readonly getFinalTableNames: () => ReadonlyMap<string, CatalogKind>,
    private readonly setFinalTableNames: (finals: ReadonlyMap<string, CatalogKind>) => void,
    private readonly getSpillGeneration: () => number | null,
    private readonly setSpillGeneration: (generation: number | null) => void,
    private readonly onSettled: () => void,
  ) {}

  /** The set of tables this session is responsible for finalizing/aborting. */
  private sessionTables(): readonly string[] {
    return this.schemaMode.kind === 'declared' ? [...this.schemaMode.schemas.keys()] : [...this.created];
  }

  /** Copies a staging table's currently-staged rows to the next parquet chunk and empties it. */
  private async rotateChunk(connection: AsyncDuckDBConnection, table: string): Promise<void> {
    const index = this.chunkIndex.get(table) ?? 0;
    const path = spillPath(this.generation, table, index);
    const stagingName = stagingTableName(this.generation, table);
    await this.opfs.registerOPFSFileName(path);
    await connection.query(`COPY ${quoteIdentifier(stagingName)} TO '${path}' (FORMAT parquet);`);
    await connection.query(`DELETE FROM ${quoteIdentifier(stagingName)};`);
    this.chunkIndex.set(table, index + 1);
    this.chunkPaths.set(table, [...(this.chunkPaths.get(table) ?? []), path]);
    this.stagedBytes.set(table, 0);
  }

  /** Best-effort drop of every staging table this session owns, outside a transaction. */
  private async dropStaging(connection: AsyncDuckDBConnection): Promise<void> {
    for (const table of this.sessionTables()) {
      const stagingName = stagingTableName(this.generation, table);
      try {
        await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(stagingName)};`);
      } catch {
        // Best-effort cleanup outside a transaction; ignore failures dropping staging tables.
      }
    }
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
    // `insertArrowFromIPCStream` transfers `copy`'s underlying `ArrayBuffer` across the
    // duckdb-wasm worker boundary (structured clone with transfer, for a zero-copy handoff), so
    // `copy.byteLength` reads back as 0 once that call resolves — capture it up front instead.
    const byteLength = copy.byteLength;
    const stagingName = stagingTableName(this.generation, table);
    const create = !this.created.has(table);

    let quotaAborted = false;
    try {
      await this.enqueue(async (connection) => {
        if (this.state !== 'open') {
          throw new Error(`Ingest session is ${this.state}; cannot append to ${JSON.stringify(table)}.`);
        }
        await connection.insertArrowFromIPCStream(copy, { name: stagingName, create });
        this.created.add(table);
        this.rowCounts.set(table, (this.rowCounts.get(table) ?? 0) + rowCount);

        if (this.tier !== 'spill') {
          return;
        }
        const staged = (this.stagedBytes.get(table) ?? 0) + byteLength;
        this.stagedBytes.set(table, staged);
        if (staged < this.rotationBytes) {
          return;
        }
        try {
          await this.rotateChunk(connection, table);
        } catch (error) {
          if (!isQuotaError(error)) {
            throw error;
          }
          quotaAborted = true;
          this.state = 'aborted';
          await this.dropStaging(connection);
          throw new Error(`SPILL_QUOTA_EXCEEDED: failed to spill ${JSON.stringify(table)} to OPFS.`, {
            cause: error,
          });
        }
      });
    } catch (error) {
      if (quotaAborted) {
        await deleteSpillGeneration(this.generation);
        this.onSettled();
      }
      throw error;
    }
  }

  async finalize(backfillSchemas?: readonly TableSchema[]): Promise<readonly TableSummary[]> {
    if (this.state !== 'open') {
      throw new Error(`Ingest session is ${this.state}; cannot finalize.`);
    }
    this.state = 'finalized';
    try {
      if (this.tier === 'spill') {
        // Flush every table's residual (never-rotated) staged rows as one final chunk, outside
        // the swap transaction, so the transaction only ever touches metadata.
        await this.enqueue(async (connection) => {
          for (const table of this.sessionTables()) {
            if (this.created.has(table) && (this.stagedBytes.get(table) ?? 0) > 0) {
              try {
                await this.rotateChunk(connection, table);
              } catch (error) {
                if (!isQuotaError(error)) {
                  throw error;
                }
                // Same tagging as appendBatch's mid-ingest rotation (Trivia 2), so the controller
                // shows its clear "ran out of space" message instead of a raw DB/OS error string.
                throw new Error(`SPILL_QUOTA_EXCEEDED: failed to spill ${JSON.stringify(table)} to OPFS.`, {
                  cause: error,
                });
              }
            }
          }
        });
      }

      const declaredSchemas = this.schemaMode.kind === 'declared' ? this.schemaMode.schemas : null;
      // Discover mode only: a pack schema for a table this session never saw an `appendBatch`
      // for (e.g. no `tcp` packets in this capture). Backfilled so the table still exists —
      // callers (like a UNION ALL overview query) assume every pack table exists, not just the
      // ones this particular file happened to populate.
      const backfillByName = new Map((backfillSchemas ?? []).map((schema) => [schema.name, schema]));
      const schemaFor = (table: string): TableSchema | undefined =>
        declaredSchemas?.get(table) ?? backfillByName.get(table);
      const finalizeTables: readonly string[] =
        this.schemaMode.kind === 'declared'
          ? this.sessionTables()
          : [...new Set([...this.created, ...backfillByName.keys()])];

      const summaries = await this.enqueue(async (connection) => {
        await connection.query('BEGIN TRANSACTION;');
        try {
          for (const [name, kind] of this.getFinalTableNames()) {
            // The old final name may be a view (a prior spill generation) or a table (a prior
            // memory generation); its recorded kind says exactly which single drop applies.
            await dropFinal(connection, name, kind);
          }

          const finalKinds = new Map<string, CatalogKind>();
          const summaries: TableSummary[] = [];
          for (const table of finalizeTables) {
            const stagingName = stagingTableName(this.generation, table);
            const chunks = this.chunkPaths.get(table) ?? [];
            if (this.tier === 'spill' && this.created.has(table) && chunks.length > 0) {
              // Explicit path array from the tracked chunk names — never a glob (spike finding).
              const pathList = chunks.map((path) => `'${path}'`).join(', ');
              await connection.query(
                `CREATE VIEW ${quoteIdentifier(table)} AS SELECT * FROM parquet_scan([${pathList}]);`,
              );
              await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(stagingName)};`);
              finalKinds.set(table, 'view');
            } else {
              if (!this.created.has(table)) {
                // A table that was never appended to: either a declared schema no rows arrived
                // for, a discover-mode table backfilled from `backfillSchemas`, or a spill-tier
                // table with zero rotated/residual chunks. Falls back to an empty TABLE rather
                // than a view over nothing.
                const schema = schemaFor(table);
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
              finalKinds.set(table, 'table');
            }
            summaries.push({ name: table, rowCount: this.rowCounts.get(table) ?? 0 });
          }

          await connection.query('COMMIT;');
          this.setFinalTableNames(finalKinds);
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

      if (this.tier === 'spill') {
        const previousGeneration = this.getSpillGeneration();
        this.setSpillGeneration(this.generation);
        if (previousGeneration !== null) {
          await deleteSpillGeneration(previousGeneration);
        }
      } else {
        // I2: a memory-tier finalize's DROP (inside the transaction above) already replaced any
        // previous spill-backed views with this generation's plain tables, so the old
        // generation's OPFS parquet payload is now orphaned — reclaim it the same best-effort
        // way the spill-tier branch does, rather than leaving it until the next launch's orphan
        // sweep or session dispose. No spill generation backs the catalog anymore, so clear it.
        const previousGeneration = this.getSpillGeneration();
        if (previousGeneration !== null) {
          this.setSpillGeneration(null);
          await deleteSpillGeneration(previousGeneration);
        }
      }

      return summaries;
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
      await this.enqueue((connection) => this.dropStaging(connection));
      if (this.tier === 'spill') {
        await deleteSpillGeneration(this.generation);
      }
    } finally {
      this.onSettled();
    }
  }
}

class BrowserDatabase implements ByteqlDatabase {
  private connection: AsyncDuckDBConnection | null = null;
  private initializePromise: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  /** Committed finals, keyed by name, with the catalog kind each was created as. */
  private finalNames: Map<string, CatalogKind> = new Map();
  private disposePromise: Promise<void> | null = null;
  private disposeRequested = false;
  private closePromise: Promise<void> | null = null;
  private terminatePromise: Promise<void> | null = null;
  private queryInFlight = false;
  private activeIngest: IngestSessionImpl | null = null;
  /** The generation currently backing committed spill views, or `null` before any spill finalize. */
  private spillGeneration: number | null = null;
  /**
   * The in-flight (not yet finalized or aborted) spill-tier ingest's generation, or `null` when
   * no spill-tier ingest is currently open. Cleared alongside `activeIngest` once that session
   * settles — a settled session's spill directory is already handled either by `finalize()`
   * (rolled into `spillGeneration`) or by `abort()`'s own cleanup. Tracked separately so
   * `dispose()` can reclaim it immediately for a session that is neither (Trivia 3).
   */
  private activeIngestSpillGeneration: number | null = null;

  constructor(
    private readonly database: AsyncDuckDB,
    private readonly bundle: DuckDBBundle,
    private readonly spillSupported: boolean,
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
      const module = await prepareWasmModule(this.bundle.mainModule);
      try {
        await this.database.instantiate(module.url, this.bundle.pthreadWorker);
      } finally {
        module.release();
      }
      const connection = await this.database.connect();
      this.connection = connection;
      await connection.query(loadLocalParquetStatement(this.bundle.mainModule));
      for (const statement of HARDENING_STATEMENTS) {
        await connection.query(statement);
      }
    } catch (error) {
      await this.cleanupAfterInitializationFailure();
      throw error;
    }
  }

  async beginIngest(options: IngestOptions): Promise<IngestSession> {
    if (this.disposeRequested) {
      throw new Error('ByteQL database has been disposed.');
    }
    if (options.tier === 'spill' && !this.spillSupported) {
      throw new Error('SPILL_UNSUPPORTED: OPFS storage is not available in this environment.');
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
      options.tier,
      options.rotationBytes ?? ROTATION_THRESHOLD_BYTES,
      this.database,
      (operation) => this.enqueue(operation),
      () => this.finalNames,
      (finals) => {
        this.finalNames = new Map(finals);
      },
      () => this.spillGeneration,
      (generation) => {
        this.spillGeneration = generation;
      },
      () => {
        if (this.activeIngest === session) {
          this.activeIngest = null;
          this.activeIngestSpillGeneration = null;
        }
      },
    );
    this.activeIngest = session;
    this.activeIngestSpillGeneration = options.tier === 'spill' ? options.generation : null;
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
    return [...this.finalNames.keys()];
  }

  collectFileStatistics(path: string, enable: boolean): Promise<void> {
    return this.enqueue(() => this.database.collectFileStatistics(path, enable));
  }

  exportFileStatistics(path: string): Promise<FileStatisticsSummary> {
    return this.enqueue(async () => {
      const stats = await this.database.exportFileStatistics(path);
      // Narrow to the plain-data subset ByteqlDatabase declares — drop the class's blockStats
      // buffer and getBlockStats() method (see the FileStatisticsSummary doc comment).
      return {
        totalFileReadsCold: stats.totalFileReadsCold,
        totalFileReadsAhead: stats.totalFileReadsAhead,
        totalFileReadsCached: stats.totalFileReadsCached,
        totalFileWrites: stats.totalFileWrites,
        totalPageAccesses: stats.totalPageAccesses,
        totalPageLoads: stats.totalPageLoads,
        blockSize: stats.blockSize,
      };
    });
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

    if (this.spillGeneration !== null) {
      // Best-effort: reclaim the current generation's OPFS spill directory on teardown.
      await deleteSpillGeneration(this.spillGeneration).catch(() => undefined);
    }
    if (this.activeIngestSpillGeneration !== null) {
      // Trivia (3): a spill-tier ingest still open at dispose (neither finalized nor aborted)
      // has its own, separately-tracked generation — reclaim it immediately too, unconditionally
      // and best-effort, rather than leaving it for the next launch's orphan sweep.
      await deleteSpillGeneration(this.activeIngestSpillGeneration).catch(() => undefined);
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
    const spillSupported = options.spillSupported ?? defaultSpillSupported();
    return new BrowserDatabase(database, bundle, spillSupported);
  } catch (error) {
    worker.terminate();
    throw error;
  }
};
