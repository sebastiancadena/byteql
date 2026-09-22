<script lang="ts">
  /* global Blob, CSSStyleDeclaration, HTMLCanvasElement, HTMLDivElement, HTMLElement,
     HTMLInputElement, HTMLSelectElement, KeyboardEvent, MouseEvent, PointerEvent, WheelEvent,
     getComputedStyle, localStorage, navigator, requestAnimationFrame, setTimeout, clearTimeout, window */
  import { untrack } from 'svelte';

  import { ByteCache, COPY_LIMIT_BYTES } from '../lib/hex/byte-cache.js';
  import type { CoverageIndex, CoverageReason } from '../lib/hex/coverage.js';
  import { measureHexFont } from '../lib/hex/font.js';
  import { parseOffsetInput } from '../lib/hex/goto.js';
  import {
    BYTES_PER_ROW,
    byteAtPoint,
    clampScrollRow,
    columnLayout,
    hexByteX,
    offsetDigits,
    paneResizeBounds,
    rowsInView,
    scrollRowForThumbTop,
    thumbGeometry,
    totalRows,
    type HexMetrics,
  } from '../lib/hex/layout.js';
  import { drawHexFrame, type CanvasTextContext, type HexColors } from '../lib/hex/render.js';
  import type { Theme } from '../lib/ui/theme.js';
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
    highlight: { start: number; end: number; ranges: readonly { start: number; end: number }[] } | null;
    filterAvailable: boolean;
    /** Changes when a new result arrives; the pane clears its local selection to follow it. */
    resetKey?: unknown;
    compact?: boolean;
    /**
     * `embedded` hands height, collapse and the resize separator to the parent dock: the pane
     * fills its container and touches neither the geometry preferences nor a resize observer.
     */
    layout?: 'standalone' | 'embedded';
    /** Embedded visibility, owned by the parent. Ignored while standalone. */
    visible?: boolean;
    /** Observed only to schedule a repaint; the canvas reads its colors from CSS tokens. */
    appearance?: Theme;
    files?: readonly { name: string; size: number }[];
    currentFile?: string | null;
    onreveal: (offset: number) => void;
    onselectionchange: (range: { start: number; end: number } | null) => void;
    onfilter: (range: { start: number; end: number }) => void;
    onfilechange?: (file: string) => void;
    /**
     * Every vertical pixel of the pane that is NOT drawing surface: the `.hex-chrome` border box,
     * the pane's own border, and the viewport's horizontal scrollbar. It is not the pane height.
     * The parent's layout coordinator budgets hex rows against exactly this number.
     */
    onchromeheightchange?: (height: number) => void;
  }

  let {
    blob,
    fileSize,
    coverage,
    coverageReason,
    highlight,
    filterAvailable,
    resetKey,
    compact = false,
    layout = 'standalone',
    visible = true,
    appearance = 'light',
    files = [],
    currentFile = null,
    onreveal,
    onselectionchange,
    onfilter,
    onfilechange = () => undefined,
    onchromeheightchange,
  }: Props = $props();

  const COLLAPSED_KEY = 'byteql.hexpane.collapsed';
  const HEIGHT_KEY = 'byteql.hexpane.height';
  const HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, '0'));
  /**
   * A hostile reassembled capture can carry ~1M pieces; bound the serialized
   * `data-hex-highlight-ranges` test hook to the first N so a huge highlight never does
   * per-piece string work proportional to the whole list. e2e only ever reads the first couple
   * of pieces, so this stays well above anything a test needs.
   */
  const MAX_HIGHLIGHT_RANGE_ATTR_PIECES = 64;

  /** Measured from the mounted element's own `--font-mono`, so hit testing matches what is painted. */
  const FALLBACK_FONT = { fontSpec: '12px monospace', charWidth: 7.2 };
  let hexFont = $state(FALLBACK_FONT);

  function measureFont(element: HTMLElement): void {
    const family = getComputedStyle(element).getPropertyValue('--font-mono').trim() || 'monospace';
    const context = window.document.createElement('canvas').getContext('2d');
    hexFont = context ? measureHexFont(context, family) : { fontSpec: `12px ${family}`, charWidth: 7.2 };
  }

  // Fixed for the life of the instance: the geometry preferences below are read once at
  // construction, so a mid-life switch between modes is not a supported transition.
  const embedded = untrack(() => layout === 'embedded');

  /**
   * Also fixed for the life of the instance: a parent either budgets against this pane's chrome
   * or it does not, and reading it once keeps an inline callback from rebuilding the observer.
   */
  const reportChromeTo = untrack(() => onchromeheightchange);

  /** Embedded, the parent dock owns these preferences; the pane must not read or write them. */
  function readGeometryPreference(key: string): string | null {
    if (embedded) return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeGeometryPreference(key: string, value: string): void {
    if (embedded) return;
    try {
      localStorage.setItem(key, value);
    } catch {
      // Geometry preferences are optional.
    }
  }

  const storedCollapsed = readGeometryPreference(COLLAPSED_KEY);
  const storedHeight = Number(readGeometryPreference(HEIGHT_KEY));

  let canvas = $state<HTMLCanvasElement | null>(null);
  let viewportEl = $state<HTMLDivElement | null>(null);
  let chromeEl = $state<HTMLDivElement | null>(null);
  let gotoInput = $state<HTMLInputElement | null>(null);
  let rootEl = $state<HTMLElement | null>(null);
  let cache = $state<ByteCache | null>(null);
  let scrollRow = $state(0);
  let selection = $state<HexSelection | null>(null);
  let gotoInvalid = $state(false);
  let readError = $state(false);
  let flashRow = $state<number | null>(null);
  let collapsed = $state(untrack(() => storedCollapsed === 'true' || (storedCollapsed === null && compact)));
  /** Index into `highlight.ranges` for the range readout and `[`/`]` navigation. */
  let rangeIndex = $state(0);
  let paneHeight = $state(storedHeight > 0 ? storedHeight : 260);
  /** Embedded, visibility comes from the parent; standalone, from the pane's own toggle. */
  const hidden = $derived(embedded ? !visible : collapsed);
  let viewportHeight = $state(200);
  let cachePulse = $state(0);

  const reducedMotion =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const metrics = $derived<HexMetrics>({
    charWidth: hexFont.charWidth,
    rowHeight: 18,
    gutterDigits: offsetDigits(fileSize),
    padding: 12,
  });
  const columns = $derived(columnLayout(metrics));
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

  const contentBytes = $derived(
    highlight ? highlight.ranges.reduce((sum, r) => sum + r.end - r.start, 0) : 0,
  );

  const showFilter = $derived(filterAvailable && range !== null && coverageReason === 'ok');
  const hintText = $derived.by(() => {
    if (coverageReason === 'no-provenance')
      return 'No byte provenance in this result — browse a table to link bytes to rows.';
    if (coverageReason === 'ambiguous-provenance')
      return 'Byte provenance is ambiguous because source columns are repeated.';
    if (coverageReason === 'too-large') return 'Result too large to index — shading and reveal are off.';
    return '';
  });

  const thumb = $derived(thumbGeometry(viewportHeight, total, view, scrollRow));

  // Cache lifecycle: rebuild only when the blob REFERENCE actually changes. Guarding on identity
  // keeps a same-blob re-render (e.g. a new result on the same source file) from tearing down the
  // cache and wiping scroll/selection — selection reset on new results is owned by `resetKey`.
  let cacheCleanup: (() => void) | null = null;
  let activeBlobRef: Blob | null | undefined;
  let blobInitialized = false;
  $effect(() => {
    const current = blob;
    untrack(() => {
      if (blobInitialized && current === activeBlobRef) return;
      blobInitialized = true;
      activeBlobRef = current;
      cacheCleanup?.();
      cacheCleanup = null;
      scrollRow = 0;
      selection = null;
      readError = false;
      flashRow = null;
      // A new source starts at the first column, exactly as it starts at the first row. Ordinary
      // resizing, hiding, appearance and tab changes leave the horizontal scroll alone.
      byteScrollLeft = 0;
      if (viewportEl) viewportEl.scrollLeft = 0;
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
      cacheCleanup = () => {
        unsubscribe();
        next.dispose();
      };
    });
  });
  // Dispose the cache once, on unmount (no reactive reads → cleanup runs only on destroy).
  $effect(() => () => {
    cacheCleanup?.();
    cacheCleanup = null;
  });

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
    void hidden;
    void cachePulse;
    // An appearance change only repaints: reveal/reset APIs would move scroll, caret or selection.
    void appearance;
    schedulePaint();
  });

  // Measure once the element has computed styles, so `--font-mono` reflects the loaded faces.
  $effect(() => {
    const element = rootEl;
    if (element) untrack(() => measureFont(element));
  });

  // A new result (resetKey reference change) already cleared byteSelection in state; the pane
  // follows by clearing its LOCAL selection + caret. Skip onselectionchange — state is already
  // null, so a callback here would be a redundant dispatch. Blob change handles its own reset.
  let lastResetKey: unknown;
  let resetKeyInitialized = false;
  $effect(() => {
    const key = resetKey;
    untrack(() => {
      if (!resetKeyInitialized) {
        resetKeyInitialized = true;
        lastResetKey = key;
        return;
      }
      if (key === lastResetKey) return;
      lastResetKey = key;
      selection = null;
      copyStatus = '';
    });
  });

  /** Value equality for the highlight prop, including every piece of `ranges`. */
  function sameHighlight(
    a: { start: number; end: number; ranges: readonly { start: number; end: number }[] } | null,
    b: typeof a,
  ): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (a.start !== b.start || a.end !== b.end || a.ranges.length !== b.ranges.length) return false;
    return a.ranges.every((piece, i) => piece.start === b.ranges[i]!.start && piece.end === b.ranges[i]!.end);
  }

  // React to a new highlight prop: scroll it into view + flash. Compare by VALUE — Workbench
  // recomputes a derived per publish, so a reference guard would re-flash and re-center on every
  // caret move, fighting user navigation.
  let lastHighlight: {
    start: number;
    end: number;
    ranges: readonly { start: number; end: number }[];
  } | null = null;
  $effect(() => {
    const next = highlight;
    if (sameHighlight(next, lastHighlight)) return;
    lastHighlight = next;
    rangeIndex = 0;
    if (next) untrack(() => revealTo(next.start, false));
  });

  /** Step to the previous (-1) or next (1) piece of the current highlight; clamps, no wrap. */
  function stepRange(delta: -1 | 1): void {
    const ranges = highlight?.ranges ?? [];
    if (ranges.length < 2) return;
    const next = Math.min(ranges.length - 1, Math.max(0, rangeIndex + delta));
    if (next === rangeIndex) return;
    rangeIndex = next;
    revealTo(ranges[next]!.start, false);
  }

  let paintHandle = 0;
  function schedulePaint(): void {
    if (paintHandle) return;
    paintHandle = requestAnimationFrame(() => {
      paintHandle = 0;
      paint();
    });
  }

  /** Canvas needs a resolved color: a `var(...)` token string paints nothing. */
  function readColor(style: CSSStyleDeclaration, name: string): string {
    let value = style.getPropertyValue(name).trim();
    for (let hops = 0; hops < 4; hops += 1) {
      const alias = /^var\(\s*(--[\w-]+)\s*\)$/u.exec(value);
      if (!alias?.[1]) break;
      value = style.getPropertyValue(alias[1]).trim();
    }
    return value.startsWith('var(') ? '' : value;
  }

  function paint(): void {
    if (!canvas || hidden) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const cssWidth = columns.width;
    const cssHeight = viewportHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    // The canvas only just took its width, so this is the first moment a restored horizontal
    // scroll can land on a real scroll range. It clamps naturally against the current width.
    if (restoreScrollLeft && viewportEl) {
      restoreScrollLeft = false;
      viewportEl.scrollLeft = byteScrollLeft;
    }

    const style = getComputedStyle(canvas);
    const colors: HexColors = {
      background: readColor(style, '--color-surface-inset') || '#eeede5',
      gutter: readColor(style, '--color-text-subtle') || '#596152',
      text: readColor(style, '--color-text') || '#222820',
      ascii: readColor(style, '--color-text-muted') || '#50594d',
      shadeA: readColor(style, '--color-shade-a'),
      shadeB: readColor(style, '--color-shade-b'),
      selection: readColor(style, '--color-hex-selection') || '#cbdfea',
      highlight: readColor(style, '--color-hex-highlight'),
      gap: readColor(style, '--color-hex-gap'),
      caret: readColor(style, '--color-focus') || '#215b86',
      placeholder: readColor(style, '--color-hex-placeholder'),
    };
    const viewStart = scrollRow * BYTES_PER_ROW;
    const viewEnd = (scrollRow + view + 1) * BYTES_PER_ROW;
    const activeCache = cache;

    drawHexFrame(context as unknown as CanvasTextContext, {
      widthPx: cssWidth,
      heightPx: cssHeight,
      firstRow: scrollRow,
      fileSize,
      metrics,
      layout: columns,
      colors,
      fontSpec: hexFont.fontSpec,
      byteAt: (offset) => activeCache?.byteAt(offset) ?? null,
      shading: coverage?.spansIn(viewStart, viewEnd) ?? [],
      selection: range,
      highlight,
      caret,
    });

    if (flashRow !== null) {
      const bandY = (flashRow - scrollRow) * metrics.rowHeight;
      if (bandY >= -metrics.rowHeight && bandY < cssHeight) {
        // Translucent: the flash marks the revealed row without hiding the bytes on it.
        context.save();
        context.globalAlpha = 0.4;
        context.fillStyle = readColor(style, '--color-hex-highlight') || '#f1d99f';
        context.fillRect(0, bandY, cssWidth, metrics.rowHeight);
        context.restore();
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
    keepCaretHorizontallyVisible(offset);
    flash(row);
  }

  function keepCaretInView(): void {
    if (caret === null) return;
    const row = rowOf(caret);
    if (row < scrollRow) scrollRow = clampScrollRow(row, total, view);
    else if (row >= scrollRow + view) scrollRow = clampScrollRow(row - view + 1, total, view);
  }

  /**
   * Scrolls the narrow viewport just far enough to expose one byte's hex cell. Called only from
   * explicit navigation — caret movement, goto and reveal — never from a paint or a resize, so an
   * ordinary resize keeps the scroll and the selection the user left behind. While the pane is
   * hidden there is no viewport to scroll, and exposure waits for the reveal/focus path to open it.
   */
  function keepCaretHorizontallyVisible(offset: number): void {
    if (!viewportEl) return;
    const left = hexByteX(metrics, columns, offset % BYTES_PER_ROW);
    const right = left + 2 * metrics.charWidth;
    if (left < viewportEl.scrollLeft) viewportEl.scrollLeft = left;
    else if (right > viewportEl.scrollLeft + viewportEl.clientWidth) {
      viewportEl.scrollLeft = right - viewportEl.clientWidth;
    }
  }

  /** Explicit navigation: put the caret's row AND its hex cell in view. */
  function keepCaretVisible(): void {
    keepCaretInView();
    if (caret !== null) keepCaretHorizontallyVisible(caret);
  }

  /** Apply a selection action and emit the range change. */
  function apply(action: SelectionAction): void {
    copyStatus = '';
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

  /** Explicit source inspection: revealRange only scrolls, it does not move focus. */
  export function focusViewport(): void {
    viewportEl?.focus();
  }

  // --- Keyboard on the canvas host ----------------------------------------
  function moveBy(delta: number, extend: boolean): void {
    if (selection === null) apply({ type: 'point', offset: 0, extend: false });
    else apply({ type: 'move', delta, extend, fileSize });
    keepCaretVisible();
  }

  let copyStatus = $state('');
  async function copySelection(): Promise<void> {
    if (!blob || !range) return;
    if (range.end - range.start > COPY_LIMIT_BYTES) {
      copyStatus = 'Selection too large to copy (limit 1 MiB)';
      return;
    }
    // Read directly from the blob, bypassing the LRU cache (which would zero-fill a range
    // wider than its budget mid-copy). Within COPY_LIMIT_BYTES this is a single small slice.
    const buffer = await blob.slice(range.start, range.end).arrayBuffer();
    const text = Array.from(new Uint8Array(buffer), (b) => HEX[b]).join(' ');
    await navigator.clipboard?.writeText(text);
    copyStatus = '';
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
      keepCaretVisible();
      return;
    }
    if (mod && event.key === 'End') {
      event.preventDefault();
      apply({ type: 'point', offset: Math.max(0, fileSize - 1), extend: shift });
      keepCaretVisible();
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
      case '[':
        event.preventDefault();
        stepRange(-1);
        break;
      case ']':
        event.preventDefault();
        stepRange(1);
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
      columns,
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
    // spansIn clips to its window (degenerating to one byte here); rangeAt is unclipped.
    const record = coverage.rangeAt(offset);
    if (!record) return;
    apply({ type: 'record', start: record.start, end: record.end });
    onreveal(offset);
  }

  // --- Scrolling ----------------------------------------------------------
  /**
   * The viewport's horizontal scroll, held in component state so a viewport that is unmounted
   * (collapsed dock, tab switch) and mounted again comes back where the user left it. The native
   * scroll event is the single writer, so a programmatic scroll updates it too.
   */
  let byteScrollLeft = 0;
  let restoreScrollLeft = false;

  function onViewportScroll(): void {
    if (viewportEl) byteScrollLeft = viewportEl.scrollLeft;
  }

  // Re-arm restoration whenever the conditionally rendered viewport is created again.
  $effect(() => {
    if (!viewportEl) return;
    restoreScrollLeft = true;
    schedulePaint();
  });

  /** Wheel delta for a horizontal gesture: a dominant deltaX, or Shift over the vertical axis. */
  function horizontalWheelDelta(event: WheelEvent): number {
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return event.deltaX;
    return event.shiftKey ? event.deltaY : 0;
  }

  function onWheel(event: WheelEvent): void {
    const element = viewportEl;
    const sideways = horizontalWheelDelta(event);
    if (sideways !== 0) {
      const maxScroll = element ? element.scrollWidth - element.clientWidth : 0;
      // Nothing to scroll sideways: leave the gesture to the page, and move no byte rows for it.
      if (!element || maxScroll <= 0) return;
      // deltaMode: 0 pixels, 1 lines (one byte row), 2 pages (one viewport width).
      const unit =
        event.deltaMode === 1 ? metrics.rowHeight : event.deltaMode === 2 ? element.clientWidth : 1;
      event.preventDefault();
      element.scrollLeft = Math.max(0, Math.min(maxScroll, element.scrollLeft + sideways * unit));
      return;
    }
    event.preventDefault();
    scrollRow = clampScrollRow(scrollRow + 3 * Math.sign(event.deltaY), total, view);
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
    writeGeometryPreference(COLLAPSED_KEY, String(collapsed));
    if (!collapsed) schedulePaint();
  }

  let resizing = $state(false);
  let resizeStartY = 0;
  let resizeStartHeight = 0;
  // The workspace grid gives the pane a fixed (auto) row and lets the row directly
  // above — the results panel, always the pane's previous sibling — flex. Growing is
  // therefore bounded by the slack that sibling can still yield, measured live.
  function resizeBounds(): { min: number; max: number } {
    const parent = rootEl?.parentElement;
    const flexRow = rootEl?.previousElementSibling;
    const remPx = Number.parseFloat(getComputedStyle(window.document.documentElement).fontSize) || 16;
    return paneResizeBounds({
      paneHeight,
      rowHeight: metrics.rowHeight,
      flexHeight: flexRow ? flexRow.clientHeight : null,
      flexMinPx: 8 * remPx, // keep in sync with the workspace's minmax(8rem, 1fr) row
      overflowPx: parent ? parent.scrollHeight - parent.clientHeight : 0,
    });
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
    writeGeometryPreference(HEIGHT_KEY, String(Math.round(paneHeight)));
  }
  function onResizeKeydown(event: KeyboardEvent): void {
    const { min, max } = resizeBounds();
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      paneHeight = Math.max(min, Math.min(max, paneHeight + metrics.rowHeight));
      writeGeometryPreference(HEIGHT_KEY, String(Math.round(paneHeight)));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      paneHeight = Math.max(min, Math.min(max, paneHeight - metrics.rowHeight));
      writeGeometryPreference(HEIGHT_KEY, String(Math.round(paneHeight)));
    }
  }

  // Clamp the pane back into the workspace when it shrinks (window resize, or an
  // oversized stored height on first layout — the observer fires once on observe).
  $effect(() => {
    const parent = rootEl?.parentElement;
    // Embedded, the dock clamps its own height; observing here would fight it.
    if (embedded || !parent || collapsed) return;
    if (typeof window.ResizeObserver !== 'function') return;
    const observer = new window.ResizeObserver(() => {
      const { min, max } = resizeBounds();
      if (paneHeight > max) paneHeight = Math.max(min, max);
    });
    observer.observe(parent);
    return () => observer.disconnect();
  });

  /**
   * Reports every vertical pixel of this pane that cannot hold a byte row: the chrome wrapper's
   * border box, the pane's own border, and the thickness of the viewport's horizontal scrollbar
   * (the viewport itself has no border, so that difference is the scrollbar). Never the whole
   * pane height — the parent owns that.
   */
  let reportedChrome = 0;
  function reportChromeHeight(): void {
    if (!reportChromeTo) return;
    const chrome = chromeEl?.offsetHeight ?? 0;
    const border = rootEl ? rootEl.offsetHeight - rootEl.clientHeight : 0;
    const scrollbar = viewportEl ? viewportEl.offsetHeight - viewportEl.clientHeight : 0;
    const height = chrome + border + scrollbar;
    // A pane that is not laid out reports nothing rather than a zero the parent would budget for.
    if (height <= 0 || height === reportedChrome) return;
    reportedChrome = height;
    reportChromeTo(height);
  }

  // One observer across the chrome wrapper and the viewport: the toolbar wraps, the hint and the
  // read-error row come and go, and the horizontal scrollbar appears and disappears with width.
  $effect(() => {
    const chrome = chromeEl;
    const viewport = viewportEl;
    if (!reportChromeTo) return;
    untrack(reportChromeHeight);
    if (typeof window.ResizeObserver !== 'function') return;
    const observer = new window.ResizeObserver(() => reportChromeHeight());
    if (chrome) observer.observe(chrome);
    if (viewport) observer.observe(viewport);
    return () => observer.disconnect();
  });

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
  class:collapsed={hidden}
  class:compact
  class:embedded
  data-hex-pane
  data-hex-layout={layout}
  data-hex-caret={caret ?? ''}
  data-hex-selection={range ? `${range.start}-${range.end}` : ''}
  data-hex-highlight={highlight ? `${highlight.start}-${highlight.end}` : ''}
  data-hex-highlight-ranges={highlight
    ? highlight.ranges
        .slice(0, MAX_HIGHLIGHT_RANGE_ATTR_PIECES)
        .map((r) => `${r.start}-${r.end}`)
        .join(',')
    : ''}
  data-hex-range-index={highlight && highlight.ranges.length > 1 ? rangeIndex : ''}
  data-hex-first-row={scrollRow}
  data-hex-provenance={coverageReason}
  data-hex-collapsed={hidden}
  style:height={embedded ? undefined : collapsed ? 'auto' : `${paneHeight}px`}
>
  {#if !embedded && !collapsed}
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

  <div bind:this={chromeEl} class="hex-chrome">
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

      {#if files.length > 1}
        <select
          class="hex-file-switcher"
          aria-label="Hex file"
          value={currentFile ?? ''}
          onchange={(event) => onfilechange((event.currentTarget as HTMLSelectElement).value)}
        >
          {#each files as file (file.name)}
            <option value={file.name}>{file.name}</option>
          {/each}
        </select>
      {/if}

      {#if highlight && highlight.ranges.length > 1}
        <span class="hex-range-readout" aria-live="polite">
          Range {rangeIndex + 1} of {highlight.ranges.length} ·
          {contentBytes.toLocaleString()} of {(highlight.end - highlight.start).toLocaleString()} bytes in span
        </span>
        <button
          type="button"
          class="hex-action"
          aria-label="Previous source range"
          disabled={rangeIndex === 0}
          onclick={() => stepRange(-1)}
        >
          ‹
        </button>
        <button
          type="button"
          class="hex-action"
          aria-label="Next source range"
          disabled={rangeIndex === highlight.ranges.length - 1}
          onclick={() => stepRange(1)}
        >
          ›
        </button>
      {/if}

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

      {#if !embedded}
        <button
          type="button"
          class="hex-collapse"
          onclick={toggleCollapsed}
          aria-label={collapsed ? 'Expand hex view' : 'Collapse hex view'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      {/if}
    </div>

    {#if hintText}
      <p class="hex-hint" data-hex-hint>{hintText}</p>
    {/if}

    {#if !hidden && readError}
      <div class="hex-error" role="alert">
        <span>Could not read part of this file — it may have changed on disk.</span>
        <button type="button" onclick={retryRead}>Retry</button>
      </div>
    {/if}
  </div>

  {#if !hidden}
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
        onscroll={onViewportScroll}
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

      <div
        class="hex-scrollbar"
        style:height={`${viewportHeight}px`}
        onpointerdown={onTrackPointerdown}
        role="presentation"
      >
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

  <div class="visually-hidden" aria-live="polite">{copyStatus || announcement}</div>
</section>
