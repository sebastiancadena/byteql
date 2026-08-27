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
import { tableFromIPC, type Schema, type Table } from 'apache-arrow';
import {
  RecordBatchStreamWriter,
  Table as DuckdbTable,
  type RecordBatch as DuckdbRecordBatch,
  type Schema as DuckdbSchema,
} from 'apache-arrow-duckdb';

import type {
  ByteqlDatabase,
  FileStatisticsSummary,
  IngestOptions,
  IngestSession,
  QueryPage,
  QueryPageSummary,
  QuerySession,
  QueryStatus,
  TableSummary,
} from './types.js';
import { QUERY_PAGE_ROWS } from './types.js';
import {
  createOpfsQueryPagePersistence,
  QUERY_RESULT_MEMORY_BYTES,
  QueryPageStore,
  type StoredQueryPage,
} from './query-pages.js';
import { deleteSpillChunks, deleteSpillGeneration, isQuotaError, spillPath } from './spill-files.js';

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

const quoteStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const loadLocalParquetStatement = (moduleUrl: string): string => {
  const platform = moduleUrl.includes('mvp') ? 'wasm_mvp' : 'wasm_eh';
  const extension = new URL(
    `${LOCAL_EXTENSION_REPOSITORY_PATH}/v1.5.4/${platform}/parquet.duckdb_extension.wasm`,
    location.origin,
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
  // Per-file boundary tracking (multi-file batches): the display name of the file currently
  // being appended, the chunks rotated for it, and its per-table appended row counts.
  private currentFile: string | null = null;
  private readonly currentFileChunks = new Map<string, string[]>();
  private readonly currentFileRows = new Map<string, number>();

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
    if (this.currentFile !== null) {
      this.currentFileChunks.set(table, [...(this.currentFileChunks.get(table) ?? []), path]);
    }
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
        if (this.currentFile !== null) {
          this.currentFileRows.set(table, (this.currentFileRows.get(table) ?? 0) + rowCount);
        }

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

  async beginFile(file: string): Promise<void> {
    if (this.state !== 'open') {
      throw new Error(`Ingest session is ${this.state}; cannot begin a file.`);
    }
    if (this.tier === 'spill') {
      // File-boundary flush: chunks must never mix files, so the previous file's residual
      // staged rows rotate out before this file's first append. Quota failures get the same
      // SPILL_QUOTA_EXCEEDED tagging as appendBatch so the controller's messaging applies, and
      // the same terminalization: abort the session, drop staging, and reclaim the generation.
      let quotaAborted = false;
      try {
        await this.enqueue(async (connection) => {
          for (const table of this.sessionTables()) {
            if (this.created.has(table) && (this.stagedBytes.get(table) ?? 0) > 0) {
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
            }
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
    this.currentFile = file;
    this.currentFileChunks.clear();
    this.currentFileRows.clear();
  }

  async discardCurrentFile(): Promise<void> {
    if (this.state !== 'open' || this.currentFile === null) {
      return;
    }
    const file = this.currentFile;
    await this.enqueue(async (connection) => {
      for (const table of this.created) {
        const stagingName = stagingTableName(this.generation, table);
        if (this.tier === 'spill') {
          // Post-boundary staging only ever holds the current file's rows (see beginFile).
          await connection.query(`DELETE FROM ${quoteIdentifier(stagingName)};`);
          this.stagedBytes.set(table, 0);
        } else {
          await connection.query(
            `DELETE FROM ${quoteIdentifier(stagingName)} WHERE _src_file = ${quoteStringLiteral(file)};`,
          );
        }
      }
    });
    const discardedChunks = [...this.currentFileChunks.entries()];
    for (const [table, chunks] of discardedChunks) {
      const kept = (this.chunkPaths.get(table) ?? []).filter((path) => !chunks.includes(path));
      if (kept.length > 0) this.chunkPaths.set(table, kept);
      else this.chunkPaths.delete(table);
    }
    await deleteSpillChunks(discardedChunks.flatMap(([, chunks]) => chunks));
    for (const [table, rows] of this.currentFileRows) {
      this.rowCounts.set(table, Math.max(0, (this.rowCounts.get(table) ?? 0) - rows));
    }
    this.currentFile = null;
    this.currentFileChunks.clear();
    this.currentFileRows.clear();
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

type DuckdbQueryIterator = AsyncIterator<DuckdbRecordBatch>;

const queryPage = (page: StoredQueryPage): QueryPage => ({
  index: page.index,
  startRow: page.startRow,
  rowCount: page.rowCount,
  table: page.table,
});

const convertDuckdbTable = async (
  schema: DuckdbSchema,
  batches: readonly DuckdbRecordBatch[],
): Promise<Table> => {
  const writer = RecordBatchStreamWriter.writeAll(new DuckdbTable(schema, [...batches]));
  return tableFromIPC(await writer.toUint8Array());
};

class QuerySessionImpl implements QuerySession {
  readonly schema: Schema;
  private readonly summaries: QueryPageSummary[] = [];
  private fetchTail: Promise<void> = Promise.resolve();
  private remainder: DuckdbRecordBatch | null = null;
  private loadedRows = 0;
  private complete = false;
  private elapsedMs = 0;
  private pendingEof = false;
  private demandState: 'open' | 'retry' | 'terminal' | 'closing' | 'closed' = 'open';
  private terminalCause: unknown = null;
  private cancelSignalPromise: Promise<boolean> | null = null;
  private readerReturnPromise: Promise<void> | null = null;
  private closePromise: Promise<boolean> | null = null;
  private disposePromise: Promise<void> | null = null;

  private constructor(
    private readonly readerSchema: DuckdbSchema,
    private readonly iterator: DuckdbQueryIterator,
    private readonly store: QueryPageStore,
    private readonly startedAt: number,
    private readonly cancelCursor: () => Promise<boolean>,
    private readonly onDisposed: () => void,
    private readonly sendCount: () => number,
    schema: Schema,
  ) {
    this.schema = schema;
    this.elapsedMs = performance.now() - startedAt;
  }

  static async create(
    readerSchema: DuckdbSchema,
    iterator: DuckdbQueryIterator,
    store: QueryPageStore,
    startedAt: number,
    cancelCursor: () => Promise<boolean>,
    onDisposed: () => void,
    sendCount: () => number,
  ): Promise<QuerySessionImpl> {
    const schemaTable = await convertDuckdbTable(readerSchema, []);
    return new QuerySessionImpl(
      readerSchema,
      iterator,
      store,
      startedAt,
      cancelCursor,
      onDisposed,
      sendCount,
      schemaTable.schema,
    );
  }

  status(): QueryStatus {
    this.assertReadable();
    return {
      loadedRows: this.loadedRows,
      complete: this.complete,
      elapsedMs: this.elapsedMs,
      storedBytes: this.store.storedBytes,
      decodedBytes: this.store.cachedDecodedBytes,
      sendCount: this.sendCount(),
    };
  }

  pages(): readonly QueryPageSummary[] {
    this.assertReadable();
    return this.summaries.map((page) => ({ ...page }));
  }

  fetchNext(targetRows = QUERY_PAGE_ROWS): Promise<QueryPage | null> {
    return this.serializeFetch(async () => {
      this.assertDemandOpen();
      if (!Number.isSafeInteger(targetRows) || targetRows <= 0) {
        throw new RangeError('Query page target must be a positive safe integer.');
      }
      if (this.complete) return null;

      const batches: DuckdbRecordBatch[] = [];
      let rowCount = 0;
      let eof = false;
      let failureNeedsCancellation = true;

      try {
        while (rowCount < targetRows) {
          let batch = this.remainder;
          this.remainder = null;
          if (!batch) {
            failureNeedsCancellation = false;
            const next = await this.iterator.next();
            failureNeedsCancellation = true;
            this.assertDemandOpen();
            if (next.done) {
              eof = true;
              break;
            }
            batch = next.value;
          }

          if (batch.numRows === 0) continue;
          const needed = targetRows - rowCount;
          if (batch.numRows > needed) {
            batches.push(batch.slice(0, needed));
            this.remainder = batch.slice(needed);
            rowCount += needed;
          } else {
            batches.push(batch);
            rowCount += batch.numRows;
          }
        }

        // A page that exactly fills its target has not necessarily reached EOF: the cursor only
        // tells us that when its next batch is requested. Probe once now so the UI can publish an
        // exact count immediately. Keep the first non-empty batch as the next-page remainder, so
        // this lookahead never consumes or duplicates a row. Empty batches are skipped just as
        // they are in the main accumulation loop.
        if (rowCount === targetRows && this.remainder === null && !eof) {
          while (true) {
            failureNeedsCancellation = false;
            const next = await this.iterator.next();
            failureNeedsCancellation = true;
            this.assertDemandOpen();
            if (next.done) {
              eof = true;
              break;
            }
            if (next.value.numRows === 0) continue;
            this.remainder = next.value;
            break;
          }
        }

        if (rowCount === 0) {
          if (eof) this.finish();
          return null;
        }

        const table = await convertDuckdbTable(this.readerSchema, batches);
        this.assertDemandOpen();
        const stored = await this.store.put(this.summaries.length, this.loadedRows, table);
        this.assertDemandOpen();
        const page = this.publish(stored);
        if (eof) this.finish();
        return page;
      } catch (error) {
        if (this.isClosing()) throw error;
        if (this.store.hasPendingRetry) {
          this.demandState = 'retry';
          this.pendingEof = eof;
          throw error;
        }
        await this.terminalize(error, failureNeedsCancellation);
        throw error;
      }
    });
  }

  retryPending(): Promise<QueryPage> {
    return this.serializeFetch(async () => {
      this.assertReadable();
      if (this.demandState === 'terminal') throw this.terminalFailure();
      if (this.demandState !== 'retry') {
        throw new Error('No query result page write is pending retry.');
      }
      try {
        const stored = await this.store.retryPending();
        this.assertReadable();
        this.demandState = 'open';
        const page = this.publish(stored);
        if (this.pendingEof) this.finish();
        this.pendingEof = false;
        return page;
      } catch (error) {
        if (this.isClosing()) throw error;
        if (!this.store.hasPendingRetry) {
          await this.terminalize(error, true);
        }
        throw error;
      }
    });
  }

  async readPage(index: number): Promise<QueryPage> {
    this.assertReadable();
    return queryPage(await this.store.get(index));
  }

  pinPages(indexes: readonly number[]): void {
    this.assertReadable();
    this.store.pin(indexes);
  }

  async materialize(maxBytes = QUERY_RESULT_MEMORY_BYTES): Promise<Table | null> {
    this.assertReadable();
    return this.store.materialize(maxBytes);
  }

  cancel(): Promise<boolean> {
    return this.close();
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = this.close().then(() => undefined);
    }
    return this.disposePromise;
  }

  private close(): Promise<boolean> {
    if (this.closePromise) return this.closePromise;
    this.demandState = 'closing';
    this.closePromise = (async () => {
      const errors: unknown[] = [];
      let cancelled = false;
      try {
        cancelled = await this.signalCancellation();
      } catch (error) {
        errors.push(error);
      }
      await this.fetchTail;
      try {
        await this.returnReader();
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.store.dispose();
      } catch (error) {
        errors.push(error);
      } finally {
        this.demandState = 'closed';
        this.onDisposed();
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Failed to close the query result session.');
      }
      return cancelled;
    })();
    return this.closePromise;
  }

  private async terminalize(cause: unknown, cancel: boolean): Promise<void> {
    if (this.demandState === 'terminal') return;
    if (this.demandState === 'closing' || this.demandState === 'closed') return;
    this.demandState = 'terminal';
    this.terminalCause = cause;
    if (cancel) await this.signalCancellation().catch(() => false);
    await this.returnReader().catch(() => undefined);
  }

  private signalCancellation(): Promise<boolean> {
    this.cancelSignalPromise ??= Promise.resolve().then(() => this.cancelCursor());
    return this.cancelSignalPromise;
  }

  private returnReader(): Promise<void> {
    this.readerReturnPromise ??= Promise.resolve()
      .then(() => this.iterator.return?.())
      .then(() => undefined);
    return this.readerReturnPromise;
  }

  private serializeFetch<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.fetchTail.then(operation);
    this.fetchTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private publish(stored: StoredQueryPage): QueryPage {
    const page = queryPage(stored);
    this.summaries.push({ index: page.index, startRow: page.startRow, rowCount: page.rowCount });
    this.loadedRows += page.rowCount;
    this.elapsedMs = performance.now() - this.startedAt;
    return page;
  }

  private finish(): void {
    this.store.markComplete();
    this.complete = true;
    this.elapsedMs = performance.now() - this.startedAt;
  }

  private assertDemandOpen(): void {
    this.assertReadable();
    if (this.demandState === 'terminal') throw this.terminalFailure();
    if (this.demandState === 'retry') {
      throw new Error('A query result page write is pending retry.');
    }
  }

  private assertReadable(): void {
    if (this.demandState === 'closing' || this.demandState === 'closed') {
      throw new Error('Query result session is closed.');
    }
  }

  private terminalFailure(): Error {
    return new Error('Query result session cannot continue after a terminal failure.', {
      cause: this.terminalCause,
    });
  }

  private isClosing(): boolean {
    return this.demandState === 'closing' || this.demandState === 'closed';
  }
}

interface PendingQueryToken {
  cancelRequested: boolean;
  sendStarted: boolean;
  sendCount: number;
  connection: AsyncDuckDBConnection | null;
  cancelSignalPromise: Promise<boolean> | null;
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
  private pendingQuery: PendingQueryToken | null = null;
  private activeQuery: QuerySessionImpl | null = null;
  private queryGeneration = 0;
  private ingestStarting = false;
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
    if (this.activeIngest || this.ingestStarting) {
      throw new Error('An ingest session is already open.');
    }

    this.ingestStarting = true;
    try {
      if (this.pendingQuery) {
        await this.cancelPendingQuery(this.pendingQuery);
      }
      await this.operationTail;
      if (this.disposeRequested) {
        throw new Error('ByteQL database has been disposed.');
      }
      await this.closeActiveQuery();

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
    } finally {
      this.ingestStarting = false;
    }
  }

  startQuery(sql: string): Promise<QuerySession> {
    if (this.disposeRequested) {
      return Promise.reject(new Error('ByteQL database has been disposed.'));
    }
    if (this.pendingQuery) {
      void this.cancelPendingQuery(this.pendingQuery).catch(() => false);
    }
    const token: PendingQueryToken = {
      cancelRequested: false,
      sendStarted: false,
      sendCount: 0,
      connection: null,
      cancelSignalPromise: null,
    };
    this.pendingQuery = token;

    const result = this.enqueue(async (connection) => {
      if (token.cancelRequested) throw new Error('Query result session is closed.');
      if (this.activeIngest || this.ingestStarting) {
        throw new Error('An ingest session is already open.');
      }
      await this.closeActiveQuery();
      if (token.cancelRequested) throw new Error('Query result session is closed.');

      const startedAt = performance.now();
      let store: QueryPageStore | null = null;
      let cursorStarted = false;
      let iterator: DuckdbQueryIterator | null = null;
      let session: QuerySessionImpl | null = null;
      try {
        const persistence = await createOpfsQueryPagePersistence(this.queryGeneration++);
        if (this.disposeRequested) {
          await persistence?.dispose().catch(() => undefined);
          throw new Error('ByteQL database has been disposed.');
        }
        store = new QueryPageStore({ persistence });
        if (token.cancelRequested) throw new Error('Query result session is closed.');
        token.connection = connection;
        token.sendStarted = true;
        token.sendCount += 1;
        const reader = await connection.send(sql);
        cursorStarted = true;
        iterator = reader[Symbol.asyncIterator]();
        if (token.cancelRequested) throw new Error('Query result session is closed.');
        session = await QuerySessionImpl.create(
          reader.schema,
          iterator,
          store,
          startedAt,
          () => this.cancelPendingQuery(token),
          () => {
            if (this.activeQuery === session) this.activeQuery = null;
          },
          () => token.sendCount,
        );
        if (token.cancelRequested) {
          await session.cancel();
          throw new Error('Query result session is closed.');
        }
        this.activeQuery = session;
        return session;
      } catch (error) {
        if (session) {
          await session.cancel().catch(() => false);
        } else {
          if (cursorStarted) await this.cancelPendingQuery(token).catch(() => false);
          await iterator?.return?.().catch(() => undefined);
          await store?.dispose().catch(() => undefined);
        }
        throw error;
      }
    });
    return result.finally(() => {
      if (this.pendingQuery === token) this.pendingQuery = null;
    });
  }

  async cancelQuery(): Promise<boolean> {
    if (this.disposeRequested) {
      return false;
    }
    if (this.pendingQuery) {
      return this.cancelPendingQuery(this.pendingQuery);
    }
    if (this.activeQuery) {
      return this.activeQuery.cancel();
    }
    return false;
  }

  async listTables(): Promise<readonly string[]> {
    return [...this.finalNames.keys()];
  }

  collectFileStatistics(path: string, enable: boolean): Promise<void> {
    if (this.pendingQuery || this.activeQuery) {
      return Promise.reject(new Error('A query result session owns the database connection.'));
    }
    return this.enqueue(() => {
      if (this.pendingQuery || this.activeQuery) {
        throw new Error('A query result session owns the database connection.');
      }
      return this.database.collectFileStatistics(path, enable);
    });
  }

  exportFileStatistics(path: string): Promise<FileStatisticsSummary> {
    if (this.pendingQuery || this.activeQuery) {
      return Promise.reject(new Error('A query result session owns the database connection.'));
    }
    return this.enqueue(async () => {
      if (this.pendingQuery || this.activeQuery) {
        throw new Error('A query result session owns the database connection.');
      }
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

    if (this.pendingQuery) {
      try {
        await this.cancelPendingQuery(this.pendingQuery);
      } catch (error) {
        errors.push(error);
      }
    } else if (this.activeQuery) {
      try {
        await this.activeQuery.cancel();
      } catch (error) {
        errors.push(error);
      }
    }
    await this.operationTail;
    if (this.activeQuery) {
      try {
        await this.activeQuery.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
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

  private async closeActiveQuery(): Promise<void> {
    const session = this.activeQuery;
    if (!session) return;
    await session.cancel();
  }

  private cancelPendingQuery(token: PendingQueryToken): Promise<boolean> {
    token.cancelRequested = true;
    if (!token.sendStarted || !token.connection) return Promise.resolve(true);
    token.cancelSignalPromise ??= token.connection.cancelSent();
    return token.cancelSignalPromise;
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
