import InlineParseWorker from '../workers/parse.worker.ts?worker&inline';
import type { BatchMessage, ParseProgress, StreamedParseResult, WorkerResponse } from './parse-protocol.js';

export type { BatchMessage, ParseProgress, StreamedParseResult } from './parse-protocol.js';

export interface ParseHandlers {
  onProgress(progress: ParseProgress): void;
  onBatch(batch: BatchMessage): Promise<void>;
}

export interface ParseClientPort {
  parse(
    input: { name: string; blob: Blob; formatId?: string },
    handlers: ParseHandlers,
  ): Promise<StreamedParseResult>;
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
  /** True once `resolve`/`reject` has taken effect; both are no-ops after that. */
  settled: boolean;
  resolve(result: StreamedParseResult): void;
  reject(error: unknown): void;
  onProgress(progress: ParseProgress): void;
  onBatch(batch: BatchMessage): Promise<void>;
  /** Serializes batch handling and ack posting in arrival (seq) order. */
  ackChain: Promise<void>;
}

const abortError = (): DOMException => new DOMException('The parse was cancelled.', 'AbortError');

export const createInlineParseWorker = (): WorkerPort => new InlineParseWorker({ name: 'byteql-parser' });

export class ParseWorkerClient implements ParseClientPort {
  private worker: WorkerPort;
  private workerGeneration = 0;
  private nextTaskId = 0;
  private active: ActiveTask | null = null;
  private disposed = false;

  constructor(private readonly workerFactory: () => WorkerPort = createInlineParseWorker) {
    this.worker = this.createWorker();
  }

  parse(
    input: { name: string; blob: Blob; formatId?: string },
    handlers: ParseHandlers,
  ): Promise<StreamedParseResult> {
    this.assertUsable();
    if (this.active) this.cancel();

    const taskId = ++this.nextTaskId;
    let settleResolve!: (result: StreamedParseResult) => void;
    let settleReject!: (error: unknown) => void;
    const promise = new Promise<StreamedParseResult>((resolve, reject) => {
      settleResolve = resolve;
      settleReject = reject;
    });
    const active: ActiveTask = {
      id: taskId,
      settled: false,
      resolve: (result) => {
        if (active.settled) return;
        active.settled = true;
        settleResolve(result);
      },
      reject: (error) => {
        if (active.settled) return;
        active.settled = true;
        settleReject(error);
      },
      onProgress: handlers.onProgress,
      onBatch: handlers.onBatch,
      ackChain: Promise.resolve(),
    };
    this.active = active;

    try {
      this.worker.postMessage({
        type: 'parse',
        taskId,
        name: input.name,
        blob: input.blob,
        ...(input.formatId !== undefined ? { formatId: input.formatId } : {}),
      });
    } catch (error) {
      this.active = null;
      this.replaceWorker();
      return Promise.reject(error);
    }

    return promise;
  }

  cancel(): void {
    if (this.disposed || !this.active) return;
    const active = this.active;
    this.active = null;
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
    if (active) {
      // Same ack-chain deferral as `case 'error'` above: don't reject ahead of queued-but-not-
      // yet-started `onBatch` calls, or a caller's failure cleanup can race a batch write for the
      // task it just discarded.
      void active.ackChain.then(
        () => active.reject(new Error('The parser worker stopped unexpectedly.')),
        () => active.reject(new Error('The parser worker stopped unexpectedly.')),
      );
    }
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
            // Always attempt to settle the task with the real failure — a no-op if `finish`'s
            // ack-chain wait (below) already resolved it first. Only touch the shared worker if
            // this task still owns it; a newer task (or none) may already have replaced it.
            active.reject(error);
            if (this.active !== active) return;
            this.active = null;
            this.replaceWorker();
          });
        break;
      }
      case 'finish': {
        // The worker sends `finish` as soon as its pull loop is exhausted — it does NOT wait for
        // outstanding batch acks first, so up to BATCH_CREDIT_WINDOW `onBatch` calls can still be
        // in flight. Resolving immediately would let a caller (e.g. an ingest sink) act on a
        // result before every batch has actually been handled. Waiting on `ackChain` — captured
        // now, since every `batch` message for this task has already been synchronously chained
        // onto it by the time `finish` arrives — guarantees every `onBatch` call has settled
        // first. If one of them failed, its own `.catch` above already rejected the task with the
        // real error, and `resolve` below becomes the (guarded) no-op.
        this.active = null;
        const result: StreamedParseResult = {
          format: message.format,
          tables: message.tables,
          issues: message.issues,
          queries: message.queries,
          capabilities: message.capabilities,
          schemas: message.schemas,
        };
        void active.ackChain.then(
          () => active.resolve(result),
          () => undefined,
        );
        break;
      }
      case 'error': {
        // Mirror `finish`'s deferral: up to BATCH_CREDIT_WINDOW `batch` messages can already be
        // chained onto `ackChain` (queued but not yet started) by the time `error` arrives.
        // Rejecting immediately would let a caller (e.g. an ingest sink) run its failure cleanup
        // — which may delete rows for this task — before a still-queued `onBatch` fires and
        // writes rows for the very task being discarded. Waiting on `ackChain` — captured now —
        // guarantees every `onBatch` call has started (and settled) before the task rejects. If
        // one of them failed first, its own `.catch` above already rejected the task with that
        // error, and `reject` below becomes the (guarded) no-op; otherwise this rejects with the
        // worker's reported error once the chain has drained.
        this.active = null;
        const errorMessage = message.message;
        void active.ackChain.then(
          () => active.reject(new Error(errorMessage)),
          () => active.reject(new Error(errorMessage)),
        );
        break;
      }
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('The parse worker client is disposed.');
  }
}
