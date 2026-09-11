// @vitest-environment jsdom
// apps/web/src/components/HexPane.test.ts
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoverageIndex } from '../lib/hex/coverage.js';
import { asciiByteX, columnLayout, hexByteX, offsetDigits, type HexMetrics } from '../lib/hex/layout.js';
import HexPane from './HexPane.svelte';

/** jsdom exposes no 2D context, so the pane uses its documented 7.2 px fallback advance width. */
const paneMetrics: HexMetrics = {
  charWidth: 7.2,
  rowHeight: 18,
  gutterDigits: offsetDigits(64),
  padding: 12,
};
const paneLayout = columnLayout(paneMetrics);

/** A coverage stub whose rangeAt always returns one fixed record. */
function fixedCoverage(record: { start: number; end: number }): CoverageIndex {
  return {
    rowCount: 1,
    rowsAt: () => [],
    rangeAt: () => record,
    spansIn: () => [],
  };
}

const blob = new Blob([new Uint8Array(64).map((_, i) => i)]);

function renderPane(overrides: Record<string, unknown> = {}) {
  return render(HexPane, {
    props: {
      blob,
      fileSize: 64,
      coverage: null,
      coverageReason: 'no-provenance',
      highlight: null,
      filterAvailable: false,
      onreveal: vi.fn(),
      onselectionchange: vi.fn(),
      onfilter: vi.fn(),
      ...overrides,
    },
  });
}

describe('HexPane', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('renders the pane with provenance status and no caret', () => {
    const { container } = renderPane();
    const root = container.querySelector('[data-hex-pane]');
    expect(root?.getAttribute('data-hex-provenance')).toBe('no-provenance');
    expect(root?.getAttribute('data-hex-caret')).toBe('');
    expect(root?.textContent).toContain('No byte provenance in this result');
  });

  it('exposes the grid-row highlight range on data-hex-highlight', () => {
    const { container } = renderPane({ highlight: { start: 12, end: 20 } });
    const root = container.querySelector('[data-hex-pane]');
    // The grid->hex link surfaces as `highlight`, distinct from the pane's own selection; e2e
    // reads this attribute to learn which bytes a row lit up. Absent a highlight it is empty.
    expect(root?.getAttribute('data-hex-highlight')).toBe('12-20');
    expect(root?.getAttribute('data-hex-selection')).toBe('');
  });

  it('leaves data-hex-highlight empty when no row is selected', () => {
    const { container } = renderPane();
    expect(container.querySelector('[data-hex-pane]')?.getAttribute('data-hex-highlight')).toBe('');
  });

  it('jumps and sets the caret through the goto input', async () => {
    const user = userEvent.setup();
    const { container, getByLabelText } = renderPane();
    await user.type(getByLabelText('Go to offset'), '0x10{Enter}');
    const root = container.querySelector('[data-hex-pane]');
    expect(root?.getAttribute('data-hex-caret')).toBe('16');
  });

  it('flags invalid goto input instead of jumping', async () => {
    const user = userEvent.setup();
    const { container, getByLabelText } = renderPane();
    await user.type(getByLabelText('Go to offset'), 'wat{Enter}');
    expect(getByLabelText('Go to offset').getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[data-hex-pane]')?.getAttribute('data-hex-caret')).toBe('');
  });

  it('moves the caret with arrows and reveals with Enter', async () => {
    const user = userEvent.setup();
    const onreveal = vi.fn();
    const { container, getByLabelText, getByRole } = renderPane({ onreveal });
    await user.type(getByLabelText('Go to offset'), '0{Enter}');
    const canvasHost = getByRole('application', { name: 'Hex viewer' });
    canvasHost.focus();
    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(container.querySelector('[data-hex-pane]')?.getAttribute('data-hex-caret')).toBe('17');
    await user.keyboard('{Enter}');
    expect(onreveal).toHaveBeenCalledWith(17);
  });

  it('reports selection changes end-exclusively', async () => {
    const user = userEvent.setup();
    const onselectionchange = vi.fn();
    const { getByLabelText, getByRole } = renderPane({ onselectionchange });
    await user.type(getByLabelText('Go to offset'), '4{Enter}');
    getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}');
    expect(onselectionchange).toHaveBeenLastCalledWith({ start: 4, end: 7 });
  });

  it('shows the filter action only when available and a selection exists', async () => {
    const user = userEvent.setup();
    const onfilter = vi.fn();
    const { getByLabelText, getByRole, queryByRole } = renderPane({
      filterAvailable: true,
      coverageReason: 'ok',
      onfilter,
    });
    expect(queryByRole('button', { name: 'Filter results to selection' })).toBeNull();
    await user.type(getByLabelText('Go to offset'), '4{Enter}');
    getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await user.click(getByRole('button', { name: 'Filter results to selection' }));
    expect(onfilter).toHaveBeenCalledWith({ start: 4, end: 6 });
  });

  it('double-click records the full covering interval via rangeAt, not a clipped byte', async () => {
    // jsdom canvas rects are zero-origin, so client coords pass straight through byteAtPoint.
    // Derive the ascii column from the layout helpers rather than assuming a font's advance width.
    const onreveal = vi.fn();
    const onselectionchange = vi.fn();
    const { container } = renderPane({
      coverage: fixedCoverage({ start: 2, end: 9 }),
      coverageReason: 'ok',
      onreveal,
      onselectionchange,
    });
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    // Ascii column, byte index 0 of row 0 → offset 0; the coverage stub records [2, 9).
    await fireEvent.dblClick(canvas, { clientX: asciiByteX(paneMetrics, paneLayout, 0) + 1, clientY: 5 });
    const root = container.querySelector('[data-hex-pane]');
    expect(root?.getAttribute('data-hex-selection')).toBe('2-9');
    expect(onselectionchange).toHaveBeenLastCalledWith({ start: 2, end: 9 });
    expect(onreveal).toHaveBeenCalledWith(0);
  });

  it('ignores an equal-but-new highlight object so it does not re-center after the user scrolls', async () => {
    const user = userEvent.setup();
    const bigBlob = new Blob([new Uint8Array(4096)]);
    const { container, getByLabelText, rerender } = renderPane({
      blob: bigBlob,
      fileSize: 4096,
      highlight: { start: 1600, end: 1610 },
    });
    const root = container.querySelector('[data-hex-pane]');
    // The initial highlight scrolls its row (100) into view.
    await vi.waitFor(() => expect(Number(root?.getAttribute('data-hex-first-row'))).toBeGreaterThan(0));

    // User navigates away to the top.
    await user.type(getByLabelText('Go to offset'), '0x0{Enter}');
    expect(root?.getAttribute('data-hex-first-row')).toBe('0');

    // A fresh object with the SAME range must be treated as a no-op (value equality).
    await rerender({ highlight: { start: 1600, end: 1610 } });
    expect(root?.getAttribute('data-hex-first-row')).toBe('0');
  });

  it('refuses to copy a selection wider than the 1 MiB limit and announces it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container, getByLabelText, getByRole } = renderPane({ fileSize: 2_000_000 });
    await user.type(getByLabelText('Go to offset'), '0{Enter}');
    getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Control>}{Shift>}{End}{/Shift}{/Control}'); // select [0, fileSize)
    await user.keyboard('{Control>}c{/Control}');

    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('too large to copy');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies a within-limit selection by reading the blob directly', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const sliceSpy = vi.fn((s: number, e: number) => ({
      arrayBuffer: async () => bytes.slice(s, e).buffer,
    }));
    const fakeBlob = { size: 8, slice: sliceSpy } as unknown as Blob;
    const { getByLabelText, getByRole } = renderPane({ blob: fakeBlob, fileSize: 8 });
    await user.type(getByLabelText('Go to offset'), '0{Enter}');
    getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}'); // select [0, 2)
    await user.keyboard('{Control>}c{/Control}');

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('00 01'));
    // Direct blob read for the copied range — never routed through the cache page fetch.
    expect(sliceSpy).toHaveBeenCalledWith(0, 2);
  });

  it('clears its local selection when resetKey changes, with no spurious callback', async () => {
    const user = userEvent.setup();
    const onselectionchange = vi.fn();
    const { container, getByLabelText, getByRole, rerender } = renderPane({
      resetKey: { id: 1 },
      onselectionchange,
    });
    await user.type(getByLabelText('Go to offset'), '4{Enter}');
    getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    const root = container.querySelector('[data-hex-pane]');
    expect(root?.getAttribute('data-hex-selection')).toBe('4-6');
    const callsBefore = onselectionchange.mock.calls.length;

    // A new result arrives (state already cleared byteSelection); the pane must follow.
    await rerender({ resetKey: { id: 2 }, onselectionchange });
    expect(root?.getAttribute('data-hex-selection')).toBe('');
    expect(root?.getAttribute('data-hex-caret')).toBe('');
    expect(onselectionchange.mock.calls.length).toBe(callsBefore); // no redundant null dispatch
  });

  it('renders a file switcher only for multi-file sessions and emits changes', async () => {
    const onfilechange = vi.fn();
    const { getByLabelText } = renderPane({
      files: [
        { name: 'a.pcap', size: 8 },
        { name: 'b.pcap', size: 8 },
      ],
      currentFile: 'a.pcap',
      onfilechange,
    });
    const select = getByLabelText('Hex file') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['a.pcap', 'b.pcap']);
    await fireEvent.change(select, { target: { value: 'b.pcap' } });
    expect(onfilechange).toHaveBeenCalledWith('b.pcap');
  });

  it('hides the switcher for single-file sessions', () => {
    const { queryByLabelText } = renderPane({
      files: [{ name: 'a.pcap', size: 8 }],
      currentFile: 'a.pcap',
    });
    expect(queryByLabelText('Hex file')).toBeNull();
  });

  it('collapses to the toolbar strip and persists the flag', async () => {
    const user = userEvent.setup();
    const { container, getByRole } = renderPane();
    await user.click(getByRole('button', { name: 'Collapse hex view' }));
    expect(container.querySelector('[data-hex-pane]')?.getAttribute('data-hex-collapsed')).toBe('true');
    expect(localStorage.getItem('byteql.hexpane.collapsed')).toBe('true');
  });
});

describe('HexPane embedded in the inspection dock', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  const renderEmbedded = (overrides: Record<string, unknown> = {}) =>
    renderPane({ layout: 'embedded', visible: true, ...overrides });

  it('hands its geometry chrome to the parent dock', () => {
    const { container, queryByRole } = renderEmbedded();

    // The dock owns the separator and the collapse control; the pane offers neither.
    expect(queryByRole('separator', { name: 'Resize hex view' })).toBeNull();
    expect(queryByRole('button', { name: 'Collapse hex view' })).toBeNull();
    expect(queryByRole('button', { name: 'Expand hex view' })).toBeNull();

    const root = container.querySelector<HTMLElement>('[data-hex-pane]')!;
    expect(root.getAttribute('data-hex-layout')).toBe('embedded');
    // No fixed height of its own: it fills whatever the dock gives it.
    expect(root.style.height).toBe('');
  });

  it('does not read or write the standalone geometry preferences', async () => {
    localStorage.setItem('byteql.hexpane.collapsed', 'true');
    localStorage.setItem('byteql.hexpane.height', '999');
    const user = userEvent.setup();

    const { container, getByLabelText } = renderEmbedded();
    const root = container.querySelector('[data-hex-pane]')!;
    // A stored standalone collapse flag must not hide an embedded pane the dock is showing.
    expect(root.getAttribute('data-hex-collapsed')).toBe('false');

    await user.type(getByLabelText('Go to offset'), '0x10{Enter}');
    expect(localStorage.getItem('byteql.hexpane.collapsed')).toBe('true');
    expect(localStorage.getItem('byteql.hexpane.height')).toBe('999');
  });

  it('follows the parent visibility instead of its own collapse state', async () => {
    const { container, rerender } = renderEmbedded({ visible: false });
    const root = container.querySelector('[data-hex-pane]')!;
    expect(root.getAttribute('data-hex-collapsed')).toBe('true');

    await rerender({ layout: 'embedded', visible: true });
    expect(root.getAttribute('data-hex-collapsed')).toBe('false');
  });

  it('keeps caret and selection across a hide and show', async () => {
    const user = userEvent.setup();
    const { container, getByLabelText, getByRole, rerender } = renderEmbedded();

    await user.type(getByLabelText('Go to offset'), '4{Enter}');
    getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');

    const root = container.querySelector('[data-hex-pane]')!;
    expect(root.getAttribute('data-hex-caret')).toBe('5');
    expect(root.getAttribute('data-hex-selection')).toBe('4-6');

    await rerender({ layout: 'embedded', visible: false });
    await rerender({ layout: 'embedded', visible: true });

    // Hiding a tab must not reset what the user selected.
    expect(root.getAttribute('data-hex-caret')).toBe('5');
    expect(root.getAttribute('data-hex-selection')).toBe('4-6');
  });
});

/**
 * Narrow-pane behaviour: the pane paints a fixed 16-byte row, so a pane narrower than that row
 * has to scroll sideways rather than clip. jsdom lays nothing out, so each test states the
 * geometry it is reasoning about explicitly.
 */
describe('HexPane in a pane narrower than one hex row', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  const bigBlob = new Blob([new Uint8Array(4096)]);

  /** Gives the viewport a scroll range and a settable scrollLeft, which jsdom pins to zero. */
  function stubViewportScrolling(
    container: HTMLElement,
    { clientWidth, scrollWidth }: { clientWidth: number; scrollWidth: number },
  ): { readonly value: number; setScrollWidth(next: number): void } {
    const viewport = container.querySelector('.hex-viewport') as HTMLElement;
    let scrollLeft = 0;
    let width = scrollWidth;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, get: () => clientWidth });
    Object.defineProperty(viewport, 'scrollWidth', { configurable: true, get: () => width });
    Object.defineProperty(viewport, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (next: number) => {
        scrollLeft = next;
      },
    });
    return {
      get value() {
        return scrollLeft;
      },
      setScrollWidth(next: number) {
        width = next;
      },
    };
  }

  it('exposes the caret hex cell on explicit navigation, and leaves it alone on a repaint', async () => {
    const user = userEvent.setup();
    const { container, getByLabelText, rerender } = renderPane({ blob: bigBlob, fileSize: 4096 });
    const scroll = stubViewportScrolling(container, { clientWidth: 120, scrollWidth: 600 });

    // Byte 15 sits past the right edge of a 120 px window, so goto scrolls just far enough.
    await user.type(getByLabelText('Go to offset'), '0x0f{Enter}');
    const right = hexByteX(paneMetrics, paneLayout, 15) + 2 * paneMetrics.charWidth;
    expect(scroll.value).toBeCloseTo(right - 120, 5);

    // Byte 0 sits left of the scrolled window, so it pulls the viewport back to that column.
    await user.clear(getByLabelText('Go to offset'));
    await user.type(getByLabelText('Go to offset'), '0x0{Enter}');
    expect(scroll.value).toBeCloseTo(hexByteX(paneMetrics, paneLayout, 0), 5);

    // An appearance change only repaints: it must not drag the caret's column back into view.
    const parked = scroll.value;
    await rerender({ appearance: 'dark' });
    expect(scroll.value).toBe(parked);
  });

  it('treats Shift and horizontal wheel deltas as sideways scrolling, never as byte rows', async () => {
    const { container } = renderPane({ blob: bigBlob, fileSize: 4096 });
    const viewport = container.querySelector('.hex-viewport') as HTMLElement;
    const root = container.querySelector('[data-hex-pane]')!;
    const scroll = stubViewportScrolling(container, { clientWidth: 120, scrollWidth: 400 });

    await fireEvent.wheel(viewport, { deltaX: 40, deltaY: 0 });
    expect(scroll.value).toBe(40);
    expect(root.getAttribute('data-hex-first-row')).toBe('0');

    await fireEvent.wheel(viewport, { deltaX: 0, deltaY: 30, shiftKey: true });
    expect(scroll.value).toBe(70);
    expect(root.getAttribute('data-hex-first-row')).toBe('0');

    // deltaMode 1 counts lines — one byte row each.
    await fireEvent.wheel(viewport, { deltaX: 2, deltaY: 0, deltaMode: 1 });
    expect(scroll.value).toBe(70 + 2 * 18);

    // A plain vertical wheel keeps its custom three-row step and leaves the column alone.
    await fireEvent.wheel(viewport, { deltaX: 0, deltaY: 10 });
    expect(root.getAttribute('data-hex-first-row')).toBe('3');
    expect(scroll.value).toBe(106);

    // With nothing to scroll sideways the gesture belongs to the page, and moves no byte rows.
    scroll.setScrollWidth(120);
    await fireEvent.wheel(viewport, { deltaX: 400, deltaY: 0 });
    expect(root.getAttribute('data-hex-first-row')).toBe('3');
    expect(scroll.value).toBe(106);
  });
});

describe('HexPane chrome height reporting', () => {
  const CHROME = 40;
  const PANE_BORDER = 2;
  const SCROLLBAR = 12;
  let observed: Element[] = [];
  let disconnects = 0;
  const originals = new Map<string, PropertyDescriptor>();

  function stubBoxes(): void {
    for (const name of ['offsetHeight', 'clientHeight'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
      if (descriptor) originals.set(name, descriptor);
    }
    // Border boxes for the three elements the report adds up; everything else stays at zero.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains('hex-chrome')) return CHROME;
        if (this.classList.contains('hex-pane')) return 200 + PANE_BORDER;
        if (this.classList.contains('hex-viewport')) return 100;
        return 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains('hex-pane')) return 200;
        if (this.classList.contains('hex-viewport')) return 100 - SCROLLBAR;
        return 0;
      },
    });
  }

  beforeEach(() => {
    observed = [];
    disconnects = 0;
    stubBoxes();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {
          disconnects += 1;
        }
        unobserve() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    for (const [name, descriptor] of originals) {
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
    originals.clear();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('reports chrome, pane border and scrollbar thickness — never the whole pane height', () => {
    const onchromeheightchange = vi.fn();
    renderPane({ layout: 'embedded', visible: true, onchromeheightchange });
    expect(onchromeheightchange).toHaveBeenCalledTimes(1);
    expect(onchromeheightchange).toHaveBeenCalledWith(CHROME + PANE_BORDER + SCROLLBAR);
  });

  it('observes the chrome wrapper and the viewport once each, and disconnects when unmounted', () => {
    const { container, unmount } = renderPane({
      layout: 'embedded',
      visible: true,
      onchromeheightchange: vi.fn(),
    });
    const chrome = container.querySelector('.hex-chrome');
    const viewport = container.querySelector('.hex-viewport');
    expect(observed.filter((element) => element === chrome)).toHaveLength(1);
    expect(observed).toContain(viewport);
    unmount();
    expect(disconnects).toBeGreaterThanOrEqual(1);
  });

  it('stays silent while nothing changes, and observes nothing when no parent asked', async () => {
    const onchromeheightchange = vi.fn();
    const { rerender } = renderPane({ layout: 'embedded', visible: true, onchromeheightchange });
    await rerender({ layout: 'embedded', visible: true, onchromeheightchange, appearance: 'dark' });
    expect(onchromeheightchange).toHaveBeenCalledTimes(1);

    cleanup();
    observed = [];
    const { container } = renderPane({ layout: 'embedded', visible: true });
    expect(observed).not.toContain(container.querySelector('.hex-chrome'));
  });
});

describe('HexPane chrome markup', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('gathers the toolbar, the hint and the read-error row into one measurable wrapper', () => {
    const { container } = renderPane({ coverageReason: 'too-large' });
    const chrome = container.querySelector('.hex-chrome')!;
    expect(chrome.querySelector('.hex-toolbar')).not.toBeNull();
    expect(chrome.querySelector('[data-hex-hint]')?.textContent).toContain('Result too large to index');
    // The drawing surface stays outside the chrome the parent budgets against.
    expect(chrome.querySelector('.hex-body')).toBeNull();
    expect(container.querySelector('.hex-pane > .hex-body')).not.toBeNull();
  });
});

describe('HexPane vertical scrollbar track', () => {
  // A classic (non-overlay) scrollbar carves real space out of the viewport's border box, so
  // its clientHeight (what the thumb math uses as `viewportHeight`) is shorter than its
  // offsetHeight (what flex `align-items: stretch` would size the track to).
  const VIEWPORT_CLIENT = 100;
  const VIEWPORT_OFFSET = 115;
  const originals = new Map<string, PropertyDescriptor>();

  function stubViewportBox(): void {
    for (const name of ['offsetHeight', 'clientHeight'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
      if (descriptor) originals.set(name, descriptor);
    }
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('hex-viewport') ? VIEWPORT_OFFSET : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('hex-viewport') ? VIEWPORT_CLIENT : 0;
      },
    });
  }

  afterEach(() => {
    cleanup();
    for (const [name, descriptor] of originals) {
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
    originals.clear();
    localStorage.clear();
  });

  it('sizes the scrollbar track from the same measurement the thumb math uses, not the viewport border box', () => {
    stubViewportBox();
    const { container } = renderPane();
    const track = container.querySelector('.hex-scrollbar') as HTMLElement;
    expect(track.style.height).toBe(`${VIEWPORT_CLIENT}px`);
    expect(track.style.height).not.toBe(`${VIEWPORT_OFFSET}px`);
  });
});
