import { type Table, tableFromIPC, tableToIPC } from 'apache-arrow';

import { isQuotaError } from './spill-files.js';

export const QUERY_RESULT_MEMORY_BYTES = 64 * 1024 * 1024;
const QUERY_RESULT_ROOT = 'byteql-results';
const GENERATED_SEGMENT_PATTERN = /^(?:0|[1-9]\d*)$/u;

export interface QueryPagePersistence {
  write(index: number, ipc: Uint8Array): Promise<void>;
  read(index: number): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

export interface StoredQueryPage {
  readonly index: number;
  readonly startRow: number;
  readonly rowCount: number;
  readonly ipcBytes: number;
  readonly table: Table;
}

export interface QueryPageStoreOptions {
  persistence: QueryPagePersistence | null;
  memoryLimitBytes?: number;
}

interface PageMetadata {
  readonly index: number;
  readonly startRow: number;
  readonly rowCount: number;
  readonly ipcBytes: number;
}

interface PendingPage {
  readonly metadata: PageMetadata;
  readonly ipc: Uint8Array;
  readonly table: Table;
}

interface CachedPage {
  readonly ipcBytes: number;
  readonly table: Table;
}

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

const opfsAvailable = (): boolean => typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

const isNotFoundError = (error: unknown): boolean =>
  (error instanceof Error ? error.name : (error as { name?: unknown } | null)?.name) === 'NotFoundError';

const assertGeneratedNumber = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
};

const quotaExceeded = (cause: unknown): Error =>
  new Error('RESULT_SPILL_QUOTA_EXCEEDED: failed to persist a query result page in OPFS.', {
    cause,
  });

const spillUnsupported = (): Error =>
  new Error('RESULT_SPILL_UNSUPPORTED: this browser cannot retain more query result pages locally.');

const toStoredPage = (metadata: PageMetadata, table: Table): StoredQueryPage => ({
  ...metadata,
  table,
});

export class QueryPageStore {
  private readonly persistence: QueryPagePersistence | null;
  private readonly memoryLimitBytes: number;
  private readonly pages = new Map<number, PageMetadata>();
  private readonly decoded = new Map<number, CachedPage>();
  private readonly pinned = new Set<number>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private decodedBytes = 0;
  private totalStoredBytes = 0;
  private pending: PendingPage | null = null;
  private complete = false;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: QueryPageStoreOptions) {
    if (!Number.isFinite(options.memoryLimitBytes ?? QUERY_RESULT_MEMORY_BYTES)) {
      throw new RangeError('memoryLimitBytes must be a finite non-negative number.');
    }
    this.persistence = options.persistence;
    this.memoryLimitBytes = options.memoryLimitBytes ?? QUERY_RESULT_MEMORY_BYTES;
    if (this.memoryLimitBytes < 0) {
      throw new RangeError('memoryLimitBytes must be a finite non-negative number.');
    }
  }

  get storedBytes(): number {
    return this.totalStoredBytes;
  }

  /** Whether the last failed put retained exact IPC bytes that retryPending can republish. */
  get hasPendingRetry(): boolean {
    return this.pending !== null;
  }

  put(index: number, startRow: number, table: Table): Promise<StoredQueryPage> {
    return this.runOperation(async () => {
      assertGeneratedNumber(index, 'Page index');
      assertGeneratedNumber(startRow, 'Page start row');
      if (this.pending) {
        throw new Error('A query result page write is pending retry.');
      }
      if (this.pages.has(index)) {
        throw new Error(`Query result page ${index} is already stored.`);
      }

      const ipc = tableToIPC(table, 'stream');
      const metadata: PageMetadata = {
        index,
        startRow,
        rowCount: table.numRows,
        ipcBytes: ipc.byteLength,
      };

      if (!this.persistence && this.totalStoredBytes + ipc.byteLength > this.memoryLimitBytes) {
        throw spillUnsupported();
      }

      if (this.persistence) {
        try {
          await this.persistence.write(index, ipc);
        } catch (error) {
          if (!isQuotaError(error)) throw error;
          if (!this.disposed) this.pending = { metadata, ipc, table };
          throw quotaExceeded(error);
        }
        this.assertOpen();
      }

      return this.accept(metadata, table);
    });
  }

  retryPending(): Promise<StoredQueryPage> {
    return this.runOperation(async () => {
      const pending = this.pending;
      if (!pending) {
        throw new Error('No query result page write is pending retry.');
      }
      if (!this.persistence) {
        throw spillUnsupported();
      }

      try {
        await this.persistence.write(pending.metadata.index, pending.ipc);
      } catch (error) {
        if (isQuotaError(error)) throw quotaExceeded(error);
        throw error;
      }
      this.assertOpen();

      this.pending = null;
      return this.accept(pending.metadata, pending.table);
    });
  }

  get(index: number): Promise<StoredQueryPage> {
    return this.runOperation(async () => {
      const metadata = this.pages.get(index);
      if (!metadata) {
        throw new Error(`Query result page ${index} is not stored.`);
      }

      const cached = this.decoded.get(index);
      if (cached) {
        this.decoded.delete(index);
        this.decoded.set(index, cached);
        return toStoredPage(metadata, cached.table);
      }

      if (!this.persistence) {
        throw new Error(`Query result page ${index} is not available in memory.`);
      }

      const table = tableFromIPC(await this.persistence.read(index));
      this.assertOpen();
      this.cache(metadata, table);
      return toStoredPage(metadata, table);
    });
  }

  pin(indexes: readonly number[]): void {
    this.assertOpen();
    this.pinned.clear();
    for (const index of indexes) {
      assertGeneratedNumber(index, 'Pinned page index');
      this.pinned.add(index);
    }
    this.evictDecodedPages();
  }

  markComplete(): void {
    this.assertOpen();
    if (this.pending) {
      throw new Error('Cannot complete a query result while a page write is pending retry.');
    }
    this.complete = true;
  }

  materialize(maxBytes: number): Promise<Table | null> {
    return this.runOperation(async () => {
      if (!this.complete || this.totalStoredBytes > maxBytes || this.pages.size === 0) {
        return null;
      }

      const metadata = [...this.pages.values()].sort((left, right) => left.index - right.index);
      const tables = await Promise.all(metadata.map(async ({ index }) => (await this.get(index)).table));
      this.assertOpen();
      const [first, ...rest] = tables;
      return first!.concat(...rest);
    });
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposed = true;
      const inFlight = [...this.inFlight];
      this.disposePromise = (async () => {
        await Promise.allSettled(inFlight);
        this.clearState();
        await this.persistence?.dispose();
      })();
    }
    return this.disposePromise;
  }

  private clearState(): void {
    this.pages.clear();
    this.decoded.clear();
    this.pinned.clear();
    this.pending = null;
    this.decodedBytes = 0;
    this.totalStoredBytes = 0;
  }

  private accept(metadata: PageMetadata, table: Table): StoredQueryPage {
    this.pages.set(metadata.index, metadata);
    this.totalStoredBytes += metadata.ipcBytes;
    this.cache(metadata, table);
    return toStoredPage(metadata, table);
  }

  private cache(metadata: PageMetadata, table: Table): void {
    const existing = this.decoded.get(metadata.index);
    if (existing) {
      this.decodedBytes -= existing.ipcBytes;
      this.decoded.delete(metadata.index);
    }
    this.decoded.set(metadata.index, { ipcBytes: metadata.ipcBytes, table });
    this.decodedBytes += metadata.ipcBytes;
    this.evictDecodedPages();
  }

  private evictDecodedPages(): void {
    while (this.decodedBytes > this.memoryLimitBytes) {
      const victim = [...this.decoded.entries()].find(([index]) => !this.pinned.has(index));
      if (!victim) return;
      const [index, cached] = victim;
      this.decoded.delete(index);
      this.decodedBytes -= cached.ipcBytes;
    }
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error('Query page store is disposed.');
    }
  }

  private runOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const promise = operation();
    this.inFlight.add(promise);
    void promise.then(
      () => this.inFlight.delete(promise),
      () => this.inFlight.delete(promise),
    );
    return promise;
  }
}

class OpfsQueryPagePersistence implements QueryPagePersistence {
  constructor(
    private readonly resultRoot: FileSystemDirectoryHandle,
    private readonly generation: string,
    private readonly generationRoot: FileSystemDirectoryHandle,
  ) {}

  async write(index: number, ipc: Uint8Array): Promise<void> {
    assertGeneratedNumber(index, 'Page index');
    const file = await this.generationRoot.getFileHandle(`${index}.arrow`, { create: true });
    const writable = await file.createWritable();
    try {
      await writable.write(new Uint8Array(ipc));
      await writable.close();
    } catch (error) {
      try {
        await writable.abort(error);
      } catch {
        // Preserve the primary write/close failure even if writer cleanup also fails.
      }
      throw error;
    }
  }

  async read(index: number): Promise<Uint8Array> {
    assertGeneratedNumber(index, 'Page index');
    const file = await this.generationRoot.getFileHandle(`${index}.arrow`, { create: false });
    return new Uint8Array(await (await file.getFile()).arrayBuffer());
  }

  async dispose(): Promise<void> {
    try {
      await this.resultRoot.removeEntry(this.generation, { recursive: true });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      // The generation was already removed concurrently.
    }
  }
}

export const createOpfsQueryPagePersistence = async (
  generation: number,
): Promise<QueryPagePersistence | null> => {
  assertGeneratedNumber(generation, 'Query generation');
  if (!opfsAvailable()) return null;

  try {
    const root = await navigator.storage.getDirectory();
    const resultRoot = await root.getDirectoryHandle(QUERY_RESULT_ROOT, { create: true });
    const generationName = String(generation);
    const generationRoot = await resultRoot.getDirectoryHandle(generationName, { create: true });
    return new OpfsQueryPagePersistence(resultRoot, generationName, generationRoot);
  } catch {
    return null;
  }
};

export const sweepQueryPageOrphans = async (): Promise<void> => {
  if (!opfsAvailable()) return;

  let resultRoot: FileSystemDirectoryHandle;
  try {
    const root = await navigator.storage.getDirectory();
    resultRoot = await root.getDirectoryHandle(QUERY_RESULT_ROOT, { create: false });
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  const generations: string[] = [];
  for await (const [name, handle] of (resultRoot as IterableDirectoryHandle).entries()) {
    if (handle.kind === 'directory' && GENERATED_SEGMENT_PATTERN.test(name)) {
      generations.push(name);
    }
  }

  await Promise.all(
    generations.map(async (generation) => {
      try {
        await resultRoot.removeEntry(generation, { recursive: true });
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        // The generation was removed concurrently.
      }
    }),
  );
};
