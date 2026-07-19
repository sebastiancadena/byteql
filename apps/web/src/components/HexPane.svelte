<script lang="ts">
  /* global Blob, HTMLCanvasElement, HTMLDivElement, HTMLInputElement, KeyboardEvent,
     PointerEvent, WheelEvent, getComputedStyle, localStorage, navigator,
     requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout, window,
     devicePixelRatio */
  import { untrack } from 'svelte';

  import { ByteCache } from '../lib/hex/byte-cache.js';
  import type { CoverageIndex, CoverageReason } from '../lib/hex/coverage.js';
  import { parseOffsetInput } from '../lib/hex/goto.js';
  import {
    BYTES_PER_ROW,
    byteAtPoint,
    clampScrollRow,
    columnLayout,
    offsetDigits,
    rowsInView,
    scrollRowForThumbTop,
    thumbGeometry,
    totalRows,
    type HexMetrics,
  } from '../lib/hex/layout.js';
  import { drawHexFrame, type CanvasTextContext, type HexColors } from '../lib/hex/render.js';
  import {
    reduceSelection,
    selectionRange,
    type HexSelection,
    type SelectionAction,
  } from '../lib/hex/selection.js';

  interface Props {
    blob: Blob | null;
    fileSize: number;
    coverage: CoverageIndex | null;
    coverageReason: CoverageReason;
    highlight: { start: number; end: number } | null;
    filterAvailable: boolean;
    compact?: boolean;
    onreveal: (offset: number) => void;
    onselectionchange: (range: { start: number; end: number } | null) => void;
    onfilter: (range: { start: number; end: number }) => void;
  }

  let {
    blob,
    fileSize,
    coverage,
    coverageReason,
    highlight,
    filterAvailable,
    compact = false,
    onreveal,
    onselectionchange,
    onfilter,
  }: Props = $props();

  const COLLAPSED_KEY = 'byteql.hexpane.collapsed';
  const HEIGHT_KEY = 'byteql.hexpane.height';
  const HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, '0'));

  /** Detached canvas measured once so metrics are stable across instances. */
  function measureCharWidth(): number {
    const probe = window.document.createElement('canvas');
    const context = probe.getContext('2d');
    if (!context) return 7.2;
    context.font = "12px 'JetBrains Mono', monospace";
    const width = context.measureText('0').width;
    return width > 0 ? width : 7.2;
  }
  const CHAR_WIDTH = measureCharWidth();

  const storedCollapsed = localStorage.getItem(COLLAPSED_KEY);
  const storedHeight = Number(localStorage.getItem(HEIGHT_KEY));

  let canvas = $state<HTMLCanvasElement | null>(null);
  let viewportEl = $state<HTMLDivElement | null>(null);
  let gotoInput = $state<HTMLInputElement | null>(null);
  let rootEl = $state<HTMLElement | null>(null);
  let cache = $state<ByteCache | null>(null);
  let scrollRow = $state(0);
  let selection = $state<HexSelection | null>(null);
  let gotoInvalid = $state(false);
  let readError = $state(false);
  let flashRow = $state<number | null>(null);
  let collapsed = $state(untrack(() => storedCollapsed === 'true' || (storedCollapsed === null && compact)));
  let paneHeight = $state(storedHeight > 0 ? storedHeight : 260);
  let viewportHeight = $state(200);
  let cachePulse = $state(0);

  const reducedMotion =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const metrics = $derived<HexMetrics>({
    charWidth: CHAR_WIDTH,
    rowHeight: 18,
    gutterDigits: offsetDigits(fileSize),
    padding: 12,
  });
  const layout = $derived(columnLayout(metrics));
  const total = $derived(totalRows(fileSize));
  const view = $derived(rowsInView(viewportHeight, metrics.rowHeight));
  const caret = $derived(selection?.focus ?? null);
  const range = $derived(selection ? selectionRange(selection) : null);
  const caretByte = $derived.by(() => {
    void cachePulse; // re-read when a cache page arrives
    return caret !== null ? (cache?.byteAt(caret) ?? null) : null;
  });
  const coveringRows = $derived(caret !== null && coverage ? coverage.rowsAt(caret).length : 0);

  const rowOf = (offset: number): number => Math.floor(offset / BYTES_PER_ROW);

  const caretHex = $derived(caret === null ? '' : `0x${caret.toString(16)}`);
  const caretByteHex = $derived(caretByte === null ? '' : `0x${HEX[caretByte]}`);
  const announcement = $derived.by(() => {
    if (caret === null) return '';
    let text = `Offset ${caretHex}`;
    if (caretByte !== null) text += `, byte 0x${HEX[caretByte]}`;
    if (coverage && coveringRows > 0) text += `, ${coveringRows} covering rows`;
    return text;
  });

  const showFilter = $derived(filterAvailable && range !== null && coverageReason === 'ok');
  const hintText = $derived.by(() => {
    if (coverageReason === 'no-provenance')
      return 'No byte provenance in this result — browse a table to link bytes to rows.';
    if (coverageReason === 'too-large') return 'Result too large to index — shading and reveal are off.';
    return '';
  });

  const thumb = $derived(thumbGeometry(viewportHeight, total, view, scrollRow));

  // Cache lifecycle: rebuild on blob change, dispose the previous instance.
  $effect(() => {
    const current = blob;
    untrack(() => {
      cache?.dispose();
      scrollRow = 0;
      selection = null;
      readError = false;
      flashRow = null;
      if (!current) {
        cache = null;
        return;
      }
      const next = new ByteCache(current);
      const unsubscribe = next.subscribe(() => {
        cachePulse += 1;
        schedulePaint();
      });
      cache = next;
      // stash the unsubscribe on the instance via closure cleanup below
      cacheCleanup = () => {
        unsubscribe();
        next.dispose();
      };
    });
    return () => {
      cacheCleanup?.();
      cacheCleanup = null;
    };
  });
  let cacheCleanup: (() => void) | null = null;

  // Prefetch the viewport plus one page of lookahead.
  $effect(() => {
    const active = cache;
    const first = scrollRow;
    const rows = view;
    if (!active) return;
    active
      .ensureRange(first * BYTES_PER_ROW, (first + rows + 1) * BYTES_PER_ROW + active.pageBytes)
      .catch(() => {
        readError = true;
      });
  });

  // Repaint whenever anything visual changes.
  $effect(() => {
    // read reactive deps
    void scrollRow;
    void selection;
    void highlight;
    void coverage;
    void flashRow;
    void metrics;
    void viewportHeight;
    void collapsed;
    void cachePulse;
    schedulePaint();
  });

  // React to a new highlight prop: scroll it into view + flash.
  let lastHighlight: { start: number; end: number } | null = null;
  $effect(() => {
    const next = highlight;
    if (next === lastHighlight) return;
    lastHighlight = next;
    if (next) untrack(() => revealTo(next.start, false));
  });

  let paintHandle = 0;
  function schedulePaint(): void {
    if (paintHandle) return;
    paintHandle = requestAnimationFrame(() => {
      paintHandle = 0;
      paint();
    });
  }

  function readColor(style: CSSStyleDeclaration, name: string): string {
    return style.getPropertyValue(name).trim();
  }

  function paint(): void {
    if (!canvas || collapsed) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const cssWidth = layout.width;
    const cssHeight = viewportHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const style = getComputedStyle(canvas);
    const colors: HexColors = {
      background: readColor(style, '--color-surface-inset') || '#0b1016',
      gutter: readColor(style, '--color-text-subtle') || '#8fa2b1',
      text: readColor(style, '--color-text') || '#edf3f7',
      ascii: readColor(style, '--color-text-muted') || '#aebdca',
      shadeA: readColor(style, '--color-shade-a'),
      shadeB: readColor(style, '--color-shade-b'),
      selection: readColor(style, '--color-selection') || '#183b3a',
      highlight: readColor(style, '--color-hex-highlight'),
      caret: readColor(style, '--color-focus') || '#ffca68',
      placeholder: readColor(style, '--color-hex-placeholder'),
    };
    const fontFamily = readColor(style, '--font-mono') || 'monospace';
    const viewStart = scrollRow * BYTES_PER_ROW;
    const viewEnd = (scrollRow + view + 1) * BYTES_PER_ROW;
    const activeCache = cache;

    drawHexFrame(context as unknown as CanvasTextContext, {
      widthPx: cssWidth,
      heightPx: cssHeight,
      firstRow: scrollRow,
      fileSize,
      metrics,
      layout,
      colors,
      fontSpec: `12px ${fontFamily}`,
      byteAt: (offset) => activeCache?.byteAt(offset) ?? null,
      shading: coverage?.spansIn(viewStart, viewEnd) ?? [],
      selection: range,
      highlight,
      caret,
    });

    if (flashRow !== null) {
      const bandY = (flashRow - scrollRow) * metrics.rowHeight;
      if (bandY >= -metrics.rowHeight && bandY < cssHeight) {
        context.fillStyle = readColor(style, '--color-accent-wash') || 'rgb(85 216 190 / 8%)';
        context.fillRect(0, bandY, cssWidth, metrics.rowHeight);
      }
    }
  }

  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  function flash(row: number): void {
    if (reducedMotion) return;
    flashRow = row;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashRow = null;
      flashTimer = null;
    }, 600);
  }

  /** Scroll so `offset` sits within view; optionally place the caret there. */
  function revealTo(offset: number, moveCaret: boolean): void {
    const row = rowOf(offset);
    if (row < scrollRow || row >= scrollRow + view) {
      scrollRow = clampScrollRow(row - Math.floor(view / 2), total, view);
    }
    if (moveCaret) apply({ type: 'point', offset, extend: false });
    flash(row);
  }

  function keepCaretInView(): void {
    if (caret === null) return;
    const row = rowOf(caret);
    if (row < scrollRow) scrollRow = clampScrollRow(row, total, view);
    else if (row >= scrollRow + view) scrollRow = clampScrollRow(row - view + 1, total, view);
  }

  /** Apply a selection action and emit the range change. */
  function apply(action: SelectionAction): void {
    selection = reduceSelection(selection, action);
    onselectionchange(selection ? selectionRange(selection) : null);
  }

  // --- Goto ---------------------------------------------------------------
  function submitGoto(): void {
    if (!gotoInput) return;
    const reference = caret ?? scrollRow * BYTES_PER_ROW;
    const parsed = parseOffsetInput(gotoInput.value, reference);
    if (parsed === 'invalid') {
      gotoInvalid = true;
      return;
    }
    gotoInvalid = false;
    if (fileSize === 0) return;
    const offset = Math.max(0, Math.min(fileSize - 1, parsed));
    apply({ type: 'point', offset, extend: false });
    revealTo(offset, false);
  }

  function onGotoKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitGoto();
    }
  }

  function onGotoInput(): void {
    if (gotoInvalid) gotoInvalid = false;
  }

  export function focusGoto(): void {
    gotoInput?.focus();
    gotoInput?.select();
  }

  export function revealRange(target: { start: number; end: number }): void {
    revealTo(target.start, false);
  }

  // --- Keyboard on the canvas host ----------------------------------------
  function moveBy(delta: number, extend: boolean): void {
    if (selection === null) apply({ type: 'point', offset: 0, extend: false });
    else apply({ type: 'move', delta, extend, fileSize });
    keepCaretInView();
  }

  async function copySelection(): Promise<void> {
    if (!cache || !range) return;
    const bytes = await cache.copyRange(range.start, range.end);
    const text = Array.from(bytes, (b) => HEX[b]).join(' ');
    await navigator.clipboard?.writeText(text);
  }

  function onCanvasKeydown(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey;
    const shift = event.shiftKey;
    if (mod && (event.key === 'c' || event.key === 'C')) {
      if (range) {
        event.preventDefault();
        void copySelection();
      }
      return;
    }
    if (mod && event.key === 'Home') {
      event.preventDefault();
      apply({ type: 'point', offset: 0, extend: shift });
      keepCaretInView();
      return;
    }
    if (mod && event.key === 'End') {
      event.preventDefault();
      apply({ type: 'point', offset: Math.max(0, fileSize - 1), extend: shift });
      keepCaretInView();
      return;
    }
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveBy(1, shift);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveBy(-1, shift);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveBy(BYTES_PER_ROW, shift);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveBy(-BYTES_PER_ROW, shift);
        break;
      case 'PageDown':
        event.preventDefault();
        moveBy(view * BYTES_PER_ROW, shift);
        break;
      case 'PageUp':
        event.preventDefault();
        moveBy(-view * BYTES_PER_ROW, shift);
        break;
      case 'Enter':
      case ' ':
        if (caret !== null) {
          event.preventDefault();
          onreveal(caret);
        }
        break;
      case 'g':
      case 'G':
        event.preventDefault();
        focusGoto();
        break;
      default:
        break;
    }
  }

  // --- Pointer on the canvas ----------------------------------------------
  function pointFromEvent(event: { clientX: number; clientY: number }): number | null {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return byteAtPoint(
      event.clientX - rect.left,
      event.clientY - rect.top,
      metrics,
      layout,
      scrollRow,
      fileSize,
    );
  }

  let dragging = $state(false);
  function onCanvasPointerdown(event: PointerEvent): void {
    const offset = pointFromEvent(event);
    if (offset === null) return;
    canvas?.setPointerCapture(event.pointerId);
    dragging = true;
    apply({ type: 'point', offset, extend: event.shiftKey });
    if (!event.shiftKey) onreveal(offset);
  }

  function onCanvasPointermove(event: PointerEvent): void {
    if (!dragging) return;
    const offset = pointFromEvent(event);
    if (offset === null) return;
    apply({ type: 'drag', offset });
  }

  function onCanvasPointerup(event: PointerEvent): void {
    if (dragging) {
      dragging = false;
      canvas?.releasePointerCapture(event.pointerId);
    }
  }

  function onCanvasDblclick(event: MouseEvent): void {
    if (!coverage) return;
    const offset = pointFromEvent(event);
    if (offset === null) return;
    const spans = coverage.spansIn(offset, offset + 1);
    let smallest: { start: number; end: number } | null = null;
    for (const span of spans) {
      if (!smallest || span.end - span.start < smallest.end - smallest.start) smallest = span;
    }
    if (!smallest) return;
    apply({ type: 'record', start: smallest.start, end: smallest.end });
    onreveal(offset);
  }

  // --- Scrolling ----------------------------------------------------------
  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const step = event.shiftKey ? view * Math.sign(event.deltaY) : 3 * Math.sign(event.deltaY);
    scrollRow = clampScrollRow(scrollRow + step, total, view);
  }

  let thumbDragging = $state(false);
  let thumbGrabOffset = 0;
  function onThumbPointerdown(event: PointerEvent): void {
    event.preventDefault();
    thumbDragging = true;
    thumbGrabOffset = event.clientY - thumb.thumbTop;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function onThumbPointermove(event: PointerEvent): void {
    if (!thumbDragging) return;
    const top = event.clientY - thumbGrabOffset;
    scrollRow = scrollRowForThumbTop(top, viewportHeight, total, view);
  }
  function onThumbPointerup(event: PointerEvent): void {
    if (!thumbDragging) return;
    thumbDragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }
  function onTrackPointerdown(event: PointerEvent): void {
    if (event.target !== event.currentTarget) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const y = event.clientY - rect.top;
    const dir = y < thumb.thumbTop ? -1 : 1;
    scrollRow = clampScrollRow(scrollRow + dir * view, total, view);
  }

  // --- Collapse + resize --------------------------------------------------
  function toggleCollapsed(): void {
    collapsed = !collapsed;
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
    if (!collapsed) schedulePaint();
  }

  let resizing = $state(false);
  let resizeStartY = 0;
  let resizeStartHeight = 0;
  function resizeBounds(): { min: number; max: number } {
    const min = 44 + 4 * metrics.rowHeight;
    const parentHeight = rootEl?.parentElement?.clientHeight ?? paneHeight / 0.7;
    return { min, max: Math.max(min, 0.7 * parentHeight) };
  }
  function onResizePointerdown(event: PointerEvent): void {
    event.preventDefault();
    resizing = true;
    resizeStartY = event.clientY;
    resizeStartHeight = paneHeight;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function onResizePointermove(event: PointerEvent): void {
    if (!resizing) return;
    const { min, max } = resizeBounds();
    const next = resizeStartHeight - (event.clientY - resizeStartY);
    paneHeight = Math.max(min, Math.min(max, next));
  }
  function onResizePointerup(event: PointerEvent): void {
    if (!resizing) return;
    resizing = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    localStorage.setItem(HEIGHT_KEY, String(Math.round(paneHeight)));
  }
  function onResizeKeydown(event: KeyboardEvent): void {
    const { min, max } = resizeBounds();
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      paneHeight = Math.max(min, Math.min(max, paneHeight + metrics.rowHeight));
      localStorage.setItem(HEIGHT_KEY, String(Math.round(paneHeight)));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      paneHeight = Math.max(min, Math.min(max, paneHeight - metrics.rowHeight));
      localStorage.setItem(HEIGHT_KEY, String(Math.round(paneHeight)));
    }
  }

  // Track viewport height so the canvas fills the pane body.
  $effect(() => {
    const element = viewportEl;
    if (!element) return;
    const update = (): void => {
      viewportHeight = Math.max(metrics.rowHeight, element.clientHeight);
    };
    update();
    if (typeof window.ResizeObserver !== 'function') return;
    const observer = new window.ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  });

  function retryRead(): void {
    readError = false;
    const source = blob;
    if (!source) return;
    cacheCleanup?.();
    const next = new ByteCache(source);
    const unsubscribe = next.subscribe(() => {
      cachePulse += 1;
      schedulePaint();
    });
    cache = next;
    cacheCleanup = () => {
      unsubscribe();
      next.dispose();
    };
  }
</script>

<section
  bind:this={rootEl}
  class="hex-pane"
  class:collapsed
  class:compact
  data-hex-pane
  data-hex-caret={caret ?? ''}
  data-hex-selection={range ? `${range.start}-${range.end}` : ''}
  data-hex-first-row={scrollRow}
  data-hex-provenance={coverageReason}
  data-hex-collapsed={collapsed}
  style:height={collapsed ? 'auto' : `${paneHeight}px`}
>
  {#if !collapsed}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="hex-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize hex view"
      tabindex="0"
      onpointerdown={onResizePointerdown}
      onpointermove={onResizePointermove}
      onpointerup={onResizePointerup}
      onkeydown={onResizeKeydown}
    ></div>
  {/if}

  <div class="hex-toolbar">
    <div class="hex-readout" aria-hidden="true">
      {#if caret !== null}
        <span class="hex-readout-offset">{caretHex}</span>
        {#if caretByte !== null}
          <span class="hex-readout-byte">{caretByteHex} · {caretByte}</span>
        {/if}
      {:else}
        <span class="hex-readout-empty">No byte selected</span>
      {/if}
    </div>

    <div class="hex-goto">
      <input
        bind:this={gotoInput}
        class="hex-goto-input"
        type="text"
        inputmode="text"
        placeholder="0x0"
        aria-label="Go to offset"
        aria-invalid={gotoInvalid}
        onkeydown={onGotoKeydown}
        oninput={onGotoInput}
      />
      {#if gotoInvalid}
        <span class="hex-goto-error" role="alert">Enter an offset like 0x1a or 42</span>
      {/if}
    </div>

    {#if showFilter && range}
      <button
        type="button"
        class="hex-action"
        onclick={() => onfilter(range)}
        aria-label="Filter results to selection"
      >
        Filter to selection
      </button>
    {/if}

    <button
      type="button"
      class="hex-collapse"
      onclick={toggleCollapsed}
      aria-label={collapsed ? 'Expand hex view' : 'Collapse hex view'}
    >
      {collapsed ? '▸' : '▾'}
    </button>
  </div>

  {#if hintText}
    <p class="hex-hint" data-hex-hint>{hintText}</p>
  {/if}

  {#if !collapsed}
    {#if readError}
      <div class="hex-error" role="alert">
        <span>Could not read part of this file — it may have changed on disk.</span>
        <button type="button" onclick={retryRead}>Retry</button>
      </div>
    {/if}

    <div class="hex-body">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="hex-viewport"
        role="application"
        aria-label="Hex viewer"
        tabindex="0"
        bind:this={viewportEl}
        onkeydown={onCanvasKeydown}
        onwheel={onWheel}
      >
        <canvas
          bind:this={canvas}
          class="hex-canvas"
          onpointerdown={onCanvasPointerdown}
          onpointermove={onCanvasPointermove}
          onpointerup={onCanvasPointerup}
          onpointercancel={onCanvasPointerup}
          ondblclick={onCanvasDblclick}
        ></canvas>
      </div>

      <div class="hex-scrollbar" onpointerdown={onTrackPointerdown} role="presentation">
        <div
          class="hex-scrollbar-thumb"
          role="presentation"
          style:height={`${thumb.thumbPx}px`}
          style:transform={`translateY(${thumb.thumbTop}px)`}
          onpointerdown={onThumbPointerdown}
          onpointermove={onThumbPointermove}
          onpointerup={onThumbPointerup}
          onpointercancel={onThumbPointerup}
        ></div>
      </div>
    </div>
  {/if}

  <div class="visually-hidden" aria-live="polite">{announcement}</div>
</section>
