import type { TableTransfer } from '@byteql/core';
import type { Table } from 'apache-arrow';

export interface QueryResult {
  table: Table;
  elapsedMs: number;
}

export interface ByteqlDatabase {
  initialize(): Promise<void>;
  replaceTables(tables: readonly TableTransfer[]): Promise<void>;
  query(sql: string): Promise<QueryResult>;
  cancelQuery(): Promise<boolean>;
  listTables(): Promise<readonly string[]>;
  dispose(): Promise<void>;
}
