import { sweepSpillOrphans, type ByteqlDatabase, type IngestSession } from '@byteql/db';

import demoUrl from '../../assets/demo.mid?url';
import { ParseWorkerClient, type ParseClientPort, type ParseProgress } from '../parse-worker-client.js';
import { initialSessionState, reduceSession, type SessionEvent, type SessionState } from './state.js';
import { TIER_THRESHOLD_BYTES, chooseTier } from './tiering.js';

export interface SessionControllerOptions {
  database: ByteqlDatabase;
  parser?: ParseClientPort;
  fetch?: typeof fetch;
  demoUrl?: string;
  stopViewer?: () => void;
  /** Test/e2e override of the tiering thresholds; production uses the tiering.ts defaults. */
  tiering?: { tierThresholdBytes?: number; rotationBytes?: number };
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
  private readonly demoUrl: string;
  private readonly stopViewer: () => void;
  private readonly tiering: { tierThresholdBytes?: number; rotationBytes?: number } | undefined;
  private initialization: Promise<void> | null = null;
  private readonly initializationAbort = new AbortController();
  private sampleBytes: Uint8Array | null = null;
  private sessionGeneration = 0;
  private queryGeneration = 0;
  private retainedFile: File | null = null;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  /** Cumulative IPC bytes ingested this open, and the last parser-reported stage, for progress. */
  private bytesIngested = 0;
  private lastProgress: ParseProgress | null = null;

  constructor(options: SessionControllerOptions) {
    this.database = options.database;
    this.parser = options.parser ?? new ParseWorkerClient();
    this.fetchSample = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.demoUrl = options.demoUrl ?? demoUrl;
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

  openFile(file: File): Promise<void> {
    this.assertUsable();
    this.retainedFile = file;
    return this.open({ name: basename(file.name), size: file.size }, file);
  }

  openSample(): Promise<void> {
    this.assertUsable();
    if (!this.sampleBytes) {
      return this.initialize().then(() => this.openSample());
    }
    this.retainedFile = null;
    const retained = this.sampleBytes;
    return this.open({ name: 'demo.mid', size: retained.byteLength }, new Blob([retained as BlobPart]));
  }

  runQuery(sql: string): Promise<void> {
    this.assertUsable();
    if (this.state.phase !== 'ready' && this.state.phase !== 'querying') {
      return Promise.reject(new Error('A file must be ready before running a query.'));
    }
    const session = this.sessionGeneration;
    const query = ++this.queryGeneration;
    if (this.state.phase === 'querying') void this.database.cancelQuery().catch(() => false);
    this.dispatch({ type: 'queryStarted', sql });
    return this.executeQuery(sql, session, query);
  }

  async cancel(): Promise<void> {
    this.assertUsable();
    ++this.sessionGeneration;
    ++this.queryGeneration;
    this.cancelParser();
    this.stopActiveViewer();
    const cancellation = this.cancelDatabaseQuery();
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

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    ++this.sessionGeneration;
    ++this.queryGeneration;
    this.initializationAbort.abort();
    this.subscribers.clear();
    this.state = { ...initialSessionState, tables: [], issues: [] };
    void this.initialization?.catch(() => undefined);
    this.sampleBytes = null;
    this.retainedFile = null;
    this.stopActiveViewer();
    try {
      this.parser.dispose();
    } catch {
      // Continue releasing independently-owned resources.
    }
    this.disposal = (async () => {
      await Promise.allSettled([
        this.cancelDatabaseQuery(),
        Promise.resolve().then(() => this.database.dispose()),
      ]);
    })();
    return this.disposal;
  }

  private async initializeOnce(): Promise<void> {
    const [response] = await Promise.all([
      this.fetchSample(this.demoUrl, { signal: this.initializationAbort.signal }),
      this.database.initialize(),
      // Best-effort: reclaim any OPFS spill directories orphaned by a prior crashed session.
      // No generation is "kept" — a fresh controller never inherits an in-flight ingest.
      sweepSpillOrphans([]).catch(() => undefined),
    ]);
    if (!response.ok) throw new Error('The bundled demo MIDI could not be loaded.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (this.disposed) throw disposedError();
    this.sampleBytes = bytes;
  }

  private open(source: { name: string; size: number }, blob: Blob): Promise<void> {
    const generation = ++this.sessionGeneration;
    ++this.queryGeneration;
    this.cancelParser();
    this.stopActiveViewer();
    const queryCancellation = this.cancelDatabaseQuery();
    this.bytesIngested = 0;
    this.lastProgress = null;
    this.dispatch({ type: 'opening', source });
    return this.completeOpen(generation, source.name, blob, queryCancellation);
  }

  private async completeOpen(
    generation: number,
    name: string,
    blob: Blob,
    queryCancellation: Promise<boolean>,
  ): Promise<void> {
    await queryCancellation;
    if (!this.isCurrent(generation)) return;

    const tierThresholdBytes = this.tiering?.tierThresholdBytes ?? TIER_THRESHOLD_BYTES;
    const tier = chooseTier(blob.size, tierThresholdBytes);
    if (tier === 'spill') {
      // Fire-and-forget: best-effort request not to have OPFS spill data evicted under pressure.
      // `navigator.storage` is absent in non-browser test environments, hence the guard.
      void navigator.storage?.persist?.().catch(() => undefined);
    }

    const rotationBytes = this.tiering?.rotationBytes;
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

    if (!this.isCurrent(generation)) {
      await ingest.abort().catch(() => undefined);
      return;
    }

    // The client resolves `parse()` as soon as the worker's `finish` message arrives, and the
    // worker sends `finish` right after its last `nextBatch()` — it does NOT wait for that last
    // batch (or up to BATCH_CREDIT_WINDOW batches still in flight) to be acked first. So `finish`
    // can race ahead of one or more `onBatch` calls that are still awaiting `appendBatch`. Every
    // `appendBatch` promise is tracked here and awaited below, after `parse()` settles but before
    // `finalize()` — otherwise finalize can commit while a batch is still mid-append, silently
    // dropping rows (or, once the session is finalized under it, rejecting that straggling append).
    const pendingAppends: Promise<void>[] = [];

    try {
      const result = await this.parser.parse(
        { name, blob },
        {
          onProgress: (progress) => {
            if (this.isCurrent(generation)) this.progress(generation, progress);
          },
          onBatch: async (batch) => {
            // Generation-guard only: the client can still deliver up to BATCH_CREDIT_WINDOW - 1
            // queued `onBatch` calls after this generation is superseded or cancelled (already
            // in-flight batch messages keep draining through the client's ack chain). Dropping
            // them here — before touching `ingest` at all — means we never call `appendBatch` on
            // an ingest whose abort may or may not have completed yet, without needing a second
            // local "aborted" flag: every path that supersedes or cancels this generation bumps
            // `sessionGeneration` synchronously before anything else happens.
            if (!this.isCurrent(generation)) return;
            this.bytesIngested += batch.ipc.byteLength;
            this.progressBytes(generation);
            const append = ingest.appendBatch(batch.table, batch.ipc);
            pendingAppends.push(append);
            await append;
          },
        },
      );

      if (!this.isCurrent(generation)) {
        await ingest.abort().catch(() => undefined);
        return;
      }

      await Promise.all(pendingAppends);
      if (!this.isCurrent(generation)) {
        await ingest.abort().catch(() => undefined);
        return;
      }

      const summaries = await ingest.finalize();
      if (!this.isCurrent(generation)) return;

      const rowCounts = new Map(summaries.map((summary) => [summary.name, summary.rowCount]));
      this.dispatch({
        type: 'ready',
        format: result.format,
        tables: result.tables.map((table) => ({
          ...table,
          rowCount: rowCounts.get(table.name) ?? table.rowCount,
        })),
        issues: result.issues,
        queries: result.queries,
        capabilities: result.capabilities,
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
    try {
      const result = await this.database.query(sql);
      if (!this.isCurrentQuery(session, query)) return;
      this.dispatch({ type: 'querySucceeded', result: result.table, elapsedMs: result.elapsedMs });
    } catch (error) {
      if (!this.isCurrentQuery(session, query)) return;
      if (isAbortError(error)) {
        this.dispatch({ type: 'cancelled' });
        return;
      }
      this.dispatch({ type: 'queryFailed', message: errorMessage(error, 'The query failed.') });
    }
  }

  private progress(generation: number, progress: ParseProgress): void {
    if (!this.isCurrent(generation)) return;
    this.lastProgress = progress;
    this.dispatch({ type: 'progress', ...progress, bytes: this.bytesIngested });
  }

  private progressBytes(generation: number): void {
    if (!this.isCurrent(generation)) return;
    const base = this.lastProgress ?? {
      stage: 'parsing' as const,
      completed: 0,
      total: null,
      label: 'Streaming data into the local database',
    };
    this.dispatch({ type: 'progress', ...base, bytes: this.bytesIngested });
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

  private cancelDatabaseQuery(): Promise<boolean> {
    return Promise.resolve()
      .then(() => this.database.cancelQuery())
      .catch(() => false);
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
