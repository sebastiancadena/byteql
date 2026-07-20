// @vitest-environment jsdom
// apps/web/src/components/HexPane.test.ts
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoverageIndex } from '../lib/hex/coverage.js';
import HexPane from './HexPane.svelte';

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
    // x=455 lands in the ascii column (index 0) of row 0 → offset 0; the stub records [2, 9).
    const onreveal = vi.fn();
    const onselectionchange = vi.fn();
    const { container } = renderPane({
      coverage: fixedCoverage({ start: 2, end: 9 }),
      coverageReason: 'ok',
      onreveal,
      onselectionchange,
    });
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    await fireEvent.dblClick(canvas, { clientX: 455, clientY: 5 });
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
