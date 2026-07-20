import { describe, expect, it } from 'vitest';

import { wrapFilterSql } from './filter-sql.js';

describe('wrapFilterSql', () => {
  it('wraps the query with the file-scoped exclusive-end overlap predicate', () => {
    expect(
      wrapFilterSql('select * from packets limit 10', { file: 'capture.pcap', start: 64, end: 120 }),
    ).toBe(
      "select * from (\nselect * from packets limit 10\n) where _src_file = 'capture.pcap' and _src_start < 120 and _src_end > 64;",
    );
  });

  it('strips a trailing semicolon and whitespace before wrapping', () => {
    expect(wrapFilterSql('select * from dns;\n  ', { file: 'capture.pcap', start: 0, end: 1 })).toBe(
      "select * from (\nselect * from dns\n) where _src_file = 'capture.pcap' and _src_start < 1 and _src_end > 0;",
    );
  });

  it('scopes the byte filter to the selection file with an escaped literal', () => {
    const wrapped = wrapFilterSql('select * from packets;', { file: "a'b.pcap", start: 10, end: 20 });
    expect(wrapped).toBe(
      "select * from (\nselect * from packets\n) where _src_file = 'a''b.pcap' and _src_start < 20 and _src_end > 10;",
    );
  });
});
