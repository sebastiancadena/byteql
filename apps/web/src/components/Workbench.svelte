<script lang="ts">
  /* global Blob, DragEvent, Event, File, HTMLElement, HTMLInputElement, KeyboardEvent, MediaQueryList, MediaQueryListEvent, Storage, document, localStorage, window */

  import type { Table } from 'apache-arrow';
  import { onMount, tick, untrack } from 'svelte';

  import type { ExportOptions } from '../lib/export/options.js';
  import { createCoverageMemo, provenanceOfRow } from '../lib/hex/coverage.js';
  import { wrapFilterSql } from '../lib/hex/filter-sql.js';
  import type { SampleId } from '../lib/session/samples.js';
  import { initialSessionState, type SessionState } from '../lib/session/state.js';
  import { sqlIdentifier } from '../lib/sql-literal.js';
  import { applyTheme, readTheme, type Theme } from '../lib/ui/theme.js';
  import { buildTraceSummary } from '../lib/ui/trace.js';
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
  import ResultGrid from './ResultGrid.svelte';
  import ResultsDownload from './ResultsDownload.svelte';
  import ShortcutsOverlay from './ShortcutsOverlay.svelte';
  import SqlEditor from './SqlEditor.svelte';
  import StatusBar from './StatusBar.svelte';
  import TraceDock from './TraceDock.svelte';

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
  // Narrow viewports render the catalog as a drawer over the workspace, so it starts closed:
  // never cover the work surface with a drawer nobody asked for.
  let explorerCollapsed = $state(untrack(() => window.matchMedia('(max-width: 959px)').matches));
  let inspectorCollapsed = $state(false);
  /** Below 1280 px the dock tabs Values and Bytes instead of showing them side by side. */
  let compactDock = $state(false);
  let dockTab = $state<'values' | 'bytes'>('bytes');
  let resultsElement = $state<HTMLElement | null>(null);
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

  function setDockCollapsed(collapsed: boolean): void {
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
    // Below 1280 px the dock tabs its two panels rather than showing them side by side.
    const dockQuery = window.matchMedia('(max-width: 1279px)');
    const syncCompactDock = (event: MediaQueryListEvent | MediaQueryList): void => {
      compactDock = event.matches;
    };
    syncCompactDock(dockQuery);
    dockQuery.addEventListener('change', syncCompactDock);

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
      dockQuery.removeEventListener('change', syncCompactDock);
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

  /**
   * Wide: Values toggle beside Bytes. Compact: open the dock on Values, or switch to Bytes
   * when Values are already what is showing.
   */
  function showValues(): void {
    if (!compactDock) {
      inspectorCollapsed = !inspectorCollapsed;
      if (!inspectorCollapsed) setDockCollapsed(false);
      return;
    }
    if (!dockCollapsed && dockTab === 'values') {
      dockTab = 'bytes';
      return;
    }
    setDockCollapsed(false);
    dockTab = 'values';
  }

  /** Opening a viewer shows Values; it never runs SQL and never changes the selection. */
  function openViewer(viewer: ViewerCapability): void {
    activeViewerId = viewer.id;
    setDockCollapsed(false);
    if (compactDock) dockTab = 'values';
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
      shortcutsOpen = !shortcutsOpen;
      return;
    }
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === 'o') {
      event.preventDefault();
      openPicker();
    } else if (key === 'b') {
      event.preventDefault();
      explorerCollapsed = !explorerCollapsed;
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
  />
{/snippet}

{#if shortcutsOpen}
  <ShortcutsOverlay onclose={() => (shortcutsOpen = false)} />
{/if}

<div
  class:explorer-collapsed={explorerCollapsed}
  class="app-shell"
  role="presentation"
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
    onshortcuts={() => (shortcutsOpen = true)}
    ontoggleexplorer={idle ? undefined : () => (explorerCollapsed = !explorerCollapsed)}
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
    <Explorer
      state={session}
      collapsed={explorerCollapsed}
      currentFile={hexFile}
      onquery={loadQuery}
      onbrowse={(name) => run(`select * from ${sqlIdentifier(name)}`)}
      onselectsource={switchHexFile}
    />

    <div
      class="workbench-main"
      role="main"
      aria-label="Results"
      data-trace-linked={traceSummary.kind === 'linked'}
    >
      <section class="sql-workspace" aria-label="SQL workspace">
        <div class="editor-heading">
          <h1>Query</h1>
          <div class="query-actions">
            <span class="shortcut" aria-hidden="true">⌘ Enter</span>
            {#if session.phase === 'querying'}
              <button
                class="button button-secondary"
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

        <SqlEditor
          bind:this={sqlEditor}
          sql={draftSql}
          {appearance}
          disabled={session.phase === 'querying'}
          onrun={run}
          onchange={(sql) => (draftSql = sql)}
        />

        <!-- Always present so the workspace grid's positional rows never shift when
             diagnostics come and go; empty it collapses to a zero-height row. -->
        <div class="query-notices">
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

        <div class="results-heading">
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
            {/if}
            <ResultsDownload {controller} {session} />
          </div>
        </div>

        <div class="results-panel" bind:this={resultsElement}>
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
                onselect={(row) => controller.selectResultRow(row)}
                onloadmore={() => perform(() => controller.loadMoreResults())}
                onloadwindow={(row) => perform(() => controller.loadResultWindow(row))}
                onretry={() => perform(() => controller.retryResultPage())}
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
              <span aria-hidden="true">▦</span>
              <p>Choose a saved query or write SQL to populate the grid.</p>
            </div>
          {/if}
        </div>

        <TraceDock
          summary={traceSummary}
          collapsed={dockCollapsed}
          oncollapsedchange={setDockCollapsed}
          compact={compactDock}
          showValues={!inspectorCollapsed}
          tab={dockTab}
          ontabchange={(tab) => (dockTab = tab)}
          onreveal={inspectSource}
          {resultsElement}
          {values}
          {bytes}
        />
      </section>
    </div>
  {/if}

  <StatusBar state={session} />
</div>
