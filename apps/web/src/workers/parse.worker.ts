import type { ParseResult } from '@byteql/core';
import { parseAndProjectMidi, type MidiParseProgress } from '@byteql/midi';

export interface ParseWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
}

type ParseMidi = (
  bytes: Uint8Array,
  signal: AbortSignal,
  onProgress?: (progress: MidiParseProgress) => void,
) => Promise<ParseResult>;

type WorkerRequest =
  { type: 'parse'; taskId: number; name: string; bytes: Uint8Array } | { type: 'cancel'; taskId: number };

const isMidiHeader = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= 4 && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64;

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'The MIDI parser could not process this file.';

const ipcBuffers = (result: ParseResult): ArrayBuffer[] => {
  const buffers = new Set<ArrayBuffer>();
  for (const table of result.tables) {
    if (table.ipc.buffer instanceof ArrayBuffer) buffers.add(table.ipc.buffer);
  }
  return [...buffers];
};

export function installParseWorker(
  scope: ParseWorkerScope,
  parseMidi: ParseMidi = parseAndProjectMidi,
): void {
  const active = new Map<number, AbortController>();
  const cancelled = new Set<number>();

  scope.addEventListener('message', (event) => {
    const request = event.data as WorkerRequest;
    if (!request || typeof request !== 'object') return;

    if (request.type === 'cancel') {
      const controller = active.get(request.taskId);
      if (controller) {
        cancelled.add(request.taskId);
        controller.abort();
      }
      return;
    }
    if (request.type !== 'parse') return;

    const { taskId, bytes } = request;
    if (!isMidiHeader(bytes)) {
      scope.postMessage({
        type: 'error',
        taskId,
        code: 'INVALID_MIDI_HEADER',
        stage: 'framing',
        message: 'This file does not begin with a Standard MIDI File header.',
      });
      return;
    }

    const controller = new AbortController();
    active.set(taskId, controller);
    if (cancelled.has(taskId)) controller.abort();

    void parseMidi(bytes, controller.signal, (progress) => {
      scope.postMessage({ type: 'progress', taskId, ...progress });
    })
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
          code: 'MIDI_PARSE_FAILED',
          stage: 'parsing',
          message: errorMessage(error),
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
