import type { TableSchema } from '@byteql/core';
import type { Table } from 'apache-arrow';

export interface QueryResult {
  table: Table;
  elapsedMs: number;
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
  finalize(): Promise<readonly TableSummary[]>;
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
  query(sql: string): Promise<QueryResult>;
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
