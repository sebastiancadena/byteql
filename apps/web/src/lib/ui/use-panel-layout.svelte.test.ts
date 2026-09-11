// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LAYOUT_KEY } from './layout-preferences.js';
import { createPanelLayout, observePanelMetrics, type LayoutMetrics } from './use-panel-layout.svelte.js';

/** The design's worked example: a 800 px workspace, 36 px toolbars, 8 px handles, no notices. */
const baseMetrics: LayoutMetrics = {
  viewportWidth: 1440,
  viewportHeight: 960,
  shellWidth: 1440,
  workspaceHeight: 800,
  dockWidth: 1208,
  queryToolbar: 36,
  notices: 0,
  resultsToolbar: 36,
  strip: 40,
  tabs: 0,
  hexChrome: 36,
  gutter: 8,
  dockCollapsed: false,
  bytesVisible: true,
};

function memoryStorage() {
  const memory = new Map<string, string>();
  return {
    memory,
    storage: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => {
        memory.set(key, value);
      }),
    },
  };
}

const savedRecord = (memory: Map<string, string>): Record<string, unknown> =>
  JSON.parse(memory.get(LAYOUT_KEY) ?? 'null') as Record<string, unknown>;

describe('panel layout coordinator', () => {
  it('solves the documented vertical budget without touching storage', () => {
    const { storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure(baseMetrics);
    expect(model.layout).toMatchObject({
      queryHeight: 116,
      dockHeight: 248,
      resultsHeight: 348,
      overflow: 0,
    });
    expect(model.active).toBeNull();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('previews a query drag without writing, commits once, and survives a shrink', () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => {
        memory.set(key, value);
      }),
    };
    const model = createPanelLayout(storage);
    const metrics: LayoutMetrics = { ...baseMetrics };
    model.measure(metrics);
    model.begin('query');
    model.preview('query', 216);
    expect(model.layout).toMatchObject({ queryHeight: 216, dockHeight: 248, resultsHeight: 248 });
    expect(storage.setItem).not.toHaveBeenCalled();
    model.commit('query', 216);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    model.measure({ ...metrics, workspaceHeight: 500 });
    model.measure(metrics);
    expect(model.layout.queryHeight).toBe(216);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('gives up dock height before query height and reports honest overflow', () => {
    const { storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure({ ...baseMetrics, workspaceHeight: 500 });
    expect(model.layout).toMatchObject({
      queryHeight: 116,
      dockHeight: 168,
      resultsHeight: 128,
      overflow: 0,
    });

    model.measure({ ...baseMetrics, workspaceHeight: 300 });
    expect(model.layout).toMatchObject({
      queryHeight: 80,
      dockHeight: 152,
      resultsHeight: 128,
      overflow: 148,
    });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('exchanges inspection space with results only, keeping the query where the user put it', () => {
    const { storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure(baseMetrics);
    model.begin('query');
    model.commit('query', 216);
    model.begin('inspection');
    model.preview('inspection', 348);
    expect(model.layout).toMatchObject({ queryHeight: 216, dockHeight: 348, resultsHeight: 148 });
  });

  it('adopts both effective heights on a vertical commit', () => {
    const { memory, storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure(baseMetrics);
    model.begin('query');
    model.commit('query', 216);
    expect(savedRecord(memory)).toMatchObject({ version: 1, queryHeight: 216, dockHeight: 248 });
  });

  it('preserves the expanded dock preference when committing while collapsed', () => {
    const { memory, storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure({ ...baseMetrics, dockCollapsed: true });
    model.begin('query');
    model.commit('query', 200);
    expect(model.layout.dockHeight).toBe(40);
    expect(savedRecord(memory)).toMatchObject({ queryHeight: 200, dockHeight: null });
  });

  it('restores the prior preferences on cancellation, even after constraints changed', () => {
    const { storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure(baseMetrics);
    model.begin('query');
    model.preview('query', 300);
    expect(model.layout.queryHeight).toBe(300);

    // A shrinking workspace cancels the vertical transaction as it lands.
    model.measure({ ...baseMetrics, workspaceHeight: 600 });
    expect(model.active).toBeNull();
    expect(model.cancelEpoch).toBe(1);

    model.measure(baseMetrics);
    expect(model.layout.queryHeight).toBe(116);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('ignores a preview frame that lands after an external cancellation', () => {
    const { storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure(baseMetrics);
    model.begin('inspection');
    model.preview('inspection', 320);
    // Wrapped notices change the chrome mid-drag, which cancels it.
    model.measure({ ...baseMetrics, notices: 48 });
    model.preview('inspection', 340);

    expect(model.active).toBeNull();
    expect(model.layout.dockHeight).toBe(248);
    model.commit('inspection', 340);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('ignores callbacks whose panel is no longer the active one', () => {
    const { storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure(baseMetrics);
    model.begin('query');
    model.preview('inspection', 320);
    expect(model.layout.dockHeight).toBe(248);
    model.commit('inspection', 320);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('starts a second divider without cancelling the handle that just took the pointer', () => {
    const { storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure(baseMetrics);
    model.begin('query');
    model.preview('query', 200);

    // A second pointer lands on the other divider while the first is still captured. The epoch
    // reaches every handle, so bumping it here would tear down the drag that is starting.
    model.begin('inspection');
    expect(model.active).toBe('inspection');
    expect(model.cancelEpoch).toBe(0);

    model.preview('inspection', 300);
    expect(model.layout).toMatchObject({ queryHeight: 116, dockHeight: 300 });

    model.commit('inspection', 300);
    expect(model.active).toBeNull();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    // The abandoned drag left no trace of its preview behind.
    expect(model.layout.queryHeight).toBe(116);
  });

  it('leaves an idle coordinator untouched when cancelled', () => {
    const { storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure(baseMetrics);
    model.cancel();
    expect(model.cancelEpoch).toBe(0);
    expect(model.layout.queryHeight).toBe(116);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('writes one null-valued record when every size is reset', () => {
    const { memory, storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure(baseMetrics);
    model.begin('query');
    model.commit('query', 216);
    storage.setItem.mockClear();

    model.reset();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(savedRecord(memory)).toEqual({
      version: 1,
      sourcesWidth: null,
      queryHeight: null,
      dockHeight: null,
      valuesWidth: null,
    });
    expect(model.layout.queryHeight).toBe(116);
  });

  it('stores null for a reset size that fits and adopts the other effective height', () => {
    const { memory, storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure(baseMetrics);
    model.begin('inspection');
    model.commit('inspection', 360);
    model.begin('query');
    model.commit('query', 300);
    storage.setItem.mockClear();

    model.reset('query');
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(savedRecord(memory)).toMatchObject({ queryHeight: null, dockHeight: 360 });
    expect(model.layout).toMatchObject({ queryHeight: 116, dockHeight: 360 });
  });

  it('keeps the last hex chrome measurement while Bytes is hidden', () => {
    const { storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure({ ...baseMetrics, hexChrome: 200 });
    // bodyMin = max(112, 200 + 72) = 272, so the dock floor is 40 + 272.
    expect(model.layout.dockBounds.min).toBe(312);

    // A hidden pane reports zero height; that is not the user shrinking the chrome.
    model.measure({ ...baseMetrics, hexChrome: 0 });
    expect(model.layout.dockBounds.min).toBe(312);
  });

  it('drops the hex chrome floor when Bytes is not on screen', () => {
    const { storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure({ ...baseMetrics, hexChrome: 200, bytesVisible: false });
    expect(model.layout.dockBounds.min).toBe(152);
  });

  it('decides compact mode from the measured dock width with hysteresis', () => {
    const { storage } = memoryStorage();
    const model = createPanelLayout(storage);

    model.measure(baseMetrics);
    expect(model.layout.compact).toBe(false);

    model.measure({ ...baseMetrics, dockWidth: 880 });
    expect(model.layout.compact).toBe(true);

    // Inside the 900-923 band the previous mode wins.
    model.measure({ ...baseMetrics, dockWidth: 910 });
    expect(model.layout.compact).toBe(true);

    model.measure({ ...baseMetrics, dockWidth: 930 });
    expect(model.layout.compact).toBe(false);
  });

  it('reads stored preferences on creation without writing them back', () => {
    const { memory, storage } = memoryStorage();
    memory.set(
      LAYOUT_KEY,
      JSON.stringify({
        version: 1,
        sourcesWidth: null,
        queryHeight: 180,
        dockHeight: 300,
        valuesWidth: null,
      }),
    );

    const model = createPanelLayout(storage);
    model.measure(baseMetrics);
    expect(model.layout).toMatchObject({ queryHeight: 180, dockHeight: 300 });
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

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

describe('observePanelMetrics', () => {
  let frames: Array<(() => void) | null>;

  beforeEach(() => {
    frames = [];
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      frames[handle - 1] = null;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const flush = (): void => {
    const queued = frames;
    frames = [];
    for (const callback of queued) callback?.();
  };

  it('coalesces several observer callbacks into one measurement per frame', () => {
    const element = document.createElement('div');
    const read = vi.fn(() => ({ ...baseMetrics }));
    const onmeasure = vi.fn();

    const observer = observePanelMetrics(read, [element], onmeasure);
    const resize = FakeResizeObserver.instances[0]!;
    resize.callback();
    resize.callback();
    observer.schedule();
    expect(onmeasure).not.toHaveBeenCalled();

    flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(onmeasure).toHaveBeenCalledExactlyOnceWith(baseMetrics);

    observer.destroy();
  });

  it('delivers only the frames whose measurements differ', () => {
    const element = document.createElement('div');
    let height = 800;
    const onmeasure = vi.fn();
    const observer = observePanelMetrics(
      () => ({ ...baseMetrics, workspaceHeight: height }),
      [element],
      onmeasure,
    );

    flush();
    expect(onmeasure).toHaveBeenCalledTimes(1);

    observer.schedule();
    flush();
    expect(onmeasure).toHaveBeenCalledTimes(1);

    height = 640;
    observer.schedule();
    flush();
    expect(onmeasure).toHaveBeenCalledTimes(2);
    expect(onmeasure).toHaveBeenLastCalledWith({ ...baseMetrics, workspaceHeight: 640 });

    observer.destroy();
  });

  it('measures on a window resize and stops after cleanup', () => {
    const element = document.createElement('div');
    const onmeasure = vi.fn();
    const observer = observePanelMetrics(() => ({ ...baseMetrics }), [element], onmeasure);
    flush();
    expect(onmeasure).toHaveBeenCalledTimes(1);

    observer.destroy();
    window.dispatchEvent(new Event('resize'));
    flush();
    expect(onmeasure).toHaveBeenCalledTimes(1);
    expect(FakeResizeObserver.instances[0]!.observed).toEqual([]);
  });

  it('cancels a queued measurement when it is destroyed first', () => {
    const element = document.createElement('div');
    const read = vi.fn(() => ({ ...baseMetrics }));
    const onmeasure = vi.fn();

    const observer = observePanelMetrics(read, [element], onmeasure);
    observer.destroy();
    flush();

    expect(read).not.toHaveBeenCalled();
    expect(onmeasure).not.toHaveBeenCalled();
  });

  it('skips the measurement when its elements are not on the page yet', () => {
    const onmeasure = vi.fn();
    const observer = observePanelMetrics(() => null, [], onmeasure);
    flush();
    expect(onmeasure).not.toHaveBeenCalled();
    observer.destroy();
  });
});
