import {
  probeSpillCapability,
  probeResultSort,
  probeResultsExport,
  readExportArtifact,
  type ExportProbeReport,
  type ResultSortProbeReport,
  type ExportArtifactInput,
  type ExportArtifactReadback,
  type ByteqlDatabase,
  type FileStatisticsSummary,
  type QueryResultView,
  type SpillProbeReport,
} from '@byteql/db';
import type { Table } from 'apache-arrow';

import {
  createInlineParseWorker,
  ParseWorkerClient,
  type ParseClientPort,
  type WorkerPort,
} from './parse-worker-client.js';
import type { QueryResultDiagnostics } from './session/controller.js';
import type { AudioEngine, AudioRow } from './viewers/tone-engine.js';

interface AudioStats {
  loadCalls: number;
  disposeCalls: number;
  loadedRows: number;
}

export interface SessionOverrides {
  tiering?: { tierThresholdBytes?: number; rotationBytes?: number };
}

export interface ReadStats {
  totalBytesRead: number;
  spillBytes: number;
}

export interface SerializableResult {
  columns: string[];
  types: string[];
  rows: Array<Array<string | number | boolean | null>>;
}

export interface BrowserE2EControl {
  armParserCrash(): void;
  workerCount(): number;
  audioStats(): AudioStats;
  spillProbe: () => Promise<SpillProbeReport>;
  probeResultsExport: (variant: 'mvp' | 'eh', rows: number) => Promise<ExportProbeReport>;
  probeResultSort: (variant: 'mvp' | 'eh') => Promise<ResultSortProbeReport>;
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
  /**
   * Enables duckdb-wasm's per-file read/write counters (`collectFileStatistics`) on the CURRENT
   * generation's registered `opfs://` parquet paths for the named tables. Must be called before
   * the query whose read fraction is being measured; `readStats()` reads the counters back
   * afterward. A no-op for tables with no spilled chunks (e.g. the memory tier, or a table that
   * never rotated) — `readStats()` then reports `totalBytesRead: 0`.
   */
  enableReadStats(tables: readonly string[]): Promise<void>;
  /**
   * Sums the read-byte estimate and on-disk size across every file `enableReadStats` armed.
   * `spillBytes` is the sum of the parquet chunks' actual OPFS file sizes (the query's read
   * fraction is `totalBytesRead / spillBytes`, or callers may divide by the original capture
   * bytes instead — both are meaningful denominators).
   */
  readStats(): Promise<ReadStats>;
  queryResultMetrics(): Promise<QueryResultMetrics>;
  storedResult(): Promise<SerializableResult>;
  exportFiles(): Promise<readonly string[]>;
  readExportArtifact(input: ExportArtifactInput): Promise<ExportArtifactReadback>;
  drainQueryResult(): Promise<void>;
  loadResultWindow(globalRow: number): Promise<void>;
  seedResultPageOrphan(): Promise<{ orphanPath: string; unrelatedPath: string }>;
}

export interface QueryResultMetrics extends QueryResultDiagnostics {
  readonly resultOpfsPaths: readonly string[];
}

interface QueryResultController {
  queryResultDiagnostics(): QueryResultDiagnostics;
  drainQueryResult(): Promise<void>;
  loadResultWindow(globalRow: number): Promise<void>;
}

/** `FileSystemDirectoryHandle` with the async-iterable `entries()` current DOM libs omit. */
type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

const SPILL_ROOT_NAME = 'byteql-spill';
const RESULT_ROOT_NAME = 'byteql-results';
const EXPORT_ROOT_NAME = 'byteql-exports';

const normalizeValue = (value: unknown): string | number | boolean | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) {
    return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

const serializeTable = (table: Table): SerializableResult => ({
  columns: table.schema.fields.map((field) => field.name),
  types: table.schema.fields.map((field) => field.type.toString()),
  rows: Array.from({ length: table.numRows }, (_, row) =>
    table.schema.fields.map((_field, column) => normalizeValue(table.getChildAt(column)?.get(row))),
  ),
});

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
  return collectOpfsFiles(SPILL_ROOT_NAME);
}

async function collectOpfsFiles(rootName: string): Promise<readonly string[]> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return [];
  try {
    const root = await navigator.storage.getDirectory();
    const opfsRoot = await root.getDirectoryHandle(rootName, { create: false });
    return await walkSpillFiles(opfsRoot, `${rootName}/`);
  } catch {
    // No spill data has ever been written, or OPFS is unavailable; treat as empty.
    return [];
  }
}

/** The exact on-disk byte size of a spill chunk, addressed by its `spillFiles()`-style relative path. */
async function spillFileSize(relativePath: string): Promise<number> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return 0;
  const segments = relativePath.split('/');
  let dir: FileSystemDirectoryHandle = await navigator.storage.getDirectory();
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment);
  }
  const fileHandle = await dir.getFileHandle(segments.at(-1)!);
  const file = await fileHandle.getFile();
  return file.size;
}

/**
 * Bytes-read estimator for duckdb-wasm's `FileStatistics` counters.
 *
 * Verified empirically (a small diagnostic capture, real Chromium, real spill-tier parquet
 * chunk): `totalFileReadsCold`/`totalFileReadsAhead`/`totalFileReadsCached` and `totalPageLoads`
 * ARE ALREADY BYTE COUNTS, not block counts — multiplying by `blockSize` (as the brief
 * speculated might be necessary) overstated reads by exactly `blockSize`'s factor (16384x in
 * the observed run: a 212,835-byte parquet file "read" 1,610,612,736 bytes by that formula,
 * over 7500x the file's own size — physically impossible). Four observations pinned this down:
 *   1. A fresh `select ts, caplen, len from packets where caplen > 900` (3 of 4 data columns)
 *      against a 212,835-byte packets chunk reported `totalFileReadsCold: 98304` — 46% of the
 *      file, a plausible fraction for 3 of 4 columns.
 *   2. Re-running the IDENTICAL query changed nothing (`totalFileReadsCold` stayed 98304) —
 *      duckdb's own buffer pool already held those pages, so genuinely nothing was re-fetched.
 *      This is a real *cumulative, deduplicating* counter, not busywork padding.
 *   3. `select * from packets` (all columns, touching the previously-unread ones too) then
 *      pushed `totalFileReadsCold` to exactly 196608 (+98304, another 46%-ish slice) — tracking
 *      real additional I/O for the newly-touched columns, not restarting from zero.
 *   4. `totalPageLoads` was numerically IDENTICAL to `totalFileReadsCold` in every sample
 *      (`totalFileReadsAhead`/`totalFileReadsCached` were 0 throughout this run), consistent
 *      with `totalPageLoads = cold + ahead + cached` — i.e. `totalPageLoads` is the sum, not an
 *      independently-scaled quantity requiring its own multiplier.
 * `blockSize` (16384 in the observed run) still divided every sample evenly — that's the OPFS
 * page cache's fetch granularity (every physical read is block-aligned), not a multiplier the
 * byte counters need applied.
 *
 * `totalFileReadsCold` (on-demand fetch) and `totalFileReadsAhead` (speculative prefetch) both
 * represent genuine OPFS I/O; `totalFileReadsCached` (serves an already-resident page, zero I/O)
 * is excluded — counting it would overstate how many bytes the query actually pulled off disk.
 */
function estimateBytesRead(stats: FileStatisticsSummary): number {
  return stats.totalFileReadsCold + stats.totalFileReadsAhead;
}

export interface BrowserE2EHarness {
  control: BrowserE2EControl;
  createParser(): ParseClientPort;
  audioEngineFactory(): AudioEngine;
  /**
   * Wires the live `ByteqlDatabase` App.svelte just created into `control.enableReadStats`/
   * `readStats()`. Called once per app boot (or retry), after `createBrowserDatabase()`
   * resolves — the harness itself is constructed synchronously at module-eval time, before that
   * database exists, so it starts with no database and this is how it's attached afterward.
   */
  attachDatabase(database: ByteqlDatabase): void;
  /** Attaches production result demand methods without adding an alternate e2e load path. */
  attachQueryController(controller: QueryResultController): void;
}

export function createBrowserE2EHarness(): BrowserE2EHarness {
  let crashNextParse = false;
  let workerCount = 0;
  let liveDatabase: ByteqlDatabase | null = null;
  let queryController: QueryResultController | null = null;
  let readStatsTargets: readonly string[] = [];
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
      probeResultsExport,
      probeResultSort,
      // App.svelte spreads this into `SessionControllerOptions` at controller construction
      // time, on app boot — well before any `page.evaluate()` a spec runs after `page.goto()`
      // could reach it. A spec that needs non-default tiering thresholds must instead set
      // `window.__byteqlE2EOverrides` via `page.addInitScript()` BEFORE navigating, so it's
      // already in place when this module (and the harness it constructs) first evaluates.
      sessionOverrides: globalThis.__byteqlE2EOverrides ?? {},
      spillFiles: () => collectSpillFiles(),
      async enableReadStats(tables) {
        // Opening a file starts the short overview cursor. The benchmark immediately replaces
        // that result, so release it first; duckdb-wasm rejects statistics calls while any
        // cursor owns the sole connection.
        await liveDatabase?.cancelQuery();
        const files = await collectSpillFiles();
        // Every generation directory but the current one is deleted on finalize (see
        // `IngestSessionImpl.finalize` in packages/db/src/browser.ts), so `spillFiles()` already
        // only ever lists the current generation's chunks in practice — filtering by table name
        // is the only narrowing this needs.
        readStatsTargets = files.filter((path) => tables.some((table) => path.includes(`/${table}/`)));
        if (!liveDatabase) return;
        for (const relativePath of readStatsTargets) {
          await liveDatabase.collectFileStatistics(`opfs://${relativePath}`, true);
        }
      },
      async readStats() {
        if (!liveDatabase || readStatsTargets.length === 0) {
          return { totalBytesRead: 0, spillBytes: 0 };
        }
        // The benchmark has already caused the measured reads. Drain through the same demand
        // path the grid uses, then release its completed cursor before exporting counters.
        await queryController?.drainQueryResult();
        await liveDatabase.cancelQuery();
        let totalBytesRead = 0;
        for (const relativePath of readStatsTargets) {
          const stats = await liveDatabase.exportFileStatistics(`opfs://${relativePath}`);
          totalBytesRead += estimateBytesRead(stats);
        }
        const sizes = await Promise.all(readStatsTargets.map(spillFileSize));
        const spillBytes = sizes.reduce((sum, size) => sum + size, 0);
        return { totalBytesRead, spillBytes };
      },
      async queryResultMetrics() {
        const metrics = queryController?.queryResultDiagnostics() ?? {
          loadedRows: 0,
          complete: false,
          windowStart: 0,
          windowRows: 0,
          sendCount: 0,
          decodedBytes: 0,
          orderRevision: 0,
          sort: null,
          sortPending: false,
          derivedViewCount: 0,
          viewCaches: [],
        };
        return { ...metrics, resultOpfsPaths: await collectOpfsFiles(RESULT_ROOT_NAME) };
      },
      async storedResult() {
        // The DISPLAY view, so a readback reflects the committed order rather than the base.
        const result = (queryController as unknown as { activeResultView?: QueryResultView } | null)
          ?.activeResultView;
        if (!result) throw new Error('No stored query result is attached.');
        const rowCap = 20_000;
        if (result.status().loadedRows > rowCap) {
          throw new Error(
            `Refusing to serialize ${result.status().loadedRows} rows; use page metrics instead.`,
          );
        }
        const serialized: SerializableResult = {
          columns: result.schema.fields.map((field) => field.name),
          types: result.schema.fields.map((field) => field.type.toString()),
          rows: [],
        };
        for (const summary of result.pages()) {
          serialized.rows.push(...serializeTable((await result.readPage(summary.index)).table).rows);
        }
        return serialized;
      },
      exportFiles: () => collectOpfsFiles(EXPORT_ROOT_NAME),
      readExportArtifact,
      async drainQueryResult() {
        await queryController?.drainQueryResult();
      },
      async loadResultWindow(globalRow) {
        await queryController?.loadResultWindow(globalRow);
      },
      async seedResultPageOrphan() {
        const root = await navigator.storage.getDirectory();
        const results = await root.getDirectoryHandle(RESULT_ROOT_NAME, { create: true });
        const generation = '777';
        const orphan = await results.getDirectoryHandle(generation, { create: true });
        const orphanFile = await orphan.getFileHandle('0.arrow', { create: true });
        const orphanWriter = await orphanFile.createWritable();
        await orphanWriter.write(new Uint8Array([66, 89, 84, 69, 81, 76]));
        await orphanWriter.close();

        const unrelated = await results.getDirectoryHandle('manual-notes', { create: true });
        const unrelatedFile = await unrelated.getFileHandle('keep.txt', { create: true });
        const unrelatedWriter = await unrelatedFile.createWritable();
        await unrelatedWriter.write('keep');
        await unrelatedWriter.close();
        return {
          orphanPath: `${RESULT_ROOT_NAME}/${generation}/0.arrow`,
          unrelatedPath: `${RESULT_ROOT_NAME}/manual-notes/keep.txt`,
        };
      },
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
    attachDatabase(database: ByteqlDatabase) {
      liveDatabase = database;
    },
    attachQueryController(controller: QueryResultController) {
      queryController = controller;
    },
  };
}
