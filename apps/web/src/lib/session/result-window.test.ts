import type { QueryPage, QueryPageSummary } from '@byteql/db';
import { RESULT_LABEL_METADATA_KEY, resultColumnLabel } from '@byteql/db/result-columns';
import {
  Field,
  Int32,
  RecordBatch,
  Schema,
  Table,
  Utf8,
  tableFromArrays,
  vectorFromArray,
} from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { RESULT_WINDOW_ROWS, assembleResultWindow, pageIndexesForWindow } from './result-window.js';

const page = (index: number, startRow: number, values: readonly number[]): QueryPage => ({
  index,
  startRow,
  rowCount: values.length,
  table: tableFromArrays({ value: Int32Array.from(values) }),
});

const duplicateLabelPage = (index: number, startRow: number, rowCount: number): QueryPage => {
  const integers = Array.from({ length: rowCount }, (_, offset) => startRow + offset);
  const built = new Table({
    c0: vectorFromArray(Int32Array.from(integers)),
    c1: vectorFromArray(
      integers.map((value) => `row-${value}`),
      new Utf8(),
    ),
  });
  const label = new Map([[RESULT_LABEL_METADATA_KEY, 'dup']]);
  const schema = new Schema([
    new Field('c0', new Int32(), true, label),
    new Field('c1', new Utf8(), true, label),
  ]);
  return {
    index,
    startRow,
    rowCount,
    table: new Table(
      schema,
      built.batches.map((batch) => new RecordBatch(schema, batch.data)),
    ),
  };
};

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

  it('caps an oversized caller maximum at 16,384 rows', () => {
    const pages = pageSummaries([8_192, 8_192, 8_192]);

    expect(pageIndexesForWindow(pages, 8_192, 1_000_000)).toEqual([0, 1]);
  });

  it('returns intersecting indexes in global page order for unordered summaries', () => {
    const [first, second, third] = pageSummaries([4, 4, 4]);

    expect(pageIndexesForWindow([third!, first!, second!], 6, 10)).toEqual([0, 1, 2]);
  });

  it('selects no pages for invalid or nonpositive caller maxima', () => {
    const pages = pageSummaries([8]);

    expect(pageIndexesForWindow(pages, 0, 0)).toEqual([]);
    expect(pageIndexesForWindow(pages, 0, -1)).toEqual([]);
    expect(pageIndexesForWindow(pages, 0, Number.NaN)).toEqual([]);
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

  it('preserves a multi-column Arrow schema across unordered page boundaries', () => {
    const first: QueryPage = {
      index: 0,
      startRow: 0,
      rowCount: 2,
      table: tableFromArrays({ value: Int32Array.from([0, 1]), label: ['zero', 'one'] }),
    };
    const second: QueryPage = {
      index: 1,
      startRow: 2,
      rowCount: 2,
      table: tableFromArrays({ value: Int32Array.from([2, 3]), label: ['two', 'three'] }),
    };

    const window = assembleResultWindow([second, first], { startRow: 1, rowCount: 2 });

    expect(window.table.schema.fields.map((field) => field.name)).toEqual(['value', 'label']);
    expect(window.table.getChild('value')!.toArray()).toEqual(Int32Array.from([1, 2]));
    expect(window.table.getChild('label')!.toArray()).toEqual(['one', 'two']);
  });

  it('retains duplicate labels across page slices, concatenation and rows beyond 16,384', () => {
    const pages = [
      duplicateLabelPage(0, 0, 8_192),
      duplicateLabelPage(1, 8_192, 8_192),
      duplicateLabelPage(2, 16_384, 8_192),
    ];
    const spanning = assembleResultWindow(pages, { startRow: 8_191, rowCount: 2 });
    const later = assembleResultWindow(pages, { startRow: 16_384, rowCount: 2 });

    expect(spanning.startRow).toBe(8_191);
    expect(spanning.table.schema.fields.map((field) => field.name)).toEqual(['c0', 'c1']);
    expect(spanning.table.schema.fields.map(resultColumnLabel)).toEqual(['dup', 'dup']);
    expect([...spanning.table.getChildAt(0)!]).toEqual([8_191, 8_192]);
    expect([...spanning.table.getChildAt(1)!]).toEqual(['row-8191', 'row-8192']);

    expect(later.startRow).toBe(16_384);
    expect(later.table.schema.fields.map(resultColumnLabel)).toEqual(['dup', 'dup']);
    expect(later.table.schema.fields.map((field) => field.type.toString())).toEqual(['Int32', 'Utf8']);
    expect([...later.table.getChildAt(0)!]).toEqual([16_384, 16_385]);
    expect([...later.table.getChildAt(1)!]).toEqual(['row-16384', 'row-16385']);
  });
});
