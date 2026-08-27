export type ResultDemand = 'forward' | 'backward' | null;

export const RESULT_EDGE_ROWS = 8;
export const RESULT_ROW_HEIGHT = 36;

export interface DemandInput {
  readonly firstVisible: number;
  readonly lastVisible: number;
  readonly windowStart: number;
  readonly windowRows: number;
  readonly loadedRows: number;
  readonly complete: boolean;
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
