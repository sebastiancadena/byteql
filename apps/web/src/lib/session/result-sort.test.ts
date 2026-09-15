import type { ResultSortCapability } from '@byteql/db';
import { Field, Int32, List, Schema, Table, Utf8 } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import {
  isResultSorting,
  nextResultSort,
  resultSortDisabledReason,
  resultSortInteractionBlocked,
  sortActionLabel,
} from './result-sort.js';
import { initialSessionState, type PagedResultState, type SessionState } from './state.js';

const schema = new Schema([new Field('velocity', new Int32(), true), new Field('note', new Utf8(), true)]);

const supported: ResultSortCapability = { supported: true };

const result = (overrides: Partial<PagedResultState> = {}): PagedResultState => ({
  generation: 1,
  schema,
  loadedRows: 10,
  complete: true,
  loadingMore: false,
  windowStart: 0,
  window: new Table(schema),
  completeTable: null,
  elapsedMs: 5,
  pageError: null,
  pageErrorRetryable: false,
  orderRevision: 0,
  sort: null,
  ...overrides,
});

const ready = (overrides: Partial<SessionState> = {}): SessionState => ({
  ...initialSessionState,
  phase: 'ready',
  resultIsCurrent: true,
  result: result(),
  ...overrides,
});

describe('nextResultSort', () => {
  it('cycles one field and starts another ascending', () => {
    expect(nextResultSort(null, 2)).toEqual({ columnIndex: 2, direction: 'asc' });
    expect(nextResultSort({ columnIndex: 2, direction: 'asc' }, 2)).toEqual({
      columnIndex: 2,
      direction: 'desc',
    });
    expect(nextResultSort({ columnIndex: 2, direction: 'desc' }, 2)).toBeNull();
    expect(nextResultSort({ columnIndex: 2, direction: 'desc' }, 5)).toEqual({
      columnIndex: 5,
      direction: 'asc',
    });
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'rejects the invalid column index %s',
    (columnIndex) => {
      expect(() => nextResultSort(null, columnIndex)).toThrow(RangeError);
    },
  );
});

describe('sortActionLabel', () => {
  it('names the next action rather than the current state', () => {
    expect(sortActionLabel(schema, null, 0)).toBe('Sort velocity ascending');
    expect(sortActionLabel(schema, { columnIndex: 0, direction: 'asc' }, 0)).toBe('Sort velocity descending');
    expect(sortActionLabel(schema, { columnIndex: 0, direction: 'desc' }, 0)).toBe('Restore query order');
    expect(sortActionLabel(schema, { columnIndex: 0, direction: 'desc' }, 1)).toBe('Sort note ascending');
  });

  it('distinguishes duplicate names by schema position', () => {
    const duplicates = new Schema([new Field('dup', new Int32(), true), new Field('dup', new Utf8(), true)]);
    expect(sortActionLabel(duplicates, null, 0)).toBe('Sort dup, column 1, ascending');
    expect(sortActionLabel(duplicates, null, 1)).toBe('Sort dup, column 2, ascending');
  });
});

describe('isResultSorting', () => {
  it.each(['loading', 'staging', 'sorting', 'storing', 'cancelling'] as const)(
    'is true during %s',
    (phase) => {
      expect(
        isResultSorting(
          ready({
            sorting: {
              requestId: 1,
              queryGeneration: 1,
              fromRevision: 0,
              requestedSort: { columnIndex: 0, direction: 'asc' },
              phase,
              rows: 0,
              totalRows: null,
              message: '',
            },
          }),
        ),
      ).toBe(true);
    },
  );

  it('is false once the operation has failed, and when none is pending', () => {
    expect(isResultSorting(ready())).toBe(false);
    expect(
      isResultSorting(
        ready({
          sorting: {
            requestId: 1,
            queryGeneration: 1,
            fromRevision: 0,
            requestedSort: null,
            phase: 'failed',
            rows: 0,
            totalRows: null,
            message: 'nope',
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('resultSortInteractionBlocked', () => {
  it('allows interaction on a current, idle, ready result', () => {
    expect(resultSortInteractionBlocked(ready())).toBe(false);
  });

  it('blocks a result left visible after a failed query', () => {
    expect(resultSortInteractionBlocked(ready({ resultIsCurrent: false }))).toBe(true);
  });

  it('blocks while the session is busy with something else', () => {
    expect(resultSortInteractionBlocked(ready({ phase: 'querying' }))).toBe(true);
  });

  it('blocks while a sort is already running', () => {
    expect(
      resultSortInteractionBlocked(
        ready({
          sorting: {
            requestId: 1,
            queryGeneration: 1,
            fromRevision: 0,
            requestedSort: null,
            phase: 'sorting',
            rows: 0,
            totalRows: null,
            message: '',
          },
        }),
      ),
    ).toBe(true);
  });

  it.each(['picking', 'loading', 'encoding', 'saving', 'cancelling', 'ready-to-save'] as const)(
    'blocks while a download is in the %s phase',
    (phase) => {
      expect(
        resultSortInteractionBlocked(
          ready({
            download: { generation: 1, phase, rows: 0, totalRows: null, bytes: 0, message: null },
          }),
        ),
      ).toBe(true);
    },
  );

  it.each(['saved', 'cancelled', 'failed'] as const)(
    'allows interaction once a download has finished in the %s phase',
    (phase) => {
      expect(
        resultSortInteractionBlocked(
          ready({
            download: { generation: 1, phase, rows: 0, totalRows: null, bytes: 0, message: null },
          }),
        ),
      ).toBe(false);
    },
  );
});

describe('resultSortDisabledReason', () => {
  it('permits sorting a supported, current, multi-row result', () => {
    expect(resultSortDisabledReason(ready(), supported)).toBeNull();
  });

  it('reports the runtime or storage reason the database gave', () => {
    const unavailable: ResultSortCapability = { supported: false, reason: 'no local storage' };
    expect(resultSortDisabledReason(ready(), unavailable)).toBe('no local storage');
  });

  it('names the first unsupported field and its 1-based position', () => {
    const nested = new Schema([
      new Field('value', new Int32(), true),
      new Field('details', new List(new Field('item', new Int32(), true)), true),
    ]);
    expect(resultSortDisabledReason(ready({ result: result({ schema: nested }) }), supported)).toBe(
      'Column sorting is unavailable: column 2 \u201Cdetails\u201D has unsupported type ' +
        'List<Int32>. Cast it in SQL and run again.',
    );
  });

  it('offers nothing to sort for a complete result of one row or fewer', () => {
    expect(resultSortDisabledReason(ready({ result: result({ loadedRows: 1 }) }), supported)).toMatch(
      /one row|nothing to sort/iu,
    );
    expect(resultSortDisabledReason(ready({ result: result({ loadedRows: 0 }) }), supported)).toMatch(
      /one row|nothing to sort/iu,
    );
  });

  it('still allows sorting an incomplete result, which the sort itself will drain', () => {
    expect(
      resultSortDisabledReason(ready({ result: result({ loadedRows: 1, complete: false }) }), supported),
    ).toBeNull();
  });

  it('refuses while a page error stands', () => {
    expect(
      resultSortDisabledReason(
        ready({ result: result({ pageError: 'storage full', pageErrorRetryable: true }) }),
        supported,
      ),
    ).toMatch(/retry|rerun|rows/iu);
  });

  it('refuses when there is no result at all', () => {
    expect(resultSortDisabledReason({ ...initialSessionState, phase: 'ready' }, supported)).toMatch(
      /run a query|no result/iu,
    );
  });
});
