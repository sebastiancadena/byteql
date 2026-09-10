/** The four panels the workspace lets the user resize. */
export type PanelId = 'sources' | 'query' | 'inspection' | 'values';

export interface Bounds {
  min: number;
  max: number;
}

/** Persisted panel sizes. `null` means "use the default for this viewport". */
export interface LayoutPreferences {
  version: 1;
  sourcesWidth: number | null;
  queryHeight: number | null;
  dockHeight: number | null;
  valuesWidth: number | null;
}

export interface VerticalInput {
  availableHeight: number;
  /** Query/results toolbars, notices, and active handle tracks only. */
  chromeHeight: number;
  stripHeight: number;
  tabsHeight: number;
  bodyMin: number;
  collapsed: boolean;
  /** Resolved preference or active-drag snapshot. */
  queryHeight: number;
  dockHeight: number;
}

export interface VerticalLayout {
  queryHeight: number;
  dockHeight: number;
  resultsHeight: number;
  overflow: number;
  queryBounds: Bounds;
  dockBounds: Bounds;
}

export interface HorizontalLayout {
  sourcesWidth: number;
  valuesWidth: number;
  sourcesBounds: Bounds;
  valuesBounds: Bounds;
}

export const clamp = (value: number, bounds: Bounds): number =>
  Math.max(bounds.min, Math.min(bounds.max, value));

export const emptyPreferences = (): LayoutPreferences => ({
  version: 1,
  sourcesWidth: null,
  queryHeight: null,
  dockHeight: null,
  valuesWidth: null,
});

export function defaultSizes(viewportWidth: number, viewportHeight: number) {
  return {
    sourcesWidth: viewportWidth >= 1280 ? 224 : 208,
    queryHeight: viewportWidth < 700 || viewportHeight < 760 ? 80 : 116,
    dockHeight: 248,
    valuesWidth: 256,
  };
}

/** Below 900 px the dock cannot hold its tabs side by side; above 924 px it always can. Between
 * those two thresholds the previous state wins, so a drag near the boundary does not flicker. */
export function compactForWidth(
  viewportWidth: number,
  dockWidth: number,
  wasCompact: boolean,
): boolean {
  if (viewportWidth < 1280 || dockWidth < 900) return true;
  if (dockWidth >= 924) return false;
  return wasCompact;
}

/**
 * Distributes the workspace's available height across the query editor, the dock, and the
 * results panel below it. The dock and query keep their preferred sizes when there is room;
 * space is given up first by the dock, then by the query, before results ever reports overflow
 * instead of shrinking below its own floor.
 */
export function fitVertical(input: VerticalInput): VerticalLayout {
  const strip = Math.max(40, input.stripHeight);
  const minDock = input.collapsed ? strip : strip + input.tabsHeight + input.bodyMin;
  const budget = input.availableHeight - input.chromeHeight;
  const queryHeight = clamp(input.queryHeight, {
    min: 80,
    max: Math.max(80, budget - minDock - 128),
  });
  const dockHeight = input.collapsed
    ? strip
    : clamp(input.dockHeight, {
        min: minDock,
        max: Math.max(minDock, budget - queryHeight - 128),
      });
  const resultsHeight = Math.max(128, budget - queryHeight - dockHeight);
  return {
    queryHeight,
    dockHeight,
    resultsHeight,
    overflow: Math.max(
      0,
      input.chromeHeight + queryHeight + dockHeight + resultsHeight - input.availableHeight,
    ),
    queryBounds: { min: 80, max: Math.max(80, budget - dockHeight - 128) },
    dockBounds: { min: minDock, max: Math.max(minDock, budget - queryHeight - 128) },
  };
}

/**
 * Clamps the sources rail and values pane to bounds derived from the shell and dock widths.
 * These values describe expanded desktop panes; the caller removes their tracks/handles in
 * drawer/tab/hidden modes. The max>=min fallback must never be used to force these columns onto
 * a narrow screen — it only keeps the bounds internally consistent when the shell is tight.
 */
export function fitHorizontal(input: {
  shellWidth: number;
  dockWidth: number;
  gutter: number;
  sourcesWidth: number;
  valuesWidth: number;
}): HorizontalLayout {
  const sourcesBounds = {
    min: 192,
    max: Math.max(192, Math.min(420, input.shellWidth - input.gutter - 640)),
  };
  const valuesBounds = {
    min: 200,
    max: Math.max(200, Math.min(480, input.dockWidth - input.gutter - 360)),
  };
  return {
    sourcesWidth: clamp(input.sourcesWidth, sourcesBounds),
    valuesWidth: clamp(input.valuesWidth, valuesBounds),
    sourcesBounds,
    valuesBounds,
  };
}
