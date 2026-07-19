import {
  ipcToTable,
  type ByteSource,
  type FormatPack,
  type TableColumn,
  type TableOverview,
} from '@byteql/core';
import { midiFormatPack } from '@byteql/midi';
import { pcapFormatPack } from '@byteql/pcap';

export interface ParseWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
}

const PROBE_HEAD_BYTES = 4096;

/** In-flight batch messages a worker may have outstanding for one task before it must wait for acks. */
export const BATCH_CREDIT_WINDOW = 4;

type WorkerRequest =
  | { type: 'parse'; taskId: number; name: string; blob: Blob; formatId?: string }
  | { type: 'cancel'; taskId: number }
  | { type: 'batchAck'; taskId: number; seq: number };

/**
 * A small async semaphore: `take()` resolves immediately while permits remain, otherwise it
 * waits for a `release()`. `releaseAll()` drains every current waiter without touching the
 * permit count — it exists purely so a cancelled task's pull loop can observe the abort instead
 * of hanging forever on a credit that will never arrive.
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

  releaseAll(): void {
    while (this.waiters.length > 0) this.waiters.shift()!();
  }
}

const blobByteSource = (blob: Blob): ByteSource => ({
  size: blob.size,
  read: async (offset, length) =>
    new Uint8Array(await blob.slice(offset, Math.min(offset + length, blob.size)).arrayBuffer()),
});

const selectPack = (packs: readonly FormatPack[], head: Uint8Array, formatId?: string): FormatPack | null => {
  if (formatId !== undefined) return packs.find((pack) => pack.id === formatId) ?? null;
  let best: FormatPack | null = null;
  let bestConfidence = 0;
  // Strict `>`: the first-registered pack wins ties, and a confidence of 0 is never selected.
  for (const pack of packs) {
    const confidence = pack.probe(head);
    if (confidence !== null && confidence > bestConfidence) {
      best = pack;
      bestConfidence = confidence;
    }
  }
  return best;
};

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
    nullable: nullable?.get(field.name) ?? field.nullable,
  }));
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

const errorMessage = (error: unknown, packTitle: string): string =>
  error instanceof Error && error.message
    ? error.message
    : `The ${packTitle} parser could not process this file.`;

export function installParseWorker(
  scope: ParseWorkerScope,
  packs: readonly FormatPack[] = [midiFormatPack, pcapFormatPack],
): void {
  const active = new Map<number, AbortController>();
  const cancelled = new Set<number>();
  const credits = new Map<number, CreditGate>();

  const runParse = async (taskId: number, name: string, blob: Blob, formatId?: string): Promise<void> => {
    const head = new Uint8Array(await blob.slice(0, PROBE_HEAD_BYTES).arrayBuffer());
    const pack = selectPack(packs, head, formatId);
    if (!pack) {
      scope.postMessage({
        type: 'error',
        taskId,
        code: 'UNRECOGNIZED_FORMAT',
        stage: 'framing',
        message: 'No registered format recognizes this file.',
      });
      return;
    }

    const controller = new AbortController();
    active.set(taskId, controller);
    if (cancelled.has(taskId)) controller.abort();

    const gate = new CreditGate(BATCH_CREDIT_WINDOW);
    credits.set(taskId, gate);

    try {
      const source = pack.open(blobByteSource(blob), {
        signal: controller.signal,
        onProgress: (progress) => scope.postMessage({ type: 'progress', taskId, ...progress }),
      });

      const overview: TableOverview[] = [];
      const index = new Map<string, number>();
      let seq = 0;
      let cancelledInLoop = false;

      for (;;) {
        await gate.take();
        if (controller.signal.aborted || cancelled.has(taskId)) {
          cancelledInLoop = true;
          break;
        }
        const batch = await source.nextBatch();
        if (batch === null) break;

        seq += 1;
        let position = index.get(batch.table);
        if (position === undefined) {
          position = overview.length;
          index.set(batch.table, position);
          overview.push({
            name: batch.table,
            rowCount: 0,
            columns: deriveColumns(pack, batch.table, batch.ipc),
          });
        }
        const current = overview[position]!;
        overview[position] = { ...current, rowCount: current.rowCount + batch.rowCount };

        scope.postMessage(
          { type: 'batch', taskId, seq, table: batch.table, ipc: batch.ipc, rowCount: batch.rowCount },
          [batch.ipc.buffer],
        );
      }

      if (cancelledInLoop || controller.signal.aborted || cancelled.has(taskId)) {
        scope.postMessage({ type: 'cancelled', taskId });
        return;
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
        schemas: pack.schemas(),
      });
    } catch (error) {
      if (controller.signal.aborted || cancelled.has(taskId) || isAbortError(error)) {
        scope.postMessage({ type: 'cancelled', taskId });
        return;
      }
      scope.postMessage({
        type: 'error',
        taskId,
        code: 'PARSE_FAILED',
        stage: 'parsing',
        message: errorMessage(error, pack.title),
      });
    } finally {
      active.delete(taskId);
      cancelled.delete(taskId);
      credits.delete(taskId);
    }
  };

  scope.addEventListener('message', (event) => {
    const request = event.data as WorkerRequest;
    if (!request || typeof request !== 'object') return;

    if (request.type === 'cancel') {
      // Recorded even when the parse has not arrived yet: task ids are never
      // reused, so a racing cancel must abort the parse that follows it.
      cancelled.add(request.taskId);
      active.get(request.taskId)?.abort();
      credits.get(request.taskId)?.releaseAll();
      return;
    }
    if (request.type === 'batchAck') {
      credits.get(request.taskId)?.release();
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
