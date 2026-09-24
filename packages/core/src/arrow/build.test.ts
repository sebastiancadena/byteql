import {
  Bool,
  Int8,
  Int16,
  Int32,
  Int64,
  Uint8,
  Uint16,
  Uint32,
  Uint64,
  Utf8,
  vectorFromArray,
  type DataType,
} from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import type { ProjectedTable } from '../projection/project.js';
import { columnVector, ipcToTable, projectedTableToArrow, tableToIpc } from './build.js';

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

  it('rejects unsafe or fractional numbers in declared 64-bit vectors', () => {
    const unsafe: ProjectedTable = {
      name: 'unsafe_values',
      rowCount: 1,
      columns: { value: [2 ** 53] },
      types: { value: 'int64' },
    };
    expect(() => projectedTableToArrow(unsafe)).toThrowError(/ARROW_UNSAFE_INT64/);

    const fractional: ProjectedTable = {
      name: 'fractional_values',
      rowCount: 1,
      columns: { value: [1.5] },
      types: { value: 'uint64' },
    };
    expect(() => projectedTableToArrow(fractional)).toThrowError(/ARROW_UNSAFE_INT64/);
  });

  it('accepts bigint values across the full uint64 range for uint64 columns', () => {
    // uint64 covers [0, 2^64) and arrow stores it as 32-bit word pairs, so the int64 bound
    // must not be applied to uint64 columns: a host byte offset or 64-bit timestamp past
    // 2^63 is a valid uint64 value.
    const topHalf: ProjectedTable = {
      name: 'top_half',
      rowCount: 1,
      columns: { value: [2n ** 63n] },
      types: { value: 'uint64' },
    };
    expect(Array.from(projectedTableToArrow(topHalf).getChild('value') ?? [])).toEqual([2n ** 63n]);

    const outOfRange: ProjectedTable = {
      name: 'out_of_range',
      rowCount: 1,
      columns: { value: [2n ** 64n] },
      types: { value: 'uint64' },
    };
    expect(() => projectedTableToArrow(outOfRange)).toThrowError(/ARROW_UNSAFE_INT64/);

    const negative: ProjectedTable = {
      name: 'negative',
      rowCount: 1,
      columns: { value: [-1n] },
      types: { value: 'uint64' },
    };
    expect(() => projectedTableToArrow(negative)).toThrowError(/ARROW_UNSAFE_INT64/);
  });

  it('rejects a column whose length does not match rowCount', () => {
    const table = logicalTable();
    table.columns.utf8_value = ['only one'];

    expect(() => projectedTableToArrow(table)).toThrowError(
      'ARROW_COLUMN_LENGTH: logical_types.utf8_value has 1 value(s), expected 2',
    );
  });
});

describe('timestamp_us columns', () => {
  it('round-trips microsecond timestamps through arrow IPC', () => {
    const table: ProjectedTable = {
      name: 'packets',
      rowCount: 2,
      types: { ts: 'timestamp_us' },
      columns: { ts: [1_500_500n, null] },
    };
    const arrow = ipcToTable(tableToIpc(projectedTableToArrow(table)));
    expect(String(arrow.schema.fields[0]!.type)).toMatch(/Timestamp/u);
    // apache-arrow JS reads timestamp vectors back as epoch milliseconds.
    expect(arrow.getChildAt(0)!.get(0)).toBe(1500.5);
    expect(arrow.getChildAt(0)!.get(1)).toBeNull();
  });

  it('rejects unsafe numeric microsecond values', () => {
    const table: ProjectedTable = {
      name: 'packets',
      rowCount: 1,
      types: { ts: 'timestamp_us' },
      columns: { ts: [Number.MAX_SAFE_INTEGER + 2] },
    };
    expect(() => projectedTableToArrow(table)).toThrow(/ARROW_UNSAFE_INT64/u);
  });

  it('rejects a bigint microsecond value that does not fit in int64', () => {
    const table: ProjectedTable = {
      name: 'packets',
      rowCount: 1,
      types: { ts: 'timestamp_us' },
      columns: { ts: [2n ** 63n] },
    };
    expect(() => projectedTableToArrow(table)).toThrow(/ARROW_UNSAFE_INT64/u);
  });

  // Read the exact physical int64 back out of a vector's underlying data buffer, bypassing
  // apache-arrow's Vector#get() (which returns a lossy epoch-millisecond float for Timestamp
  // columns). Handles both representations a Timestamp Data's `values` buffer might carry:
  // a BigInt64Array directly, or an Int32Array of little-endian [low, high] word pairs.
  const readExactMicros = (values: ArrayLike<number> | ArrayLike<bigint>, index: number): bigint => {
    if (values instanceof BigInt64Array) return values[index]!;
    const int32 = values as unknown as Int32Array;
    const low = BigInt(int32[index * 2]! >>> 0);
    const high = BigInt(int32[index * 2 + 1]!);
    return (high << 32n) | low;
  };

  it('builds a safe-integer microsecond value (number) without throwing and stores it exactly', () => {
    const micros = 4_492_512_256_312_222;
    const table: ProjectedTable = {
      name: 'packets',
      rowCount: 1,
      types: { ts: 'timestamp_us' },
      columns: { ts: [micros] },
    };
    const arrow = ipcToTable(tableToIpc(projectedTableToArrow(table)));
    const values = arrow.getChildAt(0)!.data[0]!.values;
    expect(readExactMicros(values, 0)).toBe(BigInt(micros));
  });

  it('builds a bigint microsecond value beyond safe-integer range without throwing and stores it exactly', () => {
    const micros = 4_492_512_256_312_222n;
    const table: ProjectedTable = {
      name: 'packets',
      rowCount: 1,
      types: { ts: 'timestamp_us' },
      columns: { ts: [micros] },
    };
    const arrow = ipcToTable(tableToIpc(projectedTableToArrow(table)));
    const values = arrow.getChildAt(0)!.data[0]!.values;
    expect(readExactMicros(values, 0)).toBe(micros);
  });
});

describe('binary columns', () => {
  it('round-trips byte blobs through arrow IPC', () => {
    const table: ProjectedTable = {
      name: 'packets',
      rowCount: 2,
      types: { payload: 'binary' },
      columns: { payload: [Uint8Array.of(1, 2, 3), null] },
    };
    const arrow = ipcToTable(tableToIpc(projectedTableToArrow(table)));
    expect(Array.from(arrow.getChildAt(0)!.get(0) as Uint8Array)).toEqual([1, 2, 3]);
    expect(arrow.getChildAt(0)!.get(1)).toBeNull();
  });
});

describe('src_ranges vectors', () => {
  it('builds List<Struct<start, end>> with nulls', () => {
    const vector = columnVector(
      [
        [
          { start: 1n, end: 4n },
          { start: 9n, end: 12n },
        ],
        null,
      ],
      'src_ranges',
      't',
      '_src_ranges',
    );
    expect(String(vector.type)).toContain('List');
    const first = Array.from(vector.get(0) as Iterable<{ start: bigint; end: bigint }>, (p) => [
      p.start,
      p.end,
    ]);
    expect(first).toEqual([
      [1n, 4n],
      [9n, 12n],
    ]);
    expect(vector.get(1)).toBeNull();
  });
  it.each([
    ['one piece', [{ start: 1n, end: 4n }]],
    [
      'empty piece',
      [
        { start: 1n, end: 1n },
        { start: 5n, end: 6n },
      ],
    ],
    [
      'touching',
      [
        { start: 1n, end: 4n },
        { start: 4n, end: 6n },
      ],
    ],
    [
      'unsorted',
      [
        { start: 9n, end: 12n },
        { start: 1n, end: 4n },
      ],
    ],
  ])('rejects an invariant violation: %s', (_label, value) => {
    expect(() => columnVector([value], 'src_ranges', 't', '_src_ranges')).toThrow(/SRC_RANGES_INVALID/);
  });
});

describe('direct vector construction', () => {
  // The fixed-width and utf8 fast paths must store exactly what apache-arrow's generic builder
  // stores for the same input, including typed-array wrapping and null handling.
  const reference: [string, DataType, unknown[]][] = [
    ['int8', new Int8(), [0, -128, 127, 200, null, -1.9, undefined]],
    ['uint8', new Uint8(), [0, 255, 256, -1, null]],
    ['int16', new Int16(), [-32768, 32767, 40000, null]],
    ['uint16', new Uint16(), [0, 65535, 65536, null, 7]],
    ['int32', new Int32(), [-(2 ** 31), 2 ** 31 - 1, 2 ** 31, null]],
    ['uint32', new Uint32(), [0, 2 ** 32 - 1, 2 ** 32, -1, null]],
    ['utf8', new Utf8(), ['', 'ascii', 'ñandú', '🦊 fox', null, 'x'.repeat(300), '\ud800 lone', undefined]],
  ];

  it.each(reference)('%s matches vectorFromArray', (type, arrowType, values) => {
    const direct = columnVector(values, type as 'int8', 't', 'c');
    const expected = vectorFromArray(
      values.map((v) => v ?? null),
      arrowType,
    );
    expect(String(direct.type)).toBe(String(expected.type));
    expect(direct.nullCount).toBe(expected.nullCount);
    expect([...direct]).toEqual([...expected]);
  });

  it('int64 and uint64 store exact bigints and nulls', () => {
    const int64 = columnVector([-(2n ** 63n), 2n ** 63n - 1n, 5, null], 'int64', 't', 'c');
    expect([...int64]).toEqual([-(2n ** 63n), 2n ** 63n - 1n, 5n, null]);
    expect(int64.nullCount).toBe(1);
    const uint64 = columnVector([2n ** 64n - 1n, null, 0], 'uint64', 't', 'c');
    expect([...uint64]).toEqual([2n ** 64n - 1n, null, 0n]);
  });

  it('rejects a non-numeric value in a 64-bit column', () => {
    expect(() => columnVector(['7'], 'int64', 't', 'c')).toThrow(
      'ARROW_UNSAFE_INT64: t.c received "7", expected a number, bigint, or null for a 64-bit integer column',
    );
  });

  it('builds zero-length columns', () => {
    for (const type of ['int8', 'uint32', 'int64', 'utf8'] as const) {
      expect(columnVector([], type, 't', 'c').length).toBe(0);
    }
  });
});
