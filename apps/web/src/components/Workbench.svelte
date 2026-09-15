<script lang="ts">
  /* global Blob, DragEvent, Event, File, HTMLElement, HTMLInputElement, KeyboardEvent, MediaQueryList, MediaQueryListEvent, Storage, document, localStorage, window */

  import type { ResultSort, ResultSortCapability } from '@byteql/db';
  import type { Table } from 'apache-arrow';
  import { onMount, tick, untrack } from 'svelte';

  import type { ExportOptions } from '../lib/export/options.js';
  import { createCoverageMemo, provenanceOfRow } from '../lib/hex/coverage.js';
  import { wrapFilterSql } from '../lib/hex/filter-sql.js';
  import type { SampleId } from '../lib/session/samples.js';
  import { resultSortDisabledReason } from '../lib/session/result-sort-availability.js';
  import {
    isResultSorting,
    resultSortInteractionBlocked,
    sortActionLabel,
  } from '../lib/session/result-sort.js';
  import { initialSessionState, type SessionState } from '../lib/session/state.js';
  import { sqlIdentifier } from '../lib/sql-literal.js';
  import { containFocus } from '../lib/ui/focus.js';
  import { applyTheme, readTheme, type Theme } from '../lib/ui/theme.js';
  import { buildTraceSummary } from '../lib/ui/trace.js';
  import {
    createPanelLayout,
    observePanelMetrics,
    type LayoutMetrics,
  } from '../lib/ui/use-panel-layout.svelte.js';
  import type { AudioEngine } from '../lib/viewers/tone-engine.js';
  import {
    compatibleTableViewers,
    compatibleViewers,
    type ViewerCapability,
  } from '../lib/viewers/registry.js';
  import AppHeader from './AppHeader.svelte';
  import EmptyState from './EmptyState.svelte';
  import Explorer from './Explorer.svelte';
  import HexPane from './HexPane.svelte';
  import Inspector from './Inspector.svelte';
  import ResizeHandle from './ResizeHandle.svelte';
  import ResultGrid from './ResultGrid.svelte';
  import ResultsDownload from './ResultsDownload.svelte';
  import ShortcutsOverlay from './ShortcutsOverlay.svelte';
  import SqlEditor from './SqlEditor.svelte';
  import StatusBar from './StatusBar.svelte';
  import TraceDock from './TraceDock.svelte';
  import Icon from './ui/Icon.svelte';

  interface ControllerPort {
    subscribe(listener: (state: SessionState) => void): () => void;
    openFile(file: File): Promise<void>;
    openFiles(files: readonly File[]): Promise<void>;
    openSample(id: SampleId): Promise<void>;
    runQuery(sql: string): Promise<void>;
    loadMoreResults(): Promise<void>;
    loadResultWindow(globalRow: number): Promise<void>;
    retryResultPage(): Promise<void>;
    downloadResults(options: ExportOptions): Promise<void>;
    cancelResultsDownload(): Promise<void>;
    saveResultsDownload(): void;
    dismissResultsDownload(): Promise<void>;
    cancel(): Promise<void>;
    selectResultRow(row: number | null): void;
    selectByteRange(range: { file: string; start: number; end: number } | null): void;
    getSourceBlob(file: string): Blob | null;
    sortResults(sort: ResultSort | null): Promise<void>;
    cancelResultSort(): Promise<void>;
    resultSortCapability(): ResultSortCapability;
  }

  interface Props {
    controller: ControllerPort;
    audioEngineFactory?: (() => AudioEngine) | undefined;
  }

  let { controller, audioEngineFactory }: Props = $props();
  let session = $state<SessionState>(initialSessionState);
  let draftSql = $state('');
  let actionError = $state<string | null>(null);
  let coverageMessage = $state<string | null>(null);
  /**
   * The catalog has two presentations with two independent user choices: a wide column that is
   * open until collapsed, and a narrow modal drawer that is closed until opened. Keeping them
   * apart means crossing a breakpoint preserves what the user chose in each, and never turns an
   * ordinary open column into a drawer covering the workspace.
   */
  let columnCollapsed = $state(false);
  let drawerOpen = $state(false);
  let inspectorCollapsed = $state(false);
  /** Below 960 px the catalog becomes a modal drawer over the workspace. */
  let drawerMode = $state(untrack(() => window.matchMedia('(max-width: 959px)').matches));
  let drawerElement = $state<HTMLElement | null>(null);
  /** Whichever presentation is active, this is whether the catalog is currently hidden. */
  const explorerCollapsed = $derived(drawerMode ? !drawerOpen : columnCollapsed);

  function toggleSources(): void {
    if (drawerMode) {
      // The drawer is modal: no divider transaction may survive underneath it.
      if (!drawerOpen) panels.cancel();
      drawerOpen = !drawerOpen;
      return;
    }
    // Collapsing the column takes its divider with it; no transaction may outlive its handle.
    if (!columnCollapsed) panels.cancel();
    columnCollapsed = !columnCollapsed;
  }

  function closeDrawer(): void {
    drawerOpen = false;
  }
  /**
   * Whether the dock tabs Values and Bytes instead of showing them side by side. The layout
   * coordinator decides that from measured widths; this mirrors its decision so a switch can
   * settle the dock's tab and rescue focus before the controls around it change.
   */
  let compactDock = $state(false);
  let dockTab = $state<'values' | 'bytes'>('bytes');
  let overviewSource: string | null = null;
  let activeViewerId = $state<string | null>(null);
  let dragCounter = 0;
  let dropActive = $state(false);
  let filePickerInput = $state<HTMLInputElement>();
  let shortcutsOpen = $state(false);
  let emptyState = $state<ReturnType<typeof EmptyState> | null>(null);

  const idle = $derived(session.phase === 'idle' || session.phase === 'failed');

  let appearance = $state<Theme>(readTheme(browserStorage()));

  function browserStorage(): Storage | null {
    try {
      return globalThis.localStorage;
    } catch {
      return null;
    }
  }

  function changeAppearance(next: Theme): void {
    appearance = next;
    applyTheme(next, document.documentElement, browserStorage());
  }

  /** Idle delegates to the intake's gesture-safe path; a loaded session uses its own input. */
  function openPicker(): void {
    if (idle) {
      emptyState?.openFile();
      return;
    }
    filePickerInput?.click();
  }

  function choosePickedFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length > 0) perform(() => controller.openFiles(files));
    input.value = '';
  }

  function hasFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }

  function onDragEnter(event: DragEvent): void {
    if (!hasFiles(event)) return;
    dragCounter += 1;
    dropActive = true;
  }

  function onDragLeave(event: DragEvent): void {
    if (!hasFiles(event)) return;
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) dropActive = false;
  }

  function onDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    dragCounter = 0;
    dropActive = false;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) perform(() => controller.openFiles(files));
  }

  const intakeBusy = $derived(['opening', 'normalizing', 'parsing', 'projecting'].includes(session.phase));
  const schemaViewers = $derived.by((): ViewerCapability[] => {
    if (!session.result || !session.capabilities) return [];
    return compatibleViewers(
      session.result.schema.fields.map((field) => ({ name: field.name, type: field.type.toString() })),
      session.capabilities,
    );
  });
  const viewers = $derived.by((): ViewerCapability[] => {
    if (!session.capabilities) return [];
    return compatibleTableViewers(session.result?.completeTable ?? null, session.capabilities);
  });
  const activeViewer = $derived(viewers.find(({ id }) => id === activeViewerId) ?? null);
  export function closeActiveViewer(): void {
    activeViewerId = null;
  }

  const disabledCapabilityReasons = $derived.by(() => {
    const reasons = Object.values(session.capabilities ?? {})
      .filter((capability) => !capability.enabled && capability.reason)
      .map((capability) => capability.reason as string);
    if (schemaViewers.length > 0 && !session.result?.completeTable) {
      reasons.push('Finish and narrow the result to use this viewer.');
    }
    return reasons;
  });

  let hexPane = $state<HexPane>();
  let sqlEditor = $state<ReturnType<typeof SqlEditor> | null>(null);

  /**
   * Dock collapse is read once, from the preference the standalone hex pane already used.
   * A narrow viewport only chooses the default when the user has expressed no preference —
   * crossing a breakpoint later must never overwrite what they chose.
   */
  let dockCollapsed = $state(
    untrack(() => {
      const stored = readDockCollapsedPreference();
      if (stored !== null) return stored === 'true';
      return window.matchMedia('(max-width: 699px)').matches;
    }),
  );

  function readDockCollapsedPreference(): string | null {
    try {
      return localStorage.getItem('byteql.hexpane.collapsed');
    } catch {
      return null;
    }
  }

  function setShortcutsOpen(open: boolean): void {
    // The overlay takes focus; any divider transaction ends before it does.
    if (open) panels.cancel();
    shortcutsOpen = open;
  }

  function setDockCollapsed(collapsed: boolean): void {
    // Collapsing removes the inspection divider; no transaction may outlive its handle.
    if (collapsed) panels.cancel();
    dockCollapsed = collapsed;
    try {
      localStorage.setItem('byteql.hexpane.collapsed', String(collapsed));
    } catch {
      // Geometry preferences are optional.
    }
  }

  const valuesVisible = $derived(
    !dockCollapsed && (compactDock ? dockTab === 'values' : !inspectorCollapsed),
  );
  const bytesVisible = $derived(!dockCollapsed && (!compactDock || dockTab === 'bytes'));

  /** One owner for every resizable panel: preferences, effective sizes, and drag transactions.
   * It is presentation only — nothing here reaches the session controller. */
  const panels = createPanelLayout(browserStorage());
  const layout = $derived(panels.layout);
  // Narrows the compact-mode effect below to the one field it cares about: `layout` itself is a
  // fresh object on every recomputation, so an effect reading `layout.compact` directly would
  // re-run on any layout change. This derived re-evaluates just as often, but Svelte only wakes
  // dependents when the primitive value it resolves to actually flips.
  const layoutCompact = $derived(layout.compact);
  /** The catalog is resizable only as an ordinary open column: the modal drawer has a fixed
   * width and a collapsed column has no edge, so neither renders a separator at all. */
  const sourcesResizable = $derived(!idle && !drawerMode && !explorerCollapsed);
  let shellElement = $state<HTMLElement | null>(null);
  let mainElement = $state<HTMLElement | null>(null);
  let queryToolbarElement = $state<HTMLElement | null>(null);
  let noticesElement = $state<HTMLElement | null>(null);
  let resultsToolbarElement = $state<HTMLElement | null>(null);
  let queryGutterElement = $state<HTMLElement | null>(null);
  /** Border-box heights the dock reports for its strip and, when tabbed, its tab row. */
  let dockChrome = $state({ strip: 40, tabs: 0 });
  let metricsObserver: { schedule(): void; destroy(): void } | null = null;
  /** Until the byte pane reports its own chrome the budget assumes a single toolbar row. */
  const HEX_CHROME_FALLBACK = 36;
  /** Non-drawing vertical pixels the embedded byte pane reports for itself. */
  let hexChrome = $state(HEX_CHROME_FALLBACK);
  const reportHexChrome = (height: number): void => {
    hexChrome = height;
  };

  function readMetrics(): LayoutMetrics | null {
    const main = mainElement;
    if (!main) return null;
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      shellWidth: shellElement?.clientWidth ?? main.clientWidth,
      // The budget is the height the workspace was given, never the height its rows grew to.
      workspaceHeight: main.clientHeight,
      dockWidth: main.clientWidth,
      queryToolbar: queryToolbarElement?.offsetHeight ?? 0,
      notices: noticesElement?.offsetHeight ?? 0,
      resultsToolbar: resultsToolbarElement?.offsetHeight ?? 0,
      strip: dockChrome.strip,
      tabs: dockChrome.tabs,
      hexChrome,
      // The divider track is whatever the pointer-size token renders it as.
      gutter: queryGutterElement?.offsetHeight ?? 0,
      dockCollapsed,
      bytesVisible,
    };
  }

  // Rebuilt only when a bound element is replaced — never when one of them merely changes size.
  $effect(() => {
    const elements = [
      shellElement,
      mainElement,
      queryToolbarElement,
      noticesElement,
      resultsToolbarElement,
      queryGutterElement,
    ].filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return;
    // Measure once synchronously, before the observer's first frame, so the first painted
    // layout already uses the real viewport instead of the coordinator's safe fallback. Like
    // every other measurement, this writes nothing. Untracked: reading the collapse and chrome
    // state here must not make them rebuild the observer — that is the other effect's job.
    untrack(() => {
      const initial = readMetrics();
      if (initial) panels.measure(initial);
    });
    const observer = observePanelMetrics(readMetrics, elements, (value) => panels.measure(value));
    metricsObserver = observer;
    return () => {
      observer.destroy();
      metricsObserver = null;
    };
  });

  // Collapse, tab mode and the dock's reported chrome are state rather than geometry, so they
  // have to ask for the next measurement themselves.
  $effect(() => {
    void dockCollapsed;
    void bytesVisible;
    void dockChrome;
    void hexChrome;
    metricsObserver?.schedule();
  });

  // The coordinator is the only thing that decides compact mode, and this is the only thing that
  // reads that decision. Declared after the measuring effect so the first run already sees a
  // measured viewport instead of the coordinator's safe fallback. `layoutCompact` is the sole
  // tracked dependency: everything the switch inspects is read untracked, because a mode change
  // is the only event allowed to move focus.
  $effect(() => {
    const next = layoutCompact;
    untrack(() => switchCompactDock(next));
  });

  const HEADER_SOURCES_TOGGLE =
    '.app-header [aria-label="Hide sources"], .app-header [aria-label="Show sources"]';
  const HEADER_VALUES_TOGGLE =
    '.app-header [aria-label="Hide values"], .app-header [aria-label="Show values"]';

  /** Focuses the first of these that exists, once the DOM has settled. Called only when the
   * control the user was actually on is leaving the page — never because a pane changed size. */
  function focusFallback(selectors: readonly string[]): void {
    void tick().then(() => {
      for (const selector of selectors) {
        const target = document.querySelector<HTMLElement>(selector);
        if (target) {
          target.focus();
          return;
        }
      }
    });
  }

  /**
   * Adopts the coordinator's compact decision. Focus is inspected against the dock's own panels
   * before the switch, while they still hold it: the panel the user was working in becomes the
   * active tab, so their place survives the change.
   */
  function switchCompactDock(next: boolean): void {
    if (next === compactDock) return;
    const focused = document.activeElement;
    const holds = (id: string): boolean => {
      const panel = mainElement?.querySelector<HTMLElement>(`#${id}`) ?? null;
      return panel !== null && focused !== null && panel.contains(focused);
    };
    if (next) {
      // Values the user put away stay away: the tabs open on Bytes whatever had focus.
      if (inspectorCollapsed) dockTab = 'bytes';
      else if (holds('dock-panel-values')) dockTab = 'values';
      else if (holds('dock-panel-bytes')) dockTab = 'bytes';
    }
    // The Values divider and the tab row trade places across this switch; whichever one holds
    // focus is about to be removed, and only that earns a focus move. Leaving the tabs while
    // Values are hidden takes the panel itself away, which strands focus just as surely.
    const stranded = focused?.closest('.values-resize-slot, .trace-dock-tabs') != null;
    const losesPanel = !next && inspectorCollapsed && holds('dock-panel-values');
    compactDock = next;
    if (!stranded && !losesPanel) return;
    focusFallback(
      next
        ? [`.trace-dock-tabs [data-dock-tab='${dockTab}']`, HEADER_VALUES_TOGGLE]
        : ['.values-resize-slot [role="separator"]', HEADER_VALUES_TOGGLE],
    );
  }

  // Memoize on result identity: session is reassigned on every publish (caret moves, progress
  // events), but buildCoverage must run once per result, not once per publish.
  const coverageMemo = createCoverageMemo();

  // The hex pane's active file. Defaults to the first source file and repairs itself if that
  // file leaves the session (e.g. a fresh open replaces the batch).
  let hexFile = $state<string | null>(null);
  const sourceFiles = $derived(session.source?.files ?? []);
  $effect(() => {
    if (sourceFiles.length === 0) {
      if (untrack(() => hexFile) !== null) hexFile = null;
      return;
    }
    if (
      untrack(() => hexFile) === null ||
      !sourceFiles.some((file) => file.name === untrack(() => hexFile))
    ) {
      hexFile = sourceFiles[0]!.name;
    }
  });
  const hexFileSize = $derived(sourceFiles.find((file) => file.name === hexFile)?.size ?? 0);
  const sourceBlob = $derived(hexFile ? controller.getSourceBlob(hexFile) : null);
  const coverageResult = $derived(
    coverageMemo(session.result?.window ?? null, hexFile, session.result?.windowStart ?? 0),
  );
  // Memoize on (result, file) so the reset-key object stays reference-stable across publishes
  // that don't touch either — otherwise every unrelated session field change (selectedRow,
  // byteSelection, ...) would look like "a new result" to HexPane and wipe its local selection
  // out from under the user (e.g. right after a goto/selection just set it).
  let hexResetKeyMemo: {
    result: Table | null;
    file: string | null;
    value: { result: Table | null; file: string | null };
  } | null = null;
  const hexResetKey = $derived.by(() => {
    const result = session.result?.window ?? null;
    const file = hexFile;
    if (hexResetKeyMemo && hexResetKeyMemo.result === result && hexResetKeyMemo.file === file) {
      return hexResetKeyMemo.value;
    }
    const value = { result, file };
    hexResetKeyMemo = { result, file, value };
    return value;
  });

  function switchHexFile(file: string): void {
    controller.selectByteRange(null);
    hexFile = file;
  }
  // Memoize on (result, selectedRow) so the highlight object stays reference-stable across
  // publishes; otherwise HexPane's identity guard re-flashes and re-centers on every publish
  // (including each caret move's byteRangeSelected dispatch), fighting user navigation.
  let highlightMemo: {
    result: unknown;
    row: number;
    value: { file: string; start: number; end: number } | null;
  } | null = null;
  const selectedLocalRow = $derived(
    session.result &&
      session.selectedRow !== null &&
      session.selectedRow >= session.result.windowStart &&
      session.selectedRow < session.result.windowStart + session.result.window.numRows
      ? session.selectedRow - session.result.windowStart
      : null,
  );
  const rowHighlight = $derived.by(() => {
    const result = session.result?.window ?? null;
    const row = selectedLocalRow;
    if (!result || row === null) return null;
    if (highlightMemo && highlightMemo.result === result && highlightMemo.row === row) {
      return highlightMemo.value;
    }
    const value = provenanceOfRow(result, row);
    highlightMemo = { result, row, value };
    return value;
  });

  // One honest statement about the current selection, reusing the memoized row provenance so
  // it stays reference-stable across unrelated publishes.
  const traceSummary = $derived(
    buildTraceSummary({
      hasResult: session.result !== null,
      selectedGlobalRow: session.selectedRow,
      selectedLocalRow,
      provenance: rowHighlight,
      files: sourceFiles,
    }),
  );

  // Auto-switch: follow the selected row's provenance file, but only to a file still present
  // in the session.
  // rowHighlight is only reference-stable (see its memo above) across publishes that don't
  // touch result/selectedRow — sourceFiles is NOT reference-stable across publishes (a fresh
  // derived array on every session reassignment), so gating purely on "did this effect fire"
  // would re-apply the auto-switch on every unrelated publish (e.g. the selectByteRange(null)
  // a manual switch triggers), fighting the user. Gate on the memoized highlight's identity
  // instead: only act the first time a given highlight is seen.
  let lastAutoSwitchedHighlight: typeof rowHighlight = null;
  $effect(() => {
    const highlight = rowHighlight;
    if (
      highlight &&
      highlight !== lastAutoSwitchedHighlight &&
      sourceFiles.some((candidate) => candidate.name === highlight.file) &&
      untrack(() => hexFile) !== highlight.file
    ) {
      hexFile = highlight.file;
    }
    lastAutoSwitchedHighlight = highlight;
  });

  let lastRevealOffset: number | null = null;
  let revealCycle = 0;

  function revealAt(offset: number): void {
    const rows = coverageResult.index?.rowsAt(offset) ?? [];
    if (rows.length === 0) {
      coverageMessage = session.result?.complete
        ? 'No result row covers this byte'
        : 'No loaded result row covers this byte';
      return;
    }
    coverageMessage = null;
    revealCycle = lastRevealOffset === offset ? revealCycle + 1 : 0;
    lastRevealOffset = offset;
    controller.selectResultRow(rows[revealCycle % rows.length] as number);
  }

  onMount(() => {
    // Crossing this breakpoint only changes how the catalog is presented. Each presentation
    // keeps its own choice, so an open column never becomes a drawer over the workspace.
    const drawerQuery = window.matchMedia('(max-width: 959px)');
    const syncDrawerMode = (event: MediaQueryListEvent | MediaQueryList): void => {
      // The drawer has no divider, so crossing into it strands whoever was on the sources one.
      const stranded =
        drawerMode !== event.matches && document.activeElement?.closest('.source-resize-slot') != null;
      drawerMode = event.matches;
      if (stranded) focusFallback([HEADER_SOURCES_TOGGLE]);
    };
    syncDrawerMode(drawerQuery);
    drawerQuery.addEventListener('change', syncDrawerMode);

    const unsubscribe = controller.subscribe((next) => {
      if (next.result?.window !== session.result?.window) coverageMessage = null;
      if (
        activeViewerId &&
        (next.result?.completeTable !== session.result?.completeTable ||
          next.source !== session.source ||
          next.capabilities !== session.capabilities)
      ) {
        activeViewerId = null;
      }
      session = next;
      if (next.sql && next.sql !== draftSql) draftSql = next.sql;
      if (next.phase === 'opening') overviewSource = null;

      const overview = next.queries.find((query) => query.id === 'overview');
      const sourceKey = next.source
        ? next.source.files.map((file) => `${file.name}:${file.size}`).join('|')
        : null;
      if (
        overview &&
        sourceKey &&
        next.phase === 'ready' &&
        next.sql === '' &&
        next.result === null &&
        next.queryError === null &&
        overviewSource !== sourceKey
      ) {
        overviewSource = sourceKey;
        draftSql = overview.sql;
        perform(() => controller.runQuery(overview.sql));
      }
    });

    return () => {
      drawerQuery.removeEventListener('change', syncDrawerMode);
      unsubscribe();
    };
  });

  function message(error: unknown): string {
    return error instanceof Error && error.message ? error.message : 'The action could not be completed.';
  }

  function perform(action: () => Promise<void>): void {
    actionError = null;
    void action().catch((error: unknown) => {
      actionError = message(error);
    });
  }

  /**
   * The schema index whose control started the pending sort, so focus can return to it. Toolbar
   * actions have no header of their own; a header action keeps its own button mounted.
   */
  let sortInitiator = $state<number | null>(null);

  const sortCapability = $derived.by(() => {
    void session.result;
    return controller.resultSortCapability();
  });
  const sortBusy = $derived(isResultSorting(session));
  const sortBlocked = $derived(resultSortInteractionBlocked(session));
  const sortReason = $derived(resultSortDisabledReason(session, sortCapability));
  const committedSort = $derived(session.result?.sort ?? null);
  const orderLabel = $derived.by(() => {
    const result = session.result;
    if (!result || !committedSort) return 'Query order';
    // The field is named even when it is hidden, so the toolbar always explains the order.
    const label = sortActionLabel(result.schema, null, committedSort.columnIndex)
      .replace(/^Sort /u, '')
      .replace(/ ascending$/u, '')
      .replace(/,$/u, '');
    return `Sorted by ${label} ${committedSort.direction === 'asc' ? '\u2191' : '\u2193'}`;
  });

  function requestSort(sort: ResultSort | null, initiator: number | null): void {
    sortInitiator = initiator;
    actionError = null;
    void controller
      .sortResults(sort)
      .catch((error: unknown) => {
        actionError = message(error);
      })
      .finally(() => {
        void restoreSortFocus();
      });
  }

  /**
   * Returns focus to the control that started the sort: its header button if that column is still
   * visible, otherwise the grid itself.
   */
  async function restoreSortFocus(): Promise<void> {
    const initiator = sortInitiator;
    sortInitiator = null;
    if (initiator === null) return;
    await tick();
    const header = document.querySelector<HTMLElement>(
      `.result-sort-button[data-column-index="${initiator}"]`,
    );
    if (header) {
      header.focus();
      return;
    }
    document.querySelector<HTMLElement>('.result-grid .grid-scroll')?.focus();
  }

  /** Loading an example query fills the editor and focuses it; it never runs the query. */
  function loadQuery(sql: string): void {
    draftSql = sql;
    void tick().then(() => sqlEditor?.focus());
  }

  function run(sql: string): void {
    if (!sql.trim()) return;
    draftSql = sql;
    perform(() => controller.runQuery(sql));
  }

  // While the drawer is a modal surface, Tab stays inside it and Escape closes it; on close,
  // focus returns to whatever opened it.
  $effect(() => {
    const panel = drawerElement;
    if (!drawerMode || !drawerOpen || !panel) return;
    return containFocus(panel, closeDrawer);
  });

  function loadQueryFromCatalog(sql: string): void {
    closeDrawer();
    loadQuery(sql);
  }

  function browseFromCatalog(name: string): void {
    closeDrawer();
    run(`select * from ${sqlIdentifier(name)}`);
  }

  /** Choosing a source is a request to look at its bytes, so Bytes is what opens. */
  function selectSourceFromCatalog(file: string): void {
    closeDrawer();
    switchHexFile(file);
    setDockCollapsed(false);
    if (compactDock) dockTab = 'bytes';
  }

  /**
   * The one way Values reach the screen in tab mode. `inspectorCollapsed` and `dockTab` are two
   * answers to the same question — are Values showing? — so asking for the Values tab has to
   * clear the hidden flag too. Left to disagree, widening would take away what the user just
   * opened, and narrowing would hand back what they put away.
   */
  function openValuesTab(): void {
    inspectorCollapsed = false;
    dockTab = 'values';
  }

  /** Choosing Bytes is the ordinary tab state, not a request to hide Values for good. */
  function selectDockTab(tab: 'values' | 'bytes'): void {
    if (tab === 'values') openValuesTab();
    else dockTab = 'bytes';
  }

  /**
   * Wide: Values toggle beside Bytes. Compact: open the dock on Values, or switch to Bytes
   * when Values are already what is showing.
   */
  function showValues(): void {
    if (!compactDock) {
      // Hiding Values takes its divider with it; no transaction may outlive its handle.
      if (!inspectorCollapsed) panels.cancel();
      inspectorCollapsed = !inspectorCollapsed;
      if (!inspectorCollapsed) setDockCollapsed(false);
      return;
    }
    if (!dockCollapsed && dockTab === 'values') {
      dockTab = 'bytes';
      return;
    }
    setDockCollapsed(false);
    openValuesTab();
  }

  /** Opening a viewer shows Values; it never runs SQL and never changes the selection. */
  function openViewer(viewer: ViewerCapability): void {
    activeViewerId = viewer.id;
    setDockCollapsed(false);
    if (compactDock) openValuesTab();
    else inspectorCollapsed = false;
  }

  /** A reveal from the values list shows Bytes and scrolls to the range. */
  function revealInspectorRange(range: { start: number; end: number }): void {
    setDockCollapsed(false);
    if (compactDock) dockTab = 'bytes';
    void tick().then(() => hexPane?.revealRange(range));
  }

  /**
   * Explicit source inspection: only a validated trace can be inspected. `revealRange` scrolls
   * but does not move focus, so the viewport is focused afterwards.
   */
  function inspectSource(): void {
    if (traceSummary.kind !== 'linked') return;
    const { range } = traceSummary;
    setDockCollapsed(false);
    if (compactDock) dockTab = 'bytes';
    void tick().then(() => {
      hexPane?.revealRange(range);
      hexPane?.focusViewport();
    });
  }

  function inEditableTarget(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    return !!target?.closest('input, textarea, select, [contenteditable="true"], .cm-editor');
  }

  function globalKeys(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === '?' && !mod && !inEditableTarget(event)) {
      event.preventDefault();
      setShortcutsOpen(!shortcutsOpen);
      return;
    }
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === 'o') {
      event.preventDefault();
      openPicker();
    } else if (key === 'b') {
      event.preventDefault();
      toggleSources();
    } else if (key === 'i') {
      event.preventDefault();
      showValues();
    } else if (key === 'g') {
      event.preventDefault();
      setDockCollapsed(false);
      if (compactDock) dockTab = 'bytes';
      void tick().then(() => hexPane?.focusGoto());
    }
  }
</script>

<svelte:window onkeydown={globalKeys} />

<!-- The dock composes these two panels. Both stay mounted across appearance, collapse and
     responsive changes, so navigation never resets caret, scroll or playback. -->
{#snippet values()}
  <Inspector
    table={session.result?.window ?? null}
    viewerTable={session.result?.completeTable ?? null}
    selectedRow={selectedLocalRow}
    selectedGlobalRow={session.selectedRow}
    collapsed={!valuesVisible}
    mobileOpen={valuesVisible}
    {sourceFiles}
    {viewers}
    {activeViewer}
    {audioEngineFactory}
    onopenviewer={openViewer}
    oncloseviewer={() => (activeViewerId = null)}
    onrevealrange={revealInspectorRange}
  />
{/snippet}

{#snippet bytes()}
  <HexPane
    bind:this={hexPane}
    layout="embedded"
    visible={bytesVisible}
    {appearance}
    blob={sourceBlob}
    fileSize={hexFileSize}
    coverage={coverageResult.index}
    coverageReason={coverageResult.reason}
    highlight={rowHighlight && rowHighlight.file === hexFile
      ? { start: rowHighlight.start, end: rowHighlight.end }
      : null}
    filterAvailable={coverageResult.reason === 'ok'}
    resetKey={hexResetKey}
    compact={compactDock}
    files={sourceFiles}
    currentFile={hexFile}
    onreveal={revealAt}
    onselectionchange={(range) =>
      controller.selectByteRange(range && hexFile ? { file: hexFile, ...range } : null)}
    onfilter={(range) => hexFile && run(wrapFilterSql(draftSql || session.sql, { file: hexFile, ...range }))}
    onfilechange={switchHexFile}
    onchromeheightchange={reportHexChrome}
  />
{/snippet}

{#if shortcutsOpen}
  <ShortcutsOverlay
    onclose={() => setShortcutsOpen(false)}
    onresetpanels={idle ? undefined : () => panels.reset()}
  />
{/if}

<div
  bind:this={shellElement}
  class:explorer-collapsed={explorerCollapsed}
  class:sources-resizable={sourcesResizable}
  class="app-shell"
  role="presentation"
  style:--sources-width={`${layout.sourcesWidth}px`}
  ondragenter={onDragEnter}
  ondragleave={onDragLeave}
  ondragover={onDragOver}
  ondrop={onDrop}
>
  <AppHeader
    sourceName={session.source
      ? session.source.files.length === 1
        ? session.source.files[0]!.name
        : `${session.source.files.length} files`
      : null}
    sourceSize={session.source?.totalSize ?? null}
    formatTitle={session.format?.title ?? null}
    {explorerCollapsed}
    {inspectorCollapsed}
    {intakeBusy}
    {appearance}
    onappearancechange={changeAppearance}
    onshortcuts={() => setShortcutsOpen(true)}
    ontoggleexplorer={idle ? undefined : toggleSources}
    ontoggleinspector={idle ? undefined : showValues}
    onopen={idle ? undefined : openPicker}
  />

  {#if dropActive}
    <div class="drop-overlay" aria-hidden="true">
      <p>Drop to open</p>
    </div>
  {/if}

  {#if !idle}
    <input
      bind:this={filePickerInput}
      class="visually-hidden"
      type="file"
      aria-label="Open file picker"
      multiple
      onchange={choosePickedFile}
    />
  {/if}

  {#if idle}
    <main class="empty-main">
      <EmptyState
        bind:this={emptyState}
        busy={intakeBusy}
        error={actionError ?? session.fatalError}
        onopen={(files) => perform(() => controller.openFiles(files))}
        onsample={(id) => perform(() => controller.openSample(id))}
      />
    </main>
  {:else}
    <!-- Narrow: an opaque modal drawer over the workspace. Wide: an ordinary column. The nav
         itself is the same mounted element either way, so nothing inside it remounts. -->
    <div
      bind:this={drawerElement}
      id="source-pane"
      class="explorer-drawer"
      class:drawer={drawerMode}
      role={drawerMode ? 'dialog' : undefined}
      aria-modal={drawerMode ? 'true' : undefined}
      aria-label={drawerMode ? 'Sources' : undefined}
      hidden={drawerMode && explorerCollapsed}
    >
      {#if drawerMode}
        <div class="drawer-heading">
          <h2>Sources</h2>
          <button class="icon-button" type="button" aria-label="Close sources" onclick={closeDrawer}>
            <Icon name="close" />
          </button>
        </div>
      {/if}
      <Explorer
        state={session}
        collapsed={!drawerMode && explorerCollapsed}
        currentFile={hexFile}
        onquery={loadQueryFromCatalog}
        onbrowse={browseFromCatalog}
        onselectsource={selectSourceFromCatalog}
      />
    </div>

    {#if sourcesResizable}
      <!-- A shell column of its own between the catalog and the workspace, so the separator has
           a real track instead of overlapping either neighbour. -->
      <div class="source-resize-slot">
        <ResizeHandle
          orientation="vertical"
          direction={1}
          value={layout.sourcesWidth}
          min={layout.sourcesBounds.min}
          max={layout.sourcesBounds.max}
          cancelEpoch={panels.cancelEpoch}
          onstart={() => panels.begin('sources')}
          onpreview={(value) => panels.preview('sources', value)}
          oncommit={(value) => panels.commit('sources', value)}
          oncancel={() => panels.cancel()}
          onreset={() => panels.reset('sources')}
          label="Resize sources"
          controls="source-pane"
        />
      </div>
    {/if}

    {#if drawerMode && !explorerCollapsed}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="drawer-backdrop"
        onclick={(event) => {
          // Only a click on the backdrop itself closes; a click that bubbled from the drawer
          // must not dismiss it.
          if (event.target === event.currentTarget) closeDrawer();
        }}
      ></div>
    {/if}

    <!-- While the modal drawer is open the workspace beneath it is inert, so its controls are
         neither clickable nor tab-reachable. Only this subtree — never an ancestor of the
         drawer itself — is marked. -->
    <div
      bind:this={mainElement}
      class="workbench-main"
      role="main"
      aria-label="Results"
      inert={drawerMode && !explorerCollapsed}
      data-trace-linked={traceSummary.kind === 'linked'}
    >
      <!-- Named grid areas, so a notice or a removed divider can never shift what a row means.
           The two vertical sizes are the coordinator's, published as custom properties. -->
      <section
        class="sql-workspace"
        aria-label="SQL workspace"
        style:--query-height={`${layout.queryHeight}px`}
        style:--dock-height={dockCollapsed ? 'auto' : `${layout.dockHeight}px`}
        style:--inspection-gutter={dockCollapsed ? '0px' : null}
      >
        <div bind:this={queryToolbarElement} class="editor-heading">
          <h1>Query</h1>
          <div class="query-actions">
            <span class="shortcut" aria-hidden="true">⌘ Enter</span>
            {#if session.phase === 'querying'}
              <!-- Compact like Run query: the two states share a slot, so starting a query must
                   not change the toolbar's height and resize the panes below it. -->
              <button
                class="button button-secondary button-compact"
                type="button"
                onclick={() => perform(() => controller.cancel())}
              >
                Cancel query
              </button>
            {:else}
              <button
                class="button button-primary button-compact"
                type="button"
                onclick={() => run(draftSql)}
              >
                Run query
              </button>
            {/if}
          </div>
        </div>

        <!-- A wrapper supplies the grid area; the editor host and its EditorView are untouched
             by resizing, so the document, undo history and selection all survive. -->
        <div id="query-pane" class="query-pane">
          <SqlEditor
            bind:this={sqlEditor}
            sql={draftSql}
            {appearance}
            disabled={session.phase === 'querying'}
            onrun={run}
            onchange={(sql) => (draftSql = sql)}
          />
        </div>

        <!-- Always present, so the notices row has an element to measure even when empty. The
             inner wrapper is the one that scrolls: see `.query-notices` in workbench.css. -->
        <div bind:this={noticesElement} class="query-notices">
          <div class="query-notices-scroll">
            {#if session.queryError || actionError}
              <div class="query-diagnostic" role="alert">
                <strong>Query diagnostic</strong>
                <span>{session.queryError ?? actionError}</span>
              </div>
            {/if}

            {#if coverageMessage}
              <div class="format-notice" role="status" aria-label="Coverage notice">
                {coverageMessage}
              </div>
            {/if}

            {#each disabledCapabilityReasons as reason (reason)}
              <div class="format-notice" role="status" aria-label="Format capability notice">
                {reason}
              </div>
            {/each}
          </div>
        </div>

        <div bind:this={queryGutterElement} class="query-resize-slot">
          <ResizeHandle
            orientation="horizontal"
            direction={1}
            value={layout.queryHeight}
            min={layout.queryBounds.min}
            max={layout.queryBounds.max}
            cancelEpoch={panels.cancelEpoch}
            onstart={() => panels.begin('query')}
            onpreview={(value) => panels.preview('query', value)}
            oncommit={(value) => panels.commit('query', value)}
            oncancel={() => panels.cancel()}
            onreset={() => panels.reset('query')}
            label="Resize query"
            controls="query-pane"
          />
        </div>

        <div bind:this={resultsToolbarElement} class="results-heading">
          <h2>Results</h2>
          <div class="results-heading-meta">
            {#if session.result}
              <span class="result-count">
                {session.result.pageError
                  ? `${session.result.loadedRows.toLocaleString()} loaded · ${session.result.pageError}`
                  : session.result.complete
                    ? `${session.result.loadedRows.toLocaleString()} rows`
                    : `${session.result.loadedRows.toLocaleString()} loaded · more available`}
              </span>
              <span class="result-count tabular">{session.result.elapsedMs.toFixed(1)} ms</span>
              <span class="result-count result-order">{orderLabel}</span>
              {#if committedSort !== null}
                <button
                  class="button button-secondary"
                  type="button"
                  disabled={sortBlocked}
                  onclick={() => requestSort(null, committedSort.columnIndex)}
                >
                  Clear sort
                </button>
              {/if}
              {#if sortBusy}
                <button
                  class="button button-secondary"
                  type="button"
                  disabled={session.sorting?.phase === 'cancelling'}
                  onclick={() => perform(() => controller.cancelResultSort())}
                >
                  Cancel sort
                </button>
              {/if}
            {/if}
            <ResultsDownload {controller} {session} />
          </div>
          <div class="result-sort-status">
            <p role="status" aria-label="Sort progress">{sortBusy ? (session.sorting?.message ?? '') : ''}</p>
            {#if session.sorting?.phase === 'failed'}
              <p role="alert" class="result-sort-error">{session.sorting.message}</p>
            {/if}
          </div>
        </div>

        <div class="results-panel">
          {#if session.result}
            {#key session.result.generation}
              <ResultGrid
                table={session.result.window}
                windowStart={session.result.windowStart}
                loadedRows={session.result.loadedRows}
                complete={session.result.complete}
                loadingMore={session.result.loadingMore}
                pageError={session.result.pageError}
                pageErrorRetryable={session.result.pageErrorRetryable}
                selectedRow={session.selectedRow}
                orderRevision={session.result.orderRevision}
                sort={session.result.sort}
                {sortBusy}
                sortInteractionBlocked={sortBlocked}
                sortDisabledReason={sortReason}
                onselect={(row) => controller.selectResultRow(row)}
                onloadmore={() => perform(() => controller.loadMoreResults())}
                onloadwindow={(row) => perform(() => controller.loadResultWindow(row))}
                onretry={() => perform(() => controller.retryResultPage())}
                onsort={(next) => requestSort(next, session.result?.sort?.columnIndex ?? null)}
              />
            {/key}
          {:else if intakeBusy}
            <div class="activity-state" aria-live="polite">
              <span class="activity-spinner" aria-hidden="true"></span>
              <strong>{session.progress?.label ?? 'Preparing local tables'}</strong>
              {#if session.progress?.total}
                <progress value={session.progress.completed} max={session.progress.total}>
                  {session.progress.completed} of {session.progress.total}
                </progress>
              {/if}
              <button
                class="button button-secondary"
                type="button"
                onclick={() => perform(() => controller.cancel())}
              >
                Cancel
              </button>
            </div>
          {:else}
            <div class="results-placeholder">
              <p>Choose an example query, or write SQL and run it.</p>
            </div>
          {/if}
        </div>

        {#if !dockCollapsed}
          <!-- `.hex-resize` stays as a compatibility class: the topmost-hit-test regression it
               names still applies, now to a divider that owns a real track of its own. -->
          <div class="inspection-resize-slot">
            <ResizeHandle
              orientation="horizontal"
              direction={-1}
              value={layout.dockHeight}
              min={layout.dockBounds.min}
              max={layout.dockBounds.max}
              cancelEpoch={panels.cancelEpoch}
              onstart={() => panels.begin('inspection')}
              onpreview={(value) => panels.preview('inspection', value)}
              oncommit={(value) => panels.commit('inspection', value)}
              oncancel={() => panels.cancel()}
              onreset={() => panels.reset('inspection')}
              label="Resize inspection"
              controls="inspection-pane"
              compatibilityClass="hex-resize"
            />
          </div>
        {/if}

        <TraceDock
          summary={traceSummary}
          collapsed={dockCollapsed}
          oncollapsedchange={setDockCollapsed}
          compact={compactDock}
          showValues={!inspectorCollapsed}
          tab={dockTab}
          ontabchange={selectDockTab}
          onreveal={inspectSource}
          height={layout.dockHeight}
          valuesWidth={layout.valuesWidth}
          valuesBounds={layout.valuesBounds}
          cancelEpoch={panels.cancelEpoch}
          onvaluestart={() => panels.begin('values')}
          onvaluespreview={(value) => panels.preview('values', value)}
          onvaluescommit={(value) => panels.commit('values', value)}
          onvaluescancel={() => panels.cancel()}
          onvaluesreset={() => panels.reset('values')}
          onchromechange={(value) => (dockChrome = value)}
          {values}
          {bytes}
        />
      </section>
    </div>
  {/if}

  <StatusBar state={session} />
</div>
