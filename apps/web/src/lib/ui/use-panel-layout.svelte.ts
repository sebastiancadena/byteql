/**
 * The workspace's one layout owner: it holds the persisted preferences, turns a numeric
 * measurement snapshot into effective panel sizes, and runs the preview/commit/cancel/reset
 * transaction for whichever divider the user is dragging.
 *
 * It is presentation-only — it never imports the session controller — and it never touches the
 * DOM. `observePanelMetrics` is the only part that does, and it is exported separately so the
 * coordinator can be tested against plain numbers.
 */

/* global Element, ResizeObserver, cancelAnimationFrame, requestAnimationFrame, window */

import { readLayoutPreferences, writeLayoutPreferences, type LayoutStorage } from './layout-preferences.js';
import {
  clamp,
  compactForWidth,
  defaultSizes,
  fitHorizontal,
  fitVertical,
  type HorizontalLayout,
  type LayoutPreferences,
  type PanelId,
  type VerticalLayout,
} from './panel-layout.js';

/** One frame's worth of geometry, in CSS pixels. Every field is a measurement, never a choice. */
export interface LayoutMetrics {
  viewportWidth: number;
  viewportHeight: number;
  shellWidth: number;
  workspaceHeight: number;
  dockWidth: number;
  queryToolbar: number;
  notices: number;
  resultsToolbar: number;
  strip: number;
  tabs: number;
  hexChrome: number;
  gutter: number;
  dockCollapsed: boolean;
  bytesVisible: boolean;
}

export interface ResolvedLayout extends VerticalLayout, HorizontalLayout {
  compact: boolean;
}

export interface PanelLayoutController {
  readonly preferences: LayoutPreferences;
  readonly layout: ResolvedLayout;
  readonly active: PanelId | null;
  readonly cancelEpoch: number;
  measure(metrics: LayoutMetrics): void;
  begin(panel: PanelId): void;
  preview(panel: PanelId, value: number): void;
  commit(panel: PanelId, value: number): void;
  cancel(): void;
  reset(panel?: PanelId): void;
}

/** Non-drawing hex chrome before the pane has reported its own height. */
const FALLBACK_HEX_CHROME = 36;
/** Values-only dock body floor; Bytes adds four hex rows on top of its chrome. */
const VALUES_BODY_MIN = 112;
const HEX_BODY_ROWS = 72;

const VERTICAL_PANELS: readonly PanelId[] = ['query', 'inspection'];
const isVertical = (panel: PanelId): boolean => VERTICAL_PANELS.includes(panel);

function initialMetrics(): LayoutMetrics {
  return {
    viewportWidth: 0,
    viewportHeight: 0,
    shellWidth: 0,
    workspaceHeight: 0,
    dockWidth: 0,
    queryToolbar: 0,
    notices: 0,
    resultsToolbar: 0,
    strip: 0,
    tabs: 0,
    hexChrome: FALLBACK_HEX_CHROME,
    gutter: 0,
    dockCollapsed: false,
    bytesVisible: true,
  };
}

/** The chrome the dividers must leave room for. The trace strip belongs to the dock's own
 * height, so it is deliberately absent here, and a collapsed dock has no divider track. */
function chromeHeightOf(metrics: LayoutMetrics): number {
  return (
    metrics.queryToolbar +
    metrics.notices +
    metrics.resultsToolbar +
    metrics.gutter +
    (metrics.dockCollapsed ? 0 : metrics.gutter)
  );
}

function bodyMinOf(metrics: LayoutMetrics): number {
  return metrics.bytesVisible
    ? Math.max(VALUES_BODY_MIN, metrics.hexChrome + HEX_BODY_ROWS)
    : VALUES_BODY_MIN;
}

function solveVertical(metrics: LayoutMetrics, query: number, dock: number): VerticalLayout {
  return fitVertical({
    availableHeight: metrics.workspaceHeight,
    chromeHeight: chromeHeightOf(metrics),
    stripHeight: metrics.strip,
    tabsHeight: metrics.tabs,
    bodyMin: bodyMinOf(metrics),
    collapsed: metrics.dockCollapsed,
    queryHeight: query,
    dockHeight: dock,
  });
}

/** The inputs to the vertical solution. A change to any of them invalidates an in-flight
 * vertical drag, because its frozen neighbour and its bounds were solved against the old ones. */
function verticalInputsChanged(a: LayoutMetrics, b: LayoutMetrics): boolean {
  return (
    a.workspaceHeight !== b.workspaceHeight ||
    a.queryToolbar !== b.queryToolbar ||
    a.notices !== b.notices ||
    a.resultsToolbar !== b.resultsToolbar ||
    a.strip !== b.strip ||
    a.tabs !== b.tabs ||
    a.hexChrome !== b.hexChrome ||
    a.gutter !== b.gutter ||
    a.dockCollapsed !== b.dockCollapsed ||
    a.bytesVisible !== b.bytesVisible
  );
}

interface DragState {
  panel: PanelId;
  /** Preferences as they were before the drag, restored verbatim on cancellation. */
  preferences: LayoutPreferences;
  /** Effective sizes frozen at `begin`; the inactive pane must not drift during the drag. */
  query: number;
  dock: number;
  sources: number;
  values: number;
  /** The latest previewed size, or null while the drag has not moved yet. */
  value: number | null;
}

export function createPanelLayout(storage: LayoutStorage | null): PanelLayoutController {
  let preferences = $state.raw<LayoutPreferences>(readLayoutPreferences(storage));
  let metrics = $state.raw<LayoutMetrics>(initialMetrics());
  let drag = $state.raw<DragState | null>(null);
  let cancelEpoch = $state(0);
  // The first measurement has no previous mode to keep, and tabs are the safe assumption.
  let compact = $state(true);

  const layout = $derived.by((): ResolvedLayout => {
    const current = metrics;
    const defaults = defaultSizes(current.viewportWidth, current.viewportHeight);
    const transaction = drag;

    let query = preferences.queryHeight ?? defaults.queryHeight;
    let dock = preferences.dockHeight ?? defaults.dockHeight;
    let sources = preferences.sourcesWidth ?? defaults.sourcesWidth;
    let values = preferences.valuesWidth ?? defaults.valuesWidth;

    if (transaction && isVertical(transaction.panel)) {
      // Solve once from the frozen pair to learn this divider's bounds, clamp the dragged value
      // against them, then solve again. Clamping first is what keeps a growing Query taking its
      // space from Results rather than silently squeezing the dock underneath it.
      const frozen = solveVertical(current, transaction.query, transaction.dock);
      query = transaction.query;
      dock = transaction.dock;
      if (transaction.value !== null) {
        if (transaction.panel === 'query') {
          query = clamp(transaction.value, frozen.queryBounds);
        } else {
          dock = clamp(transaction.value, frozen.dockBounds);
        }
      }
    } else if (transaction) {
      sources =
        transaction.panel === 'sources' ? (transaction.value ?? transaction.sources) : transaction.sources;
      values =
        transaction.panel === 'values' ? (transaction.value ?? transaction.values) : transaction.values;
    }

    return {
      ...solveVertical(current, query, dock),
      ...fitHorizontal({
        shellWidth: current.shellWidth,
        dockWidth: current.dockWidth,
        gutter: current.gutter,
        sourcesWidth: sources,
        valuesWidth: values,
      }),
      compact,
    };
  });

  function save(next: LayoutPreferences): void {
    preferences = next;
    writeLayoutPreferences(storage, next);
  }

  function cancel(): void {
    if (!drag) return;
    const restored = drag.preferences;
    drag = null;
    preferences = restored;
    cancelEpoch += 1;
  }

  function measure(next: LayoutMetrics): void {
    const previous = metrics;
    // A hidden pane reports zero chrome. That is not the user shrinking anything, so the last
    // real measurement stands until the pane is on screen again.
    const sanitized: LayoutMetrics = {
      ...next,
      hexChrome: next.hexChrome > 0 ? next.hexChrome : previous.hexChrome,
    };
    const nextCompact = compactForWidth(sanitized.viewportWidth, sanitized.dockWidth, compact);

    if (drag) {
      const externalResize =
        previous.viewportWidth !== sanitized.viewportWidth ||
        previous.viewportHeight !== sanitized.viewportHeight;
      // A horizontal drag is the author of its own width changes, so only an outside change
      // ends it; a vertical drag ends whenever the budget it was solved against moves.
      if (isVertical(drag.panel)) {
        if (verticalInputsChanged(previous, sanitized) || nextCompact !== compact) cancel();
      } else if (externalResize) cancel();
    }

    compact = nextCompact;
    metrics = sanitized;
  }

  function begin(panel: PanelId): void {
    // One transaction at a time: a second pointer down abandons whatever was in flight.
    cancel();
    const current = layout;
    drag = {
      panel,
      preferences,
      query: current.queryHeight,
      dock: current.dockHeight,
      sources: current.sourcesWidth,
      values: current.valuesWidth,
      value: null,
    };
  }

  function preview(panel: PanelId, value: number): void {
    if (!drag || drag.panel !== panel) return;
    drag = { ...drag, value };
  }

  function commit(panel: PanelId, value: number): void {
    if (!drag || drag.panel !== panel) return;
    drag = { ...drag, value };
    const resolved = layout;
    drag = null;
    if (isVertical(panel)) {
      save({
        ...preferences,
        queryHeight: resolved.queryHeight,
        // A collapsed dock is showing its strip, not a size the user chose.
        dockHeight: metrics.dockCollapsed ? preferences.dockHeight : resolved.dockHeight,
      });
      return;
    }
    save(
      panel === 'sources'
        ? { ...preferences, sourcesWidth: resolved.sourcesWidth }
        : { ...preferences, valuesWidth: resolved.valuesWidth },
    );
  }

  function resetVertical(panel: 'query' | 'inspection'): void {
    const defaults = defaultSizes(metrics.viewportWidth, metrics.viewportHeight);
    const current = layout;
    const query = panel === 'query' ? defaults.queryHeight : current.queryHeight;
    const dock = panel === 'inspection' ? defaults.dockHeight : current.dockHeight;
    const resolved = solveVertical(metrics, query, dock);
    // The default is stored as "no preference" only when it actually survives the current
    // budget; otherwise the clamped number is what the user will keep seeing.
    save({
      ...preferences,
      queryHeight:
        panel === 'query' && resolved.queryHeight === defaults.queryHeight ? null : resolved.queryHeight,
      dockHeight: metrics.dockCollapsed
        ? preferences.dockHeight
        : panel === 'inspection' && resolved.dockHeight === defaults.dockHeight
          ? null
          : resolved.dockHeight,
    });
  }

  function resetHorizontal(panel: 'sources' | 'values'): void {
    const defaults = defaultSizes(metrics.viewportWidth, metrics.viewportHeight);
    const resolved = fitHorizontal({
      shellWidth: metrics.shellWidth,
      dockWidth: metrics.dockWidth,
      gutter: metrics.gutter,
      sourcesWidth: panel === 'sources' ? defaults.sourcesWidth : layout.sourcesWidth,
      valuesWidth: panel === 'values' ? defaults.valuesWidth : layout.valuesWidth,
    });
    save(
      panel === 'sources'
        ? {
            ...preferences,
            sourcesWidth: resolved.sourcesWidth === defaults.sourcesWidth ? null : resolved.sourcesWidth,
          }
        : {
            ...preferences,
            valuesWidth: resolved.valuesWidth === defaults.valuesWidth ? null : resolved.valuesWidth,
          },
    );
  }

  function reset(panel?: PanelId): void {
    cancel();
    if (!panel) {
      save({
        version: 1,
        sourcesWidth: null,
        queryHeight: null,
        dockHeight: null,
        valuesWidth: null,
      });
      return;
    }
    if (panel === 'query' || panel === 'inspection') resetVertical(panel);
    else resetHorizontal(panel);
  }

  return {
    get preferences() {
      return preferences;
    },
    get layout() {
      return layout;
    },
    get active() {
      return drag?.panel ?? null;
    },
    get cancelEpoch() {
      return cancelEpoch;
    },
    measure,
    begin,
    preview,
    commit,
    cancel,
    reset,
  };
}

function sameMetrics(a: LayoutMetrics, b: LayoutMetrics): boolean {
  return (
    a.viewportWidth === b.viewportWidth &&
    a.viewportHeight === b.viewportHeight &&
    a.shellWidth === b.shellWidth &&
    a.dockWidth === b.dockWidth &&
    a.dockCollapsed === b.dockCollapsed &&
    a.bytesVisible === b.bytesVisible &&
    !verticalInputsChanged(a, b)
  );
}

/**
 * One ResizeObserver over the explicitly bound elements, plus window resize. Everything funnels
 * into a single queued frame that reads every dimension once and reports only real differences,
 * so a measurement can never fight the layout it produced.
 */
export function observePanelMetrics(
  read: () => LayoutMetrics | null,
  elements: readonly Element[],
  onmeasure: (value: LayoutMetrics) => void,
): { schedule(): void; destroy(): void } {
  let frame: number | null = null;
  let delivered: LayoutMetrics | null = null;

  function run(): void {
    frame = null;
    const next = read();
    if (!next) return;
    if (delivered && sameMetrics(delivered, next)) return;
    delivered = next;
    onmeasure(next);
  }

  function schedule(): void {
    if (frame !== null) return;
    frame = requestAnimationFrame(run);
  }

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  for (const element of elements) observer?.observe(element);
  window.addEventListener('resize', schedule);
  schedule();

  return {
    schedule,
    destroy(): void {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
    },
  };
}
