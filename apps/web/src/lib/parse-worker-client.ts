import type { ParseResult } from '@byteql/core';

export interface ParseProgress {
  stage: 'normalizing' | 'parsing' | 'projecting';
  completed: number;
  total: number | null;
  label: string;
}

export interface ParseClientPort {
  parse(
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
  resolve(result: ParseResult): void;
  reject(error: unknown): void;
  onProgress(progress: ParseProgress): void;
}

type WorkerResponse =
  | ({ type: 'progress'; taskId: number } & ParseProgress)
  | { type: 'result'; taskId: number; result: ParseResult }
  | { type: 'error'; taskId: number; message: string }
  | { type: 'cancelled'; taskId: number };

const abortError = (): DOMException => new DOMException('The parse was cancelled.', 'AbortError');

const defaultWorkerFactory = (): WorkerPort =>
  new Worker(new URL('../workers/parse.worker.ts', import.meta.url), { type: 'module' });

export class ParseWorkerClient implements ParseClientPort {
  private worker: WorkerPort;
  private workerGeneration = 0;
  private nextTaskId = 0;
  private active: ActiveTask | null = null;
  private disposed = false;

  constructor(private readonly workerFactory: () => WorkerPort = defaultWorkerFactory) {
    this.worker = this.createWorker();
  }

  parse(
    input: { name: string; bytes: Uint8Array },
    onProgress: (progress: ParseProgress) => void,
  ): Promise<ParseResult> {
    this.assertUsable();
    if (this.active) this.cancel();

    const taskId = ++this.nextTaskId;
    const promise = new Promise<ParseResult>((resolve, reject) => {
      this.active = { id: taskId, resolve, reject, onProgress };
    });

    try {
      this.worker.postMessage({ type: 'parse', taskId, name: input.name, bytes: input.bytes }, [
        input.bytes.buffer,
      ]);
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
      case 'result':
        this.active = null;
        active.resolve(message.result);
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
