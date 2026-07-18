import { describe, expect, it } from 'vitest';
import { TableBatchBuilder } from './batch.js';
import { ipcToTable, tableToIpc } from './build.js';

const types = { item_id: 'int64', value: 'int32' } as const;

describe('TableBatchBuilder', () => {
  it('seals a record batch at the flush threshold', () => {
    const builder = new TableBatchBuilder('items', types, { flushRowThreshold: 2 });
    for (let index = 0; index < 5; index += 1)
      builder.appendRow({ item_id: BigInt(index + 1), value: index });
    const table = builder.finish();
    expect(builder.rowCount).toBe(5);
    expect(table.numRows).toBe(5);
    expect(table.batches.length).toBe(3); // 2 + 2 + 1
    const roundTrip = ipcToTable(tableToIpc(table));
    expect(roundTrip.numRows).toBe(5);
    expect(roundTrip.getChild('value')!.toArray()).toEqual(new Int32Array([0, 1, 2, 3, 4]));
  });

  it('fills missing row keys with null', () => {
    const builder = new TableBatchBuilder('items', { value: 'int32' });
    builder.appendRow({});
    expect(builder.finish().getChild('value')!.get(0)).toBeNull();
  });

  it('produces an empty single-schema table when no rows were appended', () => {
    const table = new TableBatchBuilder('items', types).finish();
    expect(table.numRows).toBe(0);
    expect(table.schema.fields.map((field) => field.name)).toEqual(['item_id', 'value']);
  });

  it('clamps a non-positive flush threshold to 1, sealing every row into its own batch', () => {
    const builder = new TableBatchBuilder('items', types, { flushRowThreshold: 0 });
    for (let index = 0; index < 3; index += 1)
      builder.appendRow({ item_id: BigInt(index + 1), value: index });
    const table = builder.finish();
    expect(table.numRows).toBe(3);
    expect(table.batches.length).toBe(3);
    const roundTrip = ipcToTable(tableToIpc(table));
    expect(roundTrip.getChild('item_id')!.toArray()).toEqual(new BigInt64Array([1n, 2n, 3n]));
    expect(roundTrip.getChild('value')!.toArray()).toEqual(new Int32Array([0, 1, 2]));
  });
});
