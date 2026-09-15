// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { Field, Int32, RecordBatch, Schema, Table, Utf8, tableFromArrays } from 'apache-arrow';
import { readable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const virtualizer = {
  getTotalSize: () => 3 * 36,
  getVirtualItems: () => [
    { index: 0, key: '0', start: 0, size: 36, end: 36, lane: 0 },
    { index: 1, key: '1', start: 36, size: 36, end: 72, lane: 0 },
  ],
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
  setOptions: vi.fn(),
};

vi.mock('@tanstack/svelte-virtual', () => ({
  createVirtualizer: () => readable(virtualizer),
}));

import ResultGrid from './ResultGrid.svelte';

const table = tableFromArrays({
  value: Int32Array.from([30, 10, 20]),
  _src_start: Int32Array.from([0, 4, 8]),
});

const props = (overrides: Record<string, unknown> = {}) => ({
  table,
  windowStart: 0,
  loadedRows: table.numRows,
  complete: true,
  loadingMore: false,
  pageError: null,
  pageErrorRetryable: false,
  orderRevision: 0,
  sort: null,
  sortBusy: false,
  sortInteractionBlocked: false,
  sortDisabledReason: null,
  onselect: vi.fn(),
  onloadmore: vi.fn(),
  onloadwindow: vi.fn(),
  onretry: vi.fn(),
  onsort: vi.fn(),
  ...overrides,
});

describe('ResultGrid sort controls', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('cycles ascending, descending and back to query order from the keyboard', async () => {
    const onsort = vi.fn();
    const first = render(ResultGrid, props({ onsort }));
    const header = first.getByRole('button', { name: 'Sort value ascending' });
    await fireEvent.click(header);
    expect(onsort).toHaveBeenLastCalledWith({ columnIndex: 0, direction: 'asc' });
    first.unmount();

    const second = render(
      ResultGrid,
      props({ onsort, sort: { columnIndex: 0, direction: 'asc' }, orderRevision: 1 }),
    );
    await fireEvent.click(second.getByRole('button', { name: 'Sort value descending' }));
    expect(onsort).toHaveBeenLastCalledWith({ columnIndex: 0, direction: 'desc' });
    second.unmount();

    const third = render(
      ResultGrid,
      props({ onsort, sort: { columnIndex: 0, direction: 'desc' }, orderRevision: 2 }),
    );
    await fireEvent.click(third.getByRole('button', { name: 'Restore query order' }));
    expect(onsort).toHaveBeenLastCalledWith(null);
  });

  it('marks exactly one header with aria-sort, matching the committed direction', () => {
    const { container, rerender } = render(
      ResultGrid,
      props({ sort: { columnIndex: 0, direction: 'asc' }, orderRevision: 1 }),
    );
    expect(container.querySelectorAll('[role="columnheader"][aria-sort]')).toHaveLength(1);
    expect(container.querySelector('[role="columnheader"][aria-sort]')?.getAttribute('aria-sort')).toBe(
      'ascending',
    );

    void rerender(props({ sort: { columnIndex: 0, direction: 'desc' }, orderRevision: 2 }));
    expect(container.querySelector('[role="columnheader"][aria-sort]')?.getAttribute('aria-sort')).toBe(
      'descending',
    );
  });

  it('leaves every header unmarked in original query order', () => {
    const { container } = render(ResultGrid, props());
    expect(container.querySelectorAll('[role="columnheader"][aria-sort]')).toHaveLength(0);
  });

  it('keeps a hidden column sortable and its committed order visible', async () => {
    const onsort = vi.fn();
    const { container, getByRole } = render(
      ResultGrid,
      props({ onsort, sort: { columnIndex: 1, direction: 'asc' }, orderRevision: 1 }),
    );
    // The active key is hidden, so no header shows it — but hiding a column never clears its sort.
    expect(container.querySelectorAll('[role="columnheader"]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="columnheader"][aria-sort]')).toHaveLength(0);

    await fireEvent.click(getByRole('button', { name: 'Toggle hidden columns' }));
    expect(container.querySelectorAll('[role="columnheader"][aria-sort]')).toHaveLength(1);
    await fireEvent.click(getByRole('button', { name: 'Sort _src_start descending' }));
    expect(onsort).toHaveBeenCalledWith({ columnIndex: 1, direction: 'desc' });
  });

  it('addresses duplicate column names by position', async () => {
    const onsort = vi.fn();
    const schema = new Schema([new Field('dup', new Int32(), true), new Field('dup', new Utf8(), true)]);
    const built = new Table({
      a: tableFromArrays({ a: Int32Array.from([1, 2]) }).getChildAt(0)!,
      b: tableFromArrays({ b: ['x', 'y'] }).getChildAt(0)!,
    });
    const batch = new RecordBatch(schema, built.batches[0]!.data);
    const duplicates = new Table(batch.schema, [batch]);

    const { getByRole } = render(ResultGrid, props({ table: duplicates, loadedRows: 2, onsort }));
    await fireEvent.click(getByRole('button', { name: 'Sort dup, column 2, ascending' }));
    expect(onsort).toHaveBeenCalledWith({ columnIndex: 1, direction: 'asc' });
  });

  it('refuses activation while the grid is blocked, and says why it is unavailable', async () => {
    const onsort = vi.fn();
    const { container, getByRole } = render(ResultGrid, props({ onsort, sortInteractionBlocked: true }));
    const header = getByRole('button', { name: 'Sort value ascending' });
    expect(header.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(header);
    expect(onsort).not.toHaveBeenCalled();
    expect(container.querySelector('#result-sort-help')).not.toBeNull();
  });

  it('refuses a new sort when the result cannot be sorted, but still allows restoring order', async () => {
    const onsort = vi.fn();
    const reason = 'Column sorting is unavailable: column 1 has unsupported type List<Int32>.';
    const { container, getByRole, rerender } = render(
      ResultGrid,
      props({ onsort, sortDisabledReason: reason }),
    );
    await fireEvent.click(getByRole('button', { name: 'Sort value ascending' }));
    expect(onsort).not.toHaveBeenCalled();
    expect(container.querySelector('#result-sort-help')?.textContent).toContain(reason);

    // Restoration needs no storage, no ordering and no supported types — only the retained base.
    void rerender(props({ onsort, sortDisabledReason: reason, sort: { columnIndex: 0, direction: 'desc' } }));
    await fireEvent.click(getByRole('button', { name: 'Restore query order' }));
    expect(onsort).toHaveBeenCalledWith(null);
  });

  it('suppresses row selection and reports busy while a sort runs', async () => {
    const onselect = vi.fn();
    const { container } = render(ResultGrid, props({ onselect, sortBusy: true }));
    expect(container.querySelector('[role="grid"]')?.getAttribute('aria-busy')).toBe('true');
    await fireEvent.click(container.querySelector('[data-row-index="0"]')!);
    expect(onselect).not.toHaveBeenCalled();
  });

  it('keeps the same grid element and hidden-column state across an order change', async () => {
    const { container, getByRole, rerender } = render(ResultGrid, props());
    await fireEvent.click(getByRole('button', { name: 'Toggle hidden columns' }));
    expect(container.querySelectorAll('[role="columnheader"]')).toHaveLength(2);
    const grid = container.querySelector('[role="grid"]');
    const scroll = container.querySelector('.grid-scroll') as HTMLElement;
    scroll.scrollLeft = 120;

    void rerender(props({ orderRevision: 1, sort: { columnIndex: 0, direction: 'asc' } }));

    expect(container.querySelector('[role="grid"]')).toBe(grid);
    expect(container.querySelectorAll('[role="columnheader"]')).toHaveLength(2);
    expect(scroll.scrollLeft).toBe(120);
    expect(scroll.scrollTop).toBe(0);
  });

  it('asks for the next stored window rather than more cursor rows in a complete result', () => {
    const onloadwindow = vi.fn();
    const onloadmore = vi.fn();
    render(
      ResultGrid,
      props({
        onloadwindow,
        onloadmore,
        loadedRows: 50_000,
        complete: true,
        windowStart: 0,
      }),
    );
    expect(onloadmore).not.toHaveBeenCalled();
    expect(onloadwindow).toHaveBeenCalledWith(table.numRows);
  });

  it('tells the reader that stored rows remain past the current window', () => {
    const { getByText } = render(ResultGrid, props({ loadedRows: 50_000, complete: true, windowStart: 0 }));
    expect(getByText('More stored rows')).toBeTruthy();
  });
});
