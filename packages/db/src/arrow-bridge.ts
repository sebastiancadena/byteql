import { tableFromIPC, type Table } from 'apache-arrow';
import {
  RecordBatchStreamWriter,
  Table as DuckdbTable,
  type RecordBatch as DuckdbRecordBatch,
  type Schema as DuckdbSchema,
} from 'apache-arrow-duckdb';

/**
 * Carries a DuckDB result across the Arrow version boundary: DuckDB-WASM speaks Arrow 17, the rest
 * of ByteQL speaks Arrow 21. The IPC stream is the only safe crossing — the two packages' `Table`
 * types are structurally similar but not interchangeable, and casting one to the other hands the
 * wrong prototypes to every downstream visitor.
 */
export const convertDuckdbTable = async (
  schema: DuckdbSchema,
  batches: readonly DuckdbRecordBatch[],
): Promise<Table> => {
  const writer = RecordBatchStreamWriter.writeAll(new DuckdbTable(schema, [...batches]));
  return tableFromIPC(await writer.toUint8Array());
};
