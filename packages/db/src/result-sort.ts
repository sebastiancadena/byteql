import { DataType, type Schema } from 'apache-arrow';

import { isSupportedParquetType } from './export-types.js';
import { resultColumnLabel } from './result-columns.js';

/**
 * Private ordinal carried alongside every snapshot page. It records each row's position in the
 * original query execution so `ORDER BY key, ordinal` is stable, and it never reaches the public
 * schema, the grid, the inspector, or a download.
 */
export const SORT_ORDINAL_COLUMN = '__byteql_sort_ordinal';

/** A committed or requested single-column ordering, addressed by ORIGINAL schema index. */
export interface ResultSort {
  readonly columnIndex: number;
  readonly direction: 'asc' | 'desc';
}

export interface ResultSortProgress {
  readonly phase: 'staging' | 'sorting' | 'storing';
  readonly rows: number;
  readonly totalRows: number;
}

export interface ResultSortOptions {
  readonly sort: ResultSort;
  readonly signal: AbortSignal;
  onProgress(progress: ResultSortProgress): void;
}

/** Shown when the origin-private file system, which holds snapshot shards, is unavailable. */
export const SORT_UNAVAILABLE_STORAGE = 'Column sorting requires local browser storage (OPFS).';

/** Shown when the selected DuckDB-WASM build cannot order a snapshot. */
export const SORT_UNAVAILABLE_RUNTIME =
  "Column sorting is unavailable in this browser's WebAssembly runtime. " +
  'Update your browser and run the query again.';

/**
 * Whether the selected DuckDB-WASM bundle can order snapshot shards.
 *
 * The pinned `mvp` build fails `ORDER BY` over `parquet_scan` when the key column spans the full
 * range of a signed 16- or 32-bit type, while the same ordering succeeds in memory and the whole
 * statement succeeds on `eh`. That is a limitation of the runtime rather than of the snapshot
 * path — measured with the staging machinery removed entirely — so sorting is refused outright
 * there instead of failing unpredictably on particular data. See
 * `docs/result-column-sorting-compatibility.md`; `sort-probe.ts` guards the finding.
 *
 * `mvp` is selected only for browsers without WebAssembly exception handling; everything current
 * gets `eh`.
 */
export const resultSortRuntimeSupported = (mainModule: string): boolean => !mainModule.includes('mvp');

/** Whether this browser and runtime can sort results at all, with the reason when they cannot. */
export type ResultSortCapability =
  { readonly supported: true } | { readonly supported: false; readonly reason: string };

export type ResultSortEligibility =
  { readonly supported: true } | { readonly supported: false; readonly reason: string };

export type ResultSortErrorCode =
  'SORT_UNAVAILABLE' | 'SORT_UNSUPPORTED_TYPE' | 'SORT_STORAGE_FULL' | 'SORT_FAILED' | 'SORT_CLEANUP_FAILED';

export class ResultSortError extends Error {
  readonly code: ResultSortErrorCode;

  constructor(code: ResultSortErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ResultSortError';
    this.code = code;
  }
}

/**
 * Every field of a sorted result travels through Parquet shards and back, so v1 requires the
 * WHOLE schema to round-trip losslessly — not just the sort key. This starts from the proven
 * Parquet scalar set and additionally rejects timezone-bearing timestamps, whose instant is
 * re-expressed against the session time zone on the way back out.
 */
const isSupportedSortType = (type: DataType): boolean => {
  if (DataType.isTimestamp(type) && (type.timezone ?? '') !== '') return false;
  return isSupportedParquetType(type);
};

export function resultSortEligibility(schema: Schema): ResultSortEligibility {
  for (const [index, field] of schema.fields.entries()) {
    if (isSupportedSortType(field.type)) continue;
    return {
      supported: false,
      reason:
        `Column sorting is unavailable: column ${index + 1} “${resultColumnLabel(field)}” has ` +
        `unsupported type ${field.type.toString()}. Cast it in SQL and run again.`,
    };
  }
  return { supported: true };
}

const quoteString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Builds the ordering statement. Nothing user-controlled reaches the SQL text: column names are
 * replaced by generated positional aliases before staging, the direction comes from a closed
 * union checked at runtime, and paths come from the owned scratch allocator.
 */
export function buildResultSortSql(paths: readonly string[], schema: Schema, sort: ResultSort): string {
  if (paths.length === 0) {
    throw new ResultSortError('SORT_FAILED', 'Sorting requires at least one snapshot shard.');
  }
  const eligibility = resultSortEligibility(schema);
  if (!eligibility.supported) {
    throw new ResultSortError('SORT_UNSUPPORTED_TYPE', eligibility.reason);
  }
  if (
    !Number.isSafeInteger(sort.columnIndex) ||
    sort.columnIndex < 0 ||
    sort.columnIndex >= schema.fields.length
  ) {
    throw new ResultSortError(
      'SORT_FAILED',
      `Sort column index is out of range: ${String(sort.columnIndex)}.`,
    );
  }
  if (sort.direction !== 'asc' && sort.direction !== 'desc') {
    throw new ResultSortError('SORT_FAILED', `Unknown sort direction: ${String(sort.direction)}.`);
  }

  const projection = schema.fields.map((_field, index) => `"c${index}"`).join(', ');
  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  return (
    `SELECT ${projection} FROM parquet_scan([${paths.map(quoteString).join(', ')}]) ` +
    `ORDER BY "c${sort.columnIndex}" ${direction} NULLS LAST, "${SORT_ORDINAL_COLUMN}" ASC`
  );
}
