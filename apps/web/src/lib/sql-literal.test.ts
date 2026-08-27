import { describe, expect, it } from 'vitest';

import { sqlIdentifier, sqlStringLiteral } from './sql-literal.js';

describe('sqlStringLiteral', () => {
  it('quotes and doubles embedded single quotes', () => {
    expect(sqlStringLiteral('plain.pcap')).toBe("'plain.pcap'");
    expect(sqlStringLiteral("it's here.pcap")).toBe("'it''s here.pcap'");
  });
});

describe('sqlIdentifier', () => {
  it('quotes identifiers and doubles embedded double quotes', () => {
    expect(sqlIdentifier('dns records')).toBe('"dns records"');
    expect(sqlIdentifier('a"b')).toBe('"a""b"');
  });
});
