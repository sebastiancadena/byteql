import { describe, expect, it } from 'vitest';
import { ProjectionCompileError } from './expression.js';
import { parseProjectionSpec } from './spec.js';

const spec = (version: string) => `
version: ${version}
format: f
tables:
  - name: rec
    rows: $
    key: rec_id
    columns:
      v: { expr: _.v, type: uint32 }
`;

describe('spec version floor', () => {
  it.each(["'0.1'", "'0.2'", "'0.3'", '0.1', '0.3'])('rejects version %s with the floor message', (v) => {
    try {
      parseProjectionSpec(spec(v));
      expect.unreachable('expected a ProjectionCompileError');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectionCompileError);
      expect((error as ProjectionCompileError).code).toBe('PROJECTION_SPEC_INVALID');
      expect((error as Error).message).toMatch(
        /spec version 0\.[123] is no longer supported; the minimum is 0\.4 \(add `nullable: true` to columns that can be null\)/u,
      );
    }
  });

  it.each(["'0.4'", '0.4', "'0.5'", '0.5'])('accepts version %s', (v) => {
    expect(() => parseProjectionSpec(spec(v))).not.toThrow();
  });
});
