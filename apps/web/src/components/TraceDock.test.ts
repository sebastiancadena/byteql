// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TraceSummary } from '../lib/ui/trace.js';
import TraceDockHarness from './TraceDock.harness.svelte';

const linked: TraceSummary = {
  kind: 'linked',
  row: 2,
  range: { file: 'capture.pcap', start: 98, end: 196 },
  label: '0x00000062–0x000000c3 · 98 bytes',
};

/** jsdom gives every element a zero box, so the two measured rows are declared explicitly. */
const chromeHeights = new Map<string, number>();

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];

  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.push(element);
  }

  disconnect(): void {
    this.observed = [];
  }
}

const notifyObservers = (): void => {
  for (const observer of FakeResizeObserver.instances) observer.callback();
};

function renderDock(overrides: Record<string, unknown> = {}) {
  const handlers = {
    oncollapsedchange: vi.fn(),
    ontabchange: vi.fn(),
    onreveal: vi.fn(),
    onchromechange: vi.fn(),
  };
  const view = render(TraceDockHarness, {
    summary: linked,
    collapsed: false,
    compact: false,
    showValues: true,
    tab: 'bytes',
    ...handlers,
    ...overrides,
  });
  return { ...view, ...handlers };
}

const dock = (): HTMLElement => document.querySelector<HTMLElement>('[data-trace-dock]')!;

beforeEach(() => {
  chromeHeights.clear();
  chromeHeights.set('trace-dock-strip', 40);
  chromeHeights.set('trace-dock-tabs', 36);
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      for (const [token, value] of chromeHeights) {
        if (this.classList.contains(token)) return value;
      }
      return 0;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TraceDock geometry', () => {
  it('takes its height from the workspace and only while expanded', async () => {
    const { rerender } = renderDock({ height: 320 });
    expect(dock().style.height).toBe('320px');
    expect(dock().getAttribute('data-dock-collapsed')).toBe('false');

    await rerender({
      summary: linked,
      compact: false,
      showValues: true,
      tab: 'bytes',
      height: 420,
      collapsed: false,
    });
    expect(dock().style.height).toBe('420px');

    // Collapsed the strip alone decides how tall the dock is.
    await rerender({
      summary: linked,
      compact: false,
      showValues: true,
      tab: 'bytes',
      height: 420,
      collapsed: true,
    });
    expect(dock().style.height).toBe('');
    expect(dock().getAttribute('data-dock-collapsed')).toBe('true');
  });

  it('publishes the resolved Values width and an addressable pane id', () => {
    renderDock({ valuesWidth: 288 });
    expect(dock().style.getPropertyValue('--values-width')).toBe('288px');
    expect(dock().id).toBe('inspection-pane');
  });

  it('renders the Values separator against the bounds the workspace published', () => {
    renderDock({ valuesWidth: 288, valuesBounds: { min: 200, max: 420 } });
    const separator = screen.getByRole('separator', { name: 'Resize values' });
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.getAttribute('aria-controls')).toBe('dock-panel-values');
    expect(separator.getAttribute('aria-valuenow')).toBe('288');
    expect(separator.getAttribute('aria-valuemin')).toBe('200');
    expect(separator.getAttribute('aria-valuemax')).toBe('420');
    // It sits between the two panels, in a track of its own.
    const body = Array.from(document.querySelector('.trace-dock-body')!.children);
    expect(body.map((child) => child.classList[0])).toEqual([
      'trace-values',
      'values-resize-slot',
      'trace-bytes',
    ]);
  });

  it('reports every Values drag to the workspace and keeps no width of its own', async () => {
    const handlers = {
      onvaluestart: vi.fn(),
      onvaluespreview: vi.fn(),
      onvaluescommit: vi.fn(),
      onvaluesreset: vi.fn(),
    };
    renderDock({ valuesWidth: 256, ...handlers });
    const separator = screen.getByRole('separator', { name: 'Resize values' });

    await fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(handlers.onvaluestart).toHaveBeenCalledOnce();
    expect(handlers.onvaluescommit).toHaveBeenCalledExactlyOnceWith(274);
    await fireEvent.dblClick(separator);
    expect(handlers.onvaluesreset).toHaveBeenCalledOnce();

    // The dock reports; it never adopts. Its column still shows what the workspace published.
    expect(separator.getAttribute('aria-valuenow')).toBe('256');
    expect(dock().style.getPropertyValue('--values-width')).toBe('256px');
    expect(localStorage.getItem('byteql.ui.layout.v1')).toBeNull();
  });

  for (const { label, props } of [
    { label: 'the dock is collapsed', props: { collapsed: true } },
    { label: 'the panels are tabbed', props: { compact: true } },
    { label: 'Values are hidden', props: { showValues: false } },
  ]) {
    it(`removes the Values separator from the DOM when ${label}`, () => {
      renderDock(props);
      // Absent, not merely invisible: a hidden separator must not stay tabbable.
      expect(screen.queryByRole('separator', { name: 'Resize values' })).toBeNull();
      expect(document.querySelector('.values-resize-slot')).toBeNull();
    });
  }

  it('keeps no height preference of its own in storage', async () => {
    const { onchromechange } = renderDock();
    await fireEvent.click(screen.getByRole('button', { name: 'Hide inspection' }));
    expect(localStorage.getItem('byteql.hexpane.height')).toBeNull();
    expect(onchromechange).toHaveBeenCalled();
  });

  it('reports the strip height on mount and again when the strip wraps', async () => {
    const { onchromechange } = renderDock();
    expect(onchromechange).toHaveBeenCalledExactlyOnceWith({ strip: 40, tabs: 0 });

    chromeHeights.set('trace-dock-strip', 72);
    notifyObservers();
    await Promise.resolve();
    expect(onchromechange).toHaveBeenLastCalledWith({ strip: 72, tabs: 0 });

    // An unchanged measurement is not news.
    notifyObservers();
    expect(onchromechange).toHaveBeenCalledTimes(2);
  });

  it('reports the tab row height only while the tabs are on screen', async () => {
    const { onchromechange, rerender } = renderDock({ compact: true });
    expect(onchromechange).toHaveBeenLastCalledWith({ strip: 40, tabs: 36 });

    await rerender({
      summary: linked,
      compact: true,
      showValues: true,
      tab: 'bytes',
      collapsed: true,
    });
    expect(onchromechange).toHaveBeenLastCalledWith({ strip: 40, tabs: 0 });
  });

  it('keeps the same panel nodes across height, collapse and tab changes', async () => {
    const { rerender } = renderDock({ compact: true, height: 248 });
    const values = screen.getByTestId('values-panel');
    const bytes = screen.getByTestId('bytes-panel');

    for (const next of [
      { height: 320, collapsed: false, tab: 'values' as const },
      { height: 320, collapsed: true, tab: 'values' as const },
      { height: 200, collapsed: false, tab: 'bytes' as const },
    ]) {
      await rerender({ summary: linked, compact: true, showValues: true, ...next });
      expect(screen.getByTestId('values-panel')).toBe(values);
      expect(screen.getByTestId('bytes-panel')).toBe(bytes);
    }
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
});
