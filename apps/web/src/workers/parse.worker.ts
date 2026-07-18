import {
  ipcToTable,
  tableToIpc,
  type BatchTransfer,
  type FormatPack,
  type ParseResult,
  type TableColumn,
  type TableTransfer,
} from '@byteql/core';
import { midiFormatPack } from '@byteql/midi';
import { Table } from 'apache-arrow';

export interface ParseWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
}

const PROBE_HEAD_BYTES = 4096;

type WorkerRequest =
  | { type: 'parse'; taskId: number; name: string; bytes: Uint8Array; formatId?: string }
  | { type: 'cancel'; taskId: number };

const selectPack = (
  packs: readonly FormatPack[],
  bytes: Uint8Array,
  formatId?: string,
): FormatPack | null => {
  if (formatId !== undefined) return packs.find((pack) => pack.id === formatId) ?? null;
  const head = bytes.subarray(0, PROBE_HEAD_BYTES);
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

const concatIpc = (parts: readonly Uint8Array[]): Table =>
  new Table(parts.flatMap((part) => ipcToTable(part).batches));

const mergeBatches = (pack: FormatPack, batches: readonly BatchTransfer[]): TableTransfer[] => {
  const byTable = new Map<string, BatchTransfer[]>();
  for (const batch of batches) {
    const list = byTable.get(batch.table) ?? [];
    list.push(batch);
    byTable.set(batch.table, list);
  }
  const nullableByTable = new Map<string, Map<string, boolean>>(
    pack
      .schemas()
      .map((schema) => [
        schema.name,
        new Map(schema.columns.map((column) => [column.name, column.nullable])),
      ]),
  );
  return [...byTable.entries()].map(([name, parts]) => {
    const ipc = parts.length === 1 ? parts[0]!.ipc : tableToIpc(concatIpc(parts.map((part) => part.ipc)));
    const arrow = ipcToTable(ipc);
    const nullable = nullableByTable.get(name);
    const columns: TableColumn[] = arrow.schema.fields.map((field) => ({
      name: field.name,
      type: field.type.toString(),
      nullable: nullable?.get(field.name) ?? false,
    }));
    return { name, ipc, rowCount: parts.reduce((sum, part) => sum + part.rowCount, 0), columns };
  });
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

const errorMessage = (error: unknown, packTitle: string): string =>
  error instanceof Error && error.message
    ? error.message
    : `The ${packTitle} parser could not process this file.`;

const ipcBuffers = (result: ParseResult): ArrayBuffer[] => {
  const buffers = new Set<ArrayBuffer>();
  for (const table of result.tables) {
    if (table.ipc.buffer instanceof ArrayBuffer) buffers.add(table.ipc.buffer);
  }
  return [...buffers];
};

export function installParseWorker(
  scope: ParseWorkerScope,
  packs: readonly FormatPack[] = [midiFormatPack],
): void {
  const active = new Map<number, AbortController>();
  const cancelled = new Set<number>();

  scope.addEventListener('message', (event) => {
    const request = event.data as WorkerRequest;
    if (!request || typeof request !== 'object') return;

    if (request.type === 'cancel') {
      // Recorded even when the parse has not arrived yet: task ids are never
      // reused, so a racing cancel must abort the parse that follows it.
      cancelled.add(request.taskId);
      active.get(request.taskId)?.abort();
      return;
    }
    if (request.type !== 'parse') return;

    const { taskId, bytes } = request;
    const pack = selectPack(packs, bytes, request.formatId);
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

    const run = async (): Promise<ParseResult> => {
      const source = pack.open(bytes, {
        signal: controller.signal,
        onProgress: (progress) => scope.postMessage({ type: 'progress', taskId, ...progress }),
      });
      const batches: BatchTransfer[] = [];
      for (let batch = await source.nextBatch(); batch !== null; batch = await source.nextBatch()) {
        batches.push(batch);
      }
      const finish = source.finish();
      return {
        format: { id: pack.id, title: pack.title },
        tables: mergeBatches(pack, batches),
        issues: finish.issues,
        queries: pack.queries,
        capabilities: finish.capabilities,
      };
    };

    void run()
      .then((result) => {
        if (controller.signal.aborted || cancelled.has(taskId)) {
          scope.postMessage({ type: 'cancelled', taskId });
          return;
        }
        scope.postMessage({ type: 'result', taskId, result }, ipcBuffers(result));
      })
      .catch((error: unknown) => {
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
      })
      .finally(() => {
        active.delete(taskId);
        cancelled.delete(taskId);
      });
  });
}

const workerScope = globalThis as unknown as ParseWorkerScope & { document?: unknown };
if (typeof workerScope.addEventListener === 'function' && workerScope.document === undefined) {
  installParseWorker(workerScope);
}
