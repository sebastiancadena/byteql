import {
  ipcToTable,
  type ByteSource,
  type FormatPack,
  type TableColumn,
  type TableOverview,
} from '@byteql/core';

import { BATCH_CREDIT_WINDOW, type WorkerRequest } from '../lib/parse-protocol.js';
import { PROBE_HEAD_BYTES, REGISTERED_PACKS, selectPack } from '../lib/packs.js';
import { stampSourceFile, withSourceFileColumn } from './stamp-source-file.js';

export interface ParseWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
}

export { BATCH_CREDIT_WINDOW };

/**
 * A small async semaphore: `take()` resolves immediately while permits remain, otherwise it
 * waits for a `release()`.
 */
class CreditGate {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(initial: number) {
    this.permits = initial;
  }

  take(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter();
    else this.permits += 1;
  }
}

const blobByteSource = (blob: Blob): ByteSource => ({
  size: blob.size,
  read: async (offset, length) =>
    new Uint8Array(await blob.slice(offset, Math.min(offset + length, blob.size)).arrayBuffer()),
});

/** Derives a table's reported columns from its first batch's IPC schema, once per table. */
const deriveColumns = (pack: FormatPack, table: string, ipc: Uint8Array): readonly TableColumn[] => {
  const arrow = ipcToTable(ipc);
  const schema = pack.schemas().find((candidate) => candidate.name === table);
  const nullable = schema
    ? new Map(schema.columns.map((column) => [column.name, column.nullable]))
    : undefined;
  return arrow.schema.fields.map((field) => ({
    name: field.name,
    type: field.type.toString(),
    // The stamped provenance column is always populated; Arrow's field flag over-reports it as nullable.
    nullable: field.name === '_src_file' ? false : (nullable?.get(field.name) ?? field.nullable),
  }));
};

const errorMessage = (error: unknown, packTitle: string): string =>
  error instanceof Error && error.message
    ? error.message
    : `The ${packTitle} parser could not process this file.`;

export function installParseWorker(
  scope: ParseWorkerScope,
  packs: readonly FormatPack[] = REGISTERED_PACKS,
): void {
  // The client runs one task per worker (cancelling replaces the worker), so one gate suffices.
  let current: { taskId: number; gate: CreditGate } | null = null;

  const runParse = async (taskId: number, name: string, blob: Blob, formatId?: string): Promise<void> => {
    const head = new Uint8Array(await blob.slice(0, PROBE_HEAD_BYTES).arrayBuffer());
    const selected = selectPack(packs, head, formatId);
    if (!selected) {
      scope.postMessage({
        type: 'error',
        taskId,
        code: 'UNRECOGNIZED_FORMAT',
        stage: 'framing',
        message: 'No registered format recognizes this file.',
      });
      return;
    }
    const pack = selected.pack;

    const gate = new CreditGate(BATCH_CREDIT_WINDOW);
    current = { taskId, gate };

    try {
      const source = pack.open(blobByteSource(blob), {
        onProgress: (progress) => scope.postMessage({ type: 'progress', taskId, ...progress }),
        ...(selected.container !== undefined ? { container: selected.container } : {}),
      });

      const overview: TableOverview[] = [];
      const index = new Map<string, number>();
      let seq = 0;

      for (;;) {
        await gate.take();
        const batch = await source.nextBatch();
        if (batch === null) break;

        const stamped = stampSourceFile(batch.ipc, name);

        seq += 1;
        let position = index.get(batch.table);
        if (position === undefined) {
          position = overview.length;
          index.set(batch.table, position);
          overview.push({
            name: batch.table,
            rowCount: 0,
            columns: deriveColumns(pack, batch.table, stamped),
          });
        }
        const entry = overview[position]!;
        overview[position] = { ...entry, rowCount: entry.rowCount + batch.rowCount };

        scope.postMessage(
          { type: 'batch', taskId, seq, table: batch.table, ipc: stamped, rowCount: batch.rowCount },
          [stamped.buffer],
        );
      }

      const finish = source.finish();
      scope.postMessage({
        type: 'finish',
        taskId,
        format: { id: pack.id, title: pack.title },
        tables: overview,
        issues: finish.issues,
        queries: pack.queries,
        capabilities: finish.capabilities,
        // Every table the pack declares, not just the ones this capture happened to populate —
        // lets the DB backfill zero-row tables (e.g. no `tcp` packets) as empty tables at
        // finalize, so queries assuming every pack table exists don't hit a Catalog Error (C1).
        schemas: withSourceFileColumn(pack.schemas()),
      });
    } catch (error) {
      scope.postMessage({
        type: 'error',
        taskId,
        code: 'PARSE_FAILED',
        stage: 'parsing',
        message: errorMessage(error, pack.title),
      });
    } finally {
      if (current?.taskId === taskId) current = null;
    }
  };

  scope.addEventListener('message', (event) => {
    const request = event.data as WorkerRequest;
    if (!request || typeof request !== 'object') return;

    if (request.type === 'batchAck') {
      if (current?.taskId === request.taskId) current.gate.release();
      return;
    }
    if (request.type !== 'parse') return;

    void runParse(request.taskId, request.name, request.blob, request.formatId);
  });
}

const workerScope = globalThis as unknown as ParseWorkerScope & { document?: unknown };
if (typeof workerScope.addEventListener === 'function' && workerScope.document === undefined) {
  installParseWorker(workerScope);
}
