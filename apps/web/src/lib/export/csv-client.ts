import InlineCsvWorker from '../../workers/csv.worker.ts?worker&inline';

import type { CsvClientPort, CsvRequest, CsvResponse } from './csv-protocol.js';

export type { CsvClientPort } from './csv-protocol.js';

export interface CsvWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  terminate(): void;
}

interface InitializeWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface ActiveEncode {
  readonly id: number;
  readonly signal: AbortSignal;
  readonly write: (chunk: Uint8Array) => Promise<void>;
  readonly onAbort: () => void;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  nextSequence: number;
  writingSequence: number | null;
  settled: boolean;
}

const disposedError = (): Error => new Error('The CSV worker client is disposed.');
const abortError = (): DOMException => new DOMException('The CSV export was cancelled.', 'AbortError');

export const createInlineCsvWorker = (): CsvWorkerPort => new InlineCsvWorker({ name: 'byteql-csv-encoder' });

export class CsvWorkerClient implements CsvClientPort {
  private worker: CsvWorkerPort | null = null;
  private readonly initializeWaiters: InitializeWaiter[] = [];
  private nextId = 0;
  private active: ActiveEncode | null = null;
  private ready = false;
  private disposed = false;
  private unavailableError: Error | null = null;

  constructor(workerFactory: () => CsvWorkerPort = createInlineCsvWorker) {
    try {
      const worker = workerFactory();
      worker.onmessage = (event) => this.handleMessage(event.data);
      worker.onerror = () => this.handleWorkerFailure();
      worker.onmessageerror = () => this.handleWorkerFailure();
      this.worker = worker;
    } catch (error) {
      this.unavailableError = asError(error, 'The CSV worker could not be started.');
    }
  }

  initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(disposedError());
    if (this.unavailableError) return Promise.reject(this.unavailableError);
    if (this.ready) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      this.initializeWaiters.push({ resolve, reject });
    });
  }

  encode(
    ipc: Uint8Array,
    columns: readonly number[],
    header: boolean,
    write: (chunk: Uint8Array) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.disposed) return Promise.reject(disposedError());
    if (this.unavailableError) return Promise.reject(this.unavailableError);
    if (!this.ready) return Promise.reject(new Error('The CSV worker has not initialized.'));
    if (this.active) return Promise.reject(new Error('A CSV page is already being encoded.'));
    if (signal.aborted) return Promise.reject(abortError());

    const id = ++this.nextId;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const active: ActiveEncode = {
      id,
      signal,
      write,
      onAbort: () => this.cancelActive(active),
      resolve: resolvePromise,
      reject: rejectPromise,
      nextSequence: 0,
      writingSequence: null,
      settled: false,
    };
    this.active = active;
    signal.addEventListener('abort', active.onAbort, { once: true });

    const ownedIpc = ipc.slice();
    const request: CsvRequest = {
      type: 'encode',
      id,
      ipc: ownedIpc.buffer as ArrayBuffer,
      columns: [...columns],
      header,
    };
    try {
      this.worker!.postMessage(request, [ownedIpc.buffer]);
    } catch (error) {
      this.failWorker(asError(error, 'The CSV worker stopped unexpectedly.'));
    }

    return promise;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const error = disposedError();
    this.rejectInitialize(error);
    const active = this.active;
    if (active) this.settle(active, error, false);
    this.terminateWorker();
  }

  private handleMessage(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const message = value as CsvResponse;
    if (message.type === 'ready') {
      if (this.disposed || this.unavailableError || this.ready) return;
      this.ready = true;
      for (const waiter of this.initializeWaiters.splice(0)) waiter.resolve();
      return;
    }

    const active = this.active;
    if (!active || !('id' in message) || message.id !== active.id) return;

    switch (message.type) {
      case 'chunk':
        this.handleChunk(active, message.sequence, message.bytes);
        break;
      case 'done':
        this.settle(active, undefined, true);
        break;
      case 'error':
        this.settle(active, new Error(message.message), false);
        break;
    }
  }

  private handleChunk(active: ActiveEncode, sequence: number, bytes: ArrayBuffer): void {
    if (
      this.active !== active ||
      active.settled ||
      sequence !== active.nextSequence ||
      active.writingSequence !== null
    ) {
      return;
    }
    active.writingSequence = sequence;

    void Promise.resolve()
      .then(() => {
        if (this.active !== active || active.settled || active.signal.aborted) return;
        return active.write(new Uint8Array(bytes));
      })
      .then(
        () => {
          if (this.active !== active || active.settled || active.signal.aborted) return;
          try {
            const request: CsvRequest = { type: 'ack', id: active.id, sequence };
            this.worker!.postMessage(request);
            active.nextSequence += 1;
            active.writingSequence = null;
          } catch (error) {
            this.failWorker(asError(error, 'The CSV worker stopped unexpectedly.'));
          }
        },
        (error: unknown) => this.failWrite(active, error),
      );
  }

  private failWrite(active: ActiveEncode, error: unknown): void {
    if (this.active !== active || active.settled) return;
    try {
      const request: CsvRequest = { type: 'cancel', id: active.id };
      this.worker!.postMessage(request);
    } catch (postError) {
      this.failWorker(asError(postError, 'The CSV worker stopped unexpectedly.'));
      return;
    }
    this.settle(active, error, false);
  }

  private cancelActive(active: ActiveEncode): void {
    if (this.active !== active || active.settled) return;
    try {
      const request: CsvRequest = { type: 'cancel', id: active.id };
      this.worker!.postMessage(request);
    } catch {
      // The caller's cancellation is authoritative even when the worker port is already broken.
    }
    this.settle(active, abortError(), false);
  }

  private settle(active: ActiveEncode, error: unknown, succeeded: boolean): void {
    if (active.settled) return;
    active.settled = true;
    active.signal.removeEventListener('abort', active.onAbort);
    if (this.active === active) this.active = null;
    if (succeeded) active.resolve();
    else active.reject(error);
  }

  private handleWorkerFailure(): void {
    this.failWorker(new Error('The CSV worker stopped unexpectedly.'));
  }

  private failWorker(error: Error): void {
    if (this.disposed || this.unavailableError) return;
    this.unavailableError = error;
    this.ready = false;
    this.rejectInitialize(error);
    const active = this.active;
    if (active) this.settle(active, error, false);
    this.terminateWorker();
  }

  private rejectInitialize(error: unknown): void {
    for (const waiter of this.initializeWaiters.splice(0)) waiter.reject(error);
  }

  private terminateWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    try {
      worker.terminate();
    } catch {
      // The client no longer uses this port; disposal remains complete.
    }
  }
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
