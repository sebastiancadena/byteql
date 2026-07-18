import { Bool, Int8, Int16, Int32, Int64, Uint8, Uint16, Uint32, Uint64, Utf8 } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import type { ProjectedTable } from '../projection/project.js';
import { ipcToTable, projectedTableToArrow, tableToIpc } from './build.js';

const logicalTable = (): ProjectedTable => ({
  name: 'logical_types',
  rowCount: 2,
  columns: {
    int8_value: [-8, null],
    uint8_value: [8, null],
    int16_value: [-16, null],
    uint16_value: [16, null],
    int32_value: [-32, null],
    uint32_value: [32, null],
    int64_value: [-64n, null],
    uint64_value: [64n, null],
    bool_value: [true, null],
    utf8_value: ['ByteQL', null],
  },
  types: {
    int8_value: 'int8',
    uint8_value: 'uint8',
    int16_value: 'int16',
    uint16_value: 'uint16',
    int32_value: 'int32',
    uint32_value: 'uint32',
    int64_value: 'int64',
    uint64_value: 'uint64',
    bool_value: 'bool',
    utf8_value: 'utf8',
  },
});

describe('Arrow table construction', () => {
  it('maps every declared logical type to its explicit Arrow type', () => {
    const table = projectedTableToArrow(logicalTable());
    const expected = [Int8, Uint8, Int16, Uint16, Int32, Uint32, Int64, Uint64, Bool, Utf8];

    expect(table.schema.fields.map((field) => field.type.constructor)).toEqual(expected);
  });

  it('round-trips nulls and keeps signed and unsigned 64-bit values as bigint', () => {
    const roundTripped = ipcToTable(tableToIpc(projectedTableToArrow(logicalTable())));

    expect(roundTripped.numRows).toBe(2);
    expect(Array.from(roundTripped.getChild('int64_value') ?? [])).toEqual([-64n, null]);
    expect(Array.from(roundTripped.getChild('uint64_value') ?? [])).toEqual([64n, null]);
    expect(Array.from(roundTripped.getChild('utf8_value') ?? [])).toEqual(['ByteQL', null]);
    expect(roundTripped.schema.fields.every((field) => field.nullable)).toBe(true);
  });

  it('promotes safe integer projection values into declared 64-bit vectors', () => {
    const table = logicalTable();
    table.columns.int64_value = [-64, null];
    table.columns.uint64_value = [64, null];

    const projected = projectedTableToArrow(table);

    expect(Array.from(projected.getChild('int64_value') ?? [])).toEqual([-64n, null]);
    expect(Array.from(projected.getChild('uint64_value') ?? [])).toEqual([64n, null]);
  });

  it('rejects a column whose length does not match rowCount', () => {
    const table = logicalTable();
    table.columns.utf8_value = ['only one'];

    expect(() => projectedTableToArrow(table)).toThrowError(
      'ARROW_COLUMN_LENGTH: logical_types.utf8_value has 1 value(s), expected 2',
    );
  });
});
