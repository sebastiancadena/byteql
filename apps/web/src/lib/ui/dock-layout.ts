export interface DockGeometry {
  /** The dock's current height, including its trace strip. */
  height: number;
  /** Measured height of the results panel above the dock. */
  resultsHeight: number;
  /** How far the workspace already overflows its viewport, in pixels. */
  overflow: number;
  /** Measured height of the trace strip, which may wrap past its 40 px minimum. */
  stripHeight: number;
  /** True when Values and Bytes are tabbed rather than side by side. */
  compact: boolean;
}

const DEFAULT_HEIGHT = 248;
const MIN_HEIGHT = 152;
const RESULTS_MIN = 128;

/** Stored preferences are untrusted input: anything unusable falls back to the default. */
export function storedDockHeight(value: string | null): number {
  const height = Number(value);
  return Number.isFinite(height) && height > 0 ? Math.max(MIN_HEIGHT, height) : DEFAULT_HEIGHT;
}

/**
 * The dock may grow into whatever space the results panel can spare above its 128 px minimum,
 * minus any overflow the workspace is already carrying. Its floor keeps the strip, the tab row
 * when tabbed, and enough body to be worth opening.
 */
export function dockBounds(input: DockGeometry): { min: number; max: number } {
  const min = Math.max(40, input.stripHeight) + (input.compact ? 36 : 0) + 112;
  const slack = Math.max(0, input.resultsHeight - RESULTS_MIN);
  return { min, max: Math.max(min, input.height + slack - Math.max(0, input.overflow)) };
}
