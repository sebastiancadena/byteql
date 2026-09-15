import type { Schema, Table } from 'apache-arrow';

import { QUERY_RESULT_MEMORY_BYTES, type QueryPageStore } from './query-pages.js';
import type { QueryPage, QueryPageSummary, QueryResultView, QueryStatus } from './types.js';

/**
 * A complete, immutable result backed by its own page store.
 *
 * This is what a committed column sort publishes. It never owns a cursor, so there is nothing to
 * resume, cancel or drain: every row it will ever have is already stored when it is constructed.
 * Its timing and send count describe the ORIGINAL execution the rows came from — sorting does not
 * re-run the user's SQL, so it must not look as though it did.
 */
export class StoredResultView implements QueryResultView {
  private readonly summaries: readonly QueryPageSummary[];
  private readonly loadedRows: number;
  private disposePromise: Promise<void> | null = null;

  constructor(
    readonly schema: Schema,
    private readonly store: QueryPageStore,
    pages: readonly QueryPageSummary[],
    private readonly queryStatus: Pick<QueryStatus, 'elapsedMs' | 'sendCount'>,
    private readonly onDisposed: () => void,
  ) {
    let expectedStart = 0;
    for (const page of pages) {
      if (
        !Number.isSafeInteger(page.startRow) ||
        !Number.isSafeInteger(page.rowCount) ||
        page.rowCount < 0 ||
        page.startRow !== expectedStart
      ) {
        throw new RangeError('Stored result pages must be contiguous from row zero.');
      }
      expectedStart += page.rowCount;
    }
    this.summaries = pages.map((page) => ({ ...page }));
    this.loadedRows = expectedStart;
  }

  status(): QueryStatus {
    return {
      loadedRows: this.loadedRows,
      complete: true,
      elapsedMs: this.queryStatus.elapsedMs,
      storedBytes: this.disposed ? 0 : this.store.storedBytes,
      decodedBytes: this.disposed ? 0 : this.store.cachedDecodedBytes,
      sendCount: this.queryStatus.sendCount,
    };
  }

  pages(): readonly QueryPageSummary[] {
    return this.summaries.map((page) => ({ ...page }));
  }

  async readPage(index: number): Promise<QueryPage> {
    this.assertReadable();
    const summary = this.summaries.find((page) => page.index === index);
    if (!summary) {
      throw new RangeError(`Query result page ${String(index)} is not stored.`);
    }
    const stored = await this.store.get(index);
    return { index: stored.index, startRow: stored.startRow, rowCount: stored.rowCount, table: stored.table };
  }

  pinPages(indexes: readonly number[]): void {
    this.assertReadable();
    this.store.pin(indexes);
  }

  materialize(maxBytes = QUERY_RESULT_MEMORY_BYTES): Promise<Table | null> {
    this.assertReadable();
    return this.store.materialize(maxBytes);
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      try {
        // The store settles its own in-flight reads before releasing persistence, so a page read
        // issued just before disposal still resolves against live data.
        await this.store.dispose();
      } finally {
        this.onDisposed();
      }
    })();
    return this.disposePromise;
  }

  private get disposed(): boolean {
    return this.disposePromise !== null;
  }

  private assertReadable(): void {
    if (this.disposed) {
      throw new Error('Query result view is disposed.');
    }
  }
}
