import { tableToIpc } from '@byteql/core';
import { tableFromArrays } from 'apache-arrow';
import { describe, expect, it, vi } from 'vitest';

import { CsvWorkerClient, type CsvWorkerPort } from './csv-client.js';
import type { CsvRequest, CsvResponse } from './csv-protocol.js';
import { installCsvWorker, type CsvWorkerScope } from '../../workers/csv.worker.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 16; tick += 1) await Promise.resolve();
};

class FakeWorker implements CsvWorkerPort {
  readonly posts: Array<{ message: CsvRequest; transfer: readonly Transferable[] }> = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  terminated = false;

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    const clone = structuredClone(message, { transfer: [...transfer] }) as CsvRequest;
    this.posts.push({ message: clone, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: CsvResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: message }));
  }
}

const readyClient = async (): Promise<{ client: CsvWorkerClient; worker: FakeWorker }> => {
  const worker = new FakeWorker();
  const client = new CsvWorkerClient(() => worker);
  const initializing = client.initialize();
  worker.emit({ type: 'ready' });
  await initializing;
  return { client, worker };
};

describe('CsvWorkerClient', () => {
  it('waits for readiness and transfers an owned IPC copy without detaching the source', async () => {
    const worker = new FakeWorker();
    const client = new CsvWorkerClient(() => worker);
    let initialized = false;
    const initializing = client.initialize().then(() => {
      initialized = true;
    });
    await flush();
    expect(initialized).toBe(false);

    worker.emit({ type: 'ready' });
    await initializing;

    const ipc = Uint8Array.of(1, 2, 3, 4);
    const originalBuffer = ipc.buffer;
    const encoding = client.encode(
      ipc,
      [2, 0],
      true,
      vi.fn().mockResolvedValue(undefined),
      new AbortController().signal,
    );
    const request = worker.posts[0]?.message;

    expect(request).toEqual({
      type: 'encode',
      id: 1,
      ipc: Uint8Array.of(1, 2, 3, 4).buffer,
      columns: [2, 0],
      header: true,
    });
    expect(worker.posts[0]?.transfer).toHaveLength(1);
    expect(ipc).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(ipc.buffer).toBe(originalBuffer);
    expect(ipc.buffer.byteLength).toBe(4);

    worker.emit({ type: 'done', id: 1 });
    await expect(encoding).resolves.toBeUndefined();
  });

  it('acknowledges only after the destination write settles and ignores stale operation IDs', async () => {
    const { client, worker } = await readyClient();
    const writeGate = deferred<void>();
    const write = vi.fn(() => writeGate.promise);
    const encoding = client.encode(Uint8Array.of(1), [0], false, write, new AbortController().signal);

    worker.emit({ type: 'chunk', id: 99, sequence: 0, bytes: Uint8Array.of(8).buffer });
    worker.emit({ type: 'chunk', id: 1, sequence: 0, bytes: Uint8Array.of(9).buffer });
    await flush();

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(Uint8Array.of(9));
    expect(worker.posts).toHaveLength(1);

    writeGate.resolve();
    await flush();
    expect(worker.posts.at(-1)?.message).toEqual({ type: 'ack', id: 1, sequence: 0 });

    worker.emit({ type: 'done', id: 99 });
    await flush();
    worker.emit({ type: 'done', id: 1 });
    await expect(encoding).resolves.toBeUndefined();
  });

  it('aborts a pending write, sends cancellation, and removes its abort listener without a late ack', async () => {
    const { client, worker } = await readyClient();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const writeGate = deferred<void>();
    const encoding = client.encode(Uint8Array.of(1), [0], false, () => writeGate.promise, controller.signal);

    worker.emit({ type: 'chunk', id: 1, sequence: 0, bytes: Uint8Array.of(9).buffer });
    await flush();
    controller.abort();

    await expect(encoding).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.posts.at(-1)?.message).toEqual({ type: 'cancel', id: 1 });
    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(removeListener.mock.calls[0]?.[0]).toBe('abort');
    expect(removeListener.mock.calls[0]?.[1]).toBe(addListener.mock.calls[0]?.[1]);

    writeGate.resolve();
    await flush();
    expect(worker.posts.filter(({ message }) => message.type === 'ack')).toHaveLength(0);
  });

  it('does not start a queued destination write after the operation is aborted', async () => {
    const { client, worker } = await readyClient();
    const controller = new AbortController();
    const write = vi.fn().mockResolvedValue(undefined);
    const encoding = client.encode(Uint8Array.of(1), [0], false, write, controller.signal);

    worker.emit({ type: 'chunk', id: 1, sequence: 0, bytes: Uint8Array.of(9).buffer });
    controller.abort();

    await expect(encoding).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(worker.posts.filter(({ message }) => message.type === 'ack')).toHaveLength(0);
  });

  it('does not start a queued destination write after the client is disposed', async () => {
    const { client, worker } = await readyClient();
    const write = vi.fn().mockResolvedValue(undefined);
    const encoding = client.encode(Uint8Array.of(1), [0], false, write, new AbortController().signal);

    worker.emit({ type: 'chunk', id: 1, sequence: 0, bytes: Uint8Array.of(9).buffer });
    await client.dispose();

    await expect(encoding).rejects.toThrow('disposed');
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(worker.posts.filter(({ message }) => message.type === 'ack')).toHaveLength(0);
  });

  it('does not start a queued destination write after worker failure', async () => {
    const { client, worker } = await readyClient();
    const write = vi.fn().mockResolvedValue(undefined);
    const encoding = client.encode(Uint8Array.of(1), [0], false, write, new AbortController().signal);

    worker.emit({ type: 'chunk', id: 1, sequence: 0, bytes: Uint8Array.of(9).buffer });
    worker.onerror?.({ type: 'error' } as ErrorEvent);

    await expect(encoding).rejects.toThrow('CSV worker stopped unexpectedly');
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(worker.posts.filter(({ message }) => message.type === 'ack')).toHaveLength(0);
  });

  it('rejects a failed destination write, cancels only that operation, and remains usable', async () => {
    const { client, worker } = await readyClient();
    const first = client.encode(
      Uint8Array.of(1),
      [0],
      false,
      vi.fn().mockRejectedValue(new Error('disk full')),
      new AbortController().signal,
    );
    worker.emit({ type: 'chunk', id: 1, sequence: 0, bytes: Uint8Array.of(9).buffer });

    await expect(first).rejects.toThrow('disk full');
    expect(worker.posts.at(-1)?.message).toEqual({ type: 'cancel', id: 1 });

    const second = client.encode(
      Uint8Array.of(2),
      [0],
      false,
      vi.fn().mockResolvedValue(undefined),
      new AbortController().signal,
    );
    worker.emit({ type: 'done', id: 1 });
    worker.emit({ type: 'done', id: 2 });
    await expect(second).resolves.toBeUndefined();
  });

  it.each(['error', 'messageerror'] as const)(
    'rejects active work and permanently marks CSV unavailable after worker %s',
    async (kind) => {
      const workers: FakeWorker[] = [];
      const client = new CsvWorkerClient(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      });
      const initializing = client.initialize();
      workers[0]!.emit({ type: 'ready' });
      await initializing;
      const encoding = client.encode(
        Uint8Array.of(1),
        [0],
        false,
        vi.fn().mockResolvedValue(undefined),
        new AbortController().signal,
      );

      if (kind === 'error') workers[0]!.onerror?.({ type: 'error' } as ErrorEvent);
      else workers[0]!.onmessageerror?.(new MessageEvent('messageerror'));

      await expect(encoding).rejects.toThrow('CSV worker stopped unexpectedly');
      await expect(
        client.encode(
          Uint8Array.of(2),
          [0],
          false,
          vi.fn().mockResolvedValue(undefined),
          new AbortController().signal,
        ),
      ).rejects.toThrow('CSV worker stopped unexpectedly');
      expect(workers).toHaveLength(1);
      expect(workers[0]?.terminated).toBe(true);
    },
  );

  it('disposes idempotently and rejects pending initialization', async () => {
    const worker = new FakeWorker();
    const client = new CsvWorkerClient(() => worker);
    const initializing = client.initialize();

    await Promise.all([client.dispose(), client.dispose()]);

    await expect(initializing).rejects.toThrow('disposed');
    expect(worker.terminated).toBe(true);
  });
});

class FakeWorkerScope implements CsvWorkerScope {
  readonly posts: Array<{ message: CsvResponse; transfer: readonly Transferable[] }> = [];
  private listener: ((event: MessageEvent<unknown>) => void) | null = null;

  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') this.listener = listener;
  }

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    const clone = structuredClone(message, { transfer: [...transfer] }) as CsvResponse;
    this.posts.push({ message: clone, transfer });
  }

  receive(message: CsvRequest): void {
    const clone = structuredClone(message);
    this.listener?.(new MessageEvent('message', { data: clone }));
  }
}

class LoopbackWorker implements CsvWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  postMessage!: (message: unknown, transfer?: readonly Transferable[]) => void;
  private readonly scope: CsvWorkerScope;

  constructor() {
    let listener: ((event: MessageEvent<unknown>) => void) | null = null;
    this.scope = {
      addEventListener: (_type, next) => {
        listener = next;
      },
      postMessage: (message, transfer = []) => {
        const clone = structuredClone(message, { transfer: [...transfer] });
        queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: clone })));
      },
    };
    installCsvWorker(this.scope);
    this.postMessage = (message, transfer = []) => {
      const clone = structuredClone(message, { transfer: [...transfer] });
      queueMicrotask(() => listener?.(new MessageEvent('message', { data: clone })));
    };
  }

  terminate(): void {}
}

const responsesFor = (scope: FakeWorkerScope, id: number): CsvResponse[] =>
  scope.posts.map(({ message }) => message).filter((message) => 'id' in message && message.id === id);

describe('CSV worker boundary', () => {
  it('waits for the exact acknowledgment and ignores wrong and duplicate acknowledgments', async () => {
    const scope = new FakeWorkerScope();
    installCsvWorker(scope);
    const ipc = tableToIpc(tableFromArrays({ value: ['x'.repeat(70_000)] }));

    scope.receive({ type: 'encode', id: 4, ipc: ipc.buffer as ArrayBuffer, columns: [0], header: false });
    await flush();
    expect(responsesFor(scope, 4)).toHaveLength(1);
    expect(responsesFor(scope, 4)[0]).toMatchObject({ type: 'chunk', id: 4, sequence: 0 });

    scope.receive({ type: 'ack', id: 99, sequence: 0 });
    scope.receive({ type: 'ack', id: 4, sequence: 99 });
    await flush();
    expect(responsesFor(scope, 4)).toHaveLength(1);

    scope.receive({ type: 'ack', id: 4, sequence: 0 });
    scope.receive({ type: 'ack', id: 4, sequence: 0 });
    await flush();
    expect(responsesFor(scope, 4)).toHaveLength(2);
    expect(responsesFor(scope, 4)[1]).toMatchObject({ type: 'chunk', id: 4, sequence: 1 });

    scope.receive({ type: 'ack', id: 4, sequence: 1 });
    await flush();
    expect(responsesFor(scope, 4).at(-1)).toEqual({ type: 'done', id: 4 });
  });

  it('cancels an acknowledgment wait without advancing or reporting an error', async () => {
    const scope = new FakeWorkerScope();
    installCsvWorker(scope);
    const ipc = tableToIpc(tableFromArrays({ value: ['x'.repeat(70_000)] }));
    scope.receive({ type: 'encode', id: 5, ipc: ipc.buffer as ArrayBuffer, columns: [0], header: false });
    await flush();

    scope.receive({ type: 'cancel', id: 5 });
    await flush();
    scope.receive({ type: 'ack', id: 5, sequence: 0 });
    await flush();

    expect(responsesFor(scope, 5)).toHaveLength(1);
    expect(responsesFor(scope, 5)[0]).toMatchObject({ type: 'chunk', sequence: 0 });
  });

  it('encodes multiple pages with the BOM and header only on the requested first page', async () => {
    const client = new CsvWorkerClient(() => new LoopbackWorker());
    await client.initialize();
    const chunks: Uint8Array[] = [];
    const write = async (chunk: Uint8Array): Promise<void> => {
      chunks.push(chunk.slice());
    };

    await client.encode(
      tableToIpc(tableFromArrays({ value: ['first'] })),
      [0],
      true,
      write,
      new AbortController().signal,
    );
    await client.encode(
      tableToIpc(tableFromArrays({ value: ['second'] })),
      [0],
      false,
      write,
      new AbortController().signal,
    );

    const text = chunks.map((chunk) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(chunk)).join('');
    expect(text).toBe('\uFEFF"value"\r\n"first"\r\n"second"\r\n');
  });
});
