import type { AsyncDuckDB, AsyncDuckDBConnection, Logger } from '@duckdb/duckdb-wasm';
import { Schema as DuckdbSchema } from 'apache-arrow-duckdb';

import type { ByteqlDatabase, IngestOptions, IngestSession, QueryResultView, QuerySession } from './types.js';
import { createOpfsQueryPagePersistence, QueryPageStore } from './query-pages.js';
import { deleteSpillGeneration } from './spill-files.js';
import { defaultParquetWriterDependencies, writeParquet } from './export-parquet.js';
import type { ParquetArtifact, ParquetExportOptions } from './export-types.js';
import { ByteqlDbError } from './errors.js';
import {
  ResultSortError,
  resultSortRuntimeSupported,
  SORT_UNAVAILABLE_RUNTIME,
  SORT_UNAVAILABLE_STORAGE,
  type ResultSortCapability,
  type ResultSortOptions,
} from './result-sort.js';
import { createExportFiles } from './export-files.js';
import { writeSortedResult } from './sort-result.js';
import type { FileStatisticsAccess, FileStatisticsSummary } from './file-statistics.js';
import { Catalog } from './catalog.js';
import { IngestSessionImpl, ROTATION_THRESHOLD_BYTES } from './ingest-session.js';
import { QuerySessionImpl, type DuckdbQueryIterator } from './query-session.js';
import { createDuckdbRuntime, type DuckdbRuntime } from './runtime.js';

export interface BrowserDatabaseOptions {
  logger?: Logger;
  /** Whether the spill tier's OPFS-backed persistence is available. Defaults to feature-detection. */
  spillSupported?: boolean;
}

const defaultSpillSupported = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

interface PendingQueryToken {
  cancelRequested: boolean;
  sendStarted: boolean;
  sendCount: number;
  connection: AsyncDuckDBConnection | null;
  cancelSignalPromise: Promise<boolean> | null;
}

/** Holds the one running operation of a kind (a sort, an export) that may be aborted on its own. */
interface ExclusiveSlot<T> {
  active: { readonly controller: AbortController; readonly promise: Promise<T> } | null;
}

/**
 * Runs `operation` as the slot's active operation. The caller's `signal` is forwarded into a
 * private controller, so {@link abortExclusive} can also abort it without owning the caller's
 * signal; `isCurrent` reports whether this run still owns the slot. The slot clears itself, and
 * the forwarding listener is removed, once the operation settles.
 */
const runExclusive = <T>(
  slot: ExclusiveSlot<T>,
  signal: AbortSignal,
  operation: (signal: AbortSignal, isCurrent: () => boolean) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) forwardAbort();
  else signal.addEventListener('abort', forwardAbort, { once: true });

  let token: NonNullable<ExclusiveSlot<T>['active']> | null = null;
  const promise = operation(controller.signal, () => slot.active === token).finally(() => {
    signal.removeEventListener('abort', forwardAbort);
    if (slot.active === token) slot.active = null;
  });
  token = { controller, promise };
  slot.active = token;
  return promise;
};

/** Aborts the slot's active operation, if any, and joins its settlement whatever the outcome. */
const abortExclusive = async <T>(slot: ExclusiveSlot<T>, message: string): Promise<void> => {
  const token = slot.active;
  if (!token) return;
  if (!token.controller.signal.aborted) {
    token.controller.abort(new DOMException(message, 'AbortError'));
  }
  await token.promise.catch(() => undefined);
};

class BrowserDatabase implements ByteqlDatabase, FileStatisticsAccess {
  /** Committed finals with their catalog kinds, and the spill generation backing them. */
  private readonly catalog = new Catalog();
  private disposePromise: Promise<void> | null = null;
  private pendingQuery: PendingQueryToken | null = null;
  private activeQuery: QuerySessionImpl | null = null;
  private readonly exportSlot: ExclusiveSlot<ParquetArtifact> = { active: null };
  private readonly sortSlot: ExclusiveSlot<QueryResultView> = { active: null };
  /** Every live derived view, mapped to the base it was derived from. */
  private readonly derivedViews = new Map<QueryResultView, QuerySessionImpl>();
  /**
   * Releases that failed and must be retried before the database can honestly claim the resource
   * is gone. Retried when a result family is retired and again at teardown.
   */
  private readonly cleanupRetries = new Set<() => Promise<void>>();
  private queryGeneration = 0;
  private ingestStarting = false;
  private activeIngest: IngestSessionImpl | null = null;
  /**
   * The in-flight (not yet finalized or aborted) spill-tier ingest's generation, or `null` when
   * no spill-tier ingest is currently open. Cleared alongside `activeIngest` once that session
   * settles — a settled session's spill directory is already handled either by `finalize()`
   * (rolled into the catalog's spill generation) or by `abort()`'s own cleanup. Tracked separately so
   * `dispose()` can reclaim it immediately for a session that is neither (Trivia 3).
   */
  private activeIngestSpillGeneration: number | null = null;

  constructor(
    private readonly runtime: DuckdbRuntime,
    private readonly spillSupported: boolean,
  ) {}

  private get database(): AsyncDuckDB {
    return this.runtime.database;
  }

  initialize(): Promise<void> {
    return this.runtime.initialize();
  }

  async beginIngest(options: IngestOptions): Promise<IngestSession> {
    if (this.runtime.disposed) {
      throw new Error('ByteQL database has been disposed.');
    }
    if (options.tier === 'spill' && !this.spillSupported) {
      throw new ByteqlDbError(
        'SPILL_UNSUPPORTED',
        'SPILL_UNSUPPORTED: OPFS storage is not available in this environment.',
      );
    }
    if (!Number.isInteger(options.generation) || options.generation < 0) {
      throw new Error(
        `Ingest generation must be a non-negative integer: ${JSON.stringify(options.generation)}`,
      );
    }
    if (this.activeIngest || this.ingestStarting) {
      throw new Error('An ingest session is already open.');
    }

    this.ingestStarting = true;
    try {
      await this.abortActiveSort();
      await this.abortActiveExport();
      if (this.pendingQuery) {
        await this.cancelPendingQuery(this.pendingQuery);
      }
      await this.runtime.idle();
      if (this.runtime.disposed) {
        throw new Error('ByteQL database has been disposed.');
      }
      await this.closeActiveQuery();

      const session: IngestSessionImpl = new IngestSessionImpl({
        generation: options.generation,
        tier: options.tier,
        rotationBytes: options.rotationBytes ?? ROTATION_THRESHOLD_BYTES,
        opfs: this.database,
        enqueue: (operation) => this.runtime.enqueue(operation),
        catalog: this.catalog,
        onSettled: () => {
          if (this.activeIngest === session) {
            this.activeIngest = null;
            this.activeIngestSpillGeneration = null;
          }
        },
      });
      this.activeIngest = session;
      this.activeIngestSpillGeneration = options.tier === 'spill' ? options.generation : null;
      return session;
    } finally {
      this.ingestStarting = false;
    }
  }

  startQuery(sql: string): Promise<QuerySession> {
    if (this.runtime.disposed) {
      return Promise.reject(new Error('ByteQL database has been disposed.'));
    }
    if (this.pendingQuery) {
      void this.cancelPendingQuery(this.pendingQuery).catch(() => false);
    }
    // Aborted BEFORE enqueueing so this never waits behind an uninterruptible queue owner.
    const sortCleanup = this.abortActiveSort();
    const exportCleanup = this.abortActiveExport();
    const token: PendingQueryToken = {
      cancelRequested: false,
      sendStarted: false,
      sendCount: 0,
      connection: null,
      cancelSignalPromise: null,
    };
    this.pendingQuery = token;

    const result = this.runtime.enqueue(async (connection) => {
      await sortCleanup;
      await exportCleanup;
      if (token.cancelRequested) throw new Error('Query result session is closed.');
      if (this.activeIngest || this.ingestStarting) {
        throw new Error('An ingest session is already open.');
      }
      await this.closeActiveQuery();
      if (token.cancelRequested) throw new Error('Query result session is closed.');

      const startedAt = performance.now();
      let store: QueryPageStore | null = null;
      let cursorStarted = false;
      let iterator: DuckdbQueryIterator | null = null;
      let session: QuerySessionImpl | null = null;
      try {
        const persistence = await createOpfsQueryPagePersistence(this.queryGeneration++);
        if (this.runtime.disposed) {
          await persistence?.dispose().catch(() => undefined);
          throw new Error('ByteQL database has been disposed.');
        }
        store = new QueryPageStore({ persistence });
        if (token.cancelRequested) throw new Error('Query result session is closed.');
        token.connection = connection;
        token.sendStarted = true;
        token.sendCount += 1;
        const reader = await connection.send(sql);
        cursorStarted = true;
        iterator = reader[Symbol.asyncIterator]();
        if (token.cancelRequested) throw new Error('Query result session is closed.');
        // The pinned reader's schema is absent until its first pull, despite its declared type.
        // Supply a provisional shape while continuing to read the actual schema as it arrives.
        const provisionalSchema = new DuckdbSchema();
        session = await QuerySessionImpl.create(
          () => reader.schema ?? provisionalSchema,
          iterator,
          store,
          startedAt,
          () => this.cancelPendingQuery(token),
          () => {
            if (this.activeQuery === session) this.activeQuery = null;
          },
          () => token.sendCount,
        );
        if (token.cancelRequested) {
          await session.cancel();
          throw new Error('Query result session is closed.');
        }
        this.activeQuery = session;
        return session;
      } catch (error) {
        if (session) {
          await session.cancel().catch(() => false);
        } else {
          if (cursorStarted) await this.cancelPendingQuery(token).catch(() => false);
          await iterator?.return?.().catch(() => undefined);
          await store?.dispose().catch(() => undefined);
        }
        throw error;
      }
    });
    return result.finally(() => {
      if (this.pendingQuery === token) this.pendingQuery = null;
    });
  }

  async cancelQuery(): Promise<boolean> {
    if (this.runtime.disposed) {
      return false;
    }
    await this.abortActiveSort();
    await this.abortActiveExport();
    if (this.pendingQuery) {
      return this.cancelPendingQuery(this.pendingQuery);
    }
    if (this.activeQuery) {
      return this.activeQuery.cancel();
    }
    return false;
  }

  resultSortCapability(): ResultSortCapability {
    if (!resultSortRuntimeSupported(this.runtime.bundle.mainModule)) {
      return { supported: false, reason: SORT_UNAVAILABLE_RUNTIME };
    }
    // The same origin-private file system the spill tier needs also holds snapshot shards.
    if (!this.spillSupported) {
      return { supported: false, reason: SORT_UNAVAILABLE_STORAGE };
    }
    return { supported: true };
  }

  createSortedView(base: QuerySession, options: ResultSortOptions): Promise<QueryResultView> {
    if (this.runtime.disposed) {
      return Promise.reject(new Error('ByteQL database has been disposed.'));
    }
    if (!resultSortRuntimeSupported(this.runtime.bundle.mainModule)) {
      return Promise.reject(new ResultSortError('SORT_UNAVAILABLE', SORT_UNAVAILABLE_RUNTIME));
    }
    if (this.sortSlot.active) {
      return Promise.reject(new ResultSortError('SORT_FAILED', 'A result sort is already active.'));
    }
    try {
      this.assertSortableBase(base);
    } catch (error) {
      return Promise.reject(error);
    }

    return runExclusive(this.sortSlot, options.signal, (signal, isCurrent) =>
      this.runtime.enqueue(async () => {
        signal.throwIfAborted();
        // Checked again inside the queue: the base can be retired while this call waits its turn.
        this.assertSortableBase(base);
        const view = await writeSortedResult(
          {
            database: this.database,
            connect: () => this.database.connect(),
            createFiles: createExportFiles,
            // Built on demand, not in advance: allocating persistence eagerly creates its OPFS
            // directory, and the writer only disposes a store it actually pulled through here, so a
            // failure before that point would leave the directory behind with nothing owning it.
            createStore: () => this.createSortedPageStore(),
            onCleanupFailure: (retry) => this.cleanupRetries.add(retry),
          },
          base,
          { ...options, signal },
        );
        if (signal.aborted || this.runtime.disposed || !isCurrent() || this.activeQuery !== base) {
          // The family this view belongs to was replaced while the writer was finishing. Publishing
          // it now would show rows from a result the app has already moved on from. The abort is
          // rechecked here rather than trusted to the writer: this boundary must hold even for a
          // writer that ignores its signal.
          await view.dispose().catch(() => undefined);
          throw new DOMException('The result sort was replaced.', 'AbortError');
        }
        return this.registerDerivedView(view, base as QuerySessionImpl);
      }),
    );
  }

  exportParquet(result: QueryResultView, options: ParquetExportOptions): Promise<ParquetArtifact> {
    if (this.runtime.disposed) {
      return Promise.reject(new Error('ByteQL database has been disposed.'));
    }
    try {
      this.assertExportableResult(result);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.exportSlot.active) {
      return Promise.reject(new Error('A result export is already active.'));
    }

    return runExclusive(this.exportSlot, options.signal, (signal) =>
      this.runtime.enqueue(async () => {
        signal.throwIfAborted();
        this.assertExportableResult(result);
        return writeParquet(defaultParquetWriterDependencies(this.database), result, { ...options, signal });
      }),
    );
  }

  async listTables(): Promise<readonly string[]> {
    return this.catalog.names();
  }

  collectFileStatistics(path: string, enable: boolean): Promise<void> {
    if (this.pendingQuery || this.activeQuery) {
      return Promise.reject(new Error('A query result session owns the database connection.'));
    }
    return this.runtime.enqueue(() => {
      if (this.pendingQuery || this.activeQuery) {
        throw new Error('A query result session owns the database connection.');
      }
      return this.database.collectFileStatistics(path, enable);
    });
  }

  exportFileStatistics(path: string): Promise<FileStatisticsSummary> {
    if (this.pendingQuery || this.activeQuery) {
      return Promise.reject(new Error('A query result session owns the database connection.'));
    }
    return this.runtime.enqueue(async () => {
      if (this.pendingQuery || this.activeQuery) {
        throw new Error('A query result session owns the database connection.');
      }
      const stats = await this.database.exportFileStatistics(path);
      // Narrow to the plain-data subset ByteqlDatabase declares — drop the class's blockStats
      // buffer and getBlockStats() method (see the FileStatisticsSummary doc comment).
      return {
        totalFileReadsCold: stats.totalFileReadsCold,
        totalFileReadsAhead: stats.totalFileReadsAhead,
        totalFileReadsCached: stats.totalFileReadsCached,
        totalFileWrites: stats.totalFileWrites,
        totalPageAccesses: stats.totalPageAccesses,
        totalPageLoads: stats.totalPageLoads,
        blockSize: stats.blockSize,
      };
    });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.runtime.markDisposed();
    this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    const errors: unknown[] = [];

    try {
      await this.abortActiveSort();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.abortActiveExport();
    } catch (error) {
      errors.push(error);
    }
    errors.push(...(await this.retireDerivedViews(null)));

    if (this.pendingQuery) {
      try {
        await this.cancelPendingQuery(this.pendingQuery);
      } catch (error) {
        errors.push(error);
      }
    } else if (this.activeQuery) {
      try {
        await this.activeQuery.cancel();
      } catch (error) {
        errors.push(error);
      }
    }
    await this.runtime.idle();
    if (this.activeQuery) {
      try {
        await this.activeQuery.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    await this.runtime.settleInitialization();

    try {
      await this.runtime.closeConnection();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.runtime.terminate();
    } catch (error) {
      errors.push(error);
    }

    const spillGeneration = this.catalog.spillGeneration;
    if (spillGeneration !== null) {
      // Best-effort: reclaim the current generation's OPFS spill directory on teardown.
      await deleteSpillGeneration(spillGeneration).catch(() => undefined);
    }
    if (this.activeIngestSpillGeneration !== null) {
      // Trivia (3): a spill-tier ingest still open at dispose (neither finalized nor aborted)
      // has its own, separately-tracked generation — reclaim it immediately too, unconditionally
      // and best-effort, rather than leaving it for the next launch's orphan sweep.
      await deleteSpillGeneration(this.activeIngestSpillGeneration).catch(() => undefined);
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Failed to dispose the ByteQL database.');
    }
  }

  private async closeActiveQuery(): Promise<void> {
    await this.abortActiveExport();
    const session = this.activeQuery;
    // Derived views are retired first: they read pages this base owns, and a view left alive after
    // its family closes could still be handed to an export.
    await this.retireDerivedViews(session);
    if (!session) return;
    await session.cancel();
  }

  private cancelPendingQuery(token: PendingQueryToken): Promise<boolean> {
    token.cancelRequested = true;
    if (!token.sendStarted || !token.connection) return Promise.resolve(true);
    token.cancelSignalPromise ??= token.connection.cancelSent();
    return token.cancelSignalPromise;
  }

  private abortActiveExport(): Promise<void> {
    return abortExclusive(this.exportSlot, 'Result export was cancelled.');
  }

  /** The base a sort may derive from: the current, complete, unreplaced result and no other. */
  private assertSortableBase(base: QuerySession): void {
    if (this.activeQuery !== base || this.pendingQuery) {
      throw new ResultSortError(
        'SORT_FAILED',
        'Cannot sort a query result that is not current or has been superseded.',
      );
    }
    if (!base.status().complete) {
      throw new ResultSortError(
        'SORT_FAILED',
        'Sorting requires every row of the result to be loaded first.',
      );
    }
  }

  /**
   * Allocates a page store for a sorted view, from the same monotonically increasing allocator
   * `startQuery` uses, so a candidate's persistence can never collide with a query's.
   */
  private async createSortedPageStore(): Promise<QueryPageStore> {
    const persistence = await createOpfsQueryPagePersistence(this.queryGeneration++);
    if (!persistence) {
      throw new ResultSortError('SORT_UNAVAILABLE', SORT_UNAVAILABLE_STORAGE);
    }
    try {
      return new QueryPageStore({ persistence });
    } catch (error) {
      await persistence.dispose().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Wraps a committed view so disposing it also unregisters it, exactly once, and only after its
   * own cleanup has settled.
   */
  private registerDerivedView(view: QueryResultView, base: QuerySessionImpl): QueryResultView {
    let disposal: Promise<void> | null = null;
    const registered: QueryResultView = {
      get schema() {
        return view.schema;
      },
      status: () => view.status(),
      pages: () => view.pages(),
      readPage: (index) => view.readPage(index),
      pinPages: (indexes) => view.pinPages(indexes),
      materialize: (maxBytes) => view.materialize(maxBytes),
      dispose: () => {
        disposal ??= view.dispose().finally(() => {
          this.derivedViews.delete(registered);
        });
        return disposal;
      },
    };
    this.derivedViews.set(registered, base);
    return registered;
  }

  /** Aborts any pending sort and joins its settlement. Never enqueues behind the sort itself. */
  private abortActiveSort(): Promise<void> {
    return abortExclusive(this.sortSlot, 'The result sort was cancelled.');
  }

  /** Disposes every view derived from a base that is being retired, then retries queued releases. */
  private async retireDerivedViews(base: QuerySessionImpl | null): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const [view, owner] of [...this.derivedViews]) {
      if (base !== null && owner !== base) continue;
      this.derivedViews.delete(view);
      try {
        await view.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const retry of [...this.cleanupRetries]) {
      try {
        await retry();
        this.cleanupRetries.delete(retry);
      } catch (error) {
        // Kept for the next attempt: a resource is never silently declared released.
        errors.push(error);
      }
    }
    return errors;
  }

  private assertExportableResult(result: QueryResultView): void {
    if (this.pendingQuery || this.sortSlot.active) {
      throw new Error('Cannot export a query result that is not current or has been superseded.');
    }
    const derivedFrom = this.derivedViews.get(result);
    const current =
      result === this.activeQuery || (derivedFrom !== undefined && derivedFrom === this.activeQuery);
    if (!current) {
      throw new Error('Cannot export a query result that is not current or has been superseded.');
    }
    if (!result.status().complete) {
      throw new Error('Parquet export requires a complete query result session.');
    }
  }
}

export const createBrowserDatabase = async (
  options: BrowserDatabaseOptions = {},
): Promise<ByteqlDatabase> => {
  const runtime = await createDuckdbRuntime(options.logger);
  const spillSupported = options.spillSupported ?? defaultSpillSupported();
  return new BrowserDatabase(runtime, spillSupported);
};
