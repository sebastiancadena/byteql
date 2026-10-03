import {
  QUERY_INITIAL_ROWS,
  QUERY_PAGE_ROWS,
  QUERY_RESULT_MEMORY_BYTES,
  type ByteqlDatabase,
  type QueryResultView,
  type QuerySession,
} from '@byteql/db';
import type { Table } from 'apache-arrow';

import { readResultWindow } from './result-view.js';
import {
  errorMessage,
  isAbortError,
  isRetryablePageError,
  resultPageFailureMessage,
} from './session-errors.js';
import type { SessionStore } from './session-store.js';
import type { PagedResultState } from './state.js';

export interface ResultSessionHooks {
  /** Whether a sort currently holds the result; paging demand is refused while one does. */
  sortPending(): boolean;
  /** Releases any download of the result, for when the result family has to close. */
  supersedeExport(): Promise<void>;
}

/**
 * Releases a view the display no longer owns.
 *
 * The base is excluded explicitly rather than by reading the session's current base, which a
 * caller may already have cleared: disposing the base here would close the whole result family
 * behind the back of whoever owns that decision.
 */
export async function releaseView(
  view: QueryResultView | null,
  base: QueryResultView | null,
  keep: QueryResultView | null,
): Promise<void> {
  if (!view || view === base || view === keep) return;
  try {
    await view.dispose();
  } catch {
    // The database keeps the release as a retry; the committed order stands either way.
  }
}

/**
 * The current query's result family: the cursor-backed base, the view the grid reads, the paged
 * demand against them, and the table trusted viewers receive.
 *
 * Its fence is the query generation. Every awaited step re-checks both the session generation and
 * the query generation it captured, together with the identity of the base, before publishing.
 */
export class ResultSession {
  private queryGeneration = 0;
  private activeQuery: QuerySession | null = null;
  /**
   * The view the grid is currently reading. Starts as the base result and becomes a derived
   * sorted view once an order is committed; the base stays in `activeQuery` throughout, because
   * restoring the original order means reading it again, not running the query again.
   */
  private activeResultView: QueryResultView | null = null;
  /** The base result materialized once for trusted viewers, in ORIGINAL query order. */
  private baseViewerTable: Table | null = null;
  private baseViewerMaterialized = false;
  private resultDemand: Promise<void> | null = null;
  private resultFetchSuspendedBy: number | null = null;

  constructor(
    private readonly store: SessionStore,
    private readonly database: ByteqlDatabase,
    private readonly hooks: ResultSessionHooks,
  ) {}

  get generation(): number {
    return this.queryGeneration;
  }

  /** The cursor-backed result of the current query, or null when none is open. */
  get base(): QuerySession | null {
    return this.activeQuery;
  }

  /** The view the grid is reading: the base, or a sorted view derived from it. */
  get view(): QueryResultView | null {
    return this.activeResultView;
  }

  /** The complete base table trusted viewers receive, if it has been materialized. */
  get viewerTable(): Table | null {
    return this.baseViewerTable;
  }

  /** The paging demand in flight, which a sort or download lets finish before it starts. */
  get demand(): Promise<void> | null {
    return this.resultDemand;
  }

  /** Invalidates every continuation captured under the previous query generation. */
  nextQuery(): number {
    return ++this.queryGeneration;
  }

  isCurrentQuery(session: number, query: number): boolean {
    return this.store.isCurrent(session) && query === this.queryGeneration;
  }

  /** Swaps the view the grid reads, returning the one it replaces. */
  adoptView(view: QueryResultView): QueryResultView | null {
    const previous = this.activeResultView;
    this.activeResultView = view;
    return previous;
  }

  /** Stops user paging while a download drains the result itself. */
  suspendFetches(owner: number): void {
    this.resultFetchSuspendedBy = owner;
  }

  resumeFetches(owner: number): void {
    if (this.resultFetchSuspendedBy === owner) this.resultFetchSuspendedBy = null;
  }

  async execute(sql: string, session: number, query: number, priorCleanup: Promise<void>): Promise<void> {
    const priorResult = this.store.state.result;
    try {
      await priorCleanup;
      await this.close({ cancel: true });
      if (!this.isCurrentQuery(session, query)) return;
      if (priorResult && !priorResult.complete && this.store.state.result === priorResult) {
        this.store.dispatch({
          type: 'queryPageFailed',
          message: 'Run the prior query again to load more rows.',
          retryable: false,
        });
      }

      const active = await this.database.startQuery(sql);
      if (!this.isCurrentQuery(session, query)) {
        await closeQuery(active, true);
        return;
      }
      this.activeQuery = active;
      this.activeResultView = active;
      this.baseViewerTable = null;
      this.baseViewerMaterialized = false;

      await active.fetchNext(QUERY_INITIAL_ROWS);
      if (!this.isCurrentQuery(session, query) || this.activeQuery !== active) return;
      const status = active.status();
      const result = await this.buildResultState(active, query, Math.max(0, status.loadedRows - 1));
      if (!result || !this.isCurrentQuery(session, query) || this.activeQuery !== active) return;
      this.store.dispatch({ type: 'querySucceeded', result });
    } catch (error) {
      if (!this.isCurrentQuery(session, query)) return;
      await this.close({ cancel: true });
      if (isAbortError(error)) {
        this.store.dispatch({ type: 'cancelled' });
        return;
      }
      this.store.dispatch({ type: 'queryFailed', message: errorMessage(error, 'The query failed.') });
    }
  }

  loadMore(): Promise<void> {
    const result = this.store.state.result;
    if (
      !result ||
      result.complete ||
      result.pageError ||
      this.resultFetchSuspendedBy !== null ||
      this.hooks.sortPending()
    ) {
      return Promise.resolve();
    }
    return this.startDemand(() => this.fetchMoreResults(result.generation));
  }

  loadWindow(globalRow: number): Promise<void> {
    const result = this.store.state.result;
    if (
      !result ||
      this.hooks.sortPending() ||
      !Number.isSafeInteger(globalRow) ||
      globalRow < 0 ||
      globalRow >= result.loadedRows
    ) {
      return Promise.resolve();
    }
    return this.startDemand(() => this.publishWindow(result.generation, globalRow));
  }

  retryPage(): Promise<void> {
    const result = this.store.state.result;
    if (!result?.pageErrorRetryable || this.hooks.sortPending()) return Promise.resolve();
    return this.startDemand(() => this.retryPendingResult(result.generation));
  }

  /** Publishes new row counts without disturbing the window the reader is looking at. */
  refreshCounts(view: QueryResultView, generation: number, orderRevision?: number): void {
    const current = this.store.state.result;
    if (!current || current.generation !== generation) return;
    if (orderRevision !== undefined && current.orderRevision !== orderRevision) return;
    const status = view.status();
    this.store.dispatch({
      type: 'queryWindowUpdated',
      result: {
        ...current,
        loadedRows: status.loadedRows,
        complete: status.complete,
        loadingMore: false,
        elapsedMs: status.elapsedMs,
      },
    });
  }

  async close({ cancel }: { cancel: boolean }): Promise<void> {
    const active = this.activeQuery;
    const view = this.activeResultView;
    this.activeQuery = null;
    this.activeResultView = null;
    this.baseViewerTable = null;
    this.baseViewerMaterialized = false;
    const state = this.store.state;
    if (active && state.result?.generation === this.queryGeneration) {
      // Tell the reducer this family is closing BEFORE its resources go, so the rows left on
      // screen stop offering actions that would reach for them.
      this.store.dispatch({ type: 'resultUnavailable', queryGeneration: state.result.generation });
    }
    await releaseView(view, active, null);
    try {
      if (!active) {
        if (cancel)
          await Promise.resolve()
            .then(() => this.database.cancelQuery())
            .catch(() => false);
        return;
      }
      let workActive = true;
      try {
        workActive = !active.status().complete;
      } catch {
        // A closing/terminal cursor still needs best-effort cancellation before disposal.
      }
      await closeQuery(active, cancel && workActive);
    } finally {
      this.resultDemand = null;
    }
  }

  private startDemand(operation: () => Promise<void>): Promise<void> {
    if (this.resultDemand) return this.resultDemand;
    const demand = operation();
    const settled = demand.finally(() => {
      if (this.resultDemand === settled) this.resultDemand = null;
    });
    this.resultDemand = settled;
    return settled;
  }

  private async fetchMoreResults(generation: number): Promise<void> {
    const active = this.activeQuery;
    const current = this.store.state.result;
    if (!active || !current || current.generation !== generation) return;
    const anchor = Math.max(0, current.loadedRows - 1);
    this.store.dispatch({
      type: 'queryWindowUpdated',
      result: {
        ...current,
        loadingMore: true,
        pageError: null,
        pageErrorRetryable: false,
      },
    });

    try {
      await active.fetchNext(QUERY_PAGE_ROWS);
      if (!this.isActiveResult(active, generation)) return;
      await this.publishWindow(generation, anchor);
    } catch (error) {
      if (!this.isActiveResult(active, generation)) return;
      const retryable = isRetryablePageError(error);
      this.store.dispatch({
        type: 'queryPageFailed',
        message: resultPageFailureMessage(error, 'More query rows could not be loaded.'),
        retryable,
      });
    }
  }

  private async retryPendingResult(generation: number): Promise<void> {
    const active = this.activeQuery;
    const current = this.store.state.result;
    if (!active || !current || current.generation !== generation) return;
    const anchor = Math.max(0, current.loadedRows - 1);
    this.store.dispatch({
      type: 'queryWindowUpdated',
      result: {
        ...current,
        loadingMore: true,
        pageError: null,
        pageErrorRetryable: false,
      },
    });

    try {
      await active.retryPending();
      if (!this.isActiveResult(active, generation)) return;
      await this.publishWindow(generation, anchor);
    } catch (error) {
      if (!this.isActiveResult(active, generation)) return;
      const retryable = isRetryablePageError(error);
      this.store.dispatch({
        type: 'queryPageFailed',
        message: resultPageFailureMessage(error, 'The query result page could not be stored.'),
        retryable,
      });
    }
  }

  private async publishWindow(generation: number, anchorRow: number): Promise<void> {
    const active = this.activeQuery;
    if (!active || !this.isActiveResult(active, generation)) return;
    try {
      const result = await this.buildResultState(active, generation, anchorRow);
      if (!result || !this.isActiveResult(active, generation)) return;
      this.store.dispatch({ type: 'queryWindowUpdated', result });
    } catch (error) {
      if (!this.isActiveResult(active, generation)) return;
      this.store.dispatch({
        type: 'queryPageFailed',
        message: resultPageFailureMessage(error, 'The requested query rows could not be loaded.'),
        retryable: false,
      });
      const exportCleanup = this.hooks.supersedeExport();
      void exportCleanup
        .then(() => {
          if (!this.isActiveResult(active, generation)) return;
          return this.close({ cancel: true });
        })
        .catch(() => undefined);
    }
  }

  private async buildResultState(
    active: QuerySession,
    generation: number,
    anchorRow: number,
  ): Promise<PagedResultState | null> {
    const view = this.activeResultView;
    if (
      !view ||
      !this.isCurrentQuery(this.store.sessionGeneration, generation) ||
      this.activeQuery !== active
    ) {
      return null;
    }
    const existing = this.store.state.result?.generation === generation ? this.store.state.result : null;
    const revision = existing?.orderRevision ?? 0;
    const read = await readResultWindow(view, anchorRow);
    // Fence the VIEW and the committed order, not just the query: a window read from the order
    // that was on display when this started must not be published over a newer one. The revision
    // is only comparable within one generation — a result from an OLDER query says nothing about
    // the order of the one being published now.
    const displayed = this.store.state.result;
    const revisionMoved = displayed?.generation === generation && displayed.orderRevision !== revision;
    if (
      !this.isCurrentQuery(this.store.sessionGeneration, generation) ||
      this.activeQuery !== active ||
      this.activeResultView !== view ||
      revisionMoved
    ) {
      return null;
    }

    const completeTable = read.complete ? await this.baseViewerInput(active, generation) : null;
    if (
      !this.isCurrentQuery(this.store.sessionGeneration, generation) ||
      this.activeQuery !== active ||
      this.activeResultView !== view
    ) {
      return null;
    }

    return {
      generation,
      schema: read.schema,
      loadedRows: read.loadedRows,
      complete: read.complete,
      loadingMore: false,
      windowStart: read.windowStart,
      window: read.window,
      completeTable,
      elapsedMs: read.elapsedMs,
      pageError: existing?.pageError ?? null,
      pageErrorRetryable: existing?.pageErrorRetryable ?? false,
      orderRevision: revision,
      sort: existing?.sort ?? null,
    };
  }

  /**
   * The complete table trusted viewers consume, materialized at most once per base result and
   * always in ORIGINAL query order.
   *
   * Viewers read the query's own ordering, which is the user's to control through SQL; a header
   * sort is a view of the result, and must not silently re-order what a viewer plays.
   */
  private async baseViewerInput(active: QuerySession, generation: number): Promise<Table | null> {
    if (this.baseViewerMaterialized) return this.baseViewerTable;
    let table: Table | null;
    try {
      table = await active.materialize(QUERY_RESULT_MEMORY_BYTES);
    } catch {
      // A result too large for the viewer budget simply has no viewer input.
      table = null;
    }
    if (!this.isCurrentQuery(this.store.sessionGeneration, generation) || this.activeQuery !== active) {
      return null;
    }
    this.baseViewerTable = table;
    this.baseViewerMaterialized = true;
    return table;
  }

  private isActiveResult(active: QuerySession, generation: number): boolean {
    return (
      this.activeQuery === active &&
      this.store.state.result?.generation === generation &&
      this.isCurrentQuery(this.store.sessionGeneration, generation)
    );
  }
}

async function closeQuery(active: QuerySession, cancel: boolean): Promise<void> {
  if (cancel) await active.cancel().catch(() => false);
  await active.dispose().catch(() => undefined);
}
