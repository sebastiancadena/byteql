import type { TableSchema } from '@byteql/core';
import type { Schema, Table } from 'apache-arrow';

import type { ParquetArtifact, ParquetExportOptions } from './export-types.js';
import type { ResultSortCapability, ResultSortOptions } from './result-sort.js';

export const QUERY_INITIAL_ROWS = 1_024;
export const QUERY_PAGE_ROWS = 8_192;

export interface QueryPage {
  readonly index: number;
  readonly startRow: number;
  readonly rowCount: number;
  readonly table: Table;
}

export type QueryPageSummary = Omit<QueryPage, 'table'>;

export interface QueryStatus {
  readonly loadedRows: number;
  readonly complete: boolean;
  readonly elapsedMs: number;
  readonly storedBytes: number;
  /** Decoded Arrow pages currently retained in the bounded in-memory page cache. */
  readonly decodedBytes: number;
  /** A QuerySession owns exactly one DuckDB cursor send for its lifetime. */
  readonly sendCount: number;
}

/**
 * Read access to a stored result, with no way to ask for more rows.
 *
 * A derived view — the product of a column sort — is complete and immutable the moment it exists,
 * so it has no cursor to drive. Separating reading from demand lets the grid, the inspector and
 * the exporters consume the original cursor-backed result and a sorted one through one contract,
 * while keeping `fetchNext` out of reach of code that must never resume a cursor.
 */
export interface QueryResultView {
  readonly schema: Schema;
  status(): QueryStatus;
  pages(): readonly QueryPageSummary[];
  readPage(index: number): Promise<QueryPage>;
  pinPages(indexes: readonly number[]): void;
  materialize(maxBytes?: number): Promise<Table | null>;
  dispose(): Promise<void>;
}

/** A result view that still owns a live DuckDB cursor and can be asked for more rows. */
export interface QuerySession extends QueryResultView {
  fetchNext(targetRows?: number): Promise<QueryPage | null>;
  retryPending(): Promise<QueryPage>;
  cancel(): Promise<boolean>;
}

export interface TableSummary {
  readonly name: string;
  readonly rowCount: number;
}

export interface IngestOptions {
  /** An explicit schema list, or 'discover' to register tables lazily on first appendBatch. */
  schemas: readonly TableSchema[] | 'discover';
  tier: 'memory' | 'spill';
  generation: number;
  /** Spill tier only; defaults to ROTATION_THRESHOLD_BYTES (Task 7). */
  rotationBytes?: number;
}

export interface IngestSession {
  appendBatch(table: string, ipc: Uint8Array): Promise<void>;
  /**
   * `backfillSchemas` (discover-mode only) names tables the caller knows the format pack
   * declares but that may never have received an `appendBatch` call — e.g. a capture with no
   * `tcp` packets. Any such table is created as an empty table from its schema, exactly like a
   * never-appended declared-mode table, so it exists for queries (e.g. a UNION ALL overview)
   * that assume every pack table exists. Ignored in declared mode (already covered).
   */
  finalize(backfillSchemas?: readonly TableSchema[]): Promise<readonly TableSummary[]>;
  /**
   * Marks a file boundary in a multi-file ingest. Spill tier: rotates every table's residual
   * staged rows into chunks first, so no parquet chunk ever mixes files. Subsequent appends and
   * rotations are attributed to `file` until the next `beginFile` or `discardCurrentFile`.
   */
  beginFile(file: string): Promise<void>;
  /**
   * Removes every row appended since the active `beginFile` (the failed file's partial rows):
   * memory tier deletes by `_src_file`, spill tier truncates staging and drops the chunks
   * rotated for this file. No-op when no file boundary is active.
   */
  discardCurrentFile(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * A narrow, plain-data subset of duckdb-wasm's `FileStatistics` class (per-file read/write
 * counters gathered via `collectFileStatistics`/`exportFileStatistics`). Deliberately omits the
 * class's `blockStats: Uint8Array` payload and `getBlockStats()` method — nothing in this
 * codebase needs per-block detail, only the aggregate counters, and a plain object is trivially
 * mockable in unit tests.
 */
export interface FileStatisticsSummary {
  readonly totalFileReadsCold: number;
  readonly totalFileReadsAhead: number;
  readonly totalFileReadsCached: number;
  readonly totalFileWrites: number;
  readonly totalPageAccesses: number;
  readonly totalPageLoads: number;
  readonly blockSize: number;
}

export interface ByteqlDatabase {
  initialize(): Promise<void>;
  beginIngest(options: IngestOptions): Promise<IngestSession>;
  startQuery(sql: string): Promise<QuerySession>;
  /**
   * Builds a complete, immutable view of `base`'s retained pages in the requested order.
   *
   * Accepts only the database's current, complete base result, which it never replaces, disposes
   * or resumes. The returned view is registered against that base: it stops being exportable once
   * the base is retired.
   */
  createSortedView(base: QuerySession, options: ResultSortOptions): Promise<QueryResultView>;
  /**
   * Whether sorting is possible here at all, independently of any particular result: it needs
   * local storage for snapshot shards and a runtime whose ordering can be trusted. Reported up
   * front so the UI can explain itself rather than offering an action that always fails.
   */
  resultSortCapability(): ResultSortCapability;
  exportParquet(result: QueryResultView, options: ParquetExportOptions): Promise<ParquetArtifact>;
  cancelQuery(): Promise<boolean>;
  listTables(): Promise<readonly string[]>;
  /**
   * Pass-through to `AsyncDuckDB.collectFileStatistics` — enables or disables read/write
   * counters for the exact registered `path` (an `opfs://...` URI, not a relative OPFS walk
   * path). Added for e2e read-fraction verification (Task 12); never called in production code.
   */
  collectFileStatistics(path: string, enable: boolean): Promise<void>;
  /** Pass-through to `AsyncDuckDB.exportFileStatistics` — snapshots the counters for `path`. */
  exportFileStatistics(path: string): Promise<FileStatisticsSummary>;
  dispose(): Promise<void>;
}
