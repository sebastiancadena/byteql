import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { tableToIPC, type Table } from 'apache-arrow';
import type { RecordBatch as DuckdbRecordBatch, Schema as DuckdbSchema } from 'apache-arrow-duckdb';

import { convertDuckdbTable } from './arrow-bridge.js';
import type { ExportFiles } from './export-files.js';
import type { QueryPageStore } from './query-pages.js';
import {
  buildResultSortSql,
  resultSortEligibility,
  ResultSortError,
  SORT_ORDINAL_COLUMN,
  type ResultSortOptions,
} from './result-sort.js';
import { restoreResultSchema, snapshotPage } from './result-snapshot.js';
import { isQuotaError } from './spill-files.js';
import { StoredResultView } from './stored-result-view.js';
import { QUERY_PAGE_ROWS, type QueryPageSummary, type QueryResultView, type QuerySession } from './types.js';

/** Connection-local staging table every snapshot page is appended into, one shard at a time. */
const SORT_PAGE_TABLE = '__byteql_sort_page';

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

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const quoteString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

const isStorageUnavailable = (error: unknown): boolean => {
  const name = error instanceof Error ? error.name : (error as { name?: unknown } | null)?.name;
  return name === 'NotSupportedError' || name === 'SecurityError';
};

/**
 * Maps a failure onto the sort's own error codes without flattening the ones that already carry
 * meaning: an abort is not a failure, and a typed unsupported-type or cleanup error keeps its code.
 */
const asSortError = (error: unknown): unknown => {
  if (isAbortError(error) || error instanceof ResultSortError) return error;
  if (isStorageUnavailable(error)) {
    return new ResultSortError('SORT_UNAVAILABLE', 'Column sorting requires local browser storage (OPFS).', {
      cause: error,
    });
  }
  if (isQuotaError(error) || String((error as Error)?.message ?? '').includes('QUOTA_EXCEEDED')) {
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
  private readonly registeredPaths: string[] = [];
  private readonly shards: string[] = [];
  private readonly summaries: QueryPageSummary[] = [];
  private readonly seedTable = `__byteql_sort_seed_${crypto.randomUUID().replaceAll('-', '')}`;
  private connection: AsyncDuckDBConnection | null = null;
  private files: ExportFiles | null = null;
  private store: QueryPageStore | null = null;
  private storeAdopted = false;
  private stagingReady = false;
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
      await this.abandon();
      throw asSortError(error);
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
  }

  private async acquire(): Promise<void> {
    this.files = await this.dependencies.createFiles();
    this.options.signal.throwIfAborted();
    this.connection = await this.dependencies.connect();
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
      await this.appendStagingPage(snapshotPage(page.table, summary.startRow, SORT_ORDINAL_COLUMN));
      const shard = await this.register(`sort-shard-${summary.index}.parquet`);
      this.shards.push(shard);
      await this.runStatement(
        `COPY ${quoteIdentifier(SORT_PAGE_TABLE)} TO ${quoteString(shard)} ` +
          '(FORMAT PARQUET, COMPRESSION SNAPPY)',
      );
      await this.connection!.query(`TRUNCATE ${quoteIdentifier(SORT_PAGE_TABLE)}`);
      staged += summary.rowCount;
      this.options.onProgress({ phase: 'staging', rows: staged, totalRows });
    }
  }

  /**
   * Appends one snapshot page into the connection-local staging table.
   *
   * The table's exact column types are established once, from a zero-row insert into a
   * per-operation seed table that is then moved into TEMP and dropped. Going through TEMP keeps the
   * staging table invisible to the rest of the database and disposed of by closing the connection,
   * and the generated seed name keeps it from ever colliding with a user table.
   */
  private async appendStagingPage(staged: Table): Promise<void> {
    if (!this.stagingReady) {
      const empty = tableToIPC(staged.slice(0, 0), 'stream').slice();
      await this.connection!.insertArrowFromIPCStream(empty, { name: this.seedTable, create: true });
      this.options.signal.throwIfAborted();
      await this.connection!.query(
        `CREATE TEMP TABLE ${quoteIdentifier(SORT_PAGE_TABLE)} AS ` +
          `SELECT * FROM ${quoteIdentifier(this.seedTable)} WHERE false`,
      );
      await this.connection!.query(`DROP TABLE ${quoteIdentifier(this.seedTable)}`);
      this.stagingReady = true;
    }
    // insertArrowFromIPCStream is not a cancellable SQL cursor: let it settle, then recheck.
    await this.connection!.insertArrowFromIPCStream(tableToIPC(staged, 'stream').slice(), {
      name: SORT_PAGE_TABLE,
      create: false,
    });
    this.options.signal.throwIfAborted();
  }

  /** Orders the shards on the dedicated connection and stores the output as bounded pages. */
  private async order(totalRows: number): Promise<void> {
    this.options.onProgress({ phase: 'sorting', rows: 0, totalRows });
    const sql = buildResultSortSql(this.shards, this.base.schema, this.options.sort);
    this.options.signal.throwIfAborted();

    const reader = await this.connection!.send(sql, true);
    const iterator = reader[Symbol.asyncIterator]();
    let cancelled: Promise<boolean> | null = null;
    const abort = (): void => {
      cancelled ??= this.connection!.cancelSent();
    };
    const joinCancellation = async (): Promise<void> => {
      if (cancelled) await cancelled.catch(() => false);
    };
    if (this.options.signal.aborted) abort();
    else this.options.signal.addEventListener('abort', abort, { once: true });

    let primary: unknown = null;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) break;
        await this.storeBatch(reader.schema, next.value as SlicableBatch, totalRows);
        this.options.signal.throwIfAborted();
      }
    } catch (error) {
      primary = error;
    } finally {
      this.options.signal.removeEventListener('abort', abort);
      await joinCancellation();
      try {
        await iterator.return?.();
      } catch {
        // The reader is already finished or cancelled; that must not mask the primary failure.
      }
    }
    if (primary !== null) throw primary;

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

  private async register(name: string): Promise<string> {
    const path = this.files!.path(name);
    await this.dependencies.database.registerOPFSFileName(path);
    this.registeredPaths.push(path);
    return path;
  }

  /** Runs one long statement, cancelling only this connection if the caller aborts. */
  private async runStatement(sql: string): Promise<void> {
    this.options.signal.throwIfAborted();
    let cancelled: Promise<boolean> | null = null;
    const abort = (): void => {
      cancelled ??= this.connection!.cancelSent();
    };
    const joinCancellation = async (): Promise<void> => {
      if (cancelled) await cancelled.catch(() => false);
    };
    this.options.signal.addEventListener('abort', abort, { once: true });
    let primary: unknown = null;
    try {
      const reader = await this.connection!.send(sql, true);
      for await (const batch of reader) void batch;
      this.options.signal.throwIfAborted();
    } catch (error) {
      primary = error;
    } finally {
      this.options.signal.removeEventListener('abort', abort);
      await joinCancellation();
    }
    if (primary !== null) throw primary;
  }

  /**
   * Releases everything the sort borrowed, on the success path.
   *
   * The connection is joined before file handles are dropped — a live connection can still hold a
   * shard open — and every cleanup is attempted even when an earlier one fails.
   */
  private async release(): Promise<void> {
    const errors: unknown[] = [];
    await this.closeConnection(errors);
    await this.dropRegisteredPaths(errors);
    const files = this.files;
    this.files = null;
    if (files) {
      try {
        await files.dispose();
      } catch (error) {
        errors.push(error);
        this.dependencies.onCleanupFailure(() => files.dispose(), error);
      }
    }
    if (errors.length > 0) {
      throw new ResultSortError(
        'SORT_CLEANUP_FAILED',
        'The rows were sorted, but temporary local files could not be released.',
        { cause: errors.length === 1 ? errors[0] : new AggregateError(errors) },
      );
    }
  }

  /** Releases everything on a failure path, and disposes the candidate that will never commit. */
  private async abandon(): Promise<void> {
    const errors: unknown[] = [];
    await this.closeConnection(errors);
    await this.dropRegisteredPaths(errors);
    const files = this.files;
    this.files = null;
    if (files) {
      try {
        await files.dispose();
      } catch (error) {
        this.dependencies.onCleanupFailure(() => files.dispose(), error);
      }
    }
    if (!this.storeAdopted && this.store) {
      const store = this.store;
      this.store = null;
      try {
        await store.dispose();
      } catch (error) {
        this.dependencies.onCleanupFailure(() => store.dispose(), error);
      }
    }
  }

  private async closeConnection(errors: unknown[]): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (!connection) return;
    try {
      // Closing removes the TEMP staging table with it; the seed table is dropped during staging.
      await connection.close();
    } catch (error) {
      errors.push(error);
      this.dependencies.onCleanupFailure(() => connection.close(), error);
    }
  }

  private async dropRegisteredPaths(errors: unknown[]): Promise<void> {
    const paths = [...this.registeredPaths];
    this.registeredPaths.length = 0;
    for (const path of paths) {
      try {
        await this.dependencies.database.dropFile(path);
      } catch (error) {
        errors.push(error);
        this.dependencies.onCleanupFailure(async () => {
          await this.dependencies.database.dropFile(path);
        }, error);
      }
    }
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
