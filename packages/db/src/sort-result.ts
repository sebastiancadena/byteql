import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { RecordBatch as DuckdbRecordBatch, Schema as DuckdbSchema } from 'apache-arrow-duckdb';

import { convertDuckdbTable } from './arrow-bridge.js';
import { hasDbErrorCode, isStorageUnavailableError } from './errors.js';
import type { ExportFiles } from './export-files.js';
import type { QueryPageStore } from './query-pages.js';
import {
  buildResultSortSql,
  resultSortEligibility,
  ResultSortError,
  SORT_ORDINAL_COLUMN,
  type ResultSortOptions,
} from './result-sort.js';
import { resultSortKeyRefusal } from './result-columns.js';
import { restoreResultSchema, snapshotPage } from './result-snapshot.js';
import { ShardWorkspace } from './shard-workspace.js';
import { isQuotaError } from './spill-files.js';
import { StoredResultView } from './stored-result-view.js';
import { QUERY_PAGE_ROWS, type QueryPageSummary, type QueryResultView, type QuerySession } from './types.js';

/** Connection-local staging table every snapshot page is appended into, one shard at a time. */
const SORT_PAGE_TABLE = '__byteql_sort_page';
/** Prefix of the per-operation seed table that establishes the staging table's column types. */
const SORT_SEED_PREFIX = '__byteql_sort_seed_';

export interface ResultSortDependencies {
  readonly database: Pick<AsyncDuckDB, 'registerOPFSFileName' | 'dropFile'>;
  connect(): Promise<AsyncDuckDBConnection>;
  createFiles(): Promise<ExportFiles>;
  createStore(): Promise<QueryPageStore>;
  /**
   * Called when a resource could not be released. The retry closure is handed over so the caller
   * can attempt it again at query replacement or teardown; a resource is never silently declared
   * released.
   */
  onCleanupFailure(retry: () => Promise<void>, error: unknown): void;
}

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

/**
 * Maps a failure onto the sort's own error codes without flattening the ones that already carry
 * meaning: an abort is not a failure, and a typed unsupported-type or cleanup error keeps its code.
 */
const asSortError = (error: unknown): unknown => {
  if (isAbortError(error) || error instanceof ResultSortError) return error;
  if (isStorageUnavailableError(error)) {
    return new ResultSortError('SORT_UNAVAILABLE', 'Column sorting requires local browser storage (OPFS).', {
      cause: error,
    });
  }
  if (isQuotaError(error) || hasDbErrorCode(error, 'SPILL_QUOTA_EXCEEDED', 'RESULT_SPILL_QUOTA_EXCEEDED')) {
    return new ResultSortError(
      'SORT_STORAGE_FULL',
      'Local storage ran out of space while sorting. Free up space and try again.',
      { cause: error },
    );
  }
  return new ResultSortError('SORT_FAILED', 'The rows could not be sorted.', { cause: error });
};

/** A DuckDB record batch, narrowed to what the chunking loop needs. Arrow slices are [begin, end). */
type SlicableBatch = DuckdbRecordBatch & {
  readonly numRows: number;
  slice(begin: number, end: number): DuckdbRecordBatch;
};

class SortedResultWriter {
  private readonly shards: string[] = [];
  private readonly summaries: QueryPageSummary[] = [];
  private workspace: ShardWorkspace | null = null;
  private store: QueryPageStore | null = null;
  private storeAdopted = false;
  private outputRows = 0;

  constructor(
    private readonly dependencies: ResultSortDependencies,
    private readonly base: QuerySession,
    private readonly options: ResultSortOptions,
  ) {}

  async run(): Promise<QueryResultView> {
    this.validate();
    try {
      await this.acquire();
      const totalRows = this.base.status().loadedRows;
      await this.stage(totalRows);
      await this.order(totalRows);
      this.store!.markComplete();
      await this.release();
      const view = new StoredResultView(
        this.base.schema,
        this.store!,
        this.summaries,
        { elapsedMs: this.base.status().elapsedMs, sendCount: this.base.status().sendCount },
        () => undefined,
      );
      // Ownership of the store transfers here and nowhere earlier: until this point every failure
      // path is still responsible for disposing it.
      this.storeAdopted = true;
      return view;
    } catch (error) {
      throw await this.abandon(asSortError(error));
    }
  }

  /** Everything checkable before a single resource is acquired. */
  private validate(): void {
    this.options.signal.throwIfAborted();
    if (!this.base.status().complete) {
      throw new ResultSortError(
        'SORT_FAILED',
        'Sorting requires every row of the result to be loaded first.',
      );
    }
    const eligibility = resultSortEligibility(this.base.schema);
    if (!eligibility.supported) {
      throw new ResultSortError('SORT_UNSUPPORTED_TYPE', eligibility.reason);
    }
    // Rejects an out-of-range index or an unknown direction before any work begins; the generated
    // statement itself is built again later against the real shard paths.
    buildResultSortSql(['opfs://placeholder'], this.base.schema, this.options.sort);
    const keyField = this.base.schema.fields[this.options.sort.columnIndex];
    const refusal = keyField ? resultSortKeyRefusal(keyField) : null;
    if (refusal) {
      throw new ResultSortError('SORT_UNSUPPORTED_TYPE', refusal);
    }
  }

  private async acquire(): Promise<void> {
    this.workspace = await ShardWorkspace.open(this.dependencies, {
      staging: { kind: 'temp-table', table: SORT_PAGE_TABLE, seedPrefix: SORT_SEED_PREFIX },
      label: 'Result sort',
      signal: this.options.signal,
    });
    this.options.signal.throwIfAborted();
    await this.workspace.connect();
    this.options.signal.throwIfAborted();
    this.store = await this.dependencies.createStore();
    this.options.signal.throwIfAborted();
  }

  /** Copies every retained base page into an owned Parquet shard, one page at a time. */
  private async stage(totalRows: number): Promise<void> {
    const pages = [...this.base.pages()].sort((left, right) => left.startRow - right.startRow);
    let staged = 0;
    for (const summary of pages) {
      this.options.signal.throwIfAborted();
      const page = await this.base.readPage(summary.index);
      this.options.signal.throwIfAborted();
      const snapshot = snapshotPage(page.table, summary.startRow, SORT_ORDINAL_COLUMN);
      this.shards.push(await this.workspace!.writeShard(snapshot, `sort-shard-${summary.index}.parquet`));
      staged += summary.rowCount;
      this.options.onProgress({ phase: 'staging', rows: staged, totalRows });
    }
  }

  /** Orders the shards on the dedicated connection and stores the output as bounded pages. */
  private async order(totalRows: number): Promise<void> {
    this.options.onProgress({ phase: 'sorting', rows: 0, totalRows });
    const sql = buildResultSortSql(this.shards, this.base.schema, this.options.sort);
    await this.workspace!.stream(sql, (schema, batch) =>
      this.storeBatch(schema, batch as SlicableBatch, totalRows),
    );
    if (this.outputRows !== totalRows) {
      throw new ResultSortError(
        'SORT_FAILED',
        `Sorting produced ${this.outputRows} rows for a result of ${totalRows}.`,
      );
    }
    this.options.signal.throwIfAborted();
  }

  /** Slices one reader batch into bounded pages; no whole-result array is ever held. */
  private async storeBatch(schema: DuckdbSchema, batch: SlicableBatch, totalRows: number): Promise<void> {
    for (let offset = 0; offset < batch.numRows; offset += QUERY_PAGE_ROWS) {
      this.options.signal.throwIfAborted();
      const end = Math.min(offset + QUERY_PAGE_ROWS, batch.numRows);
      const chunk = await convertDuckdbTable(schema, [batch.slice(offset, end)]);
      const table = restoreResultSchema(chunk, this.base.schema);
      const index = this.summaries.length;
      const startRow = this.outputRows;
      if (!Number.isSafeInteger(startRow)) {
        throw new ResultSortError('SORT_FAILED', 'Sorted output exceeded addressable row offsets.');
      }
      await this.store!.put(index, startRow, table);
      this.summaries.push({ index, startRow, rowCount: table.numRows });
      this.outputRows += table.numRows;
      this.options.onProgress({ phase: 'storing', rows: this.outputRows, totalRows });
    }
  }

  /** Releases everything the sort borrowed, on the success path. */
  private async release(): Promise<void> {
    const workspace = this.workspace;
    this.workspace = null;
    const errors = workspace ? await workspace.release() : [];
    if (errors.length > 0) {
      throw new ResultSortError(
        'SORT_CLEANUP_FAILED',
        'The rows were sorted, but temporary local files could not be released.',
        { cause: errors.length === 1 ? errors[0] : new AggregateError(errors) },
      );
    }
  }

  /**
   * Releases everything on a failure path, disposes the candidate that will never commit, and
   * returns the error to raise: `primary` itself when every cleanup succeeded, otherwise a
   * `SORT_CLEANUP_FAILED` whose cause aggregates `primary` first and then each cleanup failure.
   * Failed releases are also handed to `onCleanupFailure` for a later retry.
   */
  private async abandon(primary: unknown): Promise<unknown> {
    const workspace = this.workspace;
    this.workspace = null;
    const errors = workspace ? await workspace.release() : [];
    if (!this.storeAdopted && this.store) {
      const store = this.store;
      this.store = null;
      try {
        await store.dispose();
      } catch (error) {
        errors.push(error);
        this.dependencies.onCleanupFailure(() => store.dispose(), error);
      }
    }
    if (errors.length === 0) return primary;
    const message = 'The sort did not finish, and temporary local files could not be released.';
    return new ResultSortError('SORT_CLEANUP_FAILED', message, {
      cause: new AggregateError([primary, ...errors], message, { cause: primary }),
    });
  }
}

/**
 * Sorts a complete result's retained pages into a new, complete, immutable view.
 *
 * The base is read but never advanced, cancelled or disposed: its cursor is somebody else's, and
 * the whole point of retaining pages is that sorting never re-runs the user's SQL. Work is bounded
 * page by page in both directions — no whole-result JavaScript array, no whole-result IPC buffer.
 */
export async function writeSortedResult(
  dependencies: ResultSortDependencies,
  base: QuerySession,
  options: ResultSortOptions,
): Promise<QueryResultView> {
  return new SortedResultWriter(dependencies, base, options).run();
}
