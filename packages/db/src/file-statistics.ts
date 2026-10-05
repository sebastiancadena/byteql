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

/**
 * The file-statistics pass-throughs, kept off the production `ByteqlDatabase` interface. The
 * database returned by `createBrowserDatabase` implements them; only e2e verification of the
 * spill tier's read fraction uses them.
 */
export interface FileStatisticsAccess {
  /**
   * Pass-through to `AsyncDuckDB.collectFileStatistics` — enables or disables read/write
   * counters for the exact registered `path` (an `opfs://...` URI, not a relative OPFS walk path).
   */
  collectFileStatistics(path: string, enable: boolean): Promise<void>;
  /** Pass-through to `AsyncDuckDB.exportFileStatistics` — snapshots the counters for `path`. */
  exportFileStatistics(path: string): Promise<FileStatisticsSummary>;
}
