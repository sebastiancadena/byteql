import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeWritable {
  readonly writes: Uint8Array[] = [];
  closeCalls = 0;
  abortCalls = 0;

  async write(bytes: Uint8Array): Promise<void> {
    this.writes.push(bytes.slice());
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }
}

class FakeFileHandle {
  readonly kind = 'file' as const;
  readonly writable = new FakeWritable();
  file = new File(['ready'], 'result.csv', { type: 'text/csv' });

  async createWritable(): Promise<FakeWritable> {
    return this.writable;
  }

  async getFile(): Promise<File> {
    return this.file;
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly directories = new Map<string, FakeDirectoryHandle>();
  readonly files = new Map<string, FakeFileHandle>();
  readonly removeCalls: Array<{ name: string; recursive?: boolean }> = [];
  removeError: unknown = null;
  directoryCreationGate: { name: string; entered(): void; wait: Promise<void> } | null = null;

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException(`missing ${name}`, 'NotFoundError');
    if (this.directoryCreationGate?.name === name) {
      this.directoryCreationGate.entered();
      await this.directoryCreationGate.wait;
    }
    const created = new FakeDirectoryHandle();
    this.directories.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException(`missing ${name}`, 'NotFoundError');
    const created = new FakeFileHandle();
    this.files.set(name, created);
    return created;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    this.removeCalls.push({ name, recursive: options?.recursive });
    if (this.removeError) throw this.removeError;
    if (this.files.delete(name)) return;
    const child = this.directories.get(name);
    if (!child) throw new DOMException(`missing ${name}`, 'NotFoundError');
    if (!options?.recursive && (child.directories.size > 0 || child.files.size > 0)) {
      throw new DOMException('not empty', 'InvalidModificationError');
    }
    this.directories.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    for (const entry of this.directories) yield entry;
    for (const entry of this.files) yield entry;
  }
}

class FakeLockManager {
  readonly held = new Set<string>();
  readonly requests: string[] = [];

  async request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: { name: string } | null) => Promise<T>,
  ): Promise<T> {
    this.requests.push(name);
    if (options.ifAvailable && this.held.has(name)) return callback(null);
    if (this.held.has(name)) throw new Error(`test attempted to wait for held lock ${name}`);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

const TAB = '11111111-1111-4111-8111-111111111111';
const EXPORT = '22222222-2222-4222-8222-222222222222';

const deferred = (): { promise: Promise<void>; resolve(): void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const stubEnvironment = (
  root: FakeDirectoryHandle,
  locks?: FakeLockManager,
  ids: readonly string[] = [TAB, EXPORT],
): void => {
  const randomUUID = vi.fn();
  for (const id of ids) randomUUID.mockReturnValueOnce(id);
  vi.stubGlobal('crypto', { randomUUID });
  vi.stubGlobal('navigator', {
    storage: { getDirectory: vi.fn().mockResolvedValue(root) },
    ...(locks ? { locks } : {}),
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('createExportFiles', () => {
  it('uses generated owner segments, accepts only basenames, and removes only its export once', async () => {
    const root = new FakeDirectoryHandle();
    const locks = new FakeLockManager();
    stubEnvironment(root, locks);

    const { createExportFiles } = await import('./export-files.js');
    const files = await createExportFiles();
    expect(files.path('result.parquet')).toBe(`opfs://byteql-exports/${TAB}/${EXPORT}/result.parquet`);
    expect(() => files.path('../result.parquet')).toThrow(/basename/i);
    expect(() => files.path('nested/result.parquet')).toThrow(/basename/i);
    await expect(files.file('../result.parquet')).rejects.toThrow(/basename/i);
    await expect(files.createWritable('nested/result.parquet')).rejects.toThrow(/basename/i);

    const writer = await files.createWritable('result.parquet');
    await writer.write(new Uint8Array([1, 2, 3]));
    const exportRoot = root.directories.get('byteql-exports')!;
    const tabRoot = exportRoot.directories.get(TAB)!;
    const ownedRoot = tabRoot.directories.get(EXPORT)!;
    ownedRoot.files.get('result.parquet')!.file = new File(['parquet'], 'result.parquet');
    expect((await files.file('result.parquet')).size).toBe(7);

    await Promise.all([files.dispose(), files.dispose()]);

    expect(tabRoot.removeCalls).toEqual([{ name: EXPORT, recursive: true }]);
    expect(exportRoot.directories.get(TAB)).toBe(tabRoot);
    expect(tabRoot.directories.size).toBe(0);
    expect(exportRoot.removeCalls).toEqual([]);
    expect(locks.held.size).toBe(0);
  });

  it('uses independent locks so a retained export does not block the next export in one tab', async () => {
    const root = new FakeDirectoryHandle();
    const locks = new FakeLockManager();
    const nextExport = '66666666-6666-4666-8666-666666666666';
    stubEnvironment(root, locks, [TAB, EXPORT, nextExport]);
    const { createExportFiles } = await import('./export-files.js');

    const retained = await createExportFiles();
    const next = await createExportFiles();

    expect(retained.path('result.csv')).toContain(`/${EXPORT}/`);
    expect(next.path('result.csv')).toContain(`/${nextExport}/`);
    expect(locks.held).toEqual(
      new Set([`byteql-exports:${TAB}:${EXPORT}`, `byteql-exports:${TAB}:${nextExport}`]),
    );
    await next.dispose();
    await retained.dispose();
    expect(locks.held.size).toBe(0);
  });

  it('keeps the tab owner attached while a concurrent export is creating its child', async () => {
    const root = new FakeDirectoryHandle();
    const locks = new FakeLockManager();
    const nextExport = '66666666-6666-4666-8666-666666666666';
    stubEnvironment(root, locks, [TAB, EXPORT, nextExport]);
    const { createExportFiles } = await import('./export-files.js');
    const retained = await createExportFiles();
    const exportRoot = root.directories.get('byteql-exports')!;
    const tabRoot = exportRoot.directories.get(TAB)!;
    const entered = deferred();
    const resume = deferred();
    tabRoot.directoryCreationGate = {
      name: nextExport,
      entered: entered.resolve,
      wait: resume.promise,
    };

    const creating = createExportFiles();
    await entered.promise;
    await retained.dispose();
    resume.resolve();
    const next = await creating;

    expect(exportRoot.directories.get(TAB)).toBe(tabRoot);
    expect(tabRoot.directories.has(nextExport)).toBe(true);
    await next.dispose();
  });

  it('sweeps only UUID-shaped exports whose exact owner locks are available', async () => {
    const root = new FakeDirectoryHandle();
    const exportRoot = await root.getDirectoryHandle('byteql-exports', { create: true });
    const otherTab = '33333333-3333-4333-8333-333333333333';
    const activeExport = '44444444-4444-4444-8444-444444444444';
    const orphanExport = '55555555-5555-4555-8555-555555555555';
    const otherRoot = await exportRoot.getDirectoryHandle(otherTab, { create: true });
    await otherRoot.getDirectoryHandle(activeExport, { create: true });
    await otherRoot.getDirectoryHandle(orphanExport, { create: true });
    await otherRoot.getDirectoryHandle('manual-notes', { create: true });
    const locks = new FakeLockManager();
    locks.held.add(`byteql-exports:${otherTab}:${activeExport}`);
    stubEnvironment(root, locks);

    const { createExportFiles } = await import('./export-files.js');
    const files = await createExportFiles();

    expect(otherRoot.directories.has(activeExport)).toBe(true);
    expect(otherRoot.directories.has(orphanExport)).toBe(false);
    expect(otherRoot.directories.has('manual-notes')).toBe(true);
    await files.dispose();
  });

  it('does not sweep any pre-existing owner when Web Locks are unavailable', async () => {
    const root = new FakeDirectoryHandle();
    const exportRoot = await root.getDirectoryHandle('byteql-exports', { create: true });
    const otherTab = '33333333-3333-4333-8333-333333333333';
    const orphanExport = '55555555-5555-4555-8555-555555555555';
    const otherRoot = await exportRoot.getDirectoryHandle(otherTab, { create: true });
    await otherRoot.getDirectoryHandle(orphanExport, { create: true });
    stubEnvironment(root);

    const { createExportFiles } = await import('./export-files.js');
    const files = await createExportFiles();
    await files.dispose();

    expect(otherRoot.directories.has(orphanExport)).toBe(true);
  });

  it('surfaces owned cleanup permission failures once and still releases its lock', async () => {
    const root = new FakeDirectoryHandle();
    const locks = new FakeLockManager();
    stubEnvironment(root, locks);
    const { createExportFiles } = await import('./export-files.js');
    const files = await createExportFiles();
    const ownedTab = root.directories.get('byteql-exports')!.directories.get(TAB)!;
    const denied = new DOMException('cleanup denied', 'NotAllowedError');
    ownedTab.removeError = denied;

    const first = files.dispose();
    const second = files.dispose();

    expect(second).toBe(first);
    await expect(first).rejects.toBe(denied);
    expect(ownedTab.removeCalls).toEqual([{ name: EXPORT, recursive: true }]);
    expect(locks.held.size).toBe(0);
  });
});
