import { ipcToTable } from '@byteql/core';

import { csvChunks } from '../lib/export/csv.js';
import type { CsvRequest, CsvResponse } from '../lib/export/csv-protocol.js';

export interface CsvWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
}

interface AckWaiter {
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: () => void;
}

const ackKey = (id: number, sequence: number): string => `${id}:${sequence}`;

export function installCsvWorker(scope: CsvWorkerScope): void {
  const active = new Map<number, AbortController>();
  const ackWaiters = new Map<string, AckWaiter>();

  const clearWaiter = (key: string, waiter: AckWaiter): void => {
    if (ackWaiters.get(key) === waiter) ackWaiters.delete(key);
    waiter.signal.removeEventListener('abort', waiter.onAbort);
  };

  const postChunk = (id: number, sequence: number, chunk: Uint8Array): void => {
    const bytes = chunk.buffer as ArrayBuffer;
    const response: CsvResponse = { type: 'chunk', id, sequence, bytes };
    scope.postMessage(response, [bytes]);
  };

  const waitForAck = (id: number, sequence: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    const key = ackKey(id, sequence);
    return new Promise<void>((resolve, reject) => {
      const waiter: AckWaiter = {
        signal,
        onAbort: () => {
          clearWaiter(key, waiter);
          reject(signal.reason);
        },
        resolve: () => {
          clearWaiter(key, waiter);
          resolve();
        },
      };
      ackWaiters.set(key, waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  };

  const runEncode = async (request: Extract<CsvRequest, { type: 'encode' }>): Promise<void> => {
    if (active.has(request.id)) return;
    const controller = new AbortController();
    active.set(request.id, controller);
    try {
      const table = ipcToTable(new Uint8Array(request.ipc));
      let sequence = 0;
      for (const chunk of csvChunks(table, request.columns, request.header)) {
        controller.signal.throwIfAborted();
        postChunk(request.id, sequence, chunk);
        await waitForAck(request.id, sequence, controller.signal);
        sequence += 1;
      }
      controller.signal.throwIfAborted();
      const response: CsvResponse = { type: 'done', id: request.id };
      scope.postMessage(response);
    } catch (error) {
      if (!controller.signal.aborted) {
        const response: CsvResponse = {
          type: 'error',
          id: request.id,
          message: errorMessage(error),
        };
        scope.postMessage(response);
      }
    } finally {
      active.delete(request.id);
    }
  };

  scope.addEventListener('message', (event) => {
    const request = event.data as CsvRequest;
    if (!request || typeof request !== 'object') return;
    if (request.type === 'ack') {
      ackWaiters.get(ackKey(request.id, request.sequence))?.resolve();
      return;
    }
    if (request.type === 'cancel') {
      active.get(request.id)?.abort();
      return;
    }
    if (request.type === 'encode') void runEncode(request);
  });

  const response: CsvResponse = { type: 'ready' };
  scope.postMessage(response);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'CSV encoding failed.';
}

const workerScope = globalThis as unknown as CsvWorkerScope & { document?: unknown };
if (typeof workerScope.addEventListener === 'function' && workerScope.document === undefined) {
  installCsvWorker(workerScope);
}
