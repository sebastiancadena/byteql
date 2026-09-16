import { Field, Int32, Schema, Table, tableFromArrays } from 'apache-arrow';
import { describe, expect, it, vi } from 'vitest';

import { duplicateResultTable } from '../test-support/result-columns.js';
import { QueryPageStore } from './query-pages.js';
import { resultColumnLabel } from './result-columns.js';
import { StoredResultView } from './stored-result-view.js';
import type { QueryPageSummary, QueryResultView } from './types.js';

const pageTable = (values: number[]): Table => tableFromArrays({ value: Int32Array.from(values) });

const completeView = async (values: number[]): Promise<QueryResultView> => {
  const table = pageTable(values);
  const store = new QueryPageStore({ persistence: null });
  await store.put(0, 0, table);
  store.markComplete();
  return new StoredResultView(
    table.schema,
    store,
    [{ index: 0, startRow: 0, rowCount: values.length }],
    { elapsedMs: 7, sendCount: 1 },
    () => {},
  );
};

/** A multi-page view, to exercise contiguity and window reads across page boundaries. */
const pagedView = async (pages: number[][]): Promise<{ view: QueryResultView; store: QueryPageStore }> => {
  const store = new QueryPageStore({ persistence: null });
  const summaries: QueryPageSummary[] = [];
  let startRow = 0;
  for (const [index, values] of pages.entries()) {
    await store.put(index, startRow, pageTable(values));
    summaries.push({ index, startRow, rowCount: values.length });
    startRow += values.length;
  }
  store.markComplete();
  const view = new StoredResultView(
    pageTable(pages[0] ?? []).schema,
    store,
    summaries,
    { elapsedMs: 3, sendCount: 1 },
    () => {},
  );
  return { view, store };
};

describe('StoredResultView', () => {
  it('reads committed order without any cursor method', async () => {
    const view = await completeView([3, 1, 2]);
    expect(Array.from((await view.readPage(0)).table.getChildAt(0)!)).toEqual([3, 1, 2]);
    expect(view.status()).toMatchObject({ complete: true, loadedRows: 3, sendCount: 1 });
    await view.dispose();
    await expect(view.readPage(0)).rejects.toThrow(/closed|disposed/iu);
  });

  it('exposes no cursor demand surface at all', async () => {
    const view = await completeView([1]);
    for (const method of ['fetchNext', 'retryPending', 'cancel']) {
      expect((view as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
  });

  it('reports the original execution timing and send count, not the sort that built it', async () => {
    const view = await completeView([1, 2]);
    expect(view.status()).toMatchObject({ elapsedMs: 7, sendCount: 1 });
  });

  it('derives stored and decoded byte counts from its own store', async () => {
    const { view, store } = await pagedView([
      [1, 2],
      [3, 4],
    ]);
    expect(view.status().storedBytes).toBe(store.storedBytes);
    expect(view.status().decodedBytes).toBe(store.cachedDecodedBytes);
    expect(view.status().storedBytes).toBeGreaterThan(0);
  });

  it('hands out a copy of its summaries so a caller cannot mutate them', async () => {
    const view = await completeView([1, 2]);
    const pages = view.pages();
    expect(pages).toEqual([{ index: 0, startRow: 0, rowCount: 2 }]);
    (pages as QueryPageSummary[]).push({ index: 9, startRow: 99, rowCount: 1 });
    expect(view.pages()).toHaveLength(1);
  });

  it('reads every page of a multi-page view in committed order', async () => {
    const { view } = await pagedView([[5, 6], [7], [8, 9]]);
    expect(view.status()).toMatchObject({ loadedRows: 5, complete: true });
    const rows: number[] = [];
    for (const page of view.pages()) {
      rows.push(...Array.from((await view.readPage(page.index)).table.getChildAt(0)!));
    }
    expect(rows).toEqual([5, 6, 7, 8, 9]);
  });

  it('keeps a schema and reports no pages for an empty result', () => {
    const schema = new Schema([new Field('value', new Int32(), true)]);
    const view = new StoredResultView(
      schema,
      new QueryPageStore({ persistence: null }),
      [],
      { elapsedMs: 1, sendCount: 1 },
      () => {},
    );
    expect(view.schema).toBe(schema);
    expect(view.pages()).toEqual([]);
    expect(view.status()).toMatchObject({ loadedRows: 0, complete: true });
  });

  it('rejects summaries that are not contiguous from row zero', async () => {
    const store = new QueryPageStore({ persistence: null });
    await store.put(0, 0, pageTable([1, 2]));
    store.markComplete();
    const schema = pageTable([1]).schema;
    const build =
      (summaries: QueryPageSummary[]): (() => StoredResultView) =>
      () =>
        new StoredResultView(schema, store, summaries, { elapsedMs: 1, sendCount: 1 }, () => {});

    expect(build([{ index: 0, startRow: 1, rowCount: 2 }])).toThrow(/contiguous/iu);
    expect(
      build([
        { index: 0, startRow: 0, rowCount: 2 },
        { index: 1, startRow: 3, rowCount: 1 },
      ]),
    ).toThrow(/contiguous/iu);
    expect(build([{ index: 0, startRow: 0, rowCount: -1 }])).toThrow(/contiguous/iu);
  });

  it('rejects a page index it does not hold', async () => {
    const view = await completeView([1]);
    await expect(view.readPage(4)).rejects.toThrow(/not stored|out of range/iu);
  });

  it('materializes within a budget and declines above it', async () => {
    const { view } = await pagedView([
      [1, 2],
      [3, 4],
    ]);
    const table = await view.materialize();
    expect(Array.from(table!.getChildAt(0)!)).toEqual([1, 2, 3, 4]);
    expect(await view.materialize(1)).toBeNull();
  });

  it('retains duplicate logical labels while reading and materializing stored pages', async () => {
    const first = duplicateResultTable([10, 20], ['ten', 'twenty']);
    const second = duplicateResultTable([30], ['thirty']);
    const store = new QueryPageStore({ persistence: null });
    await store.put(0, 0, first);
    await store.put(1, 2, second);
    store.markComplete();
    const view = new StoredResultView(
      first.schema,
      store,
      [
        { index: 0, startRow: 0, rowCount: 2 },
        { index: 1, startRow: 2, rowCount: 1 },
      ],
      { elapsedMs: 1, sendCount: 1 },
      () => {},
    );

    const stored = (await view.readPage(1)).table;
    expect(stored.schema.fields.map((field) => field.name)).toEqual(['c0', 'c1']);
    expect(stored.schema.fields.map(resultColumnLabel)).toEqual(['dup', 'dup']);
    expect(stored.getChildAt(0)!.get(0)).toBe(30);
    expect(stored.getChildAt(1)!.get(0)).toBe('thirty');

    const materialized = await view.materialize();
    expect(materialized!.schema.fields.map(resultColumnLabel)).toEqual(['dup', 'dup']);
    expect([...materialized!.getChildAt(0)!]).toEqual([10, 20, 30]);
    expect([...materialized!.getChildAt(1)!]).toEqual(['ten', 'twenty', 'thirty']);
  });

  it('pins pages through to the store', async () => {
    const { view, store } = await pagedView([[1], [2]]);
    const pin = vi.spyOn(store, 'pin');
    view.pinPages([1]);
    expect(pin).toHaveBeenCalledWith([1]);
  });

  it('disposes its own store exactly once and notifies its owner once', async () => {
    const table = pageTable([1]);
    const store = new QueryPageStore({ persistence: null });
    await store.put(0, 0, table);
    store.markComplete();
    const dispose = vi.spyOn(store, 'dispose');
    const onDisposed = vi.fn();
    const view = new StoredResultView(
      table.schema,
      store,
      [{ index: 0, startRow: 0, rowCount: 1 }],
      { elapsedMs: 1, sendCount: 1 },
      onDisposed,
    );

    await Promise.all([view.dispose(), view.dispose()]);
    await view.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(onDisposed).toHaveBeenCalledTimes(1);
  });

  it('leaves a sibling view untouched when one is disposed', async () => {
    const first = await completeView([1]);
    const second = await completeView([2]);
    await first.dispose();
    expect(Array.from((await second.readPage(0)).table.getChildAt(0)!)).toEqual([2]);
  });

  it('waits for an in-flight page read before its store is released', async () => {
    const table = pageTable([1, 2]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new QueryPageStore({
      persistence: {
        write: async () => undefined,
        read: async () => {
          await gate;
          const { tableToIPC } = await import('apache-arrow');
          return tableToIPC(table, 'stream');
        },
        dispose: async () => undefined,
      },
    });
    await store.put(0, 0, table);
    store.markComplete();
    store.pin([]);
    const view = new StoredResultView(
      table.schema,
      store,
      [{ index: 0, startRow: 0, rowCount: 2 }],
      { elapsedMs: 1, sendCount: 1 },
      () => {},
    );

    const settled: string[] = [];
    const read = view.readPage(0).then(
      () => settled.push('read'),
      () => settled.push('read'),
    );
    const disposal = view.dispose().then(() => settled.push('disposed'));
    release();
    await Promise.all([read, disposal]);
    expect(settled).toEqual(['read', 'disposed']);
  });
});
