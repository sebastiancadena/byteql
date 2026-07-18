import {
  Bool,
  Int8,
  Int16,
  Int32,
  Int64,
  Table,
  Uint8,
  Uint16,
  Uint32,
  Uint64,
  Utf8,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
  type DataType,
  type Vector,
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
  }
};

const valuesForType = (values: readonly unknown[], type: ArrowTypeName): readonly unknown[] => {
  if (type !== 'int64' && type !== 'uint64') return values;
  return values.map((value) =>
    typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value,
  );
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
    vectors[name] = vectorFromArray(valuesForType(values, type), arrowType(type));
  }
  return new Table(vectors);
};

export const tableToIpc = (table: Table): Uint8Array => tableToIPC(table, 'stream');

export const ipcToTable = (bytes: Uint8Array): Table => tableFromIPC(bytes);
