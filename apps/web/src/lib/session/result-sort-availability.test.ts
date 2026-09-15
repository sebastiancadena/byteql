import type { ResultSortCapability } from '@byteql/db';
import { Field, Int32, List, Schema, Table, Utf8 } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { resultSortDisabledReason } from './result-sort-availability.js';
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
