import {
  sweepQueryPageOrphans,
  sweepSpillOrphans,
  type ByteqlDatabase,
  type ResultSort,
  type ResultSortCapability,
} from '@byteql/db';

import { ParseWorkerClient, type ParseClientPort } from '../parse-worker-client.js';
import { CsvWorkerClient, type CsvClientPort } from '../export/csv-client.js';
import { prepareDestination as createExportDestination } from '../export/destination.js';
import type { ExportDestinationFactory } from '../export/operation.js';
import type { ExportOptions } from '../export/options.js';
import type { BatchEntry } from './batch.js';
import { IntakeOrchestrator } from './intake.js';
import { ResultExporter } from './result-exporter.js';
import { createResultBusy, type ResultBusy } from './result-sort.js';
import { ResultSession } from './result-session.js';
import { ResultSorter } from './result-sorter.js';
import { SAMPLES, type SampleDefinition, type SampleId } from './samples.js';
import { SessionStore } from './session-store.js';
import type { SessionState } from './state.js';

export interface SessionControllerOptions {
  database: ByteqlDatabase;
  parser?: ParseClientPort;
  csvClient?: CsvClientPort;
  prepareDestination?: ExportDestinationFactory;
  fetch?: typeof fetch;
  stopViewer?: () => void;
  /** Test override of per-sample asset URLs; production uses the samples.ts registry. */
  sampleUrlOverrides?: Partial<Record<SampleId, readonly string[]>>;
  /** Test/e2e override of the tiering thresholds; production uses the tiering.ts defaults. */
  tiering?: { tierThresholdBytes?: number; rotationBytes?: number };
}

const disposedError = (): Error => new Error('The session controller is disposed.');

const basename = (name: string): string => {
  const safe = name.split(/[\\/]/u).at(-1);
  return safe || 'local file';
};

/**
 * The session façade the workbench drives. It owns lifecycle (initialization, samples, disposal)
 * and the order in which a new file, query, cancellation, or disposal supersedes the work in
 * flight; intake, paging, sorting, and downloads live in their own collaborators, which all
 * publish through one `SessionStore` and its pure reducer.
 */
export class SessionController {
  private readonly store = new SessionStore();
  private readonly database: ByteqlDatabase;
  private readonly csvClient: CsvClientPort;
  private readonly fetchSample: typeof fetch;
  private readonly stopViewer: () => void;
  private initialization: Promise<void> | null = null;
  private csvDisposal: Promise<void> | null = null;
  private readonly initializationAbort = new AbortController();
  private readonly sampleUrlOverrides: Partial<Record<SampleId, readonly string[]>> | undefined;
  private readonly sampleCache = new Map<string, Uint8Array>();
  private readonly results: ResultSession;
  private readonly sorter: ResultSorter;
  private readonly busy: ResultBusy;
  private readonly exporter: ResultExporter;
  private readonly intake: IntakeOrchestrator;
  private disposal: Promise<void> | null = null;

  constructor(options: SessionControllerOptions) {
    this.database = options.database;
    this.csvClient = options.csvClient ?? new CsvWorkerClient();
    this.fetchSample = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sampleUrlOverrides = options.sampleUrlOverrides;
    this.stopViewer = options.stopViewer ?? (() => undefined);
    this.intake = new IntakeOrchestrator(this.store, this.database, {
      parser: options.parser ?? new ParseWorkerClient(),
      tiering: options.tiering,
    });
    this.busy = createResultBusy(
      () => this.store.state,
      () => this.sorter.pending,
    );
    this.results = new ResultSession(this.store, this.database, this.busy, {
      supersedeExport: () => this.exporter.supersede(),
    });
    this.exporter = new ResultExporter(this.store, this.database, this.results, this.busy, {
      csvClient: this.csvClient,
      prepareDestination: options.prepareDestination ?? createExportDestination,
    });
    this.sorter = new ResultSorter(this.store, this.database, this.results, this.busy, {
      supersedeExport: () => this.exporter.supersede(),
    });
  }

  initialize(): Promise<void> {
    this.assertUsable();
    this.initialization ??= this.initializeOnce();
    return this.initialization;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.assertUsable();
    return this.store.subscribe(listener);
  }

  getState(): SessionState {
    return this.store.state;
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
      if (this.store.disposed) throw disposedError();
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
    if (this.store.state.phase !== 'ready' && this.store.state.phase !== 'querying') {
      return Promise.reject(new Error('A file must be ready before running a query.'));
    }
    const session = this.store.sessionGeneration;
    // Invalidated before the generation moves, so a sort in flight can never publish against the
    // query that replaces it.
    const sortCleanup = this.sorter.supersede();
    const query = this.results.nextQuery();
    const exportCleanup = this.exporter.supersede();
    this.store.dispatch({ type: 'queryStarted', sql });
    return this.results.execute(
      sql,
      session,
      query,
      sortCleanup.then(() => exportCleanup),
    );
  }

  loadMoreResults(): Promise<void> {
    this.assertUsable();
    return this.results.loadMore();
  }

  loadResultWindow(globalRow: number): Promise<void> {
    this.assertUsable();
    return this.results.loadWindow(globalRow);
  }

  retryResultPage(): Promise<void> {
    this.assertUsable();
    return this.results.retryPage();
  }

  /** What the UI needs to decide whether to offer sorting at all, before any result exists. */
  resultSortCapability(): ResultSortCapability {
    return this.database.resultSortCapability();
  }

  /**
   * Reorders every row of the CURRENT result by one column, or restores the original query order
   * when `sort` is null.
   *
   * The query is never re-run: the rows come from the pages the session already retains, so an
   * existing LIMIT still selects the same rows and a volatile value keeps whatever it evaluated to
   * the first time. An incomplete result is drained first, because sorting only part of a result
   * would misrepresent the whole.
   */
  async sortResults(sort: ResultSort | null): Promise<void> {
    this.assertUsable();
    return this.sorter.sort(sort);
  }

  /** Stops a sort in flight without destroying the result it was derived from. */
  async cancelResultSort(): Promise<void> {
    this.assertUsable();
    return this.sorter.cancel();
  }

  downloadResults(options: ExportOptions): Promise<void> {
    this.assertUsable();
    return this.exporter.download(options);
  }

  cancelResultsDownload(): Promise<void> {
    this.assertUsable();
    return this.exporter.cancel();
  }

  saveResultsDownload(): void {
    this.assertUsable();
    this.exporter.save();
  }

  dismissResultsDownload(): Promise<void> {
    this.assertUsable();
    return this.exporter.dismiss();
  }

  async cancel(): Promise<void> {
    this.assertUsable();
    const stoppedResult = this.store.state.result && !this.store.state.result.complete;
    const sortCleanup = this.sorter.supersede();
    this.store.nextSession();
    this.results.nextQuery();
    const exportCleanup = this.exporter.supersede().then(() => sortCleanup);
    this.intake.cancelParse();
    this.stopActiveViewer();
    const cancellation = exportCleanup.then(() => this.results.close({ cancel: true }));
    if (stoppedResult) {
      this.store.dispatch({
        type: 'queryPageFailed',
        message: 'Query result loading was cancelled. Run the query again to load more rows.',
        retryable: false,
      });
    }
    if (
      this.store.state.phase === 'opening' ||
      this.store.state.phase === 'normalizing' ||
      this.store.state.phase === 'parsing' ||
      this.store.state.phase === 'projecting' ||
      this.store.state.phase === 'querying'
    ) {
      this.store.dispatch({ type: 'cancelled' });
    }
    await cancellation;
  }

  selectResultRow(row: number | null): void {
    this.assertUsable();
    // A row index means a position in the committed display, which is exactly what a pending sort
    // is about to change.
    if (this.busy.sortPending()) return;
    this.store.dispatch({ type: 'rowSelected', row });
  }

  getSourceBlob(file: string): Blob | null {
    return this.intake.sourceBlob(file);
  }

  selectByteRange(range: { file: string; start: number; end: number } | null): void {
    this.assertUsable();
    if (this.busy.sortPending()) return;
    this.store.dispatch({ type: 'byteRangeSelected', range });
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.store.markDisposed();
    const sortCleanup = this.sorter.supersede();
    this.store.nextSession();
    this.results.nextQuery();
    const exportCleanup = this.exporter.supersede().then(() => sortCleanup);
    this.initializationAbort.abort();
    this.store.release();
    void this.initialization?.catch(() => undefined);
    this.sampleCache.clear();
    this.stopActiveViewer();
    this.intake.dispose();
    this.disposal = (async () => {
      await exportCleanup;
      await this.results.close({ cancel: true });
      await this.disposeCsvClient();
      await Promise.resolve()
        .then(() => this.database.dispose())
        .catch(() => undefined);
    })();
    return this.disposal;
  }

  private async initializeOnce(): Promise<void> {
    try {
      await Promise.all([
        this.database.initialize(),
        this.csvClient.initialize(),
        // Best-effort: reclaim OPFS scratch directories orphaned by a prior crashed session.
        // No generation is "kept" — a fresh controller never inherits an in-flight ingest or query.
        sweepSpillOrphans([]).catch(() => undefined),
        sweepQueryPageOrphans().catch(() => undefined),
      ]);
      if (this.store.disposed) throw disposedError();
    } catch (error) {
      await this.disposeCsvClient();
      throw error;
    }
  }

  private async openBatch(entries: readonly BatchEntry[]): Promise<void> {
    const sortCleanup = this.sorter.supersede();
    const generation = this.store.nextSession();
    this.results.nextQuery();
    const exportCleanup = this.exporter.supersede();
    this.intake.cancelParse();
    this.stopActiveViewer();
    const queryCancellation = exportCleanup
      .then(() => sortCleanup)
      .then(() => this.results.close({ cancel: true }));
    return this.intake.open(entries, generation, queryCancellation);
  }

  private disposeCsvClient(): Promise<void> {
    this.csvDisposal ??= this.csvClient.dispose().catch(() => undefined);
    return this.csvDisposal;
  }

  private stopActiveViewer(): void {
    try {
      this.stopViewer();
    } catch {
      // Viewer cleanup must not prevent parse, database, or worker cleanup.
    }
  }

  private assertUsable(): void {
    if (this.store.disposed) throw disposedError();
  }
}
