import {
  Binary,
  Bool,
  Int8,
  Int16,
  Int32,
  Int64,
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
  util,
  vectorFromArray,
  type DataType,
} from 'apache-arrow';

import type { ProjectedTable } from '../projection/project.js';
import type { ArrowTypeName } from '../projection/spec.js';

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
  }
};

const valuesForType = (
  values: readonly unknown[],
  type: ArrowTypeName,
  table: string,
  column: string,
): readonly unknown[] => {
  if (type !== 'int64' && type !== 'uint64') return values;
  return values.map((value) => {
    if (typeof value !== 'number') return value;
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `ARROW_UNSAFE_INT64: ${table}.${column} received the number ${value}, which cannot be represented exactly in a 64-bit integer column`,
      );
    }
    return BigInt(value);
  });
};

// int64 range: [-2^63, 2^63).
const MIN_INT64 = -(2n ** 63n);
const MAX_INT64_EXCLUSIVE = 2n ** 63n;

// Convert a projected timestamp_us value into exact int64 microseconds, with no float
// detour: `Number(value)/1000` followed by arrow's internal `BigInt(ms * 1000)` both loses
// bigint precision above 2^53 and can throw a raw RangeError when the millisecond float
// isn't an exact integer multiple of 1000 (e.g. a µs value ending in *222 produces
// `...222.5` ms, and `...222.5 * 1000` isn't representable as an exact integer).
const toTimestampMicros = (value: unknown, table: string, column: string): bigint | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `ARROW_UNSAFE_INT64: ${table}.${column} received the number ${value}, which cannot be represented exactly in a 64-bit integer column`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'bigint') {
    if (value < MIN_INT64 || value >= MAX_INT64_EXCLUSIVE) {
      throw new Error(
        `ARROW_UNSAFE_INT64: ${table}.${column} received the bigint ${value}, which does not fit in a 64-bit integer column`,
      );
    }
    return value;
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
  const validity = new Array<boolean>(length);
  let nullCount = 0;
  for (let index = 0; index < length; index += 1) {
    const micros = toTimestampMicros(values[index], table, column);
    const valid = micros !== null;
    validity[index] = valid;
    if (!valid) nullCount += 1;
    data[index] = micros ?? 0n;
  }
  const vectorData = makeData({
    type: new TimestampMicrosecond(),
    length,
    nullCount,
    nullBitmap: util.packBools(validity),
    data,
  });
  return new Vector([vectorData]);
};

export const columnVector = (
  values: readonly unknown[],
  type: ArrowTypeName,
  table: string,
  column: string,
): Vector =>
  type === 'timestamp_us'
    ? timestampMicrosecondVector(values, table, column)
    : vectorFromArray(valuesForType(values, type, table, column), arrowType(type));

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
