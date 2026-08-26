import type { QueryPage, QueryPageSummary } from '@byteql/db';
import { tableFromArrays } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { RESULT_WINDOW_ROWS, assembleResultWindow, pageIndexesForWindow } from './result-window.js';

const page = (index: number, startRow: number, values: readonly number[]): QueryPage => ({
  index,
  startRow,
  rowCount: values.length,
  table: tableFromArrays({ value: Int32Array.from(values) }),
});

const pageSummaries = (counts: readonly number[]): QueryPageSummary[] => {
  let startRow = 0;
  return counts.map((rowCount, index) => {
    const summary = { index, startRow, rowCount };
    startRow += rowCount;
    return summary;
  });
};

describe('pageIndexesForWindow', () => {
  it('selects only pages intersecting a 16,384-row window around the anchor', () => {
    const pages = pageSummaries([1_024, 8_192, 8_192, 8_192]);

    expect(pageIndexesForWindow(pages, 17_000, RESULT_WINDOW_ROWS)).toEqual([1, 2, 3]);
  });

  it('clamps a window near the loaded tail and selects no pages when none are loaded', () => {
    expect(pageIndexesForWindow(pageSummaries([8_192, 8_192, 8_192]), 99_999)).toEqual([1, 2]);
    expect(pageIndexesForWindow([], 0)).toEqual([]);
  });
});

describe('assembleResultWindow', () => {
  it('assembles exact global order and slices boundary pages', () => {
    const window = assembleResultWindow([page(0, 0, [0, 1, 2]), page(1, 3, [3, 4, 5])], {
      startRow: 2,
      rowCount: 3,
    });

    expect(window.startRow).toBe(2);
    expect(window.table.getChild('value')!.toArray()).toEqual(Int32Array.from([2, 3, 4]));
  });

  it('rebases a window above the cap while retaining global row mapping', () => {
    const values = Array.from({ length: RESULT_WINDOW_ROWS + 1 }, (_, index) => index);
    const window = assembleResultWindow([page(0, 0, values)], {
      startRow: 1,
      rowCount: RESULT_WINDOW_ROWS + 1,
    });

    expect(window.startRow).toBe(1);
    expect(window.table.numRows).toBe(RESULT_WINDOW_ROWS);
    expect(window.table.getChild('value')!.get(0)).toBe(1);
    expect(window.table.getChild('value')!.get(RESULT_WINDOW_ROWS - 1)).toBe(RESULT_WINDOW_ROWS);
  });

  it('returns an empty table for an empty range without creating row objects', () => {
    const source = page(0, 0, [0, 1, 2]);
    const window = assembleResultWindow([source], { startRow: 3, rowCount: 0 });

    expect(window.startRow).toBe(3);
    expect(window.table.numRows).toBe(0);
    expect(window.table.schema).toBe(source.table.schema);
  });
});
