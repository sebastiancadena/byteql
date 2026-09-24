import { describe, expect, it } from 'vitest';

import {
  decodeQueryFile,
  normalizeSql,
  parseQueryFile,
  QUERY_FILE_MAX_BYTES,
  QUERY_SQL_MAX_BYTES,
  QueryFileError,
  serializeQueryFile,
} from './sql-file.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('serializeQueryFile', () => {
  it('writes the header, the format, and one block per query', () => {
    expect(
      serializeQueryFile('pcap', [
        { name: 'Top talkers', sql: 'select src, count(*) from ip\ngroup by 1 order by 2 desc;\n' },
        { name: 'TLS SNI list', sql: 'select distinct sni from tls;' },
      ]),
    ).toBe(
      [
        '-- byteql-queries v1',
        '-- format: pcap',
        '',
        '-- name: Top talkers',
        'select src, count(*) from ip',
        'group by 1 order by 2 desc;',
        '',
        '-- name: TLS SNI list',
        'select distinct sni from tls;',
        '',
      ].join('\n'),
    );
  });

  it('keeps names on one line', () => {
    expect(serializeQueryFile('pcap', [{ name: 'two\nlines\r\n', sql: 'select 1' }])).toContain(
      '-- name: two lines\n',
    );
  });

  it('escapes marker-like lines inside SQL so they survive a round trip', () => {
    const sql = 'select 1\n-- name: not a marker\n  --\\ format: already escaped';
    const text = serializeQueryFile('pcap', [{ name: 'q', sql }]);
    expect(text).toContain('\n--\\ name: not a marker\n');
    expect(text).toContain('\n  --\\\\ format: already escaped\n');
    expect(parseQueryFile(text, 'x').queries).toEqual([{ name: 'q', sql }]);
  });
});

describe('parseQueryFile', () => {
  it('reads the format and every named block', () => {
    const parsed = parseQueryFile(
      '-- byteql-queries v1\n-- format: pcap\n\n-- name: A\nselect 1;\n\n-- name: B\nselect 2;\n',
      'file',
    );
    expect(parsed).toEqual({
      format: 'pcap',
      queries: [
        { name: 'A', sql: 'select 1;' },
        { name: 'B', sql: 'select 2;' },
      ],
      rejected: [],
    });
  });

  it('imports a plain .sql file with no markers as one query named after the file', () => {
    expect(parseQueryFile('\n\nselect *\nfrom packets;\n\n', 'triage')).toEqual({
      format: null,
      queries: [{ name: 'triage', sql: 'select *\nfrom packets;' }],
      rejected: [],
    });
  });

  it('imports an exported empty library as zero queries', () => {
    expect(parseQueryFile('-- byteql-queries v1\n-- format: zip\n', 'lib')).toEqual({
      format: 'zip',
      queries: [],
      rejected: [],
    });
  });

  it('handles a BOM and CRLF line endings from other editors', () => {
    const parsed = parseQueryFile('﻿-- format: pcap\r\n-- name: Windows\r\nselect 1;\r\n', 'f');
    expect(parsed.format).toBe('pcap');
    expect(parsed.queries).toEqual([{ name: 'Windows', sql: 'select 1;' }]);
  });

  it('rejects empty and oversized blocks one at a time, keeping the rest', () => {
    const huge = `select '${'x'.repeat(QUERY_SQL_MAX_BYTES)}'`;
    const parsed = parseQueryFile(`-- name: Empty\n\n-- name: Huge\n${huge}\n-- name: Fine\nselect 1`, 'f');
    expect(parsed.queries).toEqual([{ name: 'Fine', sql: 'select 1' }]);
    expect(parsed.rejected).toEqual([
      { name: 'Empty', reason: 'empty' },
      { name: 'Huge', reason: 'too-large' },
    ]);
  });

  it('names a block with an empty name "Untitled query"', () => {
    expect(parseQueryFile('-- name:   \nselect 1', 'f').queries[0]!.name).toBe('Untitled query');
  });
});

describe('decodeQueryFile', () => {
  it('decodes UTF-8 and drops a BOM', () => {
    expect(decodeQueryFile(encode('﻿select é'))).toBe('select é');
  });

  it('rejects invalid UTF-8', () => {
    expect(() => decodeQueryFile(new Uint8Array([0x73, 0xff, 0xfe]))).toThrow(QueryFileError);
  });

  it('rejects a file over 1 MiB before decoding', () => {
    expect(() => decodeQueryFile(new Uint8Array(QUERY_FILE_MAX_BYTES + 1))).toThrow(/1 MiB/u);
  });
});

describe('round trip', () => {
  /** Small deterministic PRNG (mulberry32), so failures reproduce from the seed. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const PIECES = [
    'select',
    ' ',
    '\n',
    '\r\n',
    '\t',
    '--',
    '-- name:',
    '--\\ name:',
    '-- format:',
    '  --  name: x',
    "'lit'",
    'é',
    ';',
    '*',
    'from ip',
  ];

  it('parse(serialize(q)) returns every query with normalized SQL and single-line names', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      const pick = (): string => PIECES[Math.floor(next() * PIECES.length)]!;
      const queries = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, index) => ({
        name: `q${index}${pick()}`,
        sql: `select ${index}${Array.from({ length: Math.floor(next() * 12) }, pick).join('')}`,
      }));
      const parsed = parseQueryFile(serializeQueryFile('pcap', queries), 'fallback');
      expect(parsed.format, `seed ${seed}`).toBe('pcap');
      expect(parsed.rejected, `seed ${seed}`).toEqual([]);
      expect(parsed.queries, `seed ${seed}`).toEqual(
        queries.map((query) => ({
          name: query.name.replace(/\s+/gu, ' ').trim(),
          sql: normalizeSql(query.sql),
        })),
      );
    }
  });
});
