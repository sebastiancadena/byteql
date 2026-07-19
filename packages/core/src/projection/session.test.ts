import { describe, expect, it } from 'vitest';
import type { Table } from 'apache-arrow';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import { createProjectionSession } from './session.js';

// Reads every row of a column via `.get(i)`, which works uniformly across numeric,
// bigint, and utf8 vectors (unlike `.toArray()`, whose return shape varies by type).
const columnValues = (arrow: Table, column: string): unknown[] =>
  Array.from({ length: arrow.numRows }, (_, index) => arrow.getChild(column)!.get(index));

const spec = parseProjectionSpec(`
version: '0.1'
format: fixture
tables:
  - name: items
    rows: $.items[*]
    key: item_id
    columns:
      value: { expr: '_.value', type: int32 }
  - name: meta
    rows: $.meta
    key: meta_id
    columns:
      label: { expr: '_.label', type: utf8 }
`);
const compiled = compileProjection(spec);
const resolver = { resolve: () => ({ start: 0, end: 1 }) };

describe('createProjectionSession', () => {
  it('continues key numbering across project() calls', () => {
    const session = createProjectionSession(compiled);
    session.project({ items: [{ value: 10 }, { value: 20 }], meta: { label: 'a' } }, resolver);
    session.project({ items: [{ value: 30 }] }, resolver);
    const finished = session.finish();
    const items = finished.find((table) => table.name === 'items')!;
    expect(items.rowCount).toBe(3);
    expect(items.arrow.getChild('item_id')!.toArray()).toEqual(new BigInt64Array([1n, 2n, 3n]));
    expect(items.arrow.getChild('value')!.toArray()).toEqual(new Int32Array([10, 20, 30]));
  });

  it('limits emission to the requested table subset', () => {
    const session = createProjectionSession(compiled);
    session.project({ items: [{ value: 1 }], meta: { label: 'a' } }, resolver);
    session.project({ items: [{ value: 2 }], meta: { label: 'DUPLICATE' } }, resolver, { tables: ['items'] });
    const finished = session.finish();
    expect(finished.find((table) => table.name === 'meta')!.rowCount).toBe(1);
    expect(finished.find((table) => table.name === 'items')!.rowCount).toBe(2);
  });

  it('returns empty tables when nothing was projected', () => {
    const finished = createProjectionSession(compiled).finish();
    expect(finished.map((table) => table.name)).toEqual(['items', 'meta']);
    expect(finished.every((table) => table.rowCount === 0)).toBe(true);
  });

  it('flushes incremental batches at the configured threshold', () => {
    const session = createProjectionSession(compiled, { flushRowThreshold: 2 });
    session.project({ items: [{ value: 1 }, { value: 2 }, { value: 3 }] }, resolver);
    const items = session.finish().find((table) => table.name === 'items')!;
    expect(items.arrow.batches.length).toBe(2);
    expect(items.rowCount).toBe(3);
  });

  it('accumulates file-scoped ($) state across project() calls instead of resetting per call', () => {
    // A ProjectionSession models one source document: state registers persist across
    // project() calls, and resets stay scope-index-driven. A `$`-scoped register's scope
    // index never changes across calls, so it must keep accumulating rather than
    // restarting from `init` on every call.
    const statefulSpec = parseProjectionSpec(`
version: '0.1'
format: fixture
tables:
  - name: items
    rows: $.items[*]
    key: item_id
    state:
      total: { scope: '$', init: 0, update: 'total + 1' }
    columns:
      total: { expr: 'total', type: int32 }
`);
    const statefulCompiled = compileProjection(statefulSpec);
    const session = createProjectionSession(statefulCompiled);
    session.project({ items: [{ value: 1 }] }, resolver);
    session.project({ items: [{ value: 2 }] }, resolver);
    const items = session.finish().find((table) => table.name === 'items')!;
    expect(items.arrow.getChild('total')!.toArray()).toEqual(new Int32Array([1, 2]));
  });

  it('drain emits incremental batches whose union equals a one-shot projection', () => {
    const roots = [
      { items: [{ value: 10 }], meta: { label: 'a' } },
      { items: [{ value: 20 }, { value: 30 }], meta: { label: 'b' } },
      { items: [{ value: 40 }], meta: { label: 'c' } },
    ];

    const draining = createProjectionSession(compiled);
    const drainedItemIds: unknown[] = [];
    const drainedItemValues: unknown[] = [];
    const drainedMetaLabels: unknown[] = [];
    for (const root of roots) {
      draining.project(root, resolver);
      for (const batch of draining.drain()) {
        if (batch.name === 'items') {
          drainedItemIds.push(...columnValues(batch.arrow, 'item_id'));
          drainedItemValues.push(...columnValues(batch.arrow, 'value'));
        } else if (batch.name === 'meta') {
          drainedMetaLabels.push(...columnValues(batch.arrow, 'label'));
        }
      }
    }
    // Nothing left undrained: a trailing finish() returns zero-row arrows for every table.
    // (Its `rowCount` field stays cumulative by finish()'s existing contract — see the
    // ProjectionSession.drain() doc comment — so the undrained check is on `arrow.numRows`.)
    expect(draining.finish().every((table) => table.arrow.numRows === 0)).toBe(true);

    const oneShot = createProjectionSession(compiled);
    for (const root of roots) oneShot.project(root, resolver);
    const finished = oneShot.finish();
    const items = finished.find((table) => table.name === 'items')!;
    const meta = finished.find((table) => table.name === 'meta')!;

    expect(drainedItemIds).toEqual(columnValues(items.arrow, 'item_id'));
    expect(drainedItemValues).toEqual(columnValues(items.arrow, 'value'));
    expect(drainedMetaLabels).toEqual(columnValues(meta.arrow, 'label'));
    // Synthetic keys keep increasing across drains rather than resetting per batch.
    expect(drainedItemIds).toEqual([1n, 2n, 3n, 4n]);
  });

  it('pendingRowCount counts appended rows since the last drain', () => {
    const session = createProjectionSession(compiled);
    expect(session.pendingRowCount()).toBe(0);
    session.project({ items: [{ value: 1 }, { value: 2 }], meta: { label: 'a' } }, resolver);
    expect(session.pendingRowCount()).toBe(3); // 2 items + 1 meta row
    session.project({ items: [{ value: 3 }] }, resolver);
    expect(session.pendingRowCount()).toBe(4);
    session.drain();
    expect(session.pendingRowCount()).toBe(0);
    session.project({ items: [{ value: 4 }] }, resolver);
    expect(session.pendingRowCount()).toBe(1);
  });
});
