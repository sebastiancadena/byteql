import { ipcToTable, tableToIpc } from '@byteql/core';
import { Table, Uint32, vectorFromArray } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { stampSourceFile, withSourceFileColumn } from './stamp-source-file.js';

const sampleIpc = (): Uint8Array =>
  tableToIpc(new Table({ value: vectorFromArray([1, 2, 3], new Uint32()) }));

describe('stampSourceFile', () => {
  it('appends _src_file as the last column with the file name on every row', () => {
    const stamped = ipcToTable(stampSourceFile(sampleIpc(), 'capture (2).pcap'));
    expect(stamped.schema.fields.map((field) => field.name)).toEqual(['value', '_src_file']);
    expect(stamped.numRows).toBe(3);
    const column = stamped.getChild('_src_file')!;
    expect([column.get(0), column.get(2)]).toEqual(['capture (2).pcap', 'capture (2).pcap']);
    // Original data is intact.
    expect(Number(stamped.getChild('value')!.get(1))).toBe(2);
  });

  it('stamps an empty batch without error', () => {
    const empty = tableToIpc(new Table({ value: vectorFromArray([], new Uint32()) }));
    const stamped = ipcToTable(stampSourceFile(empty, 'a.mid'));
    expect(stamped.numRows).toBe(0);
    expect(stamped.schema.fields.at(-1)?.name).toBe('_src_file');
  });
});

describe('withSourceFileColumn', () => {
  it('appends the utf8 _src_file column to every schema', () => {
    const extended = withSourceFileColumn([
      { name: 'packets', columns: [{ name: 'ts', type: 'uint64', nullable: false }] },
    ]);
    expect(extended[0]!.columns.at(-1)).toEqual({ name: '_src_file', type: 'utf8', nullable: false });
    expect(extended[0]!.columns).toHaveLength(2);
  });
});
