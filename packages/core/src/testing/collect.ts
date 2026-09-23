import { Table } from 'apache-arrow';

import { ipcToTable, projectedTableToArrow, tableToIpc } from '../arrow/build.js';
import { memoryByteSource } from '../byte-source.js';
import type {
  BatchTransfer,
  ByteSource,
  FormatPack,
  OpenOptions,
  ParseProgress,
  ParseResult,
  RecordSource,
  TableSchema,
  TableTransfer,
} from '../protocol.js';
import type { ArrowTypeName } from '../projection/spec.js';

export interface CollectOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ParseProgress) => void;
  /** Override how the source is opened (conformance passes tuning/strict options through this). */
  open?: (source: ByteSource, opts: OpenOptions) => RecordSource;
}

const emptyTable = (schema: TableSchema): Table =>
  projectedTableToArrow({
    name: schema.name,
    rowCount: 0,
    columns: Object.fromEntries(schema.columns.map((column) => [column.name, []])),
    types: Object.fromEntries(schema.columns.map((column) => [column.name, column.type as ArrowTypeName])),
  });

const transfer = (name: string, arrow: Table, rowCount: number, schema?: TableSchema): TableTransfer => {
  const nullable = new Map(schema?.columns.map((column) => [column.name, column.nullable]));
  return {
    name,
    ipc: tableToIpc(arrow),
    rowCount,
    columns: arrow.schema.fields.map((field) => ({
      name: field.name,
      type: String(field.type),
      nullable: nullable.get(field.name) ?? field.nullable,
    })),
  };
};

/** Drains a pack's RecordSource into one ParseResult: one entry per declared table. */
export const collectSource = async (
  pack: FormatPack,
  bytes: Uint8Array,
  options: CollectOptions = {},
): Promise<ParseResult> => {
  const opts: OpenOptions = {
    signal: options.signal ?? new AbortController().signal,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
  const open = options.open ?? ((source, o) => pack.open(source, o));
  const source = open(memoryByteSource(bytes), opts);
  const byTable = new Map<string, BatchTransfer[]>();
  for (let batch = await source.nextBatch(); batch !== null; batch = await source.nextBatch()) {
    byTable.set(batch.table, [...(byTable.get(batch.table) ?? []), batch]);
  }
  const finish = source.finish();
  const schemas = new Map(pack.schemas().map((schema) => [schema.name, schema]));
  const tables: TableTransfer[] = [...byTable.entries()].map(([name, parts]) => {
    const arrow = new Table(parts.flatMap((part) => ipcToTable(part.ipc).batches));
    const rows = parts.reduce((sum, part) => sum + part.rowCount, 0);
    return transfer(name, arrow, rows, schemas.get(name));
  });
  for (const schema of schemas.values()) {
    if (!byTable.has(schema.name)) tables.push(transfer(schema.name, emptyTable(schema), 0, schema));
  }
  return {
    format: { id: pack.id, title: pack.title },
    tables,
    issues: finish.issues,
    queries: pack.queries,
    capabilities: finish.capabilities,
  };
};
