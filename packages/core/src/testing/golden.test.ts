import { describe, expect, it } from 'vitest';

import { projectedTableToArrow, tableToIpc } from '../arrow/build.js';
import type { ParseResult } from '../protocol.js';
import { goldenText } from './golden.js';

const result = (columns: Record<string, unknown[]>, types: Record<string, string>): ParseResult => {
  const arrow = projectedTableToArrow({
    name: 't',
    rowCount: Object.values(columns)[0]!.length,
    columns,
    types: types as never,
  });
  return {
    format: { id: 'x', title: 'X' },
    tables: [{ name: 't', ipc: tableToIpc(arrow), rowCount: arrow.numRows, columns: [] }],
    issues: [],
    queries: [],
    capabilities: {},
  };
};

describe('goldenText', () => {
  it('encodes int64, exact timestamp_us, binary, and src_ranges losslessly', async () => {
    const text = await goldenText(
      result(
        {
          id: [1n, 2n],
          ts: [1700000000123457n, null],
          b: [new Uint8Array([1, 255]), null],
          r: [
            [
              { start: 1n, end: 2n },
              { start: 4n, end: 5n },
            ],
            null,
          ],
        },
        { id: 'int64', ts: 'timestamp_us', b: 'binary', r: 'src_ranges' },
      ),
    );
    const golden = JSON.parse(text);
    expect(golden.tables.t.rowCount).toBe(2);
    expect(golden.tables.t.head[0]).toEqual([
      '1n',
      '1700000000123457us',
      '0x01ff',
      [
        ['1n', '2n'],
        ['4n', '5n'],
      ],
    ]);
    expect(golden.tables.t.head[1]).toEqual(['2n', null, null, null]);
    expect(golden.tables.t.fields.map((f: { type: string }) => f.type)).toEqual([
      'Int64',
      'Timestamp<MICROSECOND>',
      'Binary',
      'List<Struct<{start:Uint64, end:Uint64}>>',
    ]);
    expect(golden.tables.t.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is stable: same data gives byte-identical text', async () => {
    const make = () => result({ id: [1n] }, { id: 'int64' });
    expect(await goldenText(make())).toBe(await goldenText(make()));
  });
});
