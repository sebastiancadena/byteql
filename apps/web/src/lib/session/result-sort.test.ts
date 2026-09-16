import { Field, Int32, Schema, Table, Utf8 } from 'apache-arrow';
import { RESULT_LABEL_METADATA_KEY } from '@byteql/db/result-columns';
import { describe, expect, it } from 'vitest';

import {
  isResultSorting,
  nextResultSort,
  resultSortInteractionBlocked,
  sortActionLabel,
  sameResultSchema,
} from './result-sort.js';
import { initialSessionState, type PagedResultState, type SessionState } from './state.js';

const schema = new Schema([new Field('velocity', new Int32(), true), new Field('note', new Utf8(), true)]);

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

  it('distinguishes repeated SQL labels by schema position', () => {
    const duplicates = new Schema([
      new Field('c0', new Int32(), true, new Map([[RESULT_LABEL_METADATA_KEY, 'dup']])),
      new Field('c1', new Utf8(), true, new Map([[RESULT_LABEL_METADATA_KEY, 'dup']])),
    ]);
    expect(sortActionLabel(duplicates, null, 0)).toBe('Sort dup, column 1, ascending');
    expect(sortActionLabel(duplicates, null, 1)).toBe('Sort dup, column 2, ascending');
  });

  it('uses a positional accessible fallback for an empty SQL label', () => {
    const empty = new Schema([
      new Field('c0', new Int32(), true, new Map([[RESULT_LABEL_METADATA_KEY, '']])),
    ]);
    expect(sortActionLabel(empty, null, 0)).toBe('Sort column 1 ascending');
  });
});

describe('sameResultSchema', () => {
  it('detects changed SQL labels even when physical fields and types match', () => {
    const left = new Schema([
      new Field('c0', new Int32(), true, new Map([[RESULT_LABEL_METADATA_KEY, 'first']])),
      new Field('c1', new Utf8(), true, new Map([[RESULT_LABEL_METADATA_KEY, 'second']])),
    ]);
    const right = new Schema([
      new Field('c0', new Int32(), true, new Map([[RESULT_LABEL_METADATA_KEY, 'other']])),
      new Field('c1', new Utf8(), true, new Map([[RESULT_LABEL_METADATA_KEY, 'second']])),
    ]);

    expect(sameResultSchema(left, right)).toBe(false);
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

  it.each(['picking', 'loading', 'encoding', 'saving', 'cancelling'] as const)(
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

  it.each(['ready-to-save', 'saved', 'cancelled', 'failed'] as const)(
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
