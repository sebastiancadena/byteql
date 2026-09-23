import { describe, expect, it } from 'vitest';

import type { ParserRegistry } from './parsers.js';
import { compileProjection } from './project.js';
import { ProjectionFieldError } from './project.js';
import { createProjectionSession } from './session.js';
import { parseProjectionSpec } from './spec.js';

const compiled = compileProjection(
  parseProjectionSpec(`
version: '0.4'
format: f
tables:
  - name: t
    rows: $.items[*]
    key: t_id
    columns:
      a: { expr: _.a, type: utf8, nullable: true }
      deep: { expr: _.inner.b, type: utf8, nullable: true }
`),
);
const range = { resolve: () => ({ start: 0, end: 1 }) };

describe('strictFields', () => {
  it('throws ProjectionFieldError naming table, column, field, and actual keys', () => {
    const session = createProjectionSession(compiled, { strictFields: true });
    let caught: unknown;
    try {
      session.project({ items: [{ A: 'x', inner: null }] }, range);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProjectionFieldError);
    expect(caught).toMatchObject({ table: 't', column: 'a', field: 'a', keys: ['A', 'inner'] });
  });

  it('present null (including member-of-null) is not missing', () => {
    const session = createProjectionSession(compiled, { strictFields: true });
    expect(() => session.project({ items: [{ a: null, inner: null }] }, range)).not.toThrow();
  });

  it('camelCase fallback still resolves in strict mode', () => {
    const session = createProjectionSession(
      compileProjection(
        parseProjectionSpec(`
version: '0.4'
format: f
tables:
  - name: t
    rows: $
    key: t_id
    columns:
      v: { expr: _.ts_sec, type: uint32 }
`),
      ),
      { strictFields: true },
    );
    expect(() => session.project({ tsSec: 1 }, range)).not.toThrow();
  });

  it('non-strict sessions keep returning null', () => {
    const session = createProjectionSession(compiled);
    session.project({ items: [{ inner: null }] }, range);
    expect(session.finish()[0]!.arrow.getChild('a')!.get(0)).toBeNull();
  });

  it('propagates out of session.project for a missing field in a dissected child table', () => {
    // outer -> dissect -> parser 'p' -> child table `inner`; the parser's row is missing
    // `label`, which `inner.label`'s expr reads — the engine invariant (project.ts's dissect
    // parser try/catch wraps only the parser call, never row emission) means the
    // ProjectionFieldError thrown while emitting `inner`'s rows must reach session.project
    // uncaught, same as a strict miss on a root table.
    const dissectCompiled = compileProjection(
      parseProjectionSpec(`
version: '0.2'
format: f
tables:
  - name: outer
    rows: $.items[*]
    key: outer_id
    columns:
      kind: { expr: _.kind, type: uint8 }
  - name: inner
    rows: $.subs[*]
    key: inner_id
    parent_key: { table: outer, column: outer_id }
    columns:
      label: { expr: _.label, type: utf8 }
dissect:
  - from: outer
    payload: _.body
    chain:
      - { when: 'true', parser: p, table: inner }
`),
      new Map([['p', () => ({ root: { subs: [{ oops: 'x' }] } })]]) satisfies ParserRegistry,
    );
    const session = createProjectionSession(dissectCompiled, { strictFields: true });
    const body = { bytes: Uint8Array.of(1), start: 0 };
    expect(() => session.project({ items: [{ kind: 1, body }] }, range)).toThrow(ProjectionFieldError);
  });
});
