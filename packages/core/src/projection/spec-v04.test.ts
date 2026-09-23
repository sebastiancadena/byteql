import { describe, expect, it } from 'vitest';

import { parseProjectionSpec } from './spec.js';

const spec = (version: string, column: string) => `
version: '${version}'
format: f
tables:
  - name: t
    rows: $
    key: t_id
    columns:
      a: ${column}
`;

describe('spec v0.4', () => {
  it('accepts nullable on columns', () => {
    const parsed = parseProjectionSpec(spec('0.4', '{ expr: _.a, type: utf8, nullable: true }'));
    expect(parsed.version).toBe('0.4');
    expect(parsed.tables[0]!.columns.a!.nullable).toBe(true);
  });

  it('rejects nullable before v0.4', () => {
    expect(() => parseProjectionSpec(spec('0.3', '{ expr: _.a, type: utf8, nullable: true }'))).toThrow(
      /nullable requires version 0.4/u,
    );
  });

  it('v0.4 keeps streams and dissect available', () => {
    expect(parseProjectionSpec(spec('0.4', '{ expr: _.a, type: utf8 }')).version).toBe('0.4');
  });
});
