import type { FormatCapability, PackQuery, ParseIssue, TableOverview, TableSchema } from '@byteql/core';

export interface ParseProgress {
  stage: 'normalizing' | 'parsing' | 'projecting';
  completed: number;
  total: number | null;
  label: string;
}

export interface BatchMessage {
  seq: number;
  table: string;
  ipc: Uint8Array;
  rowCount: number;
}

export interface StreamedParseResult {
  format: { id: string; title: string };
  tables: readonly TableOverview[];
  issues: readonly ParseIssue[];
  queries: readonly PackQuery[];
  capabilities: Readonly<Record<string, FormatCapability>>;
  /** Every table the format pack declares (`FormatPack.schemas()`), not just populated ones. */
  schemas: readonly TableSchema[];
}

/** In-flight batch messages a worker may have outstanding for one task before it must wait for acks. */
export const BATCH_CREDIT_WINDOW = 4;

/**
 * Cancellation has no message: the client terminates the worker, which discards any in-flight
 * task. The worker therefore runs at most one task and never reports a cancelled one.
 */
export type WorkerRequest =
  | { type: 'parse'; taskId: number; name: string; blob: Blob; formatId?: string }
  | { type: 'batchAck'; taskId: number; seq: number };

export type WorkerResponse =
  | ({ type: 'progress'; taskId: number } & ParseProgress)
  | ({ type: 'batch'; taskId: number } & BatchMessage)
  | ({ type: 'finish'; taskId: number } & StreamedParseResult)
  | { type: 'error'; taskId: number; message: string };
