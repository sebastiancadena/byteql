import {
  Binary,
  Bool,
  Field,
  Int8,
  Int16,
  Int32,
  Int64,
  List,
  Struct,
  Table,
  TimestampMicrosecond,
  Uint8,
  Uint16,
  Uint32,
  Uint64,
  Utf8,
  Vector,
  makeData,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
  type DataType,
} from 'apache-arrow';

import type { ProjectedTable } from '../projection/project.js';
import type { ArrowTypeName } from '../projection/spec.js';

const SRC_RANGE_PIECE_TYPE = new Struct([
  new Field('start', new Uint64(), false),
  new Field('end', new Uint64(), false),
]);
export const SRC_RANGES_ARROW_TYPE = new List(new Field('item', SRC_RANGE_PIECE_TYPE, false));

// Enforces the `_src_ranges` contract (≥2 pieces, sorted, strictly gapped, non-empty) on every
// value. A violation is an engine bug, never input data, so it throws instead of nulling.
const srcRangesValues = (values: readonly unknown[], table: string, column: string): readonly unknown[] =>
  values.map((value) => {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value) || value.length < 2) {
      throw new Error(`SRC_RANGES_INVALID: ${table}.${column} needs at least two pieces or null`);
    }
    let previousEnd = -1n;
    return value.map((piece: { start: number | bigint; end: number | bigint }) => {
      const start = requireUint64(piece.start, table, column);
      const end = requireUint64(piece.end, table, column);
      if (end <= start || start <= previousEnd) {
        throw new Error(
          `SRC_RANGES_INVALID: ${table}.${column} piece [${start}, ${end}) is empty, unsorted, or not separated from the previous piece`,
        );
      }
      previousEnd = end;
      return { start, end };
    });
  });

const arrowType = (type: ArrowTypeName): DataType => {
  switch (type) {
    case 'int8':
      return new Int8();
    case 'uint8':
      return new Uint8();
    case 'int16':
      return new Int16();
    case 'uint16':
      return new Uint16();
    case 'int32':
      return new Int32();
    case 'uint32':
      return new Uint32();
    case 'int64':
      return new Int64();
    case 'uint64':
      return new Uint64();
    case 'bool':
      return new Bool();
    case 'utf8':
      return new Utf8();
    case 'timestamp_us':
      return new TimestampMicrosecond();
    case 'binary':
      return new Binary();
    case 'src_ranges':
      return SRC_RANGES_ARROW_TYPE;
  }
};

// int64 range: [-2^63, 2^63). uint64 range: [0, 2^64).
const MIN_INT64 = -(2n ** 63n);
const MAX_INT64_EXCLUSIVE = 2n ** 63n;
const MIN_UINT64 = 0n;
const MAX_UINT64_EXCLUSIVE = 2n ** 64n;

// Validates a number/bigint value against a 64-bit range and returns it as an exact bigint,
// throwing the shared ARROW_UNSAFE_INT64 message for whichever representation was given.
// (The stable error code covers the whole "cannot be represented in a declared 64-bit integer
// column" family, uint64 included.)
const requireFixed64 = (
  value: number | bigint,
  min: bigint,
  maxExclusive: bigint,
  table: string,
  column: string,
): bigint => {
  let exact: bigint;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `ARROW_UNSAFE_INT64: ${table}.${column} received the number ${value}, which cannot be represented exactly in a 64-bit integer column`,
      );
    }
    exact = BigInt(value);
  } else {
    exact = value;
  }
  if (exact < min || exact >= maxExclusive) {
    throw new Error(
      `ARROW_UNSAFE_INT64: ${table}.${column} received the bigint ${exact}, which does not fit in a 64-bit integer column`,
    );
  }
  return exact;
};

const requireInt64 = (value: number | bigint, table: string, column: string): bigint =>
  requireFixed64(value, MIN_INT64, MAX_INT64_EXCLUSIVE, table, column);

// uint64 covers [0, 2^64) — half of that range sits past the int64 bound, and arrow stores
// uint64 as 32-bit word pairs, so the full range is representable. The int64 bound must not
// be applied here: host byte offsets and 64-bit timestamps past 2^63 are valid uint64 values.
const requireUint64 = (value: number | bigint, table: string, column: string): bigint =>
  requireFixed64(value, MIN_UINT64, MAX_UINT64_EXCLUSIVE, table, column);

const isNull = (value: unknown): boolean => value === null || value === undefined;

/** Validity bitmap (LSB-first, one bit per row) and null count for `values`. */
const validityOf = (values: readonly unknown[]): { bitmap: Uint8Array; nullCount: number } => {
  const bitmap = new Uint8Array((values.length + 7) >> 3);
  let nullCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (isNull(values[index])) nullCount += 1;
    else bitmap[index >> 3]! |= 1 << (index & 7);
  }
  return { bitmap, nullCount };
};

// Convert a projected timestamp_us value into exact int64 microseconds, with no float
// detour: `Number(value)/1000` followed by arrow's internal `BigInt(ms * 1000)` both loses
// bigint precision above 2^53 and can throw a raw RangeError when the millisecond float
// isn't an exact integer multiple of 1000 (e.g. a µs value ending in *222 produces
// `...222.5` ms, and `...222.5 * 1000` isn't representable as an exact integer).
const toTimestampMicros = (value: unknown, table: string, column: string): bigint | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return requireInt64(value, table, column);
  }
  throw new Error(
    `ARROW_UNSAFE_INT64: ${table}.${column} received ${JSON.stringify(value)}, expected a number, bigint, or null for timestamp_us`,
  );
};

// Builds the TimestampMicrosecond vector directly from an exact BigInt64Array of
// microsecond values, sidestepping vectorFromArray's millisecond/float path entirely.
const timestampMicrosecondVector = (values: readonly unknown[], table: string, column: string): Vector => {
  const length = values.length;
  const data = new BigInt64Array(length);
  for (let index = 0; index < length; index += 1) {
    data[index] = toTimestampMicros(values[index], table, column) ?? 0n;
  }
  const { bitmap, nullCount } = validityOf(values);
  const vectorData = makeData({
    type: new TimestampMicrosecond(),
    length,
    nullCount,
    nullBitmap: bitmap,
    data,
  });
  return new Vector([vectorData]);
};

// Direct construction for the hot column types. `vectorFromArray` routes every value through a
// generic builder (null check, bitmap write, buffer reserve, one TextEncoder call per string),
// which dominated row projection's cost. These build the same buffers in one pass and store the
// same values: typed-array assignment is exactly what the builder's own `setValue` does, so
// numeric coercion and wrapping are unchanged.

type FixedIntArray =
  | Int8ArrayConstructor
  | Uint8ArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor;

const FIXED_INT_ARRAYS: Partial<Record<ArrowTypeName, FixedIntArray>> = {
  int8: Int8Array,
  uint8: Uint8Array,
  int16: Int16Array,
  uint16: Uint16Array,
  int32: Int32Array,
  uint32: Uint32Array,
};

const fixedIntVector = (
  values: readonly unknown[],
  type: ArrowTypeName,
  ArrayType: FixedIntArray,
): Vector => {
  const length = values.length;
  const data = new ArrayType(length);
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (!isNull(value)) data[index] = value as number;
  }
  const { bitmap, nullCount } = validityOf(values);
  return new Vector([
    makeData({
      type: arrowType(type) as Int8,
      length,
      nullCount,
      nullBitmap: bitmap,
      data: data as Int8Array,
    }),
  ]);
};

const fixed64Vector = (
  values: readonly unknown[],
  type: 'int64' | 'uint64',
  table: string,
  column: string,
): Vector => {
  const length = values.length;
  const data = type === 'int64' ? new BigInt64Array(length) : new BigUint64Array(length);
  const [min, maxExclusive] =
    type === 'int64' ? [MIN_INT64, MAX_INT64_EXCLUSIVE] : [MIN_UINT64, MAX_UINT64_EXCLUSIVE];
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (isNull(value)) continue;
    if (typeof value !== 'number' && typeof value !== 'bigint') {
      throw new Error(
        `ARROW_UNSAFE_INT64: ${table}.${column} received ${JSON.stringify(
          value,
        )}, expected a number, bigint, or null for a 64-bit integer column`,
      );
    }
    data[index] = requireFixed64(value, min, maxExclusive, table, column);
  }
  const { bitmap, nullCount } = validityOf(values);
  return new Vector([
    makeData({
      type: arrowType(type) as Int64,
      length,
      nullCount,
      nullBitmap: bitmap,
      data: data as BigInt64Array,
    }),
  ]);
};

const utf8Encoder = new TextEncoder();

const utf8Vector = (values: readonly unknown[]): Vector => {
  const length = values.length;
  const valueOffsets = new Int32Array(length + 1);
  let bytes = new Uint8Array(Math.max(64, length * 8));
  let used = 0;
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (!isNull(value)) {
      const text = String(value);
      // UTF-8 needs at most 3 bytes per UTF-16 code unit.
      const worst = text.length * 3;
      if (used + worst > bytes.length) {
        const grown = new Uint8Array(Math.max(bytes.length * 2, used + worst));
        grown.set(bytes.subarray(0, used));
        bytes = grown;
      }
      used += utf8Encoder.encodeInto(text, bytes.subarray(used)).written;
    }
    valueOffsets[index + 1] = used;
  }
  const { bitmap, nullCount } = validityOf(values);
  return new Vector([
    makeData({
      type: new Utf8(),
      length,
      nullCount,
      nullBitmap: bitmap,
      valueOffsets,
      data: bytes.subarray(0, used),
    }),
  ]);
};

export const columnVector = (
  values: readonly unknown[],
  type: ArrowTypeName,
  table: string,
  column: string,
): Vector => {
  if (type === 'timestamp_us') return timestampMicrosecondVector(values, table, column);
  if (type === 'src_ranges') {
    return vectorFromArray(srcRangesValues(values, table, column), SRC_RANGES_ARROW_TYPE);
  }
  if (type === 'int64' || type === 'uint64') return fixed64Vector(values, type, table, column);
  if (type === 'utf8') return utf8Vector(values);
  const fixedInt = FIXED_INT_ARRAYS[type];
  if (fixedInt) return fixedIntVector(values, type, fixedInt);
  return vectorFromArray(values, arrowType(type));
};

export const projectedTableToArrow = (table: ProjectedTable): Table => {
  for (const [name, values] of Object.entries(table.columns)) {
    if (values.length !== table.rowCount) {
      throw new Error(
        `ARROW_COLUMN_LENGTH: ${table.name}.${name} has ${values.length} value(s), expected ${table.rowCount}`,
      );
    }
  }

  const vectors: Record<string, Vector> = {};
  for (const [name, values] of Object.entries(table.columns)) {
    const type = table.types[name]!;
    vectors[name] = columnVector(values, type, table.name, name);
  }
  return new Table(vectors);
};

export const tableToIpc = (table: Table): Uint8Array => tableToIPC(table, 'stream');

export const ipcToTable = (bytes: Uint8Array): Table => tableFromIPC(bytes);
