import type { TableSchema, TableTransfer } from '@byteql/core';
import type { Table } from 'apache-arrow';

export interface QueryResult {
  table: Table;
  elapsedMs: number;
}

export interface TableSummary {
  readonly name: string;
  readonly rowCount: number;
}

export interface IngestOptions {
  /** An explicit schema list, or 'discover' to register tables lazily on first appendBatch. */
  schemas: readonly TableSchema[] | 'discover';
  tier: 'memory' | 'spill';
  generation: number;
  /** Spill tier only; defaults to ROTATION_THRESHOLD_BYTES (Task 7). */
  rotationBytes?: number;
}

export interface IngestSession {
  appendBatch(table: string, ipc: Uint8Array): Promise<void>;
  finalize(): Promise<readonly TableSummary[]>;
  abort(): Promise<void>;
}

export interface ByteqlDatabase {
  initialize(): Promise<void>;
  replaceTables(tables: readonly TableTransfer[]): Promise<void>;
  beginIngest(options: IngestOptions): Promise<IngestSession>;
  query(sql: string): Promise<QueryResult>;
  cancelQuery(): Promise<boolean>;
  listTables(): Promise<readonly string[]>;
  dispose(): Promise<void>;
}
