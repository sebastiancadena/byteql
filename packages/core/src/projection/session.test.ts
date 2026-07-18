import { describe, expect, it } from 'vitest';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import { createProjectionSession } from './session.js';

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
});
