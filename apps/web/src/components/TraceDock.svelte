<script lang="ts">
  /* global HTMLElement, KeyboardEvent, ResizeObserver */
  import type { Snippet } from 'svelte';

  import type { Bounds } from '../lib/ui/panel-layout.js';
  import type { TraceSummary } from '../lib/ui/trace.js';
  import ResizeHandle from './ResizeHandle.svelte';
  import TraceBar from './TraceBar.svelte';

  type DockTab = 'values' | 'bytes';

  interface Props {
    summary: TraceSummary;
    collapsed: boolean;
    oncollapsedchange: (collapsed: boolean) => void;
    /** True when Values and Bytes are tabbed rather than side by side. */
    compact: boolean;
    showValues: boolean;
    tab: DockTab;
    ontabchange: (tab: DockTab) => void;
    onreveal: () => void;
    /** Effective dock height from the workspace layout. The dock owns no size of its own. */
    height: number;
    /** Effective width of the Values column, published for the dock's own grid. */
    valuesWidth: number;
    /** Limits for the Values separator. The dock renders that separator; it owns no preference,
     * and every value it reports goes straight back to the workspace's layout coordinator. */
    valuesBounds: Bounds;
    /** Bumped by the coordinator to abandon an in-flight drag. */
    cancelEpoch: number;
    onvaluestart: () => void;
    onvaluespreview: (value: number) => void;
    onvaluescommit: (value: number) => void;
    onvaluescancel: () => void;
    onvaluesreset: () => void;
    /** Border-box heights of the chrome the workspace budget has to account for. */
    onchromechange: (value: { strip: number; tabs: number }) => void;
    values: Snippet;
    bytes: Snippet;
  }

  let {
    summary,
    collapsed,
    oncollapsedchange,
    compact,
    showValues,
    tab,
    ontabchange,
    onreveal,
    height,
    valuesWidth,
    valuesBounds,
    cancelEpoch,
    onvaluestart,
    onvaluespreview,
    onvaluescommit,
    onvaluescancel,
    onvaluesreset,
    onchromechange,
    values,
    bytes,
  }: Props = $props();

  let stripEl = $state<HTMLElement | null>(null);
  let tabsEl = $state<HTMLElement | null>(null);
  let reported = { strip: -1, tabs: -1 };

  /** A hidden tab row honestly contributes nothing to the budget, so it reports zero. */
  function reportChrome(): void {
    const strip = stripEl?.offsetHeight ?? 0;
    const tabs = tabsEl && !tabsEl.hidden ? tabsEl.offsetHeight : 0;
    if (strip === reported.strip && tabs === reported.tabs) return;
    reported = { strip, tabs };
    onchromechange({ strip, tabs });
  }

  // The strip wraps on narrow layouts and the tab row exists only in compact mode, so both are
  // measured rather than assumed. Re-runs when either element is created, removed or hidden.
  $effect(() => {
    const strip = stripEl;
    const tabs = tabsEl;
    void collapsed;
    reportChrome();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(reportChrome);
    if (strip) observer.observe(strip);
    if (tabs) observer.observe(tabs);
    return () => observer.disconnect();
  });

  function onTabKeydown(event: KeyboardEvent): void {
    let next: DockTab | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      next = tab === 'values' ? 'bytes' : 'values';
    } else if (event.key === 'Home') next = 'values';
    else if (event.key === 'End') next = 'bytes';
    if (!next) return;
    event.preventDefault();
    ontabchange(next);
    // Roving focus follows the selected tab.
    const tablist = (event.currentTarget as HTMLElement).parentElement;
    tablist?.querySelector<HTMLElement>(`[data-dock-tab='${next}']`)?.focus();
  }

  const valuesActive = $derived(compact ? tab === 'values' : showValues);
  const bytesActive = $derived(compact ? tab === 'bytes' : true);
  /** Only a Values column that is actually beside Bytes has an edge to drag. Tabs, a collapsed
   * dock and hidden Values each remove the separator from the DOM rather than hiding it. */
  const valuesResizable = $derived(!collapsed && !compact && showValues);
</script>

<section
  id="inspection-pane"
  class="trace-dock"
  class:compact
  class:values-hidden={!compact && !showValues}
  class:values-resizable={valuesResizable}
  data-trace-dock
  data-dock-collapsed={collapsed}
  style:height={collapsed ? undefined : `${height}px`}
  style:--values-width={`${valuesWidth}px`}
>
  <div bind:this={stripEl} class="trace-dock-strip">
    <TraceBar {summary} {collapsed} {onreveal} ontoggle={() => oncollapsedchange(!collapsed)} />
  </div>

  <!-- Hidden, never unmounted: collapsing the dock must not reset caret, scroll or playback. -->
  {#if compact}
    <div
      bind:this={tabsEl}
      class="trace-dock-tabs"
      role="tablist"
      aria-label="Inspection views"
      hidden={collapsed}
    >
      <button
        type="button"
        role="tab"
        data-dock-tab="values"
        id="dock-tab-values"
        aria-selected={tab === 'values'}
        aria-controls="dock-panel-values"
        tabindex={tab === 'values' ? 0 : -1}
        onkeydown={onTabKeydown}
        onclick={() => ontabchange('values')}>Values</button
      >
      <button
        type="button"
        role="tab"
        data-dock-tab="bytes"
        id="dock-tab-bytes"
        aria-selected={tab === 'bytes'}
        aria-controls="dock-panel-bytes"
        tabindex={tab === 'bytes' ? 0 : -1}
        onkeydown={onTabKeydown}
        onclick={() => ontabchange('bytes')}>Bytes</button
      >
    </div>
  {/if}

  <div class="trace-dock-body" hidden={collapsed}>
    <div
      class="trace-values"
      id="dock-panel-values"
      role={compact ? 'tabpanel' : undefined}
      aria-labelledby={compact ? 'dock-tab-values' : undefined}
      hidden={!valuesActive}
    >
      {@render values()}
    </div>
    {#if valuesResizable}
      <div class="values-resize-slot">
        <ResizeHandle
          orientation="vertical"
          direction={1}
          value={valuesWidth}
          min={valuesBounds.min}
          max={valuesBounds.max}
          {cancelEpoch}
          onstart={onvaluestart}
          onpreview={onvaluespreview}
          oncommit={onvaluescommit}
          oncancel={onvaluescancel}
          onreset={onvaluesreset}
          label="Resize values"
          controls="dock-panel-values"
        />
      </div>
    {/if}
    <div
      class="trace-bytes"
      id="dock-panel-bytes"
      role={compact ? 'tabpanel' : undefined}
      aria-labelledby={compact ? 'dock-tab-bytes' : undefined}
      hidden={!bytesActive}
    >
      {@render bytes()}
    </div>
  </div>
</section>
