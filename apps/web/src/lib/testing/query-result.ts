import type { QueryResultView, ResultSort } from '@byteql/db';

import type { SessionController } from '../session/controller.js';
import type { ResultSession } from '../session/result-session.js';
import type { ResultSorter } from '../session/result-sorter.js';

/** Read-only, bounded-result diagnostics consumed only by the e2e build harness and tests. */
export interface QueryResultDiagnostics {
  readonly loadedRows: number;
  readonly complete: boolean;
  readonly windowStart: number;
  readonly windowRows: number;
  readonly sendCount: number;
  readonly decodedBytes: number;
  /** Committed order changes so far, and the order currently on display. */
  readonly orderRevision: number;
  readonly sort: ResultSort | null;
  readonly sortPending: boolean;
  /** Views derived from the base that the controller still holds; the base itself is not one. */
  readonly derivedViewCount: number;
  /** Decoded-cache bytes per live store. The base and the display may be the same object. */
  readonly viewCaches: readonly { kind: 'base' | 'display'; decodedBytes: number }[];
}

/**
 * The controller's private result bookkeeping. Typed here, in one place, so the e2e harness reads
 * it without the production controller carrying test-only accessors.
 */
interface ControllerResultInternals {
  readonly results: ResultSession;
  readonly sorter: ResultSorter;
}

const internals = (controller: SessionController): ControllerResultInternals =>
  controller as unknown as ControllerResultInternals;

/** The view the grid is currently reading (the sorted view once an order is committed). */
export const activeResultView = (controller: SessionController): QueryResultView | null =>
  internals(controller).results.view;

export const queryResultDiagnostics = (controller: SessionController): QueryResultDiagnostics => {
  const result = controller.getState().result;
  const { results, sorter } = internals(controller);
  const base = results.base;
  const display = results.view;
  const status = base?.status();
  // Counted by object identity: before any sort the base IS the display, and reporting it twice
  // would double the cache figures a memory check reads.
  const views = new Set<QueryResultView>();
  if (base) views.add(base);
  if (display) views.add(display);
  return {
    loadedRows: result?.loadedRows ?? 0,
    complete: result?.complete ?? false,
    windowStart: result?.windowStart ?? 0,
    windowRows: result?.window.numRows ?? 0,
    sendCount: status?.sendCount ?? 0,
    decodedBytes: status?.decodedBytes ?? 0,
    orderRevision: result?.orderRevision ?? 0,
    sort: result?.sort ?? null,
    sortPending: sorter.pending,
    derivedViewCount: display && display !== base ? 1 : 0,
    viewCaches: [...views].map((view) => ({
      kind: view === base ? ('base' as const) : ('display' as const),
      decodedBytes: view.status().decodedBytes,
    })),
  };
};

/** Repeatedly invokes the same demand path the result grid uses until it reaches EOF. */
export const drainQueryResult = async (controller: SessionController): Promise<void> => {
  for (;;) {
    const result = controller.getState().result;
    if (!result || result.complete || result.pageError) return;
    const loadedRows = result.loadedRows;
    await controller.loadMoreResults();
    const after = controller.getState().result;
    if (!after || after.loadedRows <= loadedRows) return;
  }
};
