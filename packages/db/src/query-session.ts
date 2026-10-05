import type { Schema, Table } from 'apache-arrow';
import {
  util as duckdbUtil,
  type RecordBatch as DuckdbRecordBatch,
  type Schema as DuckdbSchema,
} from 'apache-arrow-duckdb';

import { convertDuckdbTable } from './arrow-bridge.js';
import { QUERY_RESULT_MEMORY_BYTES, type QueryPageStore, type StoredQueryPage } from './query-pages.js';
import {
  normalizeDuckdbResultBatch,
  normalizeDuckdbResultSchema,
  sameDuckdbResultType,
} from './result-arrow.js';
import { RESULT_LABEL_METADATA_KEY } from './result-columns.js';
import type { QueryPage, QueryPageSummary, QuerySession, QueryStatus } from './types.js';
import { QUERY_PAGE_ROWS } from './types.js';

export type DuckdbQueryIterator = AsyncIterator<DuckdbRecordBatch>;

const queryPage = (page: StoredQueryPage): QueryPage => ({
  index: page.index,
  startRow: page.startRow,
  rowCount: page.rowCount,
  table: page.table,
});

export class QuerySessionImpl implements QuerySession {
  private resultSchema: Schema;
  private readonly summaries: QueryPageSummary[] = [];
  private fetchTail: Promise<void> = Promise.resolve();
  private remainder: DuckdbRecordBatch | null = null;
  private loadedRows = 0;
  private complete = false;
  private elapsedMs = 0;
  private pendingEof = false;
  private demandState: 'open' | 'retry' | 'terminal' | 'closing' | 'closed' = 'open';
  private terminalCause: unknown = null;
  private cancelSignalPromise: Promise<boolean> | null = null;
  private readerReturnPromise: Promise<void> | null = null;
  private closePromise: Promise<boolean> | null = null;
  private disposePromise: Promise<void> | null = null;

  private constructor(
    private readonly readSchema: () => DuckdbSchema,
    private readonly iterator: DuckdbQueryIterator,
    private readonly store: QueryPageStore,
    private readonly startedAt: number,
    private readonly cancelCursor: () => Promise<boolean>,
    private readonly onDisposed: () => void,
    private readonly sendCount: () => number,
    schema: Schema,
    private normalizedSchema: DuckdbSchema,
  ) {
    this.resultSchema = schema;
    this.elapsedMs = performance.now() - startedAt;
  }

  get schema(): Schema {
    return this.resultSchema;
  }

  static async create(
    readSchema: () => DuckdbSchema,
    iterator: DuckdbQueryIterator,
    store: QueryPageStore,
    startedAt: number,
    cancelCursor: () => Promise<boolean>,
    onDisposed: () => void,
    sendCount: () => number,
  ): Promise<QuerySessionImpl> {
    const normalizedSchema = normalizeDuckdbResultSchema(readSchema());
    const schemaTable = await convertDuckdbTable(normalizedSchema, []);
    return new QuerySessionImpl(
      readSchema,
      iterator,
      store,
      startedAt,
      cancelCursor,
      onDisposed,
      sendCount,
      schemaTable.schema,
      normalizedSchema,
    );
  }

  status(): QueryStatus {
    this.assertReadable();
    return {
      loadedRows: this.loadedRows,
      complete: this.complete,
      elapsedMs: this.elapsedMs,
      storedBytes: this.store.storedBytes,
      decodedBytes: this.store.cachedDecodedBytes,
      sendCount: this.sendCount(),
    };
  }

  pages(): readonly QueryPageSummary[] {
    this.assertReadable();
    return this.summaries.map((page) => ({ ...page }));
  }

  fetchNext(targetRows = QUERY_PAGE_ROWS): Promise<QueryPage | null> {
    return this.serializeFetch(async () => {
      this.assertDemandOpen();
      if (!Number.isSafeInteger(targetRows) || targetRows <= 0) {
        throw new RangeError('Query page target must be a positive safe integer.');
      }
      if (this.complete) return null;

      const batches: DuckdbRecordBatch[] = [];
      let rowCount = 0;
      let eof = false;
      let failureNeedsCancellation = true;

      try {
        while (rowCount < targetRows) {
          let batch = this.remainder;
          this.remainder = null;
          if (!batch) {
            failureNeedsCancellation = false;
            const next = await this.iterator.next();
            failureNeedsCancellation = true;
            this.assertDemandOpen();
            if (next.done) {
              eof = true;
              break;
            }
            batch = this.normalizeBatch(next.value);
          }

          if (batch.numRows === 0) {
            // Arrow represents a schema-only stream with an internal zero-row placeholder
            // batch. Its schema is authoritative even when the reader's public schema remains
            // the empty pre-open value.
            this.resultSchema = (await convertDuckdbTable(batch.schema, [])).schema;
            continue;
          }
          const needed = targetRows - rowCount;
          if (batch.numRows > needed) {
            batches.push(batch.slice(0, needed));
            this.remainder = batch.slice(needed);
            rowCount += needed;
          } else {
            batches.push(batch);
            rowCount += batch.numRows;
          }
        }

        // A page that exactly fills its target has not necessarily reached EOF: the cursor only
        // tells us that when its next batch is requested. Probe once now so the UI can publish an
        // exact count immediately. Keep the first non-empty batch as the next-page remainder, so
        // this lookahead never consumes or duplicates a row. Empty batches are skipped just as
        // they are in the main accumulation loop.
        if (rowCount === targetRows && this.remainder === null && !eof) {
          while (true) {
            failureNeedsCancellation = false;
            const next = await this.iterator.next();
            failureNeedsCancellation = true;
            this.assertDemandOpen();
            if (next.done) {
              eof = true;
              break;
            }
            const batch = this.normalizeBatch(next.value);
            if (batch.numRows === 0) continue;
            this.remainder = batch;
            break;
          }
        }

        if (rowCount === 0) {
          if (eof) {
            if (this.normalizedSchema.fields.length === 0) {
              this.normalizedSchema = normalizeDuckdbResultSchema(this.readSchema());
            }
            this.resultSchema = (await convertDuckdbTable(this.normalizedSchema, [])).schema;
            this.finish();
          }
          return null;
        }

        const table = await convertDuckdbTable(this.normalizedSchema, batches);
        this.resultSchema = table.schema;
        this.assertDemandOpen();
        const stored = await this.store.put(this.summaries.length, this.loadedRows, table);
        this.assertDemandOpen();
        const page = this.publish(stored);
        if (eof) this.finish();
        return page;
      } catch (error) {
        if (this.isClosing()) throw error;
        if (this.store.hasPendingRetry) {
          this.demandState = 'retry';
          this.pendingEof = eof;
          throw error;
        }
        await this.terminalize(error, failureNeedsCancellation);
        throw error;
      }
    });
  }

  /** Normalize only newly received batches; stored remainders already have positional names. */
  private normalizeBatch(raw: DuckdbRecordBatch): DuckdbRecordBatch {
    const batch = normalizeDuckdbResultBatch(raw, this.readSchema());
    if (
      this.normalizedSchema.fields.length > 0 &&
      (!duckdbUtil.compareSchemas(this.normalizedSchema, batch.schema) ||
        this.normalizedSchema.fields.some(
          (field, index) =>
            !sameDuckdbResultType(field.type, batch.schema.fields[index]!.type) ||
            field.metadata.get(RESULT_LABEL_METADATA_KEY) !==
              batch.schema.fields[index]!.metadata.get(RESULT_LABEL_METADATA_KEY),
        ))
    ) {
      throw new Error('Result schema changed between cursor batches.');
    }
    this.normalizedSchema = batch.schema;
    return batch;
  }

  retryPending(): Promise<QueryPage> {
    return this.serializeFetch(async () => {
      this.assertReadable();
      if (this.demandState === 'terminal') throw this.terminalFailure();
      if (this.demandState !== 'retry') {
        throw new Error('No query result page write is pending retry.');
      }
      try {
        const stored = await this.store.retryPending();
        this.assertReadable();
        this.demandState = 'open';
        const page = this.publish(stored);
        if (this.pendingEof) this.finish();
        this.pendingEof = false;
        return page;
      } catch (error) {
        if (this.isClosing()) throw error;
        if (!this.store.hasPendingRetry) {
          await this.terminalize(error, true);
        }
        throw error;
      }
    });
  }

  async readPage(index: number): Promise<QueryPage> {
    this.assertReadable();
    return queryPage(await this.store.get(index));
  }

  pinPages(indexes: readonly number[]): void {
    this.assertReadable();
    this.store.pin(indexes);
  }

  async materialize(maxBytes = QUERY_RESULT_MEMORY_BYTES): Promise<Table | null> {
    this.assertReadable();
    return this.store.materialize(maxBytes);
  }

  cancel(): Promise<boolean> {
    return this.close();
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = this.close().then(() => undefined);
    }
    return this.disposePromise;
  }

  private close(): Promise<boolean> {
    if (this.closePromise) return this.closePromise;
    this.demandState = 'closing';
    this.closePromise = (async () => {
      const errors: unknown[] = [];
      let cancelled = false;
      try {
        cancelled = await this.signalCancellation();
      } catch (error) {
        errors.push(error);
      }
      await this.fetchTail;
      try {
        await this.returnReader();
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.store.dispose();
      } catch (error) {
        errors.push(error);
      } finally {
        this.demandState = 'closed';
        this.onDisposed();
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Failed to close the query result session.');
      }
      return cancelled;
    })();
    return this.closePromise;
  }

  private async terminalize(cause: unknown, cancel: boolean): Promise<void> {
    if (this.demandState === 'terminal') return;
    if (this.demandState === 'closing' || this.demandState === 'closed') return;
    this.demandState = 'terminal';
    this.terminalCause = cause;
    if (cancel) await this.signalCancellation().catch(() => false);
    await this.returnReader().catch(() => undefined);
  }

  private signalCancellation(): Promise<boolean> {
    this.cancelSignalPromise ??= Promise.resolve().then(() => this.cancelCursor());
    return this.cancelSignalPromise;
  }

  private returnReader(): Promise<void> {
    this.readerReturnPromise ??= Promise.resolve()
      .then(() => this.iterator.return?.())
      .then(() => undefined);
    return this.readerReturnPromise;
  }

  private serializeFetch<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.fetchTail.then(operation);
    this.fetchTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private publish(stored: StoredQueryPage): QueryPage {
    const page = queryPage(stored);
    this.summaries.push({ index: page.index, startRow: page.startRow, rowCount: page.rowCount });
    this.loadedRows += page.rowCount;
    this.elapsedMs = performance.now() - this.startedAt;
    return page;
  }

  private finish(): void {
    this.store.markComplete();
    this.complete = true;
    this.elapsedMs = performance.now() - this.startedAt;
  }

  private assertDemandOpen(): void {
    this.assertReadable();
    if (this.demandState === 'terminal') throw this.terminalFailure();
    if (this.demandState === 'retry') {
      throw new Error('A query result page write is pending retry.');
    }
  }

  private assertReadable(): void {
    if (this.demandState === 'closing' || this.demandState === 'closed') {
      throw new Error('Query result session is closed.');
    }
  }

  private terminalFailure(): Error {
    return new Error('Query result session cannot continue after a terminal failure.', {
      cause: this.terminalCause,
    });
  }

  private isClosing(): boolean {
    return this.demandState === 'closing' || this.demandState === 'closed';
  }
}
