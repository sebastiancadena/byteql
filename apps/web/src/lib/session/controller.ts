import { tableToIpc, type ParseIssue, type TableOverview } from '@byteql/core';
import {
  QUERY_PAGE_ROWS,
  hasDbErrorCode,
  sweepQueryPageOrphans,
  sweepSpillOrphans,
  type ByteqlDatabase,
  type IngestSession,
  type QueryResultView,
  type QuerySession,
  type ResultSort,
  type ResultSortCapability,
  type ResultSortProgress,
} from '@byteql/db';
import { parquetColumnNames } from '@byteql/db/result-columns';
import { Table } from 'apache-arrow';

import {
  ParseWorkerClient,
  type ParseClientPort,
  type ParseProgress,
  type StreamedParseResult,
} from '../parse-worker-client.js';
import { REGISTERED_PACKS } from '../packs.js';
import { CsvWorkerClient, type CsvClientPort } from '../export/csv-client.js';
import {
  prepareDestination as createExportDestination,
  type ExportDestination,
} from '../export/destination.js';
import {
  type ExportDestinationFactory,
  type ExportOperation,
  type ExportState,
} from '../export/operation.js';
import { exportFilename, selectExportColumns, type ExportOptions } from '../export/options.js';
import {
  buildFilesTableIpc,
  mergeTableOverviews,
  planBatch,
  type BatchEntry,
  type FilesRow,
  type PlannedFile,
} from './batch.js';
import { SAMPLES, type SampleDefinition, type SampleId } from './samples.js';
import { ResultSession, releaseView } from './result-session.js';
import {
  errorMessage,
  isAbortError,
  isRetryablePageError,
  resultPageFailureMessage,
} from './session-errors.js';
import { SessionStore } from './session-store.js';
import { type PagedResultState, type SessionState, type SourceFile } from './state.js';
import { readResultWindow } from './result-view.js';
import { resultSortDisabledReason } from './result-sort-availability.js';
import { hasActiveDownload, resultSortInteractionBlocked, sameResultSchema } from './result-sort.js';
import { TIER_THRESHOLD_BYTES, chooseTier } from './tiering.js';

export interface SessionControllerOptions {
  database: ByteqlDatabase;
  parser?: ParseClientPort;
  csvClient?: CsvClientPort;
  prepareDestination?: ExportDestinationFactory;
  fetch?: typeof fetch;
  stopViewer?: () => void;
  /** Test override of per-sample asset URLs; production uses the samples.ts registry. */
  sampleUrlOverrides?: Partial<Record<SampleId, readonly string[]>>;
  /** Test/e2e override of the tiering thresholds; production uses the tiering.ts defaults. */
  tiering?: { tierThresholdBytes?: number; rotationBytes?: number };
}

const disposedError = (): Error => new Error('The session controller is disposed.');

const basename = (name: string): string => {
  const safe = name.split(/[\\/]/u).at(-1);
  return safe || 'local file';
};

/** Whether two committed orders are the same request, so asking again would change nothing. */
const sameResultSort = (left: ResultSort | null, right: ResultSort | null): boolean =>
  left === null || right === null
    ? left === right
    : left.columnIndex === right.columnIndex && left.direction === right.direction;

const bytesToMb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

type ExportDestinationOutcome =
  { status: 'fulfilled'; destination: ExportDestination } | { status: 'rejected'; error: unknown };

export class SessionController {
  private readonly store = new SessionStore();
  private readonly database: ByteqlDatabase;
  private readonly parser: ParseClientPort;
  private readonly csvClient: CsvClientPort;
  private readonly prepareDestination: ExportDestinationFactory;
  private readonly fetchSample: typeof fetch;
  private readonly stopViewer: () => void;
  private readonly tiering: { tierThresholdBytes?: number; rotationBytes?: number } | undefined;
  private initialization: Promise<void> | null = null;
  private csvDisposal: Promise<void> | null = null;
  private readonly initializationAbort = new AbortController();
  private readonly sampleUrlOverrides: Partial<Record<SampleId, readonly string[]>> | undefined;
  private readonly sampleCache = new Map<string, Uint8Array>();
  private readonly results: ResultSession;
  private sortRequestId = 0;
  private activeSort: {
    id: number;
    queryGeneration: number;
    sessionGeneration: number;
    fromRevision: number;
    base: QuerySession;
    previousView: QueryResultView;
    controller: AbortController;
    settlement: Promise<void>;
  } | null = null;
  private exportGeneration = 0;
  private activeExport: ExportOperation | null = null;
  private retainedExport: { generation: number; destination: ExportDestination } | null = null;
  private exportCleanup: Promise<void> = Promise.resolve();
  private retainedBlobs = new Map<string, Blob>();
  private batchFileIndex = 0;
  private batchFileCount = 0;
  private disposal: Promise<void> | null = null;
  /** Cumulative IPC bytes ingested this open, and the last parser-reported stage, for progress. */
  private bytesIngested = 0;
  private lastProgress: ParseProgress | null = null;
  /**
   * Resolves once the ingest session currently (or most recently) owned by this controller has
   * fully settled — its `finalize()` or `abort()` call has resolved or rejected. Starts resolved
   * (no ingest owned yet). `completeBatchOpen` awaits this before its own `beginIngest` call, so a
   * quick supersession never races the real DB's single-open-session invariant (I1).
   */
  private ingestSettlement: Promise<void> = Promise.resolve();

  constructor(options: SessionControllerOptions) {
    this.database = options.database;
    this.parser = options.parser ?? new ParseWorkerClient();
    this.csvClient = options.csvClient ?? new CsvWorkerClient();
    this.prepareDestination = options.prepareDestination ?? createExportDestination;
    this.fetchSample = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sampleUrlOverrides = options.sampleUrlOverrides;
    this.stopViewer = options.stopViewer ?? (() => undefined);
    this.tiering = options.tiering;
    this.results = new ResultSession(this.store, this.database, {
      sortPending: () => this.activeSort !== null,
      supersedeExport: () => this.supersedeExport(),
    });
  }

  initialize(): Promise<void> {
    this.assertUsable();
    this.initialization ??= this.initializeOnce();
    return this.initialization;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.assertUsable();
    return this.store.subscribe(listener);
  }

  getState(): SessionState {
    return this.store.state;
  }

  openFiles(files: readonly File[]): Promise<void> {
    this.assertUsable();
    const entries: BatchEntry[] = files.map((file) => ({
      name: basename(file.name),
      size: file.size,
      blob: file,
    }));
    return this.openBatch(entries);
  }

  openFile(file: File): Promise<void> {
    return this.openFiles([file]);
  }

  openSample(id: SampleId): Promise<void> {
    this.assertUsable();
    const definition = SAMPLES.find((sample) => sample.id === id);
    if (!definition) return Promise.reject(new Error(`Unknown sample: ${id}`));
    return this.initialize().then(() => this.loadSample(definition));
  }

  private async loadSample(definition: SampleDefinition): Promise<void> {
    const urls = this.sampleUrlOverrides?.[definition.id] ?? definition.files.map((file) => file.url);
    const entries: BatchEntry[] = [];
    for (const [index, file] of definition.files.entries()) {
      const bytes = await this.fetchSampleBytes(urls[index]!);
      if (this.store.disposed) throw disposedError();
      const blob = new Blob([bytes as BlobPart]);
      entries.push({ name: file.name, size: blob.size, blob });
    }
    return this.openBatch(entries);
  }

  private async fetchSampleBytes(url: string): Promise<Uint8Array> {
    const cached = this.sampleCache.get(url);
    if (cached) return cached;
    const response = await this.fetchSample(url, { signal: this.initializationAbort.signal });
    if (!response.ok) throw new Error('A bundled sample could not be loaded.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.sampleCache.set(url, bytes);
    return bytes;
  }

  runQuery(sql: string): Promise<void> {
    this.assertUsable();
    if (this.store.state.phase !== 'ready' && this.store.state.phase !== 'querying') {
      return Promise.reject(new Error('A file must be ready before running a query.'));
    }
    const session = this.store.sessionGeneration;
    // Invalidated before the generation moves, so a sort in flight can never publish against the
    // query that replaces it.
    const sortCleanup = this.supersedeSort();
    const query = this.results.nextQuery();
    const exportCleanup = this.supersedeExport();
    this.store.dispatch({ type: 'queryStarted', sql });
    return this.results.execute(
      sql,
      session,
      query,
      sortCleanup.then(() => exportCleanup),
    );
  }

  loadMoreResults(): Promise<void> {
    this.assertUsable();
    return this.results.loadMore();
  }

  loadResultWindow(globalRow: number): Promise<void> {
    this.assertUsable();
    return this.results.loadWindow(globalRow);
  }

  retryResultPage(): Promise<void> {
    this.assertUsable();
    return this.results.retryPage();
  }

  /** What the UI needs to decide whether to offer sorting at all, before any result exists. */
  resultSortCapability(): ResultSortCapability {
    return this.database.resultSortCapability();
  }

  /**
   * Reorders every row of the CURRENT result by one column, or restores the original query order
   * when `sort` is null.
   *
   * The query is never re-run: the rows come from the pages the session already retains, so an
   * existing LIMIT still selects the same rows and a volatile value keeps whatever it evaluated to
   * the first time. An incomplete result is drained first, because sorting only part of a result
   * would misrepresent the whole.
   */
  async sortResults(sort: ResultSort | null): Promise<void> {
    this.assertUsable();
    const base = this.results.base;
    const previousView = this.results.view;
    const result = this.store.state.result;
    // Freshness and busy-ness are checked first when a result is on screen, so a stale result
    // says why it is stale rather than claiming no query has run.
    if (result && resultSortInteractionBlocked(this.store.state)) {
      throw new Error(this.sortBlockedReason());
    }
    if (!base || !previousView || !result) {
      throw new Error('Run a query before sorting its results.');
    }
    if (sort !== null) {
      const reason = resultSortDisabledReason(this.store.state, this.database.resultSortCapability());
      if (reason !== null) throw new Error(reason);
    }
    // Asking for the order already on display is not a no-op that needs a progress indicator and a
    // selection reset; it is nothing at all.
    if (sameResultSort(result.sort, sort)) return;

    const controller = new AbortController();
    const token = {
      id: ++this.sortRequestId,
      queryGeneration: this.results.generation,
      sessionGeneration: this.store.sessionGeneration,
      fromRevision: result.orderRevision,
      base,
      previousView,
      controller,
      settlement: Promise.resolve(),
    };
    this.activeSort = token;
    // Published synchronously so no other action can slip in before the operation is visible.
    this.publishSortProgress(token, {
      phase: sort === null ? 'storing' : 'loading',
      rows: result.loadedRows,
      totalRows: result.complete ? result.loadedRows : null,
      message: sort === null ? 'Restoring query order…' : 'Preparing sort…',
      requestedSort: sort,
    });

    const settlement = this.runSort(token, sort);
    token.settlement = settlement.then(
      () => undefined,
      () => undefined,
    );
    return settlement;
  }

  /** Stops a sort in flight without destroying the result it was derived from. */
  async cancelResultSort(): Promise<void> {
    this.assertUsable();
    const token = this.activeSort;
    if (!token) return;
    if (!token.controller.signal.aborted) {
      token.controller.abort(new DOMException('The sort was cancelled.', 'AbortError'));
    }
    this.publishSortProgress(token, {
      phase: 'cancelling',
      rows: this.store.state.sorting?.rows ?? 0,
      totalRows: this.store.state.sorting?.totalRows ?? null,
      message: 'Cancelling sort…',
      requestedSort: this.store.state.sorting?.requestedSort ?? null,
    });
    await token.settlement;
  }

  private sortBlockedReason(): string {
    if (!this.store.state.resultIsCurrent) return 'Run the query again before sorting its results.';
    // The same predicate the blocking check uses: a prepared-but-unsaved file does not block a
    // sort, so it must not be reported as the reason one was refused.
    if (hasActiveDownload(this.store.state)) return 'Finish or cancel the download before sorting.';
    if (this.activeSort !== null) return 'A sort is already running.';
    return 'The results cannot be sorted right now.';
  }

  private async runSort(token: NonNullable<SessionController['activeSort']>, sort: ResultSort | null) {
    const { base } = token;
    let candidate: QueryResultView | null = null;
    let adopted = false;
    try {
      // A terminal retained download artifact is released here: once the order changes, a
      // ready-to-save file built from the old one is no longer what the user asked for.
      await this.supersedeExport();
      this.assertCurrentSort(token);
      const pendingDemand = this.results.demand;
      if (pendingDemand) await pendingDemand.catch(() => undefined);
      this.assertCurrentSort(token);
      if (this.store.state.result?.pageError) {
        throw new Error('Retry or rerun the query before sorting results.');
      }

      if (sort !== null) {
        await this.drainForSort(token);
        candidate = await this.database.createSortedView(base, {
          sort,
          signal: token.controller.signal,
          onProgress: (progress) => this.publishSortPhase(token, progress, sort),
        });
      } else {
        candidate = base;
      }
      this.assertCurrentSort(token);

      const first = await readResultWindow(candidate, 0);
      this.assertCurrentSort(token);
      const current = this.store.state.result;
      if (
        !current ||
        !first.complete ||
        !sameResultSchema(first.schema, current.schema) ||
        first.loadedRows !== current.loadedRows
      ) {
        throw new Error('The sorted result did not match the query result.');
      }

      const next: PagedResultState = {
        generation: token.queryGeneration,
        schema: first.schema,
        loadedRows: first.loadedRows,
        complete: true,
        loadingMore: false,
        windowStart: first.windowStart,
        window: first.window,
        completeTable: this.results.viewerTable,
        elapsedMs: first.elapsedMs,
        pageError: null,
        pageErrorRetryable: false,
        orderRevision: token.fromRevision + 1,
        sort,
      };
      // One synchronous turn: adopt the view and publish the order together, so nothing can read a
      // view that does not match the revision on display.
      const previousView = this.results.adoptView(candidate);
      adopted = true;
      this.activeSort = null;
      this.store.dispatch({
        type: 'resultOrderCommitted',
        queryGeneration: token.queryGeneration,
        requestId: token.id,
        fromRevision: token.fromRevision,
        result: next,
      });
      await releaseView(previousView, base, candidate);
    } catch (error) {
      if (!adopted) await releaseView(candidate, base, null);
      if (this.activeSort === token) this.activeSort = null;
      this.reportSortOutcome(token, error);
    } finally {
      if (this.activeSort === token) this.activeSort = null;
    }
  }

  /** Loads the rest of the result, between page fetches, so the sort covers every row. */
  private async drainForSort(token: NonNullable<SessionController['activeSort']>): Promise<void> {
    const { base } = token;
    while (!base.status().complete) {
      this.assertCurrentSort(token);
      try {
        await base.fetchNext(QUERY_PAGE_ROWS);
      } catch (error) {
        const retryable = isRetryablePageError(error);
        const message = resultPageFailureMessage(error, 'More query rows could not be loaded.');
        if (this.isCurrentSort(token)) {
          this.store.dispatch({ type: 'queryPageFailed', message, retryable });
        }
        throw new Error(message, { cause: error });
      }
      this.assertCurrentSort(token);
      // Counts move forward while the previously visible window stays exactly where it is.
      this.results.refreshCounts(token.base, token.queryGeneration);
      this.publishSortProgress(token, {
        phase: 'loading',
        rows: base.status().loadedRows,
        totalRows: base.status().complete ? base.status().loadedRows : null,
        message: `Loading remaining rows… ${base.status().loadedRows.toLocaleString()} loaded`,
        requestedSort: this.store.state.sorting?.requestedSort ?? null,
      });
    }
  }

  private publishSortPhase(
    token: NonNullable<SessionController['activeSort']>,
    progress: ResultSortProgress,
    sort: ResultSort | null,
  ): void {
    if (!this.isCurrentSort(token)) return;
    const total = progress.totalRows.toLocaleString();
    const message =
      progress.phase === 'staging'
        ? `Preparing sort… ${progress.rows.toLocaleString()} of ${total} rows`
        : progress.phase === 'sorting'
          ? `Sorting all ${total} rows…`
          : `Saving sorted rows… ${progress.rows.toLocaleString()} of ${total}`;
    this.publishSortProgress(token, {
      phase: progress.phase,
      rows: progress.rows,
      totalRows: progress.totalRows,
      message,
      requestedSort: sort,
    });
  }

  private publishSortProgress(
    token: NonNullable<SessionController['activeSort']>,
    update: {
      phase: 'loading' | 'staging' | 'sorting' | 'storing' | 'cancelling' | 'failed';
      rows: number;
      totalRows: number | null;
      message: string;
      requestedSort: ResultSort | null;
    },
  ): void {
    this.store.dispatch({
      type: 'resultSortUpdated',
      queryGeneration: token.queryGeneration,
      requestId: token.id,
      sorting: {
        requestId: token.id,
        queryGeneration: token.queryGeneration,
        fromRevision: token.fromRevision,
        requestedSort: update.requestedSort,
        phase: update.phase,
        rows: update.rows,
        totalRows: update.totalRows,
        message: update.message,
      },
    });
  }

  /** A cancellation is not a failure; anything else becomes an inline sort error. */
  private reportSortOutcome(token: NonNullable<SessionController['activeSort']>, error: unknown): void {
    if (this.store.state.result?.generation !== token.queryGeneration) return;
    if (this.store.sessionGeneration !== token.sessionGeneration || this.store.disposed) return;
    if (isAbortError(error)) {
      this.store.dispatch({
        type: 'resultSortEnded',
        queryGeneration: token.queryGeneration,
        requestId: token.id,
      });
      return;
    }
    this.publishSortProgress(token, {
      phase: 'failed',
      rows: 0,
      totalRows: null,
      message: errorMessage(error, 'The results could not be sorted.'),
      requestedSort: this.store.state.sorting?.requestedSort ?? null,
    });
  }

  private isCurrentSort(token: NonNullable<SessionController['activeSort']>): boolean {
    return (
      !this.store.disposed &&
      this.activeSort === token &&
      !token.controller.signal.aborted &&
      this.store.sessionGeneration === token.sessionGeneration &&
      this.results.generation === token.queryGeneration &&
      this.results.base === token.base &&
      this.store.state.result?.generation === token.queryGeneration
    );
  }

  private assertCurrentSort(token: NonNullable<SessionController['activeSort']>): void {
    if (!this.isCurrentSort(token)) {
      throw new DOMException('The sort was replaced.', 'AbortError');
    }
  }

  /**
   * Invalidates any pending sort and joins its cleanup. Unlike a user cancellation, this belongs
   * to closing the whole result family, so the base may be cancelled by the caller afterwards.
   */
  private supersedeSort(): Promise<void> {
    const token = this.activeSort;
    this.activeSort = null;
    if (!token) return Promise.resolve();
    // Invalidated synchronously, before any await, so the success continuation cannot publish.
    if (!token.controller.signal.aborted) {
      token.controller.abort(new DOMException('The sort was replaced.', 'AbortError'));
    }
    return token.settlement;
  }

  downloadResults(options: ExportOptions): Promise<void> {
    this.assertUsable();
    const resultState = this.store.state.result;
    const base = this.results.base;
    const view = this.results.view;
    let columns: number[];
    let capturedNames: string[] | null;
    try {
      if (!resultState || !base || !view || resultState.generation !== this.results.generation) {
        throw new Error('Run a query before downloading results.');
      }
      if (!this.store.state.resultIsCurrent) {
        throw new Error('Run the query again before downloading results.');
      }
      if (this.activeSort !== null) {
        throw new Error('Finish or cancel the sort before downloading results.');
      }
      if (resultState.pageError) {
        throw new Error('Retry or rerun the query before downloading results.');
      }
      columns = selectExportColumns(resultState.schema, options);
      capturedNames =
        options.format === 'parquet'
          ? parquetColumnNames(resultState.schema, columns).map(({ name }) => name)
          : null;
    } catch (error) {
      return this.publishDownloadValidationFailure(error);
    }

    const previousDownload = this.store.state.download?.generation;
    const generation = ++this.exportGeneration;
    const priorCleanup = this.detachExportResources();
    if (previousDownload !== undefined) {
      this.store.dispatch({ type: 'downloadUpdated', generation: previousDownload, download: null });
    }
    const filename = exportFilename(
      this.store.state.source?.files.map((file) => file.name) ?? [],
      options.format,
    );
    const abortController = new AbortController();
    const operation: ExportOperation = {
      generation,
      resultGeneration: resultState.generation,
      base,
      // Both the view and its revision are captured here: the file must reproduce the order the
      // user was looking at when they asked for it.
      result: view,
      orderRevision: resultState.orderRevision,
      parquetColumnNames: capturedNames === null ? null : [...capturedNames],
      abortController,
      destination: null,
      destinationAbort: null,
      settlement: Promise.resolve(),
    };
    this.activeExport = operation;
    this.results.suspendFetches(generation);
    this.updateDownload(operation, {
      phase: 'picking',
      rows: resultState.loadedRows,
      totalRows: resultState.complete ? resultState.loadedRows : null,
      bytes: 0,
      message: null,
    });

    let destination: Promise<ExportDestination>;
    try {
      // Keep the picker invocation in the caller's user-activation turn.
      destination = this.prepareDestination(filename, options.format);
    } catch (error) {
      destination = Promise.reject(error);
    }
    const destinationOutcome = destination.then<ExportDestinationOutcome, ExportDestinationOutcome>(
      (acquired) => ({ status: 'fulfilled', destination: acquired }),
      (error: unknown) => ({ status: 'rejected', error }),
    );
    operation.settlement = this.performDownload(
      operation,
      destinationOutcome,
      priorCleanup,
      options,
      columns,
    );
    return operation.settlement;
  }

  cancelResultsDownload(): Promise<void> {
    this.assertUsable();
    const operation = this.activeExport;
    if (!operation) return Promise.resolve();
    operation.abortController.abort();
    this.updateDownload(operation, {
      phase: 'cancelling',
      message: 'Cancelling download…',
    });
    const aborting = this.abortExportDestination(operation);
    return Promise.allSettled([aborting, operation.settlement]).then(() => undefined);
  }

  saveResultsDownload(): void {
    this.assertUsable();
    const retained = this.retainedExport;
    if (!retained || this.store.state.download?.generation !== retained.generation) return;
    try {
      // This must stay synchronous so the fallback anchor click retains user activation.
      retained.destination.save();
      this.store.dispatch({
        type: 'downloadUpdated',
        generation: retained.generation,
        download: {
          ...this.store.state.download,
          phase: 'saved',
          message: 'Download handed to the browser.',
        },
      });
    } catch (error) {
      this.store.dispatch({
        type: 'downloadUpdated',
        generation: retained.generation,
        download: {
          ...this.store.state.download,
          phase: 'failed',
          message: errorMessage(error, 'The prepared file could not be saved.'),
        },
      });
    }
  }

  dismissResultsDownload(): Promise<void> {
    this.assertUsable();
    const generation = this.store.state.download?.generation;
    ++this.exportGeneration;
    const cleanup = this.detachExportResources();
    if (generation !== undefined) {
      this.store.dispatch({ type: 'downloadUpdated', generation, download: null });
    }
    return cleanup;
  }

  async cancel(): Promise<void> {
    this.assertUsable();
    const stoppedResult = this.store.state.result && !this.store.state.result.complete;
    const sortCleanup = this.supersedeSort();
    this.store.nextSession();
    this.results.nextQuery();
    const exportCleanup = this.supersedeExport().then(() => sortCleanup);
    this.cancelParser();
    this.stopActiveViewer();
    const cancellation = exportCleanup.then(() => this.results.close({ cancel: true }));
    if (stoppedResult) {
      this.store.dispatch({
        type: 'queryPageFailed',
        message: 'Query result loading was cancelled. Run the query again to load more rows.',
        retryable: false,
      });
    }
    if (
      this.store.state.phase === 'opening' ||
      this.store.state.phase === 'normalizing' ||
      this.store.state.phase === 'parsing' ||
      this.store.state.phase === 'projecting' ||
      this.store.state.phase === 'querying'
    ) {
      this.store.dispatch({ type: 'cancelled' });
    }
    await cancellation;
  }

  selectResultRow(row: number | null): void {
    this.assertUsable();
    // A row index means a position in the committed display, which is exactly what a pending sort
    // is about to change.
    if (this.activeSort !== null) return;
    this.store.dispatch({ type: 'rowSelected', row });
  }

  getSourceBlob(file: string): Blob | null {
    return this.retainedBlobs.get(file) ?? null;
  }

  selectByteRange(range: { file: string; start: number; end: number } | null): void {
    this.assertUsable();
    if (this.activeSort !== null) return;
    this.store.dispatch({ type: 'byteRangeSelected', range });
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.store.markDisposed();
    const sortCleanup = this.supersedeSort();
    this.store.nextSession();
    this.results.nextQuery();
    const exportCleanup = this.supersedeExport().then(() => sortCleanup);
    this.initializationAbort.abort();
    this.store.release();
    void this.initialization?.catch(() => undefined);
    this.sampleCache.clear();
    this.retainedBlobs = new Map();
    this.stopActiveViewer();
    try {
      this.parser.dispose();
    } catch {
      // Continue releasing independently-owned resources.
    }
    this.disposal = (async () => {
      await exportCleanup;
      await this.results.close({ cancel: true });
      await this.disposeCsvClient();
      await Promise.resolve()
        .then(() => this.database.dispose())
        .catch(() => undefined);
    })();
    return this.disposal;
  }

  private async initializeOnce(): Promise<void> {
    try {
      await Promise.all([
        this.database.initialize(),
        this.csvClient.initialize(),
        // Best-effort: reclaim OPFS scratch directories orphaned by a prior crashed session.
        // No generation is "kept" — a fresh controller never inherits an in-flight ingest or query.
        sweepSpillOrphans([]).catch(() => undefined),
        sweepQueryPageOrphans().catch(() => undefined),
      ]);
      if (this.store.disposed) throw disposedError();
    } catch (error) {
      await this.disposeCsvClient();
      throw error;
    }
  }

  private async openBatch(entries: readonly BatchEntry[]): Promise<void> {
    const sortCleanup = this.supersedeSort();
    const generation = this.store.nextSession();
    this.results.nextQuery();
    const exportCleanup = this.supersedeExport();
    this.cancelParser();
    this.stopActiveViewer();
    const queryCancellation = exportCleanup
      .then(() => sortCleanup)
      .then(() => this.results.close({ cancel: true }));
    this.bytesIngested = 0;
    this.lastProgress = null;

    const plan = await planBatch(entries, REGISTERED_PACKS);
    if (!this.isCurrent(generation)) return;
    const okFiles = plan.files.filter((file) => file.status === 'ok');
    if (plan.formatId === null || okFiles.length === 0) {
      this.store.dispatch({ type: 'failed', message: 'No registered format recognizes the selected files.' });
      return;
    }

    this.retainedBlobs = new Map(okFiles.map((file) => [file.displayName, file.blob]));
    this.batchFileIndex = 1;
    this.batchFileCount = okFiles.length;
    this.store.dispatch({
      type: 'opening',
      source: {
        files: okFiles.map((file) => ({ name: file.displayName, size: file.size })),
        totalSize: plan.totalSize,
      },
    });
    return this.completeBatchOpen(generation, plan.formatId, plan.files, queryCancellation);
  }

  private async completeBatchOpen(
    generation: number,
    formatId: string,
    planned: readonly PlannedFile[],
    queryCancellation: Promise<void>,
  ): Promise<void> {
    await queryCancellation;
    if (!this.isCurrent(generation)) return;

    const tierThresholdBytes = this.tiering?.tierThresholdBytes ?? TIER_THRESHOLD_BYTES;
    const okPlanned = planned.filter((file) => file.status === 'ok');
    const totalSize = okPlanned.reduce((sum, file) => sum + file.size, 0);
    const tier = chooseTier(totalSize, tierThresholdBytes);
    if (tier === 'spill') {
      void navigator.storage?.persist?.().catch(() => undefined);
    }

    const rotationBytes = this.tiering?.rotationBytes;
    await this.ingestSettlement;
    if (!this.isCurrent(generation)) return;

    let ingest: IngestSession;
    try {
      ingest = await this.database.beginIngest({
        tier,
        generation,
        ...(rotationBytes !== undefined ? { rotationBytes } : {}),
      });
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.store.dispatch({ type: 'failed', message: this.openFailureMessage(error, tierThresholdBytes) });
      }
      return;
    }

    let settleIngest!: () => void;
    this.ingestSettlement = new Promise<void>((resolve) => {
      settleIngest = resolve;
    });

    try {
      if (!this.isCurrent(generation)) {
        await ingest.abort().catch(() => undefined);
        return;
      }

      // Batch-skip bookkeeping: planner skips carry over; mid-parse failures join them.
      const skipped = new Map<string, string>(
        planned.filter((file) => file.status === 'skipped').map((f) => [f.displayName, f.error ?? '']),
      );
      const results: StreamedParseResult[] = [];
      const succeededFiles: SourceFile[] = [];
      const issues: ParseIssue[] = [];

      try {
        for (const [index, file] of okPlanned.entries()) {
          if (!this.isCurrent(generation)) {
            await ingest.abort().catch(() => undefined);
            return;
          }
          this.batchFileIndex = index + 1;
          this.lastProgress = null;
          await ingest.beginFile(file.displayName);

          const pendingAppends: Promise<void>[] = [];
          try {
            const result = await this.parser.parse(
              { name: file.displayName, blob: file.blob, formatId },
              {
                onProgress: (progress) => {
                  if (this.isCurrent(generation)) this.progress(generation, progress);
                },
                onBatch: async (batch) => {
                  if (!this.isCurrent(generation)) return;
                  this.bytesIngested += batch.ipc.byteLength;
                  this.progressBytes(generation);
                  const append = ingest.appendBatch(batch.table, batch.ipc);
                  pendingAppends.push(append);
                  await append;
                },
              },
            );
            await Promise.all(pendingAppends);
            if (!this.isCurrent(generation)) {
              await ingest.abort().catch(() => undefined);
              return;
            }
            results.push(result);
            succeededFiles.push({ name: file.displayName, size: file.size });
            issues.push(...result.issues);
          } catch (error) {
            await Promise.allSettled(pendingAppends);
            if (isAbortError(error)) throw error;
            const message = errorMessage(error, 'The local file could not be parsed.');
            // Environment-level failures (quota, unsupported spill) doom the whole batch.
            if (hasDbErrorCode(error, 'SPILL_QUOTA_EXCEEDED', 'SPILL_UNSUPPORTED')) {
              throw error;
            }
            if (!this.isCurrent(generation)) {
              await ingest.abort().catch(() => undefined);
              return;
            }
            await ingest.discardCurrentFile();
            this.retainedBlobs.delete(file.displayName);
            skipped.set(file.displayName, message);
          }
        }

        if (!this.isCurrent(generation)) {
          await ingest.abort().catch(() => undefined);
          return;
        }
        if (results.length === 0) {
          const reasons = [...skipped.values()].filter(Boolean);
          throw new Error(reasons[0] ?? 'None of the selected files could be ingested.');
        }

        for (const [displayName, reason] of skipped) {
          issues.push({
            stage: 'framing',
            track: null,
            code: 'FILE_SKIPPED',
            message: `${displayName} was skipped: ${reason}`,
            recoverable: true,
            sourceStart: null,
            sourceEnd: null,
          });
        }

        const filesRows: FilesRow[] = planned.map((file, order) => ({
          file: file.displayName,
          originalName: file.originalName,
          size: file.size,
          ingestOrder: order,
          status: skipped.has(file.displayName) || file.status === 'skipped' ? 'skipped' : 'ok',
          error: skipped.get(file.displayName) ?? file.error,
        }));
        await ingest.appendBatch('_files', buildFilesTableIpc(filesRows));

        const first = results[0]!;
        const summaries = await ingest.finalize(first.schemas);
        if (!this.isCurrent(generation)) return;

        const rowCounts = new Map(summaries.map((summary) => [summary.name, summary.rowCount]));
        const mergedTables = mergeTableOverviews(results.map((result) => result.tables));
        const populatedNames = new Set(mergedTables.map((table) => table.name));
        const backfilledTables = first.schemas
          .filter((schema) => !populatedNames.has(schema.name))
          .map((schema) => ({ name: schema.name, rowCount: 0, columns: schema.columns }));
        const filesOverview: TableOverview = {
          name: '_files',
          rowCount: filesRows.length,
          columns: [
            { name: 'file', type: 'Utf8', nullable: false },
            { name: 'original_name', type: 'Utf8', nullable: false },
            { name: 'size', type: 'Uint64', nullable: false },
            { name: 'ingest_order', type: 'Int32', nullable: false },
            { name: 'status', type: 'Utf8', nullable: false },
            { name: 'error', type: 'Utf8', nullable: true },
          ],
        };
        this.store.dispatch({
          type: 'ready',
          format: first.format,
          files: succeededFiles,
          tables: [...mergedTables, ...backfilledTables, filesOverview].map((table) => ({
            ...table,
            rowCount: rowCounts.get(table.name) ?? table.rowCount,
          })),
          issues,
          queries: first.queries,
          capabilities: first.capabilities,
        });
      } catch (error) {
        await ingest.abort().catch(() => undefined);
        if (!this.isCurrent(generation)) return;
        if (isAbortError(error)) {
          this.store.dispatch({ type: 'cancelled' });
          return;
        }
        this.store.dispatch({ type: 'failed', message: this.openFailureMessage(error, tierThresholdBytes) });
      }
    } finally {
      settleIngest();
    }
  }

  private openFailureMessage(error: unknown, tierThresholdBytes: number): string {
    const raw = errorMessage(error, 'The local file could not be parsed.');
    if (hasDbErrorCode(error, 'SPILL_UNSUPPORTED')) {
      return `This browser cannot analyze files over ${bytesToMb(tierThresholdBytes)} MB.`;
    }
    if (hasDbErrorCode(error, 'SPILL_QUOTA_EXCEEDED')) {
      return 'Local storage ran out of space while analyzing this file. Free up space and try again.';
    }
    return raw;
  }

  private async performDownload(
    operation: ExportOperation,
    destinationOutcome: Promise<ExportDestinationOutcome>,
    priorCleanup: Promise<void>,
    options: ExportOptions,
    columns: readonly number[],
  ): Promise<void> {
    let destination: ExportDestination | null = null;
    let keepDestination = false;
    try {
      await priorCleanup;
      const acquired = await destinationOutcome;
      if (acquired.status === 'rejected') throw acquired.error;
      destination = acquired.destination;
      operation.destination = destination;
      this.assertCurrentExport(operation);

      this.results.suspendFetches(operation.generation);
      this.updateDownload(operation, {
        phase: 'loading',
        message: 'Loading remaining rows…',
      });
      const pendingDemand = this.results.demand;
      if (pendingDemand) await pendingDemand.catch(() => undefined);
      this.assertCurrentExport(operation);
      if (this.store.state.result?.pageError) {
        throw new Error('Retry or rerun the query before downloading results.');
      }

      // Only the cursor-backed base can be asked for more rows. A derived view is complete by
      // construction, so reaching for fetchNext on one would be a category error.
      if (operation.result !== operation.base && !operation.result.status().complete) {
        throw new Error('A sorted result must be complete before it can be downloaded.');
      }
      while (operation.result === operation.base && !operation.base.status().complete) {
        this.throwIfExportAborted(operation);
        try {
          await operation.base.fetchNext(QUERY_PAGE_ROWS);
        } catch (error) {
          throw new Error(this.publishExportPageFailure(operation, error), { cause: error });
        }
        this.assertCurrentExport(operation);
        this.results.refreshCounts(operation.result, operation.resultGeneration, operation.orderRevision);
        const status = operation.result.status();
        this.updateDownload(operation, {
          phase: 'loading',
          rows: status.loadedRows,
          totalRows: status.complete ? status.loadedRows : null,
          message: status.complete ? 'All rows loaded.' : 'Loading remaining rows…',
        });
      }

      this.results.refreshCounts(operation.result, operation.resultGeneration, operation.orderRevision);
      const totalRows = operation.result.status().loadedRows;
      this.updateDownload(operation, {
        phase: 'encoding',
        rows: 0,
        totalRows,
        message: options.format === 'csv' ? 'Preparing CSV file…' : 'Preparing Parquet file…',
      });

      let bytes = 0;
      if (options.format === 'csv') {
        const pages = operation.result.pages();
        if (pages.length === 0) {
          await this.csvClient.encode(
            tableToIpc(new Table(operation.result.schema)),
            columns,
            true,
            async (chunk) => {
              await destination!.write(chunk);
              bytes += chunk.byteLength;
              this.updateDownload(operation, { phase: 'encoding', bytes });
            },
            operation.abortController.signal,
          );
        } else {
          let rows = 0;
          for (const [index, summary] of pages.entries()) {
            this.throwIfExportAborted(operation);
            const storedPage = await operation.result.readPage(summary.index);
            this.assertCurrentExport(operation);
            await this.csvClient.encode(
              tableToIpc(storedPage.table),
              columns,
              index === 0,
              async (chunk) => {
                await destination!.write(chunk);
                bytes += chunk.byteLength;
                this.updateDownload(operation, { phase: 'encoding', bytes });
              },
              operation.abortController.signal,
            );
            rows += summary.rowCount;
            this.updateDownload(operation, { phase: 'encoding', rows, bytes });
          }
        }
      } else {
        if (operation.parquetColumnNames === null) {
          throw new Error('Parquet column names were not captured for this export.');
        }
        const artifact = await this.database.exportParquet(operation.result, {
          columns,
          columnNames: operation.parquetColumnNames,
          signal: operation.abortController.signal,
          onProgress: (rows) => {
            this.updateDownload(operation, { phase: 'encoding', rows });
          },
        });
        try {
          this.assertCurrentExport(operation);
          bytes = await this.copyFileToDestination(operation, artifact.file, destination, totalRows);
        } finally {
          await artifact.dispose();
        }
      }

      this.updateDownload(operation, {
        phase: 'saving',
        rows: totalRows,
        totalRows,
        bytes,
        message: 'Saving file…',
      });
      // The identity check and invocation intentionally share one synchronous turn. Once close
      // starts, supersession aborts the sink and joins this promise before disposing the query.
      this.assertCurrentExport(operation);
      const committing = destination.commit();
      const outcome = await committing;
      this.assertCurrentExport(operation);
      if (outcome === 'ready-to-save') {
        keepDestination = true;
        this.retainedExport = { generation: operation.generation, destination };
        this.updateDownload(operation, {
          phase: 'ready-to-save',
          message: 'File ready. Choose Save file to download it.',
        });
      } else {
        await destination.dispose();
        destination = null;
        this.updateDownload(operation, {
          phase: 'saved',
          message: 'File saved.',
        });
      }
    } catch (error) {
      if (destination) {
        await this.abortExportDestination(operation);
        await destination.dispose().catch(() => undefined);
      } else {
        void destinationOutcome.then(async (outcome) => {
          if (outcome.status === 'rejected') return;
          await outcome.destination.abort().catch(() => undefined);
          await outcome.destination.dispose().catch(() => undefined);
        });
      }
      if (this.activeExport === operation && operation.generation === this.exportGeneration) {
        const cancelled = operation.abortController.signal.aborted || isAbortError(error);
        this.updateDownload(operation, {
          phase: cancelled ? 'cancelled' : 'failed',
          message: cancelled
            ? 'Download cancelled.'
            : errorMessage(error, 'The result could not be downloaded.'),
        });
      }
    } finally {
      this.results.resumeFetches(operation.generation);
      if (this.activeExport === operation) this.activeExport = null;
      if (!keepDestination && this.retainedExport?.generation === operation.generation) {
        this.retainedExport = null;
      }
    }
  }

  private async copyFileToDestination(
    operation: ExportOperation,
    file: File,
    destination: ExportDestination,
    totalRows: number,
  ): Promise<number> {
    const reader = file.stream().getReader();
    const cancelReader = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    operation.abortController.signal.addEventListener('abort', cancelReader, { once: true });
    let bytes = 0;
    try {
      while (true) {
        this.throwIfExportAborted(operation);
        const next = await reader.read();
        if (next.done) return bytes;
        this.assertCurrentExport(operation);
        await destination.write(next.value);
        bytes += next.value.byteLength;
        this.updateDownload(operation, {
          phase: 'saving',
          rows: totalRows,
          totalRows,
          bytes,
          message: 'Saving file…',
        });
      }
    } finally {
      operation.abortController.signal.removeEventListener('abort', cancelReader);
      reader.releaseLock();
    }
  }

  private publishDownloadValidationFailure(error: unknown): Promise<void> {
    const previousDownload = this.store.state.download?.generation;
    const generation = ++this.exportGeneration;
    const cleanup = this.detachExportResources();
    if (previousDownload !== undefined) {
      this.store.dispatch({ type: 'downloadUpdated', generation: previousDownload, download: null });
    }
    this.store.dispatch({
      type: 'downloadUpdated',
      generation,
      download: {
        generation,
        phase: 'failed',
        rows: this.store.state.result?.loadedRows ?? 0,
        totalRows: this.store.state.result?.complete ? this.store.state.result.loadedRows : null,
        bytes: 0,
        message: errorMessage(error, 'The result cannot be downloaded.'),
      },
    });
    return cleanup;
  }

  private updateDownload(operation: ExportOperation, update: Partial<Omit<ExportState, 'generation'>>): void {
    if (operation.generation !== this.exportGeneration) return;
    const current = this.store.state.download;
    if (current && current.generation !== operation.generation) return;
    const base: ExportState = current ?? {
      generation: operation.generation,
      phase: 'picking',
      rows: 0,
      totalRows: null,
      bytes: 0,
      message: null,
    };
    this.store.dispatch({
      type: 'downloadUpdated',
      generation: operation.generation,
      download: { ...base, ...update },
    });
  }

  private publishExportPageFailure(operation: ExportOperation, error: unknown): string {
    const message = resultPageFailureMessage(error, 'More query rows could not be loaded.');
    if (!this.isCurrentExport(operation)) return message;
    this.store.dispatch({
      type: 'queryPageFailed',
      message,
      retryable: isRetryablePageError(error),
    });
    return message;
  }

  private throwIfExportAborted(operation: ExportOperation): void {
    if (operation.abortController.signal.aborted) {
      throw new DOMException('The download was cancelled.', 'AbortError');
    }
  }

  private assertCurrentExport(operation: ExportOperation): void {
    this.throwIfExportAborted(operation);
    if (!this.isCurrentExport(operation)) {
      throw new DOMException('The download was replaced.', 'AbortError');
    }
  }

  private isCurrentExport(operation: ExportOperation): boolean {
    return (
      !this.store.disposed &&
      this.exportGeneration === operation.generation &&
      this.activeExport === operation &&
      this.results.base === operation.base &&
      this.results.view === operation.result &&
      this.results.generation === operation.resultGeneration &&
      this.store.state.result?.generation === operation.resultGeneration &&
      this.store.state.result.orderRevision === operation.orderRevision
    );
  }

  private supersedeExport(): Promise<void> {
    const generation = this.store.state.download?.generation;
    ++this.exportGeneration;
    const cleanup = this.detachExportResources();
    if (generation !== undefined) {
      this.store.dispatch({ type: 'downloadUpdated', generation, download: null });
    }
    return cleanup;
  }

  private detachExportResources(): Promise<void> {
    const priorCleanup = this.exportCleanup;
    const active = this.activeExport;
    const retained = this.retainedExport;
    this.activeExport = null;
    this.retainedExport = null;
    active?.abortController.abort();
    const aborting = active ? this.abortExportDestination(active) : Promise.resolve();
    const disposingRetained = retained?.destination.dispose().catch(() => undefined) ?? Promise.resolve();
    this.exportCleanup = Promise.allSettled([
      priorCleanup,
      aborting,
      active?.settlement ?? Promise.resolve(),
      disposingRetained,
    ]).then(() => undefined);
    return this.exportCleanup;
  }

  private abortExportDestination(operation: ExportOperation): Promise<void> {
    if (!operation.destination) return Promise.resolve();
    operation.destinationAbort ??= operation.destination.abort().catch(() => undefined);
    return operation.destinationAbort;
  }

  private disposeCsvClient(): Promise<void> {
    this.csvDisposal ??= this.csvClient.dispose().catch(() => undefined);
    return this.csvDisposal;
  }

  private progress(generation: number, progress: ParseProgress): void {
    if (!this.isCurrent(generation)) return;
    this.lastProgress = progress;
    this.store.dispatch({
      type: 'progress',
      ...progress,
      bytes: this.bytesIngested,
      fileIndex: this.batchFileIndex,
      fileCount: this.batchFileCount,
    });
  }

  private progressBytes(generation: number): void {
    if (!this.isCurrent(generation)) return;
    const base = this.lastProgress ?? {
      stage: 'parsing' as const,
      completed: 0,
      total: null,
      label: 'Streaming data into the local database',
    };
    this.store.dispatch({
      type: 'progress',
      ...base,
      bytes: this.bytesIngested,
      fileIndex: this.batchFileIndex,
      fileCount: this.batchFileCount,
    });
  }

  private cancelParser(): void {
    try {
      this.parser.cancel();
    } catch {
      // The client terminates its worker as the authoritative cancellation path.
    }
  }

  private stopActiveViewer(): void {
    try {
      this.stopViewer();
    } catch {
      // Viewer cleanup must not prevent parse, database, or worker cleanup.
    }
  }

  private isCurrent(generation: number): boolean {
    return this.store.isCurrent(generation);
  }

  private assertUsable(): void {
    if (this.store.disposed) throw disposedError();
  }
}
