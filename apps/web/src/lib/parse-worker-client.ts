import {
  ipcToTable,
  tableToIpc,
  type FormatCapability,
  type PackQuery,
  type ParseIssue,
  type ParseResult,
  type TableOverview,
  type TableTransfer,
} from '@byteql/core';
import { Table } from 'apache-arrow';

import InlineParseWorker from '../workers/parse.worker.ts?worker&inline';

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
}

export interface ParseHandlers {
  onProgress(progress: ParseProgress): void;
  onBatch(batch: BatchMessage): Promise<void>;
}

export interface ParseClientPort {
  parse(input: { name: string; blob: Blob }, handlers: ParseHandlers): Promise<StreamedParseResult>;
  /**
   * Legacy bridge kept only for `SessionController`, which still wants a single merged
   * `ParseResult` (IPC included) rather than the streaming batch protocol. Implemented on top
   * of `parse()`; deleted once the controller migrates to the streaming API.
   */
  parseToResult(
    input: { name: string; bytes: Uint8Array },
    onProgress: (progress: ParseProgress) => void,
  ): Promise<ParseResult>;
  cancel(): void;
  dispose(): void;
}

export interface WorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  terminate(): void;
}

interface ActiveTask {
  id: number;
  resolve(result: StreamedParseResult): void;
  reject(error: unknown): void;
  onProgress(progress: ParseProgress): void;
  onBatch(batch: BatchMessage): Promise<void>;
  /** Serializes batch handling and ack posting in arrival (seq) order. */
  ackChain: Promise<void>;
}

type WorkerResponse =
  | ({ type: 'progress'; taskId: number } & ParseProgress)
  | ({ type: 'batch'; taskId: number } & BatchMessage)
  | ({ type: 'finish'; taskId: number } & StreamedParseResult)
  | { type: 'error'; taskId: number; message: string }
  | { type: 'cancelled'; taskId: number };

const abortError = (): DOMException => new DOMException('The parse was cancelled.', 'AbortError');

export const createInlineParseWorker = (): WorkerPort =>
  new InlineParseWorker({ name: 'byteql-midi-parser' });

const concatIpc = (parts: readonly Uint8Array[]): Uint8Array =>
  tableToIpc(new Table(parts.flatMap((part) => ipcToTable(part).batches)));

export class ParseWorkerClient implements ParseClientPort {
  private worker: WorkerPort;
  private workerGeneration = 0;
  private nextTaskId = 0;
  private active: ActiveTask | null = null;
  private disposed = false;

  constructor(private readonly workerFactory: () => WorkerPort = createInlineParseWorker) {
    this.worker = this.createWorker();
  }

  parse(input: { name: string; blob: Blob }, handlers: ParseHandlers): Promise<StreamedParseResult> {
    this.assertUsable();
    if (this.active) this.cancel();

    const taskId = ++this.nextTaskId;
    const promise = new Promise<StreamedParseResult>((resolve, reject) => {
      this.active = {
        id: taskId,
        resolve,
        reject,
        onProgress: handlers.onProgress,
        onBatch: handlers.onBatch,
        ackChain: Promise.resolve(),
      };
    });

    try {
      this.worker.postMessage({ type: 'parse', taskId, name: input.name, blob: input.blob });
    } catch (error) {
      this.active = null;
      this.replaceWorker();
      return Promise.reject(error);
    }

    return promise;
  }

  parseToResult(
    input: { name: string; bytes: Uint8Array },
    onProgress: (progress: ParseProgress) => void,
  ): Promise<ParseResult> {
    const blob = new Blob([input.bytes as BlobPart]);
    const order: string[] = [];
    const parts = new Map<string, Uint8Array[]>();
    const rowCounts = new Map<string, number>();

    return this.parse(
      { name: input.name, blob },
      {
        onProgress,
        onBatch: async (batch) => {
          let list = parts.get(batch.table);
          if (!list) {
            list = [];
            parts.set(batch.table, list);
            rowCounts.set(batch.table, 0);
            order.push(batch.table);
          }
          list.push(batch.ipc);
          rowCounts.set(batch.table, (rowCounts.get(batch.table) ?? 0) + batch.rowCount);
        },
      },
    ).then((streamed) => {
      const columnsByTable = new Map(streamed.tables.map((table) => [table.name, table.columns]));
      const tables: TableTransfer[] = order.map((name) => {
        const tableParts = parts.get(name)!;
        return {
          name,
          ipc: tableParts.length === 1 ? tableParts[0]! : concatIpc(tableParts),
          rowCount: rowCounts.get(name) ?? 0,
          columns: columnsByTable.get(name) ?? [],
        };
      });
      return {
        format: streamed.format,
        tables,
        issues: streamed.issues,
        queries: streamed.queries,
        capabilities: streamed.capabilities,
      };
    });
  }

  cancel(): void {
    if (this.disposed || !this.active) return;
    const active = this.active;
    this.active = null;
    try {
      this.worker.postMessage({ type: 'cancel', taskId: active.id });
    } catch {
      // Termination below remains authoritative if cooperative cancellation cannot be posted.
    }
    active.reject(abortError());
    this.replaceWorker();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const active = this.active;
    this.active = null;
    active?.reject(abortError());
    try {
      this.worker.terminate();
    } catch {
      // The client is already unusable; continue disposal.
    }
  }

  private createWorker(): WorkerPort {
    const worker = this.workerFactory();
    const generation = ++this.workerGeneration;
    worker.onmessage = (event) => {
      if (generation !== this.workerGeneration) return;
      this.handleMessage(event.data);
    };
    worker.onerror = () => {
      if (generation === this.workerGeneration) this.handleCrash();
    };
    worker.onmessageerror = () => {
      if (generation === this.workerGeneration) this.handleCrash();
    };
    return worker;
  }

  private replaceWorker(): void {
    try {
      this.worker.terminate();
    } catch {
      // Continue with a fresh worker even if the broken port rejects termination.
    }
    if (this.disposed) return;
    try {
      this.worker = this.createWorker();
    } catch {
      this.disposed = true;
    }
  }

  private handleCrash(): void {
    const active = this.active;
    this.active = null;
    active?.reject(new Error('The parser worker stopped unexpectedly.'));
    this.replaceWorker();
  }

  private handleMessage(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const message = value as WorkerResponse;
    const active = this.active;
    if (!active || message.taskId !== active.id) return;

    switch (message.type) {
      case 'progress':
        active.onProgress({
          stage: message.stage,
          completed: message.completed,
          total: message.total,
          label: message.label,
        });
        break;
      case 'batch': {
        const batch: BatchMessage = {
          seq: message.seq,
          table: message.table,
          ipc: message.ipc,
          rowCount: message.rowCount,
        };
        active.ackChain = active.ackChain
          .then(() => active.onBatch(batch))
          .then(() => {
            if (this.active !== active) return;
            this.worker.postMessage({ type: 'batchAck', taskId: active.id, seq: batch.seq });
          })
          .catch((error: unknown) => {
            if (this.active !== active) return;
            this.active = null;
            active.reject(error);
            try {
              this.worker.postMessage({ type: 'cancel', taskId: active.id });
            } catch {
              // Termination below remains authoritative if cooperative cancellation cannot be posted.
            }
            this.replaceWorker();
          });
        break;
      }
      case 'finish':
        this.active = null;
        active.resolve({
          format: message.format,
          tables: message.tables,
          issues: message.issues,
          queries: message.queries,
          capabilities: message.capabilities,
        });
        break;
      case 'error':
        this.active = null;
        active.reject(new Error(message.message));
        break;
      case 'cancelled':
        this.active = null;
        active.reject(abortError());
        break;
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('The parse worker client is disposed.');
  }
}
