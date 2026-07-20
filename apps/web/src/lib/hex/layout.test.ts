import { describe, expect, it } from 'vitest';

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
} from './layout.js';

const metrics: HexMetrics = { charWidth: 8, rowHeight: 18, gutterDigits: 8, padding: 12 };

describe('offsets and rows', () => {
  it('uses 8 gutter digits up to 4 GiB and grows in steps of 2 past it', () => {
    expect(offsetDigits(0)).toBe(8);
    expect(offsetDigits(2 ** 32)).toBe(8);
    expect(offsetDigits(2 ** 32 + 1)).toBe(10);
  });

  it('computes total rows, with an empty file still showing one row', () => {
    expect(totalRows(0)).toBe(1);
    expect(totalRows(16)).toBe(1);
    expect(totalRows(17)).toBe(2);
    expect(totalRows(4 * 2 ** 30)).toBe(268_435_456);
  });
});

describe('column layout and hit-testing', () => {
  const layout = columnLayout(metrics);

  it('lays out gutter, hex, and ascii regions left to right', () => {
    expect(layout.gutterX).toBe(12);
    expect(layout.hexX).toBe(12 + 10 * 8); // gutterDigits + 2 gap chars
    expect(layout.asciiX).toBe(layout.hexX + 49 * 8 + 16); // 16*3+1 mid-gap chars + 2 gap chars
    expect(layout.width).toBe(layout.asciiX + BYTES_PER_ROW * 8 + 12);
  });

  it('adds the mid-gap after byte 8', () => {
    expect(hexByteX(metrics, layout, 7)).toBe(layout.hexX + 21 * 8);
    expect(hexByteX(metrics, layout, 8)).toBe(layout.hexX + 25 * 8);
  });

  it('hit-tests hex cells (including the trailing gap) and ascii cells', () => {
    const y = 18 * 2 + 4; // third visible row
    const hexHit = byteAtPoint(hexByteX(metrics, layout, 3) + 5, y, metrics, layout, 10, 4096);
    expect(hexHit).toBe(12 * 16 + 3);
    const asciiHit = byteAtPoint(layout.asciiX + 8 * 5 + 2, y, metrics, layout, 10, 4096);
    expect(asciiHit).toBe(12 * 16 + 5);
  });

  it('returns null outside byte regions and past EOF', () => {
    expect(byteAtPoint(2, 4, metrics, layout, 0, 4096)).toBeNull();
    // y = 40 → row 2 → offset 2 * 16 + 2 = 34, past the 33-byte file
    expect(byteAtPoint(hexByteX(metrics, layout, 2), 40, metrics, layout, 0, 33)).toBeNull();
  });
});

describe('scrollbar mapping', () => {
  it('clamps the scroll row to the last full viewport', () => {
    expect(clampScrollRow(-5, 100, 20)).toBe(0);
    expect(clampScrollRow(95, 100, 20)).toBe(80);
    expect(clampScrollRow(5, 10, 20)).toBe(0);
  });

  it('round-trips thumb position to scroll row at 4 GiB scale', () => {
    const total = totalRows(4 * 2 ** 30);
    const view = rowsInView(360, 18);
    const scrollRow = 123_456_789;
    const { thumbPx, thumbTop } = thumbGeometry(300, total, view, scrollRow);
    expect(thumbPx).toBe(24); // MIN_THUMB_PX floor at this scale
    const roundTripped = scrollRowForThumbTop(thumbTop, 300, total, view);
    expect(Math.abs(roundTripped - scrollRow)).toBeLessThan(total / (300 - 24) + 1);
  });

  it('pins the thumb to the top when everything fits', () => {
    expect(thumbGeometry(300, 10, 20, 0)).toEqual({ thumbPx: 300, thumbTop: 0 });
  });
});

describe('pane resize bounds', () => {
  const base = { paneHeight: 260, rowHeight: 18, flexMinPx: 128, overflowPx: 0 };

  it('keeps a minimum of the toolbar plus four rows', () => {
    expect(paneResizeBounds({ ...base, flexHeight: 400 }).min).toBe(44 + 4 * 18);
  });

  it('lets the pane grow by exactly the slack the flexible row can yield', () => {
    // Results row at 400px can give up 400 - 128 = 272px before hitting its minimum.
    expect(paneResizeBounds({ ...base, flexHeight: 400 }).max).toBe(260 + 272);
  });

  it('allows no growth once the flexible row sits at its minimum', () => {
    expect(paneResizeBounds({ ...base, flexHeight: 128 }).max).toBe(260);
  });

  it('pulls max below the current height to recover clipped overflow', () => {
    // Workspace already overflows by 100px (e.g. oversized stored height): the pane
    // must shrink by that much even though the results row has nothing left to give.
    expect(paneResizeBounds({ ...base, flexHeight: 128, overflowPx: 100 }).max).toBe(160);
  });

  it('never reports a max below the min', () => {
    const bounds = paneResizeBounds({ ...base, paneHeight: 120, flexHeight: 128, overflowPx: 500 });
    expect(bounds.max).toBe(bounds.min);
  });

  it('falls back to the current height when the flexible row is unknown', () => {
    expect(paneResizeBounds({ ...base, flexHeight: null }).max).toBe(260);
  });
});
