import { probeSpillCapability, type SpillProbeReport } from '@byteql/db';

import {
  createInlineParseWorker,
  ParseWorkerClient,
  type ParseClientPort,
  type WorkerPort,
} from './parse-worker-client.js';
import type { AudioEngine, AudioRow } from './viewers/tone-engine.js';

interface AudioStats {
  loadCalls: number;
  disposeCalls: number;
  loadedRows: number;
}

export interface BrowserE2EControl {
  armParserCrash(): void;
  workerCount(): number;
  audioStats(): AudioStats;
  spillProbe: () => Promise<SpillProbeReport>;
}

export interface BrowserE2EHarness {
  control: BrowserE2EControl;
  createParser(): ParseClientPort;
  audioEngineFactory(): AudioEngine;
}

export function createBrowserE2EHarness(): BrowserE2EHarness {
  let crashNextParse = false;
  let workerCount = 0;
  const audioStats: AudioStats = { loadCalls: 0, disposeCalls: 0, loadedRows: 0 };

  const createWorker = (): WorkerPort => {
    workerCount += 1;
    const inner = createInlineParseWorker();
    const port: WorkerPort = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage(message, transfer) {
        inner.postMessage(message, transfer);
        if (
          crashNextParse &&
          message !== null &&
          typeof message === 'object' &&
          (message as { type?: unknown }).type === 'parse'
        ) {
          crashNextParse = false;
          globalThis.queueMicrotask(() => port.onerror?.(new ErrorEvent('error')));
        }
      },
      terminate() {
        inner.terminate();
      },
    };
    inner.onmessage = (event) => port.onmessage?.(event);
    inner.onerror = (event) => port.onerror?.(event);
    inner.onmessageerror = (event) => port.onmessageerror?.(event);
    return port;
  };

  return {
    control: {
      armParserCrash() {
        crashNextParse = true;
      },
      workerCount: () => workerCount,
      audioStats: () => ({ ...audioStats }),
      spillProbe: () => probeSpillCapability(),
    },
    createParser: () => new ParseWorkerClient(createWorker),
    audioEngineFactory: () => {
      let disposed = false;
      return {
        async load(rows: readonly AudioRow[]) {
          if (disposed) throw new Error('The E2E audio engine is disposed.');
          audioStats.loadCalls += 1;
          audioStats.loadedRows = rows.length;
        },
        async play() {},
        pause() {},
        stop() {},
        seek() {},
        positionSeconds: () => 0,
        dispose() {
          if (disposed) return;
          disposed = true;
          audioStats.disposeCalls += 1;
        },
      };
    },
  };
}
