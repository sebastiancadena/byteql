import type { ParseResult, TableTransfer } from '@byteql/core';
import type { ByteqlDatabase } from '@byteql/db';

import demoUrl from '../../assets/demo.mid?url';
import { ParseWorkerClient, type ParseClientPort, type ParseProgress } from '../parse-worker-client.js';
import { initialSessionState, reduceSession, type SessionEvent, type SessionState } from './state.js';

export interface SessionControllerOptions {
  database: ByteqlDatabase;
  parser?: ParseClientPort;
  fetch?: typeof fetch;
  demoUrl?: string;
  stopViewer?: () => void;
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

export class SessionController {
  private state: SessionState = initialSessionState;
  private readonly subscribers = new Set<(state: SessionState) => void>();
  private readonly database: ByteqlDatabase;
  private readonly parser: ParseClientPort;
  private readonly fetchSample: typeof fetch;
  private readonly demoUrl: string;
  private readonly stopViewer: () => void;
  private initialization: Promise<void> | null = null;
  private readonly initializationAbort = new AbortController();
  private sampleBytes: Uint8Array | null = null;
  private committedTables: readonly TableTransfer[] = [];
  private registrationGeneration: number | null = null;
  private sessionGeneration = 0;
  private queryGeneration = 0;
  private retainedFile: File | null = null;
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(options: SessionControllerOptions) {
    this.database = options.database;
    this.parser = options.parser ?? new ParseWorkerClient();
    this.fetchSample = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.demoUrl = options.demoUrl ?? demoUrl;
    this.stopViewer = options.stopViewer ?? (() => undefined);
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
    return this.open(
      { name: basename(file.name), size: file.size },
      async () => new Uint8Array(await file.arrayBuffer()),
    );
  }

  openSample(): Promise<void> {
    this.assertUsable();
    if (!this.sampleBytes) {
      return this.initialize().then(() => this.openSample());
    }
    this.retainedFile = null;
    const retained = this.sampleBytes;
    return this.open({ name: 'demo.mid', size: retained.byteLength }, () =>
      Promise.resolve(retained.slice()),
    );
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
      this.state.phase === 'registering' ||
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
    this.committedTables = [];
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
    ]);
    if (!response.ok) throw new Error('The bundled demo MIDI could not be loaded.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (this.disposed) throw disposedError();
    this.sampleBytes = bytes;
  }

  private open(source: { name: string; size: number }, readBytes: () => Promise<Uint8Array>): Promise<void> {
    const generation = ++this.sessionGeneration;
    ++this.queryGeneration;
    this.cancelParser();
    this.stopActiveViewer();
    const queryCancellation = this.cancelDatabaseQuery();
    this.dispatch({ type: 'opening', source });
    return this.completeOpen(generation, source.name, readBytes, queryCancellation);
  }

  private async completeOpen(
    generation: number,
    name: string,
    readBytes: () => Promise<Uint8Array>,
    queryCancellation: Promise<boolean>,
  ): Promise<void> {
    try {
      const [, bytes] = await Promise.all([queryCancellation, readBytes()]);
      if (!this.isCurrent(generation)) return;
      const result = await this.parser.parse({ name, bytes }, (progress) => {
        if (this.isCurrent(generation)) this.progress(progress);
      });
      if (!this.isCurrent(generation)) return;
      this.dispatch({ type: 'registering', format: result.format });
      if (!(await this.registerTables(generation, result.tables))) return;
      this.dispatchReady(result);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      if (isAbortError(error)) {
        this.dispatch({ type: 'cancelled' });
        return;
      }
      this.dispatch({
        type: 'failed',
        message: errorMessage(error, 'The local file could not be parsed.'),
      });
    }
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

  private progress(progress: ParseProgress): void {
    this.dispatch({ type: 'progress', ...progress });
  }

  private dispatchReady(result: ParseResult): void {
    this.dispatch({
      type: 'ready',
      tables: result.tables,
      issues: result.issues,
      queries: result.queries,
      capabilities: result.capabilities,
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

  private async registerTables(generation: number, tables: readonly TableTransfer[]): Promise<boolean> {
    this.registrationGeneration = generation;
    try {
      await this.database.replaceTables(tables);
    } catch (error) {
      if (this.registrationGeneration === generation) this.registrationGeneration = null;
      throw error;
    }

    if (!this.isCurrent(generation)) {
      if (!this.disposed && this.registrationGeneration === generation) {
        await this.database.replaceTables(this.committedTables);
        if (this.registrationGeneration === generation) this.registrationGeneration = null;
      }
      return false;
    }

    this.registrationGeneration = null;
    this.committedTables = tables;
    return true;
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
