import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createOpfsQueryPagePersistence,
  QueryPageStore,
  type QueryPagePersistence,
  sweepQueryPageOrphans,
} from './query-pages.js';

class FakePersistence implements QueryPagePersistence {
  readonly files = new Map<number, Uint8Array>();
  readonly reads: number[] = [];
  readonly writes: Array<{ index: number; ipc: Uint8Array }> = [];
  failWriteOnce = false;
  disposeCalls = 0;
  disposeError: unknown = null;
  writeGate: Promise<void> | null = null;
  readGate: Promise<void> | null = null;
  readonly events: string[] = [];

  async write(index: number, ipc: Uint8Array): Promise<void> {
    this.events.push(`write:${index}:start`);
    this.writes.push({ index, ipc });
    if (this.failWriteOnce) {
      this.failWriteOnce = false;
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    }
    if (this.writeGate) await this.writeGate;
    this.files.set(index, ipc.slice());
    this.events.push(`write:${index}:end`);
  }

  async read(index: number): Promise<Uint8Array> {
    this.events.push(`read:${index}:start`);
    this.reads.push(index);
    const ipc = this.files.get(index);
    if (!ipc) throw new Error(`missing page ${index}`);
    if (this.readGate) await this.readGate;
    this.events.push(`read:${index}:end`);
    return ipc.slice();
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.events.push('dispose');
    if (this.disposeError) throw this.disposeError;
    this.files.clear();
  }
}

class FakeWritable {
  readonly writes: Uint8Array[] = [];
  readonly abortReasons: unknown[] = [];
  closeCalls = 0;
  private staged: Uint8Array | null = null;

  constructor(private readonly file: FakeFileHandle) {}

  async write(data: Uint8Array): Promise<void> {
    const owned = data.slice();
    this.writes.push(owned);
    if (this.file.writeErrorOnce) {
      const error = this.file.writeErrorOnce;
      this.file.writeErrorOnce = null;
      throw error;
    }
    this.staged = owned;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.staged) this.file.bytes = this.staged;
  }

  async abort(reason?: unknown): Promise<void> {
    this.abortReasons.push(reason);
    this.staged = null;
  }
}

class FakeFileHandle {
  readonly kind = 'file' as const;
  readonly writers: FakeWritable[] = [];
  bytes = new Uint8Array();
  writeErrorOnce: unknown = null;

  async createWritable(): Promise<FakeWritable> {
    const writer = new FakeWritable(this);
    this.writers.push(writer);
    return writer;
  }

  async getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    const bytes = this.bytes.slice();
    return {
      arrayBuffer: async () => bytes.buffer,
    };
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly directories = new Map<string, FakeDirectoryHandle>();
  readonly files = new Map<string, FakeFileHandle>();
  readonly removeCalls: Array<{ name: string; recursive?: boolean }> = [];
  removeError: unknown = null;

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw Object.assign(new Error(`not found: ${name}`), { name: 'NotFoundError' });
    const created = new FakeDirectoryHandle();
    this.directories.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw Object.assign(new Error(`not found: ${name}`), { name: 'NotFoundError' });
    const created = new FakeFileHandle();
    this.files.set(name, created);
    return created;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    this.removeCalls.push({ name, recursive: options?.recursive });
    if (this.removeError) throw this.removeError;
    if (this.files.delete(name)) return;
    const directory = this.directories.get(name);
    if (!directory) throw Object.assign(new Error(`not found: ${name}`), { name: 'NotFoundError' });
    if (!options?.recursive && (directory.directories.size > 0 || directory.files.size > 0)) {
      throw new DOMException('directory is not empty', 'InvalidModificationError');
    }
    this.directories.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    for (const entry of this.directories) yield entry;
    for (const entry of this.files) yield entry;
  }
}

const stubOpfs = (root: FakeDirectoryHandle): void => {
  vi.stubGlobal('navigator', {
    storage: { getDirectory: vi.fn().mockResolvedValue(root) },
  });
};

const deferred = (): { promise: Promise<void>; resolve(): void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('QueryPageStore', () => {
  it('evicts unpinned decoded pages and reloads exact Arrow values from persistence', async () => {
    const persistence = new FakePersistence();
    const store = new QueryPageStore({ persistence, memoryLimitBytes: 80 });
    await store.put(0, 0, tableFromArrays({ value: [10, 11] }));
    await store.put(1, 2, tableFromArrays({ value: [12, 13] }));
    store.pin([1]);

    const page = await store.get(0);

    expect(page.startRow).toBe(0);
    expect(Array.from(page.table.getChild('value')!.toArray())).toEqual([10, 11]);
    expect(persistence.reads).toContain(0);
  });

  it('keeps pinned decoded pages while evicting an unpinned page over the cache budget', async () => {
    const persistence = new FakePersistence();
    const first = tableFromArrays({ value: [20, 21] });
    const memoryLimitBytes = tableToIPC(first, 'stream').byteLength;
    const store = new QueryPageStore({ persistence, memoryLimitBytes });
    await store.put(0, 0, first);
    store.pin([0]);
    await store.put(1, 2, tableFromArrays({ value: [22, 23] }));

    expect(Array.from((await store.get(0)).table.getChild('value')!.toArray())).toEqual([20, 21]);
    expect(persistence.reads).toEqual([]);
    expect(Array.from((await store.get(1)).table.getChild('value')!.toArray())).toEqual([22, 23]);
    expect(persistence.reads).toEqual([1]);
  });

  it('retains a failed write as pending and retries the same bytes', async () => {
    const persistence = new FakePersistence();
    persistence.failWriteOnce = true;
    const store = new QueryPageStore({ persistence });
    const table = tableFromArrays({ value: [7] });

    await expect(store.put(0, 0, table)).rejects.toMatchObject({
      message: expect.stringContaining('RESULT_SPILL_QUOTA_EXCEEDED'),
    });
    expect(store.hasPendingRetry).toBe(true);
    await store.retryPending();

    expect(store.hasPendingRetry).toBe(false);
    expect((await store.get(0)).table.getChild('value')!.get(0)).toBe(7);
    expect(persistence.writes.map(({ index }) => index)).toEqual([0, 0]);
    expect(persistence.writes[1]!.ipc).toEqual(persistence.writes[0]!.ipc);
  });

  it('rejects an over-budget no-OPFS result without discarding prior pages', async () => {
    const first = tableFromArrays({ value: [1] });
    const firstBytes = tableToIPC(first, 'stream').byteLength;
    const store = new QueryPageStore({ persistence: null, memoryLimitBytes: firstBytes });
    await store.put(0, 0, first);

    await expect(store.put(1, 1, tableFromArrays({ value: [2] }))).rejects.toThrow(
      'RESULT_SPILL_UNSUPPORTED',
    );

    expect(store.hasPendingRetry).toBe(false);
    expect((await store.get(0)).table.getChild('value')!.get(0)).toBe(1);
    expect(store.storedBytes).toBe(firstBytes);
  });

  it('materializes only a complete result within the byte limit and disposes once', async () => {
    const persistence = new FakePersistence();
    const store = new QueryPageStore({ persistence });
    await store.put(0, 0, tableFromArrays({ value: [1, 2] }));
    await store.put(1, 2, tableFromArrays({ value: [3] }));

    expect(await store.materialize(64 * 1024 * 1024)).toBeNull();
    store.markComplete();
    expect(await store.materialize(store.storedBytes - 1)).toBeNull();
    const materialized = await store.materialize(64 * 1024 * 1024);
    expect(materialized!.numRows).toBe(3);
    expect(Array.from(materialized!.getChild('value')!.toArray())).toEqual([1, 2, 3]);

    await Promise.all([store.dispose(), store.dispose()]);
    expect(persistence.disposeCalls).toBe(1);
  });

  it('surfaces persistence cleanup failures through every concurrent dispose caller', async () => {
    const persistence = new FakePersistence();
    const cleanupError = new DOMException('cleanup denied', 'NotAllowedError');
    persistence.disposeError = cleanupError;
    const store = new QueryPageStore({ persistence });

    const firstDispose = store.dispose();
    const secondDispose = store.dispose();

    expect(secondDispose).toBe(firstDispose);
    await expect(firstDispose).rejects.toBe(cleanupError);
    expect(persistence.disposeCalls).toBe(1);
  });

  it('waits for an in-flight put before cleanup and prevents post-dispose publication', async () => {
    const persistence = new FakePersistence();
    const write = deferred();
    persistence.writeGate = write.promise;
    const store = new QueryPageStore({ persistence });

    const putting = store.put(0, 0, tableFromArrays({ value: [31] }));
    const disposing = store.dispose();
    expect(persistence.events).toEqual(['write:0:start']);

    write.resolve();

    await expect(putting).rejects.toThrow('Query page store is disposed.');
    await disposing;
    expect(persistence.events).toEqual(['write:0:start', 'write:0:end', 'dispose']);
    expect(store.storedBytes).toBe(0);
  });

  it('waits for an in-flight reload and does not return a page after disposal begins', async () => {
    const persistence = new FakePersistence();
    const store = new QueryPageStore({ persistence, memoryLimitBytes: 0 });
    await store.put(0, 0, tableFromArrays({ value: [41] }));
    const read = deferred();
    persistence.readGate = read.promise;

    const getting = store.get(0);
    const disposing = store.dispose();
    read.resolve();

    await expect(getting).rejects.toThrow('Query page store is disposed.');
    await disposing;
    expect(persistence.events.slice(-3)).toEqual(['read:0:start', 'read:0:end', 'dispose']);
    expect(store.storedBytes).toBe(0);
  });

  it('waits for an in-flight pending retry and prevents post-dispose publication', async () => {
    const persistence = new FakePersistence();
    persistence.failWriteOnce = true;
    const store = new QueryPageStore({ persistence });
    await expect(store.put(0, 0, tableFromArrays({ value: [51] }))).rejects.toThrow(
      'RESULT_SPILL_QUOTA_EXCEEDED',
    );
    const write = deferred();
    persistence.writeGate = write.promise;

    const retrying = store.retryPending();
    const disposing = store.dispose();
    write.resolve();

    await expect(retrying).rejects.toThrow('Query page store is disposed.');
    await disposing;
    expect(persistence.events.slice(-3)).toEqual(['write:0:start', 'write:0:end', 'dispose']);
    expect(store.storedBytes).toBe(0);
  });
});

describe('OPFS query page persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses only generated root, generation, and page path segments for Arrow bytes', async () => {
    const root = new FakeDirectoryHandle();
    stubOpfs(root);
    const persistence = await createOpfsQueryPagePersistence(7);
    const ipc = new Uint8Array([1, 3, 5, 7]);

    await persistence!.write(3, ipc);

    expect([...root.directories.keys()]).toEqual(['byteql-results']);
    const resultRoot = root.directories.get('byteql-results')!;
    expect([...resultRoot.directories.keys()]).toEqual(['7']);
    const generation = resultRoot.directories.get('7')!;
    expect([...generation.files.keys()]).toEqual(['3.arrow']);
    expect(await persistence!.read(3)).toEqual(ipc);
  });

  it('aborts a rejected writer, preserves its quota error, and retries the exact bytes', async () => {
    const root = new FakeDirectoryHandle();
    stubOpfs(root);
    const persistence = await createOpfsQueryPagePersistence(8);
    const generation = root.directories.get('byteql-results')!.directories.get('8')!;
    const file = await generation.getFileHandle('2.arrow', { create: true });
    const quotaError = new DOMException('quota exceeded', 'QuotaExceededError');
    file.writeErrorOnce = quotaError;
    const ipc = new Uint8Array([2, 4, 6, 8]);

    await expect(persistence!.write(2, ipc)).rejects.toBe(quotaError);

    expect(file.writers[0]!.writes).toEqual([ipc]);
    expect(file.writers[0]!.abortReasons).toEqual([quotaError]);
    expect(file.writers[0]!.closeCalls).toBe(0);

    await persistence!.write(2, ipc);

    expect(file.writers[1]!.writes).toEqual([ipc]);
    expect(file.writers[1]!.abortReasons).toEqual([]);
    expect(file.writers[1]!.closeCalls).toBe(1);
    expect(await persistence!.read(2)).toEqual(ipc);
  });

  it('deletes only its generated query generation recursively', async () => {
    const root = new FakeDirectoryHandle();
    stubOpfs(root);
    const persistence = await createOpfsQueryPagePersistence(11);
    await persistence!.write(0, new Uint8Array([9]));
    const resultRoot = root.directories.get('byteql-results')!;

    await persistence!.dispose();

    expect(resultRoot.removeCalls).toEqual([{ name: '11', recursive: true }]);
    expect(resultRoot.directories.has('11')).toBe(false);
  });

  it('surfaces generation cleanup failures but tolerates a concurrently absent generation', async () => {
    const root = new FakeDirectoryHandle();
    stubOpfs(root);
    const persistence = await createOpfsQueryPagePersistence(12);
    const resultRoot = root.directories.get('byteql-results')!;
    const cleanupError = new DOMException('cleanup denied', 'NotAllowedError');
    resultRoot.removeError = cleanupError;

    await expect(persistence!.dispose()).rejects.toBe(cleanupError);
    expect(resultRoot.directories.has('12')).toBe(true);

    resultRoot.removeError = new DOMException('already removed', 'NotFoundError');
    await expect(persistence!.dispose()).resolves.toBeUndefined();
  });

  it('sweeps query generations on reload without touching unrelated OPFS paths', async () => {
    const root = new FakeDirectoryHandle();
    await root.getDirectoryHandle('unrelated-app', { create: true });
    const resultRoot = await root.getDirectoryHandle('byteql-results', { create: true });
    await resultRoot.getDirectoryHandle('4', { create: true });
    await resultRoot.getDirectoryHandle('9', { create: true });
    await resultRoot.getDirectoryHandle('manual-notes', { create: true });
    await resultRoot.getFileHandle('README.txt', { create: true });
    stubOpfs(root);

    await sweepQueryPageOrphans();

    expect(resultRoot.removeCalls).toEqual([
      { name: '4', recursive: true },
      { name: '9', recursive: true },
    ]);
    expect([...resultRoot.directories.keys()]).toEqual(['manual-notes']);
    expect([...resultRoot.files.keys()]).toEqual(['README.txt']);
    expect(root.directories.has('unrelated-app')).toBe(true);
    expect(root.removeCalls).toEqual([]);
  });

  it('returns null when OPFS is unavailable and tolerates a missing result root during sweep', async () => {
    vi.stubGlobal('navigator', {});
    await expect(createOpfsQueryPagePersistence(1)).resolves.toBeNull();
    await expect(sweepQueryPageOrphans()).resolves.toBeUndefined();
  });
});
