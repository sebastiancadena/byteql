import { Field, List, Schema, Struct, Uint64, Utf8 } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { wrapFilterSql } from './filter-sql.js';

const rangesField = new Field(
  '_src_ranges',
  new List(
    new Field(
      'item',
      new Struct([new Field('start', new Uint64(), true), new Field('end', new Uint64(), true)]),
      true,
    ),
  ),
  true,
);
const selection = { file: 'a.pcap', start: 100, end: 110 };

describe('wrapFilterSql', () => {
  it('wraps the query with the file-scoped exclusive-end overlap predicate', () => {
    expect(
      wrapFilterSql('select * from packets limit 10', { file: 'capture.pcap', start: 64, end: 120 }, null),
    ).toBe(
      "select * from (\nselect * from packets limit 10\n) where _src_file = 'capture.pcap' and _src_start < 120 and _src_end > 64;",
    );
  });

  it('strips a trailing semicolon and whitespace before wrapping', () => {
    expect(wrapFilterSql('select * from dns;\n  ', { file: 'capture.pcap', start: 0, end: 1 }, null)).toBe(
      "select * from (\nselect * from dns\n) where _src_file = 'capture.pcap' and _src_start < 1 and _src_end > 0;",
    );
  });

  it('scopes the byte filter to the selection file with an escaped literal', () => {
    const wrapped = wrapFilterSql('select * from packets;', { file: "a'b.pcap", start: 10, end: 20 }, null);
    expect(wrapped).toBe(
      "select * from (\nselect * from packets\n) where _src_file = 'a''b.pcap' and _src_start < 20 and _src_end > 10;",
    );
  });

  it('adds the piece-overlap clause when the result has valid source ranges', () => {
    const sql = wrapFilterSql('select * from tls;', selection, new Schema([rangesField]));
    expect(sql).toContain(
      'and (_src_ranges is null or len(list_filter(_src_ranges, lambda r: r.start < 110 and r."end" > 100)) > 0)',
    );
  });

  it('omits the clause without a ranges column or with an impostor type', () => {
    expect(wrapFilterSql('select * from packets', selection, null)).not.toContain('_src_ranges');
    expect(
      wrapFilterSql('select * from x', selection, new Schema([new Field('_src_ranges', new Utf8(), true)])),
    ).not.toContain('list_filter');
  });
});
