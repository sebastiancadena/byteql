import { describe, expect, it } from 'vitest';

import { wrapFilterSql } from './filter-sql.js';

describe('wrapFilterSql', () => {
  it('wraps the query with the exclusive-end overlap predicate', () => {
    expect(wrapFilterSql('select * from packets limit 10', { start: 64, end: 120 })).toBe(
      'select * from (\nselect * from packets limit 10\n) where _src_start < 120 and _src_end > 64;',
    );
  });

  it('strips a trailing semicolon and whitespace before wrapping', () => {
    expect(wrapFilterSql('select * from dns;\n  ', { start: 0, end: 1 })).toBe(
      'select * from (\nselect * from dns\n) where _src_start < 1 and _src_end > 0;',
    );
  });
});
