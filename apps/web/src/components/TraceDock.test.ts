// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TraceSummary } from '../lib/ui/trace.js';
import TraceDockHarness from './TraceDock.harness.svelte';

const linked: TraceSummary = {
  kind: 'linked',
  row: 2,
  range: { file: 'capture.pcap', start: 98, end: 196 },
  label: '0x00000062–0x000000c3 · 98 bytes',
};

function renderDock(overrides: Record<string, unknown> = {}) {
  const handlers = {
    oncollapsedchange: vi.fn(),
    ontabchange: vi.fn(),
    onreveal: vi.fn(),
  };
  const view = render(TraceDockHarness, {
    summary: linked,
    collapsed: false,
    compact: false,
    showValues: true,
    tab: 'bytes',
    resultsElement: null,
    ...handlers,
    ...overrides,
  });
  return { ...view, ...handlers };
}

const dock = (): HTMLElement => document.querySelector<HTMLElement>('[data-trace-dock]')!;

/** jsdom reports every clientHeight as 0, so the results panel is measured explicitly. */
function measuredResults(clientHeight: number): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight });
  return element;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('TraceDock geometry', () => {
  it('owns an explicit height only while expanded', async () => {
    const { rerender } = renderDock();
    expect(dock().style.height).toBe('248px');
    expect(dock().getAttribute('data-dock-collapsed')).toBe('false');

    await rerender({ collapsed: true, summary: linked, compact: false, showValues: true, tab: 'bytes' });
    expect(dock().style.height).toBe('');
    expect(dock().getAttribute('data-dock-collapsed')).toBe('true');
  });

  it('starts from a validated stored height', () => {
    localStorage.setItem('byteql.hexpane.height', 'garbage');
    renderDock();
    expect(dock().style.height).toBe('248px');
    cleanup();

    localStorage.setItem('byteql.hexpane.height', '320');
    renderDock();
    expect(dock().style.height).toBe('320px');
  });

  it('exposes a labelled separator with numeric bounds', () => {
    renderDock();
    const separator = screen.getByRole('separator', { name: 'Resize inspection' });
    expect(separator.getAttribute('aria-orientation')).toBe('horizontal');
    expect(separator.getAttribute('tabindex')).toBe('0');
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(248);
    expect(Number(separator.getAttribute('aria-valuemin'))).toBe(152);
    expect(Number(separator.getAttribute('aria-valuemax'))).toBeGreaterThanOrEqual(248);
  });

  it('keeps the compatibility class that pins it above adjacent chrome', () => {
    renderDock();
    expect(screen.getByRole('separator', { name: 'Resize inspection' }).classList).toContain('hex-resize');
  });

  it('changes height by one row with the arrows and persists it', async () => {
    renderDock({ resultsElement: measuredResults(360) });
    const separator = screen.getByRole('separator', { name: 'Resize inspection' });

    await fireEvent.keyDown(separator, { key: 'ArrowDown' });
    expect(dock().style.height).toBe('230px');
    expect(localStorage.getItem('byteql.hexpane.height')).toBe('230');

    await fireEvent.keyDown(separator, { key: 'ArrowUp' });
    expect(dock().style.height).toBe('248px');
    expect(localStorage.getItem('byteql.hexpane.height')).toBe('248');
  });

  it('stops at its minimum and at the space the results panel can spare', async () => {
    renderDock({ resultsElement: measuredResults(360) });
    const separator = screen.getByRole('separator', { name: 'Resize inspection' });

    await fireEvent.keyDown(separator, { key: 'Home' });
    expect(dock().style.height).toBe('152px');

    // 360 px of results, 128 px of which the grid keeps: 232 px of slack.
    await fireEvent.keyDown(separator, { key: 'End' });
    expect(dock().style.height).toBe('384px');
  });

  it('will not grow when the results panel has nothing to spare', async () => {
    renderDock({ resultsElement: measuredResults(128) });
    const separator = screen.getByRole('separator', { name: 'Resize inspection' });

    await fireEvent.keyDown(separator, { key: 'ArrowUp' });
    expect(dock().style.height).toBe('248px');
  });

  it('drops pointer capture when a drag is cancelled', async () => {
    renderDock();
    const separator = screen.getByRole('separator', { name: 'Resize inspection' });
    const release = vi.fn();
    Object.assign(separator, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: release,
    });

    await fireEvent.pointerDown(separator, { pointerId: 1, clientY: 400 });
    await fireEvent.pointerCancel(separator, { pointerId: 1 });
    expect(release).toHaveBeenCalledWith(1);

    // A cancelled drag leaves no residual dragging state.
    await fireEvent.pointerMove(separator, { pointerId: 1, clientY: 100 });
    expect(dock().style.height).toBe('248px');
  });
});

describe('TraceDock composition', () => {
  it('shows the trace strip and both panels side by side on wide layouts', () => {
    renderDock();
    expect(screen.getByRole('region', { name: 'Source trace' })).toBeTruthy();
    expect(screen.getByTestId('values-panel').closest('[hidden]')).toBeNull();
    expect(screen.getByTestId('bytes-panel').closest('[hidden]')).toBeNull();
    // Side by side means no tablist.
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('hides only Values when the wide layout turns them off', () => {
    renderDock({ showValues: false });
    expect(screen.getByTestId('values-panel').closest('[hidden]')).not.toBeNull();
    expect(screen.getByTestId('bytes-panel').closest('[hidden]')).toBeNull();
  });

  it('shows only the trace strip when collapsed, without unmounting its panels', () => {
    renderDock({ collapsed: true });
    expect(screen.getByRole('region', { name: 'Source trace' })).toBeTruthy();
    expect(screen.queryByRole('separator', { name: 'Resize inspection' })).toBeNull();

    // Hidden, not destroyed: collapsing must not reset caret, scroll or playback.
    expect(screen.getByTestId('values-panel').closest('[hidden]')).not.toBeNull();
    expect(screen.getByTestId('bytes-panel').closest('[hidden]')).not.toBeNull();
    expect(document.querySelector('.trace-dock-body')?.hasAttribute('hidden')).toBe(true);
  });

  it('reports a collapse request rather than collapsing itself', async () => {
    const { oncollapsedchange } = renderDock();
    await fireEvent.click(screen.getByRole('button', { name: 'Hide inspection' }));
    expect(oncollapsedchange).toHaveBeenCalledExactlyOnceWith(true);
    // It is the parent's state: the dock stays open until the prop changes.
    expect(dock().getAttribute('data-dock-collapsed')).toBe('false');
  });

  it('forwards the reveal request from the strip', async () => {
    const { onreveal } = renderDock();
    await fireEvent.click(screen.getByRole('button', { name: 'Inspect source' }));
    expect(onreveal).toHaveBeenCalledOnce();
  });
});

describe('TraceDock compact tabs', () => {
  it('names its tablist and marks the active tab', () => {
    renderDock({ compact: true, tab: 'bytes' });
    const tablist = screen.getByRole('tablist', { name: 'Inspection views' });
    expect(tablist).toBeTruthy();

    const bytes = screen.getByRole('tab', { name: 'Bytes' });
    const values = screen.getByRole('tab', { name: 'Values' });
    expect(bytes.getAttribute('aria-selected')).toBe('true');
    expect(values.getAttribute('aria-selected')).toBe('false');
    // Roving focus: only the selected tab is in the tab order.
    expect(bytes.getAttribute('tabindex')).toBe('0');
    expect(values.getAttribute('tabindex')).toBe('-1');
  });

  it('shows only the active panel but keeps both mounted', () => {
    renderDock({ compact: true, tab: 'bytes' });
    expect(screen.getByTestId('bytes-panel').closest('[hidden]')).toBeNull();
    expect(screen.getByTestId('values-panel').closest('[hidden]')).not.toBeNull();
    // Mounted, not destroyed — hiding a tab must not reset its component state.
    expect(screen.getByTestId('values-panel')).toBeTruthy();
  });

  it('associates each tab with the panel it controls', () => {
    renderDock({ compact: true, tab: 'values' });
    const values = screen.getByRole('tab', { name: 'Values' });
    const panel = document.getElementById(values.getAttribute('aria-controls')!)!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(values.id);
  });

  it('moves between tabs with arrows, Home and End', async () => {
    const { ontabchange } = renderDock({ compact: true, tab: 'bytes' });
    const bytes = screen.getByRole('tab', { name: 'Bytes' });

    await fireEvent.keyDown(bytes, { key: 'ArrowLeft' });
    expect(ontabchange).toHaveBeenLastCalledWith('values');

    await fireEvent.keyDown(bytes, { key: 'Home' });
    expect(ontabchange).toHaveBeenLastCalledWith('values');

    await fireEvent.keyDown(bytes, { key: 'End' });
    expect(ontabchange).toHaveBeenLastCalledWith('bytes');
  });

  it('moves focus to the tab it selects', async () => {
    renderDock({ compact: true, tab: 'bytes' });
    const bytes = screen.getByRole('tab', { name: 'Bytes' });
    bytes.focus();

    await fireEvent.keyDown(bytes, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Values' }));
  });

  it('reserves room for the tab row in its minimum height', async () => {
    renderDock({ compact: true, tab: 'bytes' });
    const separator = screen.getByRole('separator', { name: 'Resize inspection' });
    await fireEvent.keyDown(separator, { key: 'Home' });
    expect(dock().style.height).toBe('188px');
  });
});
