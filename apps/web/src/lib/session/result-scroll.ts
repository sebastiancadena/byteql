export type ResultDemand = 'forward' | 'backward' | null;

export const RESULT_EDGE_ROWS = 8;
export const RESULT_ROW_HEIGHT = 36;

export interface VisibleResultRange {
  readonly firstVisible: number;
  readonly lastVisible: number;
}

export interface DemandInput {
  readonly firstVisible: number;
  readonly lastVisible: number;
  readonly windowStart: number;
  readonly windowRows: number;
  readonly loadedRows: number;
  readonly complete: boolean;
}

/** Computes the visible local row range from the scroll element's physical geometry. */
export function visibleResultRange(
  scrollTop: number,
  viewportHeight: number,
  windowRows: number,
  rowHeight = RESULT_ROW_HEIGHT,
): VisibleResultRange {
  if (windowRows <= 0 || viewportHeight <= 0 || rowHeight <= 0) {
    return { firstVisible: 0, lastVisible: Math.max(0, windowRows - 1) };
  }
  const firstVisible = Math.min(windowRows - 1, Math.max(0, Math.floor(scrollTop / rowHeight)));
  const lastVisible = Math.min(
    windowRows - 1,
    Math.max(firstVisible, Math.ceil((scrollTop + viewportHeight) / rowHeight) - 1),
  );
  return { firstVisible, lastVisible };
}

/** Chooses one edge demand from the virtualizer's local visible range. */
export function resultDemand(input: DemandInput): ResultDemand {
  if (input.windowStart > 0 && input.firstVisible <= RESULT_EDGE_ROWS) return 'backward';
  const visibleGlobalTail = input.windowStart + input.lastVisible;
  if (
    !input.complete &&
    input.windowRows > 0 &&
    visibleGlobalTail >= input.loadedRows - RESULT_EDGE_ROWS - 1
  ) {
    return 'forward';
  }
  return null;
}

/** Pixel delta required to preserve a global row's visual position across a window rebase. */
export function scrollCompensation(
  previousStart: number,
  nextStart: number,
  rowHeight = RESULT_ROW_HEIGHT,
): number {
  return (previousStart - nextStart) * rowHeight;
}
