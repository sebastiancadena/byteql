import type { QueryPage, QueryPageSummary, QueryResultView } from '@byteql/db';
import { Field, Int32, Schema, Table, tableFromArrays } from 'apache-arrow';
import { describe, expect, it, vi } from 'vitest';

import { readResultWindow } from './result-view.js';
import { RESULT_WINDOW_ROWS } from './result-window.js';

const PAGE_ROWS = 8_192;

/** A view whose pages are generated on demand, so a million rows cost nothing to describe. */
const generatedView = (
  totalRows: number,
  options: { complete?: boolean; onRead?: (index: number) => void } = {},
): QueryResultView & { pinned: number[][] } => {
  const summaries: QueryPageSummary[] = [];
  for (let startRow = 0; startRow < totalRows; startRow += PAGE_ROWS) {
    summaries.push({
      index: summaries.length,
      startRow,
      rowCount: Math.min(PAGE_ROWS, totalRows - startRow),
    });
  }
  const pinned: number[][] = [];
  const schema = tableFromArrays({ value: Int32Array.from([0]) }).schema;
  return {
    pinned,
    schema,
    status: () => ({
      loadedRows: totalRows,
      complete: options.complete ?? true,
      elapsedMs: 12,
      storedBytes: 1,
      decodedBytes: 1,
      sendCount: 1,
    }),
    pages: () => summaries,
    readPage: async (index: number): Promise<QueryPage> => {
      options.onRead?.(index);
      const summary = summaries[index]!;
      return {
        ...summary,
        table: tableFromArrays({
          value: Int32Array.from({ length: summary.rowCount }, (_, offset) => summary.startRow + offset),
        }),
      };
    },
    pinPages: (indexes: readonly number[]) => pinned.push([...indexes]),
    materialize: vi.fn(),
    dispose: vi.fn(),
  } as unknown as QueryResultView & { pinned: number[][] };
};

describe('readResultWindow', () => {
  it('centres a bounded window on the anchor and reads only the pages it covers', async () => {
    const reads: number[] = [];
    const view = generatedView(100_000, { onRead: (index) => reads.push(index) });

    const window = await readResultWindow(view, 50_000);

    expect(window.window.numRows).toBe(RESULT_WINDOW_ROWS);
    expect(window.windowStart).toBe(50_000 - RESULT_WINDOW_ROWS / 2);
    expect(window.loadedRows).toBe(100_000);
    expect(window.complete).toBe(true);
    expect(window.elapsedMs).toBe(12);
    expect(window.schema).toBe(view.schema);
    // Three 8,192-row pages cover a 16,384-row window that starts mid-page; never the whole result.
    expect(reads.length).toBeLessThanOrEqual(3);
    expect(view.pinned.at(-1)).toEqual(reads);
    expect(Array.from(window.window.getChildAt(0)!).slice(0, 1)).toEqual([window.windowStart]);
  });

  it('clamps the tail window of a million-row result to the last rows', async () => {
    const view = generatedView(1_000_000);
    const window = await readResultWindow(view, 999_999);

    expect(window.window.numRows).toBe(RESULT_WINDOW_ROWS);
    expect(window.windowStart).toBe(1_000_000 - RESULT_WINDOW_ROWS);
    expect(Array.from(window.window.getChildAt(0)!).at(-1)).toBe(999_999);
  });

  it('clamps an anchor beyond the end and below zero', async () => {
    const view = generatedView(10);
    expect((await readResultWindow(view, 9_999)).windowStart).toBe(0);
    expect((await readResultWindow(view, -5)).windowStart).toBe(0);
    expect((await readResultWindow(view, 4)).window.numRows).toBe(10);
  });

  it('returns a schemaful empty window for a result with no rows', async () => {
    const schema = new Schema([new Field('value', new Int32(), true)]);
    const view = {
      schema,
      status: () => ({
        loadedRows: 0,
        complete: true,
        elapsedMs: 3,
        storedBytes: 0,
        decodedBytes: 0,
        sendCount: 1,
      }),
      pages: () => [],
      readPage: vi.fn(),
      pinPages: vi.fn(),
      materialize: vi.fn(),
      dispose: vi.fn(),
    } as unknown as QueryResultView;

    const window = await readResultWindow(view, 0);
    expect(window.window).toBeInstanceOf(Table);
    expect(window.window.numRows).toBe(0);
    expect(window.window.schema).toBe(schema);
    expect(view.readPage).not.toHaveBeenCalled();
  });

  it('propagates a page read failure to its caller', async () => {
    const view = generatedView(10_000, {
      onRead: () => {
        throw new Error('page unavailable');
      },
    });
    await expect(readResultWindow(view, 0)).rejects.toThrow(/page unavailable/iu);
  });

  it('reads an incomplete result without pretending it is finished', async () => {
    const view = generatedView(8_192, { complete: false });
    const window = await readResultWindow(view, 0);
    expect(window.complete).toBe(false);
    expect(window.loadedRows).toBe(8_192);
  });
});
