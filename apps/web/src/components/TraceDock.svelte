<script lang="ts">
  /* global HTMLElement, KeyboardEvent, PointerEvent, localStorage, window */
  import type { Snippet } from 'svelte';

  import { dockBounds, storedDockHeight } from '../lib/ui/dock-layout.js';
  import type { TraceSummary } from '../lib/ui/trace.js';
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
    /** The results panel above, measured for the resize budget — never a sibling lookup. */
    resultsElement: HTMLElement | null;
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
    resultsElement,
    values,
    bytes,
  }: Props = $props();

  const HEIGHT_KEY = 'byteql.hexpane.height';
  const ROW_STEP = 18;

  function readStoredHeight(): string | null {
    try {
      return localStorage.getItem(HEIGHT_KEY);
    } catch {
      return null;
    }
  }

  function writeStoredHeight(value: number): void {
    try {
      localStorage.setItem(HEIGHT_KEY, String(Math.round(value)));
    } catch {
      // Geometry preferences are optional.
    }
  }

  let rootEl = $state<HTMLElement | null>(null);
  let stripEl = $state<HTMLElement | null>(null);
  let height = $state(storedDockHeight(readStoredHeight()));
  let stripHeight = $state(40);
  let resizing = $state(false);
  let resizeStartY = 0;
  let resizeStartHeight = 0;

  function bounds(): { min: number; max: number } {
    const parent = rootEl?.parentElement;
    return dockBounds({
      height,
      resultsHeight: resultsElement?.clientHeight ?? 0,
      overflow: parent ? parent.scrollHeight - parent.clientHeight : 0,
      stripHeight,
      compact,
    });
  }

  function clampTo(next: number): void {
    const { min, max } = bounds();
    height = Math.max(min, Math.min(max, next));
  }

  // Geometry changes clamp immediately and without animation.
  $effect(() => {
    const parent = rootEl?.parentElement;
    if (collapsed || !parent || typeof window.ResizeObserver !== 'function') return;
    const observer = new window.ResizeObserver(() => {
      if (stripEl) stripHeight = stripEl.offsetHeight;
      const { min, max } = bounds();
      if (height > max) height = Math.max(min, max);
    });
    observer.observe(parent);
    if (resultsElement) observer.observe(resultsElement);
    if (stripEl) observer.observe(stripEl);
    return () => observer.disconnect();
  });

  function onResizePointerdown(event: PointerEvent): void {
    event.preventDefault();
    resizing = true;
    resizeStartY = event.clientY;
    resizeStartHeight = height;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onResizePointermove(event: PointerEvent): void {
    if (!resizing) return;
    clampTo(resizeStartHeight - (event.clientY - resizeStartY));
  }

  /** Also handles pointercancel: capture must never outlive the drag. */
  function endResize(event: PointerEvent): void {
    if (!resizing) return;
    resizing = false;
    const handle = event.currentTarget as HTMLElement;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    writeStoredHeight(height);
  }

  function onResizeKeydown(event: KeyboardEvent): void {
    const { min, max } = bounds();
    let next: number | null = null;
    if (event.key === 'ArrowUp') next = height + ROW_STEP;
    else if (event.key === 'ArrowDown') next = height - ROW_STEP;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    height = Math.max(min, Math.min(max, next));
    writeStoredHeight(height);
  }

  const separatorBounds = $derived.by(() => {
    void height;
    void stripHeight;
    void compact;
    return dockBounds({
      height,
      resultsHeight: resultsElement?.clientHeight ?? 0,
      overflow: 0,
      stripHeight,
      compact,
    });
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
</script>

<section
  bind:this={rootEl}
  class="trace-dock"
  class:compact
  class:values-hidden={!compact && !showValues}
  data-trace-dock
  data-dock-collapsed={collapsed}
  style:height={collapsed ? undefined : `${height}px`}
>
  {#if !collapsed}
    <!-- Above the strip, with a 6 px hit area layered over adjacent chrome so the pointerdown
         reaches it rather than the toolbar it overlaps. `.hex-resize` is kept as a
         compatibility class: the topmost-hit-test regression still applies, with a new owner. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="hex-resize dock-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize inspection"
      aria-valuenow={Math.round(height)}
      aria-valuemin={Math.round(separatorBounds.min)}
      aria-valuemax={Math.round(separatorBounds.max)}
      tabindex="0"
      onpointerdown={onResizePointerdown}
      onpointermove={onResizePointermove}
      onpointerup={endResize}
      onpointercancel={endResize}
      onkeydown={onResizeKeydown}
    ></div>
  {/if}

  <div bind:this={stripEl} class="trace-dock-strip">
    <TraceBar {summary} {collapsed} {onreveal} ontoggle={() => oncollapsedchange(!collapsed)} />
  </div>

  <!-- Hidden, never unmounted: collapsing the dock must not reset caret, scroll or playback. -->
  {#if compact}
    <div class="trace-dock-tabs" role="tablist" aria-label="Inspection views" hidden={collapsed}>
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
