import { createInlineParseWorker, ParseWorkerClient, type WorkerPort } from '../parse-worker-client.js';

interface WorkerProbeResult {
  initial: string;
  cancellation: string;
  crash: string;
  messageError: string;
  recreated: string;
  workerCount: number;
}

declare global {
  var markByteqlWorkerReady: () => Promise<void>;
  var runByteqlWorkerProbe: (() => Promise<WorkerProbeResult>) | undefined;
}

const rejectMessage = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'resolved unexpectedly';
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
};

globalThis.runByteqlWorkerProbe = async () => {
  const workers: WorkerPort[] = [];
  const client = new ParseWorkerClient(() => {
    const worker = createInlineParseWorker();
    workers.push(worker);
    return worker;
  });
  const invalid = (): Blob => new Blob([new Uint8Array([1, 2, 3, 4])]);
  const parseable = (): Blob => new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64])]);
  const noop = { onProgress: () => undefined, onBatch: async () => undefined };

  const initial = await rejectMessage(client.parse({ name: 'initial.mid', blob: invalid() }, noop));
  await globalThis.markByteqlWorkerReady();

  const cancelled = client.parse({ name: 'cancelled.mid', blob: parseable() }, noop);
  client.cancel();
  const cancellation = await rejectMessage(cancelled);

  const crashed = client.parse({ name: 'crashed.mid', blob: parseable() }, noop);
  workers.at(-1)?.onerror?.(new ErrorEvent('error'));
  const crash = await rejectMessage(crashed);

  const corrupted = client.parse({ name: 'corrupted.mid', blob: parseable() }, noop);
  workers.at(-1)?.onmessageerror?.(new MessageEvent('messageerror'));
  const messageError = await rejectMessage(corrupted);

  const recreated = await rejectMessage(client.parse({ name: 'recreated.mid', blob: invalid() }, noop));
  client.dispose();

  return { initial, cancellation, crash, messageError, recreated, workerCount: workers.length };
};
