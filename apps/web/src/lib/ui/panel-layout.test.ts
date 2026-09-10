import { describe, expect, it } from 'vitest';

import {
  clamp,
  compactForWidth,
  defaultSizes,
  emptyPreferences,
  fitHorizontal,
  fitVertical,
  type VerticalInput,
} from './panel-layout.js';

describe('clamp', () => {
  it('holds a value inside its bounds', () => {
    expect(clamp(50, { min: 0, max: 100 })).toBe(50);
    expect(clamp(-10, { min: 0, max: 100 })).toBe(0);
    expect(clamp(200, { min: 0, max: 100 })).toBe(100);
  });
});

describe('emptyPreferences', () => {
  it('returns version 1 with every field null', () => {
    expect(emptyPreferences()).toEqual({
      version: 1,
      sourcesWidth: null,
      queryHeight: null,
      dockHeight: null,
      valuesWidth: null,
    });
  });
});

describe('defaultSizes', () => {
  it('widens the sources rail on desktop-class viewports', () => {
    expect(defaultSizes(1280, 900)).toMatchObject({ sourcesWidth: 224 });
    expect(defaultSizes(1279, 900)).toMatchObject({ sourcesWidth: 208 });
  });

  it('shrinks the query editor on narrow or short viewports', () => {
    expect(defaultSizes(699, 900)).toMatchObject({ queryHeight: 80 });
    expect(defaultSizes(1280, 759)).toMatchObject({ queryHeight: 80 });
    expect(defaultSizes(1280, 760)).toMatchObject({ queryHeight: 116 });
  });

  it('always returns the fixed dock and values defaults', () => {
    expect(defaultSizes(1280, 900)).toMatchObject({ dockHeight: 248, valuesWidth: 256 });
  });
});

describe('fitVertical', () => {
  const base: VerticalInput = {
    availableHeight: 800,
    chromeHeight: 88,
    stripHeight: 40,
    tabsHeight: 0,
    bodyMin: 112,
    collapsed: false,
    queryHeight: 116,
    dockHeight: 248,
  };

  it('gives remaining height to Results', () => {
    expect(fitVertical(base)).toMatchObject({
      queryHeight: 116,
      dockHeight: 248,
      resultsHeight: 348,
      overflow: 0,
    });
  });

  it('yields dock space before reducing the editor', () => {
    expect(fitVertical({ ...base, availableHeight: 500 })).toMatchObject({
      queryHeight: 116,
      dockHeight: 168,
      resultsHeight: 128,
      overflow: 0,
    });
  });

  it('reports unavoidable overflow instead of clipping minimum panes', () => {
    expect(fitVertical({ ...base, availableHeight: 300 })).toMatchObject({
      queryHeight: 80,
      dockHeight: 152,
      resultsHeight: 128,
      overflow: 148,
    });
  });

  it('counts strip wrapping, tabs and hex chrome', () => {
    const layout = fitVertical({ ...base, stripHeight: 76, tabsHeight: 36, bodyMin: 180 });
    expect(layout.dockBounds.min).toBe(292);
    expect(layout.dockHeight).toBe(292);
  });

  it('collapses the dock to just its strip, freeing height for Results', () => {
    const layout = fitVertical({ ...base, collapsed: true });
    expect(layout).toMatchObject({
      queryHeight: 116,
      dockHeight: 40,
      resultsHeight: 556,
      overflow: 0,
    });
  });

  it('lets the query grow without moving the dock', () => {
    const layout = fitVertical({ ...base, queryHeight: base.queryHeight + 100 });
    expect(layout.queryHeight).toBe(216);
    expect(layout.dockHeight).toBe(base.dockHeight);
  });

  it('lets the dock grow without moving the query', () => {
    const layout = fitVertical({ ...base, dockHeight: base.dockHeight + 100 });
    expect(layout.dockHeight).toBe(348);
    expect(layout.queryHeight).toBe(base.queryHeight);
  });
});

describe('compactForWidth', () => {
  it('goes compact once the dock is too narrow, regardless of prior state', () => {
    expect(compactForWidth(1440, 899, false)).toBe(true);
  });

  it('stays compact in the hysteresis band when it was already compact', () => {
    expect(compactForWidth(1440, 910, true)).toBe(true);
  });

  it('stays expanded in the hysteresis band when it was already expanded', () => {
    expect(compactForWidth(1440, 910, false)).toBe(false);
  });

  it('expands once the dock clears the upper hysteresis threshold', () => {
    expect(compactForWidth(1440, 924, true)).toBe(false);
  });

  it('forces compact below the 1280 viewport breakpoint regardless of dock width', () => {
    expect(compactForWidth(1279, 1100, false)).toBe(true);
  });
});

describe('fitHorizontal', () => {
  it('clamps sources and values widths to their shell-derived bounds', () => {
    expect(
      fitHorizontal({ shellWidth: 960, dockWidth: 900, gutter: 8, sourcesWidth: 400, valuesWidth: 800 }),
    ).toMatchObject({
      sourcesWidth: 312,
      valuesWidth: 480,
    });
  });

  it('never reports a maximum below its own minimum on a narrow shell', () => {
    const layout = fitHorizontal({ shellWidth: 390, dockWidth: 390, gutter: 8, sourcesWidth: 200, valuesWidth: 200 });
    expect(layout.sourcesBounds.max).toBeGreaterThanOrEqual(layout.sourcesBounds.min);
    expect(layout.valuesBounds.max).toBeGreaterThanOrEqual(layout.valuesBounds.min);
  });
});
