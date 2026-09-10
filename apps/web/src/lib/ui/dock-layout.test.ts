import { describe, expect, it } from 'vitest';

import { dockBounds, storedDockHeight } from './dock-layout.js';

describe('storedDockHeight', () => {
  it('defaults when nothing is stored', () => {
    expect(storedDockHeight(null)).toBe(248);
  });

  it('rejects values that are not usable heights', () => {
    expect(storedDockHeight('garbage')).toBe(248);
    expect(storedDockHeight('-80')).toBe(248);
    expect(storedDockHeight('0')).toBe(248);
    expect(storedDockHeight('')).toBe(248);
    expect(storedDockHeight('Infinity')).toBe(248);
  });

  it('clamps a stored value up to the minimum but keeps a larger one', () => {
    expect(storedDockHeight('80')).toBe(152);
    expect(storedDockHeight('400')).toBe(400);
  });
});

describe('dockBounds', () => {
  it('allows side-by-side content down to 152 px and grows into the space above', () => {
    expect(
      dockBounds({ height: 248, resultsHeight: 360, overflow: 0, stripHeight: 40, compact: false }),
    ).toEqual({ min: 152, max: 480 });
  });

  it('reserves another row for the tab strip in compact mode', () => {
    expect(
      dockBounds({ height: 248, resultsHeight: 128, overflow: 0, stripHeight: 40, compact: true }),
    ).toEqual({ min: 188, max: 248 });
  });

  it('counts a wrapped trace strip beyond its first 40 px', () => {
    expect(
      dockBounds({ height: 248, resultsHeight: 360, overflow: 0, stripHeight: 76, compact: false }).min,
    ).toBe(188);
    // A strip shorter than the 40 px minimum never shrinks the floor.
    expect(
      dockBounds({ height: 248, resultsHeight: 360, overflow: 0, stripHeight: 12, compact: false }).min,
    ).toBe(152);
  });

  it('leaves the results panel its 128 px minimum', () => {
    // Only the slack above 128 px is available to the dock.
    expect(
      dockBounds({ height: 200, resultsHeight: 200, overflow: 0, stripHeight: 40, compact: false }).max,
    ).toBe(272);
    expect(
      dockBounds({ height: 200, resultsHeight: 128, overflow: 0, stripHeight: 40, compact: false }).max,
    ).toBe(200);
    expect(
      dockBounds({ height: 200, resultsHeight: 40, overflow: 0, stripHeight: 40, compact: false }).max,
    ).toBe(200);
  });

  it('gives back workspace overflow before growing', () => {
    expect(
      dockBounds({ height: 300, resultsHeight: 300, overflow: 60, stripHeight: 40, compact: false }).max,
    ).toBe(412);
  });

  it('never reports a maximum below its own minimum', () => {
    const bounds = dockBounds({
      height: 60,
      resultsHeight: 0,
      overflow: 900,
      stripHeight: 40,
      compact: true,
    });
    expect(bounds.max).toBe(bounds.min);
    expect(bounds.min).toBe(188);
  });
});
