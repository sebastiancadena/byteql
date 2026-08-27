import type { ParseIssue, TableOverview } from '@byteql/core';
import {
  QUERY_INITIAL_ROWS,
  QUERY_PAGE_ROWS,
  QUERY_RESULT_MEMORY_BYTES,
  sweepQueryPageOrphans,
  sweepSpillOrphans,
  type ByteqlDatabase,
  type IngestSession,
  type QuerySession,
} from '@byteql/db';
import { Table } from 'apache-arrow';

import {
  ParseWorkerClient,
  type ParseClientPort,
  type ParseProgress,
  type StreamedParseResult,
} from '../parse-worker-client.js';
import { REGISTERED_PACKS } from '../packs.js';
import {
  buildFilesTableIpc,
  mergeTableOverviews,
  planBatch,
  type BatchEntry,
  type FilesRow,
  type PlannedFile,
} from './batch.js';
import { SAMPLES, type SampleDefinition, type SampleId } from './samples.js';
import {
  initialSessionState,
  reduceSession,
  type PagedResultState,
  type SessionEvent,
  type SessionState,
  type SourceFile,
} from './state.js';
import { RESULT_WINDOW_ROWS, assembleResultWindow, pageIndexesForWindow } from './result-window.js';
import { TIER_THRESHOLD_BYTES, chooseTier } from './tiering.js';

export interface SessionControllerOptions {
  database: ByteqlDatabase;
  parser?: ParseClientPort;
  fetch?: typeof fetch;
  stopViewer?: () => void;
  /** Test override of per-sample asset URLs; production uses the samples.ts registry. */
  sampleUrlOverrides?: Partial<Record<SampleId, readonly string[]>>;
  /** Test/e2e override of the tiering thresholds; production uses the tiering.ts defaults. */
  tiering?: { tierThresholdBytes?: number; rotationBytes?: number };
}

/** Read-only, bounded-result diagnostics consumed only by the e2e build harness. */
export interface QueryResultDiagnostics {
  readonly loadedRows: number;
  readonly complete: boolean;
  readonly windowStart: number;
  readonly windowRows: number;
  readonly sendCount: number;
  readonly decodedBytes: number;
}

const disposedError = (): Error => new Error('The session controller is disposed.');

const basename = (name: string): string => {
  const safe = name.split(/[\\/]/u).at(-1);
  return safe || 'local file';
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

const bytesToMb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

export class SessionController {
  private state: SessionState = initialSessionState;
  private readonly subscribers = new Set<(state: SessionState) => void>();
  private readonly database: ByteqlDatabase;
  private readonly parser: ParseClientPort;
  private readonly fetchSample: typeof fetch;
  private readonly stopViewer: () => void;
  private readonly tiering: { tierThresholdBytes?: number; rotationBytes?: number } | undefined;
  private initialization: Promise<void> | null = null;
  private readonly initializationAbort = new AbortController();
  private readonly sampleUrlOverrides: Partial<Record<SampleId, readonly string[]>> | undefined;
  private readonly sampleCache = new Map<string, Uint8Array>();
  private sessionGeneration = 0;
  private queryGeneration = 0;
  private activeQuery: QuerySession | null = null;
  private resultDemand: Promise<void> | null = null;
  private retainedBlobs = new Map<string, Blob>();
  private batchFileIndex = 0;
  private batchFileCount = 0;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  /** Cumulative IPC bytes ingested this open, and the last parser-reported stage, for progress. */
  private bytesIngested = 0;
  private lastProgress: ParseProgress | null = null;
  /**
   * Resolves once the ingest session currently (or most recently) owned by this controller has
   * fully settled — its `finalize()` or `abort()` call has resolved or rejected. Starts resolved
   * (no ingest owned yet). `completeBatchOpen` awaits this before its own `beginIngest` call, so a
   * quick supersession never races the real DB's single-open-session invariant (I1).
   */
  private ingestSettlement: Promise<void> = Promise.resolve();

  constructor(options: SessionControllerOptions) {
    this.database = options.database;
    this.parser = options.parser ?? new ParseWorkerClient();
    this.fetchSample = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sampleUrlOverrides = options.sampleUrlOverrides;
    this.stopViewer = options.stopViewer ?? (() => undefined);
    this.tiering = options.tiering;
  }

  initialize(): Promise<void> {
    this.assertUsable();
    this.initialization ??= this.initializeOnce();
    return this.initialization;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.assertUsable();
    this.subscribers.add(listener);
    try {
      listener(this.state);
    } catch (error) {
      this.subscribers.delete(listener);
      throw error;
    }
    return () => this.subscribers.delete(listener);
  }

  getState(): SessionState {
    return this.state;
  }

  openFiles(files: readonly File[]): Promise<void> {
    this.assertUsable();
    const entries: BatchEntry[] = files.map((file) => ({
      name: basename(file.name),
      size: file.size,
      blob: file,
    }));
    return this.openBatch(entries);
  }

  openFile(file: File): Promise<void> {
    return this.openFiles([file]);
  }

  openSample(id: SampleId): Promise<void> {
    this.assertUsable();
    const definition = SAMPLES.find((sample) => sample.id === id);
    if (!definition) return Promise.reject(new Error(`Unknown sample: ${id}`));
    return this.initialize().then(() => this.loadSample(definition));
  }

  private async loadSample(definition: SampleDefinition): Promise<void> {
    const urls = this.sampleUrlOverrides?.[definition.id] ?? definition.files.map((file) => file.url);
    const entries: BatchEntry[] = [];
    for (const [index, file] of definition.files.entries()) {
      const bytes = await this.fetchSampleBytes(urls[index]!);
      if (this.disposed) throw disposedError();
      const blob = new Blob([bytes as BlobPart]);
      entries.push({ name: file.name, size: blob.size, blob });
    }
    return this.openBatch(entries);
  }

  private async fetchSampleBytes(url: string): Promise<Uint8Array> {
    const cached = this.sampleCache.get(url);
    if (cached) return cached;
    const response = await this.fetchSample(url, { signal: this.initializationAbort.signal });
    if (!response.ok) throw new Error('A bundled sample could not be loaded.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.sampleCache.set(url, bytes);
    return bytes;
  }

  runQuery(sql: string): Promise<void> {
    this.assertUsable();
    if (this.state.phase !== 'ready' && this.state.phase !== 'querying') {
      return Promise.reject(new Error('A file must be ready before running a query.'));
    }
    const session = this.sessionGeneration;
    const query = ++this.queryGeneration;
    this.dispatch({ type: 'queryStarted', sql });
    return this.executeQuery(sql, session, query);
  }

  loadMoreResults(): Promise<void> {
    this.assertUsable();
    const result = this.state.result;
    if (!result || result.complete || result.pageError) return Promise.resolve();
    return this.startResultDemand(() => this.fetchMoreResults(result.generation));
  }

  loadResultWindow(globalRow: number): Promise<void> {
    this.assertUsable();
    const result = this.state.result;
    if (!result || !Number.isSafeInteger(globalRow) || globalRow < 0 || globalRow >= result.loadedRows) {
      return Promise.resolve();
    }
    return this.startResultDemand(() => this.publishWindow(result.generation, globalRow));
  }

  queryResultDiagnostics(): QueryResultDiagnostics {
    const result = this.state.result;
    const status = this.activeQuery?.status();
    return {
      loadedRows: result?.loadedRows ?? 0,
      complete: result?.complete ?? false,
      windowStart: result?.windowStart ?? 0,
      windowRows: result?.window.numRows ?? 0,
      sendCount: status?.sendCount ?? 0,
      decodedBytes: status?.decodedBytes ?? 0,
    };
  }

  /** Repeatedly invokes the same demand path the result grid uses until it reaches EOF. */
  async drainQueryResult(): Promise<void> {
    while (this.state.result && !this.state.result.complete && !this.state.result.pageError) {
      const loadedRows = this.state.result.loadedRows;
      await this.loadMoreResults();
      if (!this.state.result || this.state.result.loadedRows <= loadedRows) return;
    }
  }

  retryResultPage(): Promise<void> {
    this.assertUsable();
    const result = this.state.result;
    if (!result?.pageErrorRetryable) return Promise.resolve();
    return this.startResultDemand(() => this.retryPendingResult(result.generation));
  }

  async cancel(): Promise<void> {
    this.assertUsable();
    const stoppedResult = this.state.result && !this.state.result.complete;
    ++this.sessionGeneration;
    ++this.queryGeneration;
    this.cancelParser();
    this.stopActiveViewer();
    const cancellation = this.closeActiveQuery({ cancel: true });
    if (stoppedResult) {
      this.dispatch({
        type: 'queryPageFailed',
        message: 'Query result loading was cancelled. Run the query again to load more rows.',
        retryable: false,
      });
    }
    if (
      this.state.phase === 'opening' ||
      this.state.phase === 'normalizing' ||
      this.state.phase === 'parsing' ||
      this.state.phase === 'projecting' ||
      this.state.phase === 'querying'
    ) {
      this.dispatch({ type: 'cancelled' });
    }
    await cancellation;
  }

  selectResultRow(row: number | null): void {
    this.assertUsable();
    this.dispatch({ type: 'rowSelected', row });
  }

  getSourceBlob(file: string): Blob | null {
    return this.retainedBlobs.get(file) ?? null;
  }

  selectByteRange(range: { file: string; start: number; end: number } | null): void {
    this.assertUsable();
    this.dispatch({ type: 'byteRangeSelected', range });
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    ++this.sessionGeneration;
    ++this.queryGeneration;
    this.initializationAbort.abort();
    this.subscribers.clear();
    this.state = { ...initialSessionState, tables: [], issues: [] };
    void this.initialization?.catch(() => undefined);
    this.sampleCache.clear();
    this.retainedBlobs = new Map();
    this.stopActiveViewer();
    try {
      this.parser.dispose();
    } catch {
      // Continue releasing independently-owned resources.
    }
    this.disposal = (async () => {
      await this.closeActiveQuery({ cancel: true });
      await Promise.resolve()
        .then(() => this.database.dispose())
        .catch(() => undefined);
    })();
    return this.disposal;
  }

  private async initializeOnce(): Promise<void> {
    await Promise.all([
      this.database.initialize(),
      // Best-effort: reclaim OPFS scratch directories orphaned by a prior crashed session.
      // No generation is "kept" — a fresh controller never inherits an in-flight ingest or query.
      sweepSpillOrphans([]).catch(() => undefined),
      sweepQueryPageOrphans().catch(() => undefined),
    ]);
    if (this.disposed) throw disposedError();
  }

  private async openBatch(entries: readonly BatchEntry[]): Promise<void> {
    const generation = ++this.sessionGeneration;
    ++this.queryGeneration;
    this.cancelParser();
    this.stopActiveViewer();
    const queryCancellation = this.closeActiveQuery({ cancel: true });
    this.bytesIngested = 0;
    this.lastProgress = null;

    const plan = await planBatch(entries, REGISTERED_PACKS);
    if (!this.isCurrent(generation)) return;
    const okFiles = plan.files.filter((file) => file.status === 'ok');
    if (plan.formatId === null || okFiles.length === 0) {
      this.dispatch({ type: 'failed', message: 'No registered format recognizes the selected files.' });
      return;
    }

    this.retainedBlobs = new Map(okFiles.map((file) => [file.displayName, file.blob]));
    this.batchFileIndex = 1;
    this.batchFileCount = okFiles.length;
    this.dispatch({
      type: 'opening',
      source: {
        files: okFiles.map((file) => ({ name: file.displayName, size: file.size })),
        totalSize: plan.totalSize,
      },
    });
    return this.completeBatchOpen(generation, plan.formatId, plan.files, queryCancellation);
  }

  private async completeBatchOpen(
    generation: number,
    formatId: string,
    planned: readonly PlannedFile[],
    queryCancellation: Promise<void>,
  ): Promise<void> {
    await queryCancellation;
    if (!this.isCurrent(generation)) return;

    const tierThresholdBytes = this.tiering?.tierThresholdBytes ?? TIER_THRESHOLD_BYTES;
    const okPlanned = planned.filter((file) => file.status === 'ok');
    const totalSize = okPlanned.reduce((sum, file) => sum + file.size, 0);
    const tier = chooseTier(totalSize, tierThresholdBytes);
    if (tier === 'spill') {
      void navigator.storage?.persist?.().catch(() => undefined);
    }

    const rotationBytes = this.tiering?.rotationBytes;
    await this.ingestSettlement;
    if (!this.isCurrent(generation)) return;

    let ingest: IngestSession;
    try {
      ingest = await this.database.beginIngest({
        schemas: 'discover',
        tier,
        generation,
        ...(rotationBytes !== undefined ? { rotationBytes } : {}),
      });
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.dispatch({ type: 'failed', message: this.openFailureMessage(error, tierThresholdBytes) });
      }
      return;
    }

    let settleIngest!: () => void;
    this.ingestSettlement = new Promise<void>((resolve) => {
      settleIngest = resolve;
    });

    try {
      if (!this.isCurrent(generation)) {
        await ingest.abort().catch(() => undefined);
        return;
      }

      // Batch-skip bookkeeping: planner skips carry over; mid-parse failures join them.
      const skipped = new Map<string, string>(
        planned.filter((file) => file.status === 'skipped').map((f) => [f.displayName, f.error ?? '']),
      );
      const results: StreamedParseResult[] = [];
      const succeededFiles: SourceFile[] = [];
      const issues: ParseIssue[] = [];

      try {
        for (const [index, file] of okPlanned.entries()) {
          if (!this.isCurrent(generation)) {
            await ingest.abort().catch(() => undefined);
            return;
          }
          this.batchFileIndex = index + 1;
          this.lastProgress = null;
          await ingest.beginFile(file.displayName);

          const pendingAppends: Promise<void>[] = [];
          try {
            const result = await this.parser.parse(
              { name: file.displayName, blob: file.blob, formatId },
              {
                onProgress: (progress) => {
                  if (this.isCurrent(generation)) this.progress(generation, progress);
                },
                onBatch: async (batch) => {
                  if (!this.isCurrent(generation)) return;
                  this.bytesIngested += batch.ipc.byteLength;
                  this.progressBytes(generation);
                  const append = ingest.appendBatch(batch.table, batch.ipc);
                  pendingAppends.push(append);
                  await append;
                },
              },
            );
            await Promise.all(pendingAppends);
            if (!this.isCurrent(generation)) {
              await ingest.abort().catch(() => undefined);
              return;
            }
            results.push(result);
            succeededFiles.push({ name: file.displayName, size: file.size });
            issues.push(...result.issues);
          } catch (error) {
            await Promise.allSettled(pendingAppends);
            if (isAbortError(error)) throw error;
            const message = errorMessage(error, 'The local file could not be parsed.');
            // Environment-level failures (quota, unsupported spill) doom the whole batch.
            if (message.includes('SPILL_QUOTA_EXCEEDED') || message.includes('SPILL_UNSUPPORTED')) {
              throw error;
            }
            if (!this.isCurrent(generation)) {
              await ingest.abort().catch(() => undefined);
              return;
            }
            await ingest.discardCurrentFile();
            this.retainedBlobs.delete(file.displayName);
            skipped.set(file.displayName, message);
          }
        }

        if (!this.isCurrent(generation)) {
          await ingest.abort().catch(() => undefined);
          return;
        }
        if (results.length === 0) {
          const reasons = [...skipped.values()].filter(Boolean);
          throw new Error(reasons[0] ?? 'None of the selected files could be ingested.');
        }

        for (const [displayName, reason] of skipped) {
          issues.push({
            stage: 'framing',
            track: null,
            code: 'FILE_SKIPPED',
            message: `${displayName} was skipped: ${reason}`,
            recoverable: true,
            sourceStart: null,
            sourceEnd: null,
          });
        }

        const filesRows: FilesRow[] = planned.map((file, order) => ({
          file: file.displayName,
          originalName: file.originalName,
          size: file.size,
          ingestOrder: order,
          status: skipped.has(file.displayName) || file.status === 'skipped' ? 'skipped' : 'ok',
          error: skipped.get(file.displayName) ?? file.error,
        }));
        await ingest.appendBatch('_files', buildFilesTableIpc(filesRows));

        const first = results[0]!;
        const summaries = await ingest.finalize(first.schemas);
        if (!this.isCurrent(generation)) return;

        const rowCounts = new Map(summaries.map((summary) => [summary.name, summary.rowCount]));
        const mergedTables = mergeTableOverviews(results.map((result) => result.tables));
        const populatedNames = new Set(mergedTables.map((table) => table.name));
        const backfilledTables = first.schemas
          .filter((schema) => !populatedNames.has(schema.name))
          .map((schema) => ({ name: schema.name, rowCount: 0, columns: schema.columns }));
        const filesOverview: TableOverview = {
          name: '_files',
          rowCount: filesRows.length,
          columns: [
            { name: 'file', type: 'Utf8', nullable: false },
            { name: 'original_name', type: 'Utf8', nullable: false },
            { name: 'size', type: 'Uint64', nullable: false },
            { name: 'ingest_order', type: 'Int32', nullable: false },
            { name: 'status', type: 'Utf8', nullable: false },
            { name: 'error', type: 'Utf8', nullable: true },
          ],
        };
        this.dispatch({
          type: 'ready',
          format: first.format,
          files: succeededFiles,
          tables: [...mergedTables, ...backfilledTables, filesOverview].map((table) => ({
            ...table,
            rowCount: rowCounts.get(table.name) ?? table.rowCount,
          })),
          issues,
          queries: first.queries,
          capabilities: first.capabilities,
        });
      } catch (error) {
        await ingest.abort().catch(() => undefined);
        if (!this.isCurrent(generation)) return;
        if (isAbortError(error)) {
          this.dispatch({ type: 'cancelled' });
          return;
        }
        this.dispatch({ type: 'failed', message: this.openFailureMessage(error, tierThresholdBytes) });
      }
    } finally {
      settleIngest();
    }
  }

  private openFailureMessage(error: unknown, tierThresholdBytes: number): string {
    const raw = errorMessage(error, 'The local file could not be parsed.');
    if (raw.includes('SPILL_UNSUPPORTED')) {
      return `This browser cannot analyze files over ${bytesToMb(tierThresholdBytes)} MB.`;
    }
    if (raw.includes('SPILL_QUOTA_EXCEEDED')) {
      return 'Local storage ran out of space while analyzing this file. Free up space and try again.';
    }
    return raw;
  }

  private async executeQuery(sql: string, session: number, query: number): Promise<void> {
    const priorResult = this.state.result;
    try {
      await this.closeActiveQuery({ cancel: true });
      if (!this.isCurrentQuery(session, query)) return;
      if (priorResult && !priorResult.complete && this.state.result === priorResult) {
        this.dispatch({
          type: 'queryPageFailed',
          message: 'Run the prior query again to load more rows.',
          retryable: false,
        });
      }

      const active = await this.database.startQuery(sql);
      if (!this.isCurrentQuery(session, query)) {
        await this.closeQuery(active, true);
        return;
      }
      this.activeQuery = active;

      await active.fetchNext(QUERY_INITIAL_ROWS);
      if (!this.isCurrentQuery(session, query) || this.activeQuery !== active) return;
      const status = active.status();
      const result = await this.buildResultState(active, query, Math.max(0, status.loadedRows - 1));
      if (!result || !this.isCurrentQuery(session, query) || this.activeQuery !== active) return;
      this.dispatch({ type: 'querySucceeded', result });
    } catch (error) {
      if (!this.isCurrentQuery(session, query)) return;
      await this.closeActiveQuery({ cancel: true });
      if (isAbortError(error)) {
        this.dispatch({ type: 'cancelled' });
        return;
      }
      this.dispatch({ type: 'queryFailed', message: errorMessage(error, 'The query failed.') });
    }
  }

  private startResultDemand(operation: () => Promise<void>): Promise<void> {
    if (this.resultDemand) return this.resultDemand;
    const demand = operation();
    const settled = demand.finally(() => {
      if (this.resultDemand === settled) this.resultDemand = null;
    });
    this.resultDemand = settled;
    return settled;
  }

  private async fetchMoreResults(generation: number): Promise<void> {
    const active = this.activeQuery;
    const current = this.state.result;
    if (!active || !current || current.generation !== generation) return;
    const anchor = Math.max(0, current.loadedRows - 1);
    this.dispatch({
      type: 'queryWindowUpdated',
      result: {
        ...current,
        loadingMore: true,
        pageError: null,
        pageErrorRetryable: false,
      },
    });

    try {
      await active.fetchNext(QUERY_PAGE_ROWS);
      if (!this.isActiveResult(active, generation)) return;
      await this.publishWindow(generation, anchor);
    } catch (error) {
      if (!this.isActiveResult(active, generation)) return;
      const retryable = this.isRetryablePageError(error);
      this.dispatch({
        type: 'queryPageFailed',
        message: this.resultPageFailureMessage(error, 'More query rows could not be loaded.'),
        retryable,
      });
      if (!retryable) await this.closeActiveQuery({ cancel: true });
    }
  }

  private async retryPendingResult(generation: number): Promise<void> {
    const active = this.activeQuery;
    const current = this.state.result;
    if (!active || !current || current.generation !== generation) return;
    const anchor = Math.max(0, current.loadedRows - 1);
    this.dispatch({
      type: 'queryWindowUpdated',
      result: {
        ...current,
        loadingMore: true,
        pageError: null,
        pageErrorRetryable: false,
      },
    });

    try {
      await active.retryPending();
      if (!this.isActiveResult(active, generation)) return;
      await this.publishWindow(generation, anchor);
    } catch (error) {
      if (!this.isActiveResult(active, generation)) return;
      const retryable = this.isRetryablePageError(error);
      this.dispatch({
        type: 'queryPageFailed',
        message: this.resultPageFailureMessage(error, 'The query result page could not be stored.'),
        retryable,
      });
      if (!retryable) await this.closeActiveQuery({ cancel: true });
    }
  }

  private async publishWindow(generation: number, anchorRow: number): Promise<void> {
    const active = this.activeQuery;
    if (!active || !this.isActiveResult(active, generation)) return;
    try {
      const result = await this.buildResultState(active, generation, anchorRow);
      if (!result || !this.isActiveResult(active, generation)) return;
      this.dispatch({ type: 'queryWindowUpdated', result });
    } catch (error) {
      if (!this.isActiveResult(active, generation)) return;
      this.dispatch({
        type: 'queryPageFailed',
        message: this.resultPageFailureMessage(error, 'The requested query rows could not be loaded.'),
        retryable: false,
      });
      await this.closeActiveQuery({ cancel: true });
    }
  }

  private async buildResultState(
    active: QuerySession,
    generation: number,
    anchorRow: number,
  ): Promise<PagedResultState | null> {
    if (!this.isCurrentQuery(this.sessionGeneration, generation) || this.activeQuery !== active) return null;
    const status = active.status();
    const summaries = active.pages();
    const indexes = pageIndexesForWindow(summaries, anchorRow);
    active.pinPages(indexes);
    const pages = [];
    for (const index of indexes) {
      pages.push(await active.readPage(index));
      if (!this.isCurrentQuery(this.sessionGeneration, generation) || this.activeQuery !== active)
        return null;
    }

    const rowCount = Math.min(RESULT_WINDOW_ROWS, status.loadedRows);
    const normalizedAnchor =
      status.loadedRows === 0 ? 0 : Math.min(Math.max(0, Math.floor(anchorRow)), status.loadedRows - 1);
    const windowStart = Math.min(
      Math.max(0, normalizedAnchor - Math.floor(rowCount / 2)),
      Math.max(0, status.loadedRows - rowCount),
    );
    const window =
      pages.length === 0
        ? new Table(active.schema)
        : assembleResultWindow(pages, { startRow: windowStart, rowCount }).table;

    let completeTable = null;
    if (status.complete) {
      try {
        completeTable = await active.materialize(QUERY_RESULT_MEMORY_BYTES);
      } catch {
        completeTable = null;
      }
      if (!this.isCurrentQuery(this.sessionGeneration, generation) || this.activeQuery !== active)
        return null;
    }

    return {
      generation,
      schema: active.schema,
      loadedRows: status.loadedRows,
      complete: status.complete,
      loadingMore: false,
      windowStart,
      window,
      completeTable,
      elapsedMs: status.elapsedMs,
      pageError: null,
      pageErrorRetryable: false,
    };
  }

  private isActiveResult(active: QuerySession, generation: number): boolean {
    return (
      this.activeQuery === active &&
      this.state.result?.generation === generation &&
      this.isCurrentQuery(this.sessionGeneration, generation)
    );
  }

  private isRetryablePageError(error: unknown): boolean {
    return errorMessage(error, '').includes('RESULT_SPILL_QUOTA_EXCEEDED');
  }

  private resultPageFailureMessage(error: unknown, fallback: string): string {
    const raw = errorMessage(error, fallback);
    if (raw.includes('RESULT_SPILL_QUOTA_EXCEEDED')) {
      return 'Local result storage is full. Free local storage, then retry loading rows.';
    }
    if (raw.includes('RESULT_SPILL_UNSUPPORTED')) {
      return 'This browser cannot retain more local result pages. Narrow the SQL and run the query again.';
    }
    return `${raw} Run the query again to load more rows.`;
  }

  private progress(generation: number, progress: ParseProgress): void {
    if (!this.isCurrent(generation)) return;
    this.lastProgress = progress;
    this.dispatch({
      type: 'progress',
      ...progress,
      bytes: this.bytesIngested,
      fileIndex: this.batchFileIndex,
      fileCount: this.batchFileCount,
    });
  }

  private progressBytes(generation: number): void {
    if (!this.isCurrent(generation)) return;
    const base = this.lastProgress ?? {
      stage: 'parsing' as const,
      completed: 0,
      total: null,
      label: 'Streaming data into the local database',
    };
    this.dispatch({
      type: 'progress',
      ...base,
      bytes: this.bytesIngested,
      fileIndex: this.batchFileIndex,
      fileCount: this.batchFileCount,
    });
  }

  private dispatch(event: SessionEvent): void {
    this.state = reduceSession(this.state, event);
    for (const listener of this.subscribers) {
      try {
        listener(this.state);
      } catch {
        this.subscribers.delete(listener);
      }
    }
  }

  private cancelParser(): void {
    try {
      this.parser.cancel();
    } catch {
      // The client terminates its worker as the authoritative cancellation path.
    }
  }

  private async closeActiveQuery({ cancel }: { cancel: boolean }): Promise<void> {
    const active = this.activeQuery;
    this.activeQuery = null;
    try {
      if (!active) {
        if (cancel)
          await Promise.resolve()
            .then(() => this.database.cancelQuery())
            .catch(() => false);
        return;
      }
      let workActive = true;
      try {
        workActive = !active.status().complete;
      } catch {
        // A closing/terminal cursor still needs best-effort cancellation before disposal.
      }
      await this.closeQuery(active, cancel && workActive);
    } finally {
      this.resultDemand = null;
    }
  }

  private async closeQuery(active: QuerySession, cancel: boolean): Promise<void> {
    if (cancel) await active.cancel().catch(() => false);
    await active.dispose().catch(() => undefined);
  }

  private stopActiveViewer(): void {
    try {
      this.stopViewer();
    } catch {
      // Viewer cleanup must not prevent parse, database, or worker cleanup.
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.sessionGeneration;
  }

  private isCurrentQuery(session: number, query: number): boolean {
    return this.isCurrent(session) && query === this.queryGeneration;
  }

  private assertUsable(): void {
    if (this.disposed) throw disposedError();
  }
}
