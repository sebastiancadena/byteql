import {
  QUERY_PAGE_ROWS,
  type ByteqlDatabase,
  type QueryResultView,
  type QuerySession,
  type ResultSort,
  type ResultSortProgress,
} from '@byteql/db';

import { resultSortDisabledReason } from './result-sort-availability.js';
import { resultSortInteractionBlocked, sameResultSchema, type ResultBusy } from './result-sort.js';
import { readResultWindow } from './result-view.js';
import { releaseView, type ResultSession } from './result-session.js';
import {
  errorMessage,
  isAbortError,
  isRetryablePageError,
  resultPageFailureMessage,
} from './session-errors.js';
import type { SessionStore } from './session-store.js';
import type { PagedResultState, ResultSortingState } from './state.js';

/** Whether two committed orders are the same request, so asking again would change nothing. */
const sameResultSort = (left: ResultSort | null, right: ResultSort | null): boolean =>
  left === null || right === null
    ? left === right
    : left.columnIndex === right.columnIndex && left.direction === right.direction;

interface SortRequest {
  id: number;
  queryGeneration: number;
  sessionGeneration: number;
  fromRevision: number;
  base: QuerySession;
  previousView: QueryResultView;
  controller: AbortController;
  settlement: Promise<void>;
}

interface SortProgressUpdate {
  phase: ResultSortingState['phase'];
  rows: number;
  totalRows: number | null;
  message: string;
  requestedSort: ResultSort | null;
}

export interface ResultSorterHooks {
  /** Releases a download of the result: a ready-to-save file of the old order is not wanted. */
  supersedeExport(): Promise<void>;
}

/**
 * Reorders the current result without re-running its query, and restores the original order.
 *
 * Its fence is the sort request: every awaited step re-checks that the request is still the one
 * pending and that the session generation, query generation, base, and displayed result it
 * captured are all unchanged.
 */
export class ResultSorter {
  private sortRequestId = 0;
  private activeSort: SortRequest | null = null;

  constructor(
    private readonly store: SessionStore,
    private readonly database: ByteqlDatabase,
    private readonly results: ResultSession,
    private readonly busy: ResultBusy,
    private readonly hooks: ResultSorterHooks,
  ) {}

  /** Whether a sort has been requested and has not yet committed, failed, or been cancelled. */
  get pending(): boolean {
    return this.activeSort !== null;
  }

  async sort(sort: ResultSort | null): Promise<void> {
    const base = this.results.base;
    const previousView = this.results.view;
    const result = this.store.state.result;
    // Freshness and busy-ness are checked first when a result is on screen, so a stale result
    // says why it is stale rather than claiming no query has run.
    if (result && resultSortInteractionBlocked(this.store.state)) {
      throw new Error(this.blockedReason());
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
    const token: SortRequest = {
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
    this.publishProgress(token, {
      phase: sort === null ? 'storing' : 'loading',
      rows: result.loadedRows,
      totalRows: result.complete ? result.loadedRows : null,
      message: sort === null ? 'Restoring query order…' : 'Preparing sort…',
      requestedSort: sort,
    });

    const settlement = this.run(token, sort);
    token.settlement = settlement.then(
      () => undefined,
      () => undefined,
    );
    return settlement;
  }

  /** Stops a sort in flight without destroying the result it was derived from. */
  async cancel(): Promise<void> {
    const token = this.activeSort;
    if (!token) return;
    if (!token.controller.signal.aborted) {
      token.controller.abort(new DOMException('The sort was cancelled.', 'AbortError'));
    }
    const sorting = this.store.state.sorting;
    this.publishProgress(token, {
      phase: 'cancelling',
      rows: sorting?.rows ?? 0,
      totalRows: sorting?.totalRows ?? null,
      message: 'Cancelling sort…',
      requestedSort: sorting?.requestedSort ?? null,
    });
    await token.settlement;
  }

  /**
   * Invalidates any pending sort and joins its cleanup. Unlike a user cancellation, this belongs
   * to closing the whole result family, so the base may be cancelled by the caller afterwards.
   */
  supersede(): Promise<void> {
    const token = this.activeSort;
    this.activeSort = null;
    if (!token) return Promise.resolve();
    // Invalidated synchronously, before any await, so the success continuation cannot publish.
    if (!token.controller.signal.aborted) {
      token.controller.abort(new DOMException('The sort was replaced.', 'AbortError'));
    }
    return token.settlement;
  }

  private blockedReason(): string {
    if (!this.store.state.resultIsCurrent) return 'Run the query again before sorting its results.';
    // The same predicate the blocking check uses: a prepared-but-unsaved file does not block a
    // sort, so it must not be reported as the reason one was refused.
    if (this.busy.downloadActive()) return 'Finish or cancel the download before sorting.';
    if (this.activeSort !== null) return 'A sort is already running.';
    return 'The results cannot be sorted right now.';
  }

  private async run(token: SortRequest, sort: ResultSort | null): Promise<void> {
    const { base } = token;
    let candidate: QueryResultView | null = null;
    let adopted = false;
    try {
      // A terminal retained download artifact is released here: once the order changes, a
      // ready-to-save file built from the old one is no longer what the user asked for.
      await this.hooks.supersedeExport();
      this.assertCurrent(token);
      const pendingDemand = this.results.demand;
      if (pendingDemand) await pendingDemand.catch(() => undefined);
      this.assertCurrent(token);
      if (this.store.state.result?.pageError) {
        throw new Error('Retry or rerun the query before sorting results.');
      }

      if (sort !== null) {
        await this.drain(token);
        candidate = await this.database.createSortedView(base, {
          sort,
          signal: token.controller.signal,
          onProgress: (progress) => this.publishPhase(token, progress, sort),
        });
      } else {
        candidate = base;
      }
      this.assertCurrent(token);

      const first = await readResultWindow(candidate, 0);
      this.assertCurrent(token);
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
      this.reportOutcome(token, error);
    } finally {
      if (this.activeSort === token) this.activeSort = null;
    }
  }

  /** Loads the rest of the result, between page fetches, so the sort covers every row. */
  private async drain(token: SortRequest): Promise<void> {
    const { base } = token;
    while (!base.status().complete) {
      this.assertCurrent(token);
      try {
        await base.fetchNext(QUERY_PAGE_ROWS);
      } catch (error) {
        const retryable = isRetryablePageError(error);
        const message = resultPageFailureMessage(error, 'More query rows could not be loaded.');
        if (this.isCurrent(token)) {
          this.store.dispatch({ type: 'queryPageFailed', message, retryable });
        }
        throw new Error(message, { cause: error });
      }
      this.assertCurrent(token);
      // Counts move forward while the previously visible window stays exactly where it is.
      this.results.refreshCounts(token.base, token.queryGeneration);
      this.publishProgress(token, {
        phase: 'loading',
        rows: base.status().loadedRows,
        totalRows: base.status().complete ? base.status().loadedRows : null,
        message: `Loading remaining rows… ${base.status().loadedRows.toLocaleString()} loaded`,
        requestedSort: this.store.state.sorting?.requestedSort ?? null,
      });
    }
  }

  private publishPhase(token: SortRequest, progress: ResultSortProgress, sort: ResultSort | null): void {
    if (!this.isCurrent(token)) return;
    const total = progress.totalRows.toLocaleString();
    const message =
      progress.phase === 'staging'
        ? `Preparing sort… ${progress.rows.toLocaleString()} of ${total} rows`
        : progress.phase === 'sorting'
          ? `Sorting all ${total} rows…`
          : `Saving sorted rows… ${progress.rows.toLocaleString()} of ${total}`;
    this.publishProgress(token, {
      phase: progress.phase,
      rows: progress.rows,
      totalRows: progress.totalRows,
      message,
      requestedSort: sort,
    });
  }

  private publishProgress(token: SortRequest, update: SortProgressUpdate): void {
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
  private reportOutcome(token: SortRequest, error: unknown): void {
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
    this.publishProgress(token, {
      phase: 'failed',
      rows: 0,
      totalRows: null,
      message: errorMessage(error, 'The results could not be sorted.'),
      requestedSort: this.store.state.sorting?.requestedSort ?? null,
    });
  }

  private isCurrent(token: SortRequest): boolean {
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

  private assertCurrent(token: SortRequest): void {
    if (!this.isCurrent(token)) {
      throw new DOMException('The sort was replaced.', 'AbortError');
    }
  }
}
