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

export interface SessionOverrides {
  tiering?: { tierThresholdBytes?: number; rotationBytes?: number };
}

export interface BrowserE2EControl {
  armParserCrash(): void;
  workerCount(): number;
  audioStats(): AudioStats;
  spillProbe: () => Promise<SpillProbeReport>;
  /**
   * Plain data spread into `SessionControllerOptions` by App.svelte when it constructs the
   * `SessionController` — e2e-build only. Empty by default so e2e specs exercise the same
   * production tiering thresholds unless a spec opts into an override.
   */
  sessionOverrides?: SessionOverrides;
  /**
   * Every file path under OPFS `byteql-spill/`, walked recursively (e.g.
   * `byteql-spill/1/packets/0.parquet`). Tolerates OPFS or the directory being absent by
   * resolving to `[]` — a session that never spilled, or ran before OPFS is available, is
   * indistinguishable from "no spill files" for e2e purposes.
   */
  spillFiles(): Promise<readonly string[]>;
}

/** `FileSystemDirectoryHandle` with the async-iterable `entries()` current DOM libs omit. */
type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

const SPILL_ROOT_NAME = 'byteql-spill';

async function walkSpillFiles(dir: FileSystemDirectoryHandle, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for await (const [name, handle] of (dir as IterableDirectoryHandle).entries()) {
    const path = `${prefix}${name}`;
    if (handle.kind === 'directory') {
      out.push(...(await walkSpillFiles(handle as FileSystemDirectoryHandle, `${path}/`)));
    } else {
      out.push(path);
    }
  }
  return out;
}

async function collectSpillFiles(): Promise<readonly string[]> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return [];
  try {
    const root = await navigator.storage.getDirectory();
    const spillRoot = await root.getDirectoryHandle(SPILL_ROOT_NAME, { create: false });
    return await walkSpillFiles(spillRoot, `${SPILL_ROOT_NAME}/`);
  } catch {
    // No spill data has ever been written, or OPFS is unavailable; treat as empty.
    return [];
  }
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
      // App.svelte spreads this into `SessionControllerOptions` at controller construction
      // time, on app boot — well before any `page.evaluate()` a spec runs after `page.goto()`
      // could reach it. A spec that needs non-default tiering thresholds must instead set
      // `window.__byteqlE2EOverrides` via `page.addInitScript()` BEFORE navigating, so it's
      // already in place when this module (and the harness it constructs) first evaluates.
      sessionOverrides: globalThis.__byteqlE2EOverrides ?? {},
      spillFiles: () => collectSpillFiles(),
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
