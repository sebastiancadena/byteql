import { describe, expect, it } from 'vitest';
import { IssueCollector } from '../issues.js';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import { createProjectionSession } from './session.js';
import type { ParserRegistry } from './parsers.js';

// Envelope fixture: outer records carry a kind selector and a payload; kind 1
// payloads parse into items, whose trailer chains onward into a grandchild.
const yaml = `
version: '0.2'
format: envelope
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      kind: { expr: '_.kind', type: uint8 }
  - name: inner
    rows: $.items[*]
    key: inner_id
    parent_key: { table: records, column: record_id }
    columns:
      label: { expr: '_.label', type: utf8 }
  - name: deep
    rows: $.parts[*]
    key: deep_id
    parent_key: { table: records, column: record_id }
    columns:
      flag: { expr: '_.flag', type: bool }
dissect:
  - from: records
    payload: _.body
    chain:
      - { when: '_.kind == 0x01', parser: inner_parser, table: inner }
      - { when: '_.kind == 0x02', parser: never_parser, table: deep }
  - from: inner_parser
    payload: _.trailer
    chain:
      - { when: '_.has_parts', parser: deep_parser, table: deep }
`;

const innerParser = (bytes: Uint8Array) => ({
  root: {
    items: [{ label: `item-${bytes[0]}` }, { label: `item-${bytes[0]}-b` }],
    has_parts: bytes[0] === 7,
    trailer: { bytes: Uint8Array.of(9), start: 900 },
  },
  resolve: (_table: string, match: { readonly indexes: readonly number[] }) => ({
    start: match.indexes[0]! * 10,
    end: match.indexes[0]! * 10 + 5,
  }),
});

const registry: ParserRegistry = new Map([
  ['inner_parser', innerParser],
  ['never_parser', () => ({ root: {} })],
  ['deep_parser', () => ({ root: { parts: [{ flag: true }] } })],
]);

const resolver = { resolve: () => ({ start: 0, end: 4 }) };

const project = (records: unknown[], issues = new IssueCollector()) => {
  const compiled = compileProjection(parseProjectionSpec(yaml), registry);
  const session = createProjectionSession(compiled, { issues });
  session.project({ records }, resolver);
  return { finished: session.finish(), issues };
};

describe('dissect execution', () => {
  it('projects chained child tables with parent keys and composed provenance', () => {
    const { finished } = project([
      { kind: 1, body: { bytes: Uint8Array.of(7), start: 100 } },
      { kind: 1, body: { bytes: Uint8Array.of(7), start: 200 } },
    ]);
    const inner = finished.find((table) => table.name === 'inner')!;
    expect(inner.rowCount).toBe(4);
    expect(inner.arrow.getChild('record_id')!.toArray()).toEqual(new BigInt64Array([1n, 1n, 2n, 2n]));
    expect(inner.arrow.getChild('label')!.get(0)).toBe('item-7');
    expect(inner.arrow.getChild('label')!.get(2)).toBe('item-7');
    // resolve(start 0*10) + payload.start 100 (root-table dissect: base 0, so absolute unchanged)
    expect(inner.arrow.getChild('_src_start')!.toArray()).toEqual(
      new BigUint64Array([100n, 110n, 200n, 210n]),
    );
    expect(inner.arrow.getChild('_src_end')!.toArray()).toEqual(new BigUint64Array([105n, 115n, 205n, 215n]));

    // Grandchild fires for both records now that both bodies produce has_parts: true.
    // Provenance composes: the inner_parser's trailer.start (900) is relative to the
    // *inner payload*, so the absolute value differs per parent (100 + 900, 200 + 900) —
    // proof the engine threads the enclosing base offset rather than treating every
    // payload's `start` as file-absolute.
    const deep = finished.find((table) => table.name === 'deep')!;
    expect(deep.rowCount).toBe(2);
    expect(deep.arrow.getChild('record_id')!.toArray()).toEqual(new BigInt64Array([1n, 2n]));
    // deep_parser has no resolve → whole trailer payload range, composed against each
    // parent's absolute inner-payload base.
    expect(deep.arrow.getChild('_src_start')!.toArray()).toEqual(new BigUint64Array([1000n, 1100n]));
    expect(deep.arrow.getChild('_src_end')!.toArray()).toEqual(new BigUint64Array([1001n, 1101n]));
  });

  it('leaves the parent childless when no guard matches, without reporting an issue', () => {
    const { finished, issues } = project([{ kind: 9, body: { bytes: Uint8Array.of(1), start: 0 } }]);
    expect(finished.find((table) => table.name === 'inner')!.rowCount).toBe(0);
    expect(issues.issues()).toHaveLength(0);
  });

  it('fires only the first matching guard', () => {
    // kind 1 matches link 0; never_parser (link 1) must not run (it would throw the deep row count off).
    const { finished } = project([{ kind: 1, body: { bytes: Uint8Array.of(2), start: 0 } }]);
    expect(finished.find((table) => table.name === 'deep')!.rowCount).toBe(0);
  });

  it('reports an issue and continues when the payload is not a byte range', () => {
    const { finished, issues } = project([{ kind: 1, body: 'not-a-range' }]);
    expect(finished.find((table) => table.name === 'records')!.rowCount).toBe(1);
    expect(issues.issues()).toEqual([
      expect.objectContaining({ stage: 'dissecting', code: 'DISSECT_PAYLOAD_INVALID', recoverable: true }),
    ]);
  });

  it('reports an issue and continues when a child parser throws', () => {
    const throwingRegistry = new Map(registry);
    throwingRegistry.set('inner_parser', () => {
      throw new Error('poison record');
    });
    const compiled = compileProjection(parseProjectionSpec(yaml), throwingRegistry);
    const issues = new IssueCollector();
    const session = createProjectionSession(compiled, { issues });
    session.project({ records: [{ kind: 1, body: { bytes: Uint8Array.of(1), start: 0 } }] }, resolver);
    expect(session.finish().find((table) => table.name === 'records')!.rowCount).toBe(1);
    expect(issues.issues()).toEqual([
      expect.objectContaining({ stage: 'dissecting', code: 'DISSECT_PARSE_FAILED', recoverable: true }),
    ]);
  });

  it('resets a dissected child table state register per parent payload instead of carrying it across parents', () => {
    const statefulYaml = `
version: '0.2'
format: envelope
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      kind: { expr: '_.kind', type: uint8 }
  - name: inner
    rows: $.items[*]
    key: inner_id
    parent_key: { table: records, column: record_id }
    state:
      counter: { scope: '$', init: 0, update: 'counter + 1' }
    columns:
      seq: { expr: 'counter', type: int32 }
dissect:
  - from: records
    payload: _.body
    chain:
      - { when: 'true', parser: inner_parser, table: inner }
`;
    const statefulRegistry: ParserRegistry = new Map([
      ['inner_parser', () => ({ root: { items: [{}, {}] } })],
    ]);
    const compiled = compileProjection(parseProjectionSpec(statefulYaml), statefulRegistry);
    const session = createProjectionSession(compiled);
    session.project(
      {
        records: [
          { kind: 1, body: { bytes: Uint8Array.of(1), start: 0 } },
          { kind: 1, body: { bytes: Uint8Array.of(2), start: 10 } },
        ],
      },
      resolver,
    );
    const inner = session.finish().find((table) => table.name === 'inner')!;
    // Each parent record dissects a fresh payload: the counter must restart from init for
    // every parent (1, 2, 1, 2), not keep accumulating across parents (1, 2, 3, 4). The child
    // table's own key stays globally monotonic regardless.
    expect(inner.arrow.getChild('seq')!.toArray()).toEqual(new Int32Array([1, 2, 1, 2]));
    expect(inner.arrow.getChild('inner_id')!.toArray()).toEqual(new BigInt64Array([1n, 2n, 3n, 4n]));
  });
});
