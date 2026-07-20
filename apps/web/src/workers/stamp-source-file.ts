import { ipcToTable, tableToIpc, type TableSchema } from '@byteql/core';
import { Table, Utf8, vectorFromArray, type Vector } from 'apache-arrow';

const SRC_FILE_COLUMN = { name: '_src_file', type: 'utf8', nullable: false } as const;

/** Appends `_src_file` (the batch's source display name) as the last column of an IPC batch. */
export const stampSourceFile = (ipc: Uint8Array, file: string): Uint8Array => {
  const table = ipcToTable(ipc);
  const children: Record<string, Vector> = {};
  for (const field of table.schema.fields) {
    children[field.name] = table.getChild(field.name) as Vector;
  }
  children[SRC_FILE_COLUMN.name] = vectorFromArray(new Array<string>(table.numRows).fill(file), new Utf8());
  return tableToIpc(new Table(children));
};

/** Extends every pack schema with the `_src_file` column the stamped batches carry. */
export const withSourceFileColumn = (schemas: readonly TableSchema[]): TableSchema[] =>
  schemas.map((schema) => ({ ...schema, columns: [...schema.columns, SRC_FILE_COLUMN] }));
