import { afterEach, describe, expect, it, vi } from 'vitest';
import process from 'node:process';

import { prepareDestination } from './destination.js';

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

class FakeWritable {
  readonly writes: Array<Uint8Array<ArrayBuffer>> = [];
  readonly abortReasons: unknown[] = [];
  closeCalls = 0;
  failWriteAt = 0;
  abortError: unknown = null;
  writeGate: Promise<void> | null = null;
  closeGate: Promise<void> | null = null;

  constructor(private readonly file?: FakeFileHandle) {}

  async write(bytes: Uint8Array): Promise<void> {
    this.writes.push(Uint8Array.from(bytes));
    if (this.writes.length === this.failWriteAt) {
      throw new DOMException('write failed', 'QuotaExceededError');
    }
    if (this.writeGate) await this.writeGate;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeGate) await this.closeGate;
    if (this.file) this.file.file = new File(this.writes, 'result.csv', { type: 'text/csv' });
  }

  async abort(reason?: unknown): Promise<void> {
    this.abortReasons.push(reason);
    if (this.abortError) throw this.abortError;
  }
}

class FakeFileHandle {
  readonly kind = 'file' as const;
  readonly writable = new FakeWritable(this);
  file = new File([], 'result.csv', { type: 'text/csv' });

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

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException(`missing ${name}`, 'NotFoundError');
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
    this.removeCalls.push(
      options?.recursive === undefined ? { name } : { name, recursive: options.recursive },
    );
    if (this.files.delete(name)) return;
    const directory = this.directories.get(name);
    if (!directory) throw new DOMException(`missing ${name}`, 'NotFoundError');
    if (!options?.recursive && (directory.directories.size > 0 || directory.files.size > 0)) {
      throw new DOMException('not empty', 'InvalidModificationError');
    }
    this.directories.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    for (const entry of this.directories) yield entry;
    for (const entry of this.files) yield entry;
  }
}

const stubPicker = (writable: FakeWritable): ReturnType<typeof vi.fn> => {
  const picker = vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(writable) });
  vi.stubGlobal('showSaveFilePicker', picker);
  return picker;
};

const stubOpfs = (root: FakeDirectoryHandle): void => {
  vi.stubGlobal('navigator', {
    storage: { getDirectory: vi.fn().mockResolvedValue(root) },
  });
};

const withoutPicker = (): void => {
  Reflect.deleteProperty(globalThis, 'showSaveFilePicker');
};

const stubObjectUrls = (): { create: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> } => {
  const create = vi.fn().mockReturnValue('blob:byteql-export');
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  return { create, revoke };
};

const stubDownloadDocument = (): ReturnType<typeof vi.fn> => {
  const click = vi.fn();
  vi.stubGlobal('document', {
    createElement: vi.fn().mockReturnValue({ href: '', download: '', click }),
  });
  return click;
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const nextTask = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const captureUnhandled = (): { reasons: unknown[]; stop(): void } => {
  const reasons: unknown[] = [];
  const listener = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', listener);
  return { reasons, stop: () => process.off('unhandledRejection', listener) };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('prepareDestination', () => {
  it('invokes the picker synchronously and aborts without closing when the second write fails', async () => {
    const writable = new FakeWritable();
    writable.failWriteAt = 2;
    const picker = stubPicker(writable);
    stubOpfs(new FakeDirectoryHandle());

    const preparing = prepareDestination('capture.csv', 'csv');
    expect(picker).toHaveBeenCalledTimes(1);
    const destination = await preparing;
    await destination.write(new Uint8Array([1]));
    const failed = destination.write(new Uint8Array([2]));

    await expect(failed).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(writable.abortReasons).toHaveLength(1);
    expect(writable.closeCalls).toBe(0);
    await expect(destination.write(new Uint8Array([3]))).rejects.toThrow(/aborted/i);
    await expect(destination.commit()).rejects.toThrow(/aborted/i);
    await Promise.all([destination.dispose(), destination.dispose()]);
    expect(writable.abortReasons).toHaveLength(1);
  });

  it('returns picker dismissal and permission failures without falling back to OPFS', async () => {
    const getDirectory = vi.fn().mockResolvedValue(new FakeDirectoryHandle());
    vi.stubGlobal('navigator', { storage: { getDirectory } });
    const dismissed = new DOMException('dismissed', 'AbortError');
    const picker = vi.fn().mockRejectedValue(dismissed);
    vi.stubGlobal('showSaveFilePicker', picker);

    await expect(prepareDestination('capture.csv', 'csv')).rejects.toBe(dismissed);
    expect(getDirectory).not.toHaveBeenCalled();

    const denied = new DOMException('permission denied', 'NotAllowedError');
    picker.mockResolvedValueOnce({ createWritable: vi.fn().mockRejectedValue(denied) });
    await expect(prepareDestination('capture.csv', 'csv')).rejects.toBe(denied);
    expect(getDirectory).not.toHaveBeenCalled();
  });

  it('closes a direct picker file only on commit and treats save as a no-op', async () => {
    const writable = new FakeWritable();
    stubPicker(writable);
    stubOpfs(new FakeDirectoryHandle());
    const click = stubDownloadDocument();
    const destination = await prepareDestination('capture.csv', 'csv');

    await destination.write(new Uint8Array([1, 2, 3]));
    expect(writable.closeCalls).toBe(0);
    await expect(destination.commit()).resolves.toBe('saved');
    destination.save();

    expect(writable.closeCalls).toBe(1);
    expect(click).not.toHaveBeenCalled();
    await destination.dispose();
    expect(writable.abortReasons).toEqual([]);
  });

  it('rejects Parquet before opening an available picker when OPFS is unavailable', async () => {
    const picker = stubPicker(new FakeWritable());
    vi.stubGlobal('navigator', {});

    await expect(prepareDestination('capture.parquet', 'parquet')).rejects.toThrow(/opfs.*parquet/i);
    expect(picker).not.toHaveBeenCalled();
  });

  it('rejects Parquet after picker selection when the advertised OPFS method is unusable', async () => {
    const picker = stubPicker(new FakeWritable());
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockRejectedValue(new DOMException('not supported', 'NotSupportedError')),
      },
    });

    await expect(prepareDestination('capture.parquet', 'parquet')).rejects.toThrow(/opfs.*parquet/i);
    expect(picker).toHaveBeenCalledOnce();
  });

  it('handles an unexpected OPFS rejection immediately while the picker remains open', async () => {
    let select!: (handle: { createWritable(): Promise<FakeWritable> }) => void;
    const selection = new Promise<{ createWritable(): Promise<FakeWritable> }>((resolve) => {
      select = resolve;
    });
    vi.stubGlobal('showSaveFilePicker', vi.fn().mockReturnValue(selection));
    const probeFailure = new DOMException('OPFS denied', 'NotAllowedError');
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockRejectedValue(probeFailure) },
    });
    const unhandled = captureUnhandled();

    try {
      const preparing = prepareDestination('capture.parquet', 'parquet');
      await nextTask();
      select({ createWritable: async () => new FakeWritable() });

      await expect(preparing).rejects.toBe(probeFailure);
      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it('preserves picker rejection precedence while handling a concurrent OPFS rejection', async () => {
    const pickerFailure = new DOMException('dismissed', 'AbortError');
    vi.stubGlobal('showSaveFilePicker', vi.fn().mockRejectedValue(pickerFailure));
    const probeFailure = new DOMException('OPFS denied', 'NotAllowedError');
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockRejectedValue(probeFailure) },
    });
    const unhandled = captureUnhandled();

    try {
      await expect(prepareDestination('capture.parquet', 'parquet')).rejects.toBe(pickerFailure);
      await nextTask();
      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it('retains an OPFS file and object URL across saves until repeated disposal', async () => {
    withoutPicker();
    const root = new FakeDirectoryHandle();
    stubOpfs(root);
    const urls = stubObjectUrls();
    const click = stubDownloadDocument();

    const destination = await prepareDestination('capture.csv', 'csv');
    await destination.write(new Uint8Array([1, 2]));
    await destination.write(new Uint8Array([3]));

    await expect(destination.commit()).resolves.toBe('ready-to-save');
    destination.save();
    destination.save();

    expect(click).toHaveBeenCalledTimes(2);
    expect(urls.create).toHaveBeenCalledOnce();
    expect((urls.create.mock.calls[0]![0] as File).size).toBe(3);
    expect(urls.revoke).not.toHaveBeenCalled();
    expect(root.directories.get('byteql-exports')!.directories.size).toBe(1);

    await Promise.all([destination.dispose(), destination.dispose()]);
    expect(urls.revoke).toHaveBeenCalledOnce();
    expect(root.directories.get('byteql-exports')!.directories.size).toBe(1);
    expect([...root.directories.get('byteql-exports')!.directories.values()][0]!.directories.size).toBe(0);
  });

  it('allows exactly 64 MiB in the CSV Blob fallback using repeated bounded chunks', async () => {
    withoutPicker();
    vi.stubGlobal('navigator', {});
    const urls = stubObjectUrls();
    const destination = await prepareDestination('capture.csv', 'csv');
    const chunk = new Uint8Array(1024 * 1024);

    for (let index = 0; index < 64; index += 1) await destination.write(chunk);

    await expect(destination.commit()).resolves.toBe('ready-to-save');
    expect((urls.create.mock.calls[0]![0] as Blob).size).toBe(64 * 1024 * 1024);
    await destination.dispose();
  });

  it('aborts the CSV Blob fallback before retaining bytes beyond 64 MiB', async () => {
    withoutPicker();
    vi.stubGlobal('navigator', {});
    const urls = stubObjectUrls();
    const destination = await prepareDestination('capture.csv', 'csv');
    const chunk = new Uint8Array(1024 * 1024);

    for (let index = 0; index < 64; index += 1) await destination.write(chunk);
    await expect(destination.write(new Uint8Array([1]))).rejects.toThrow(/64 MiB.*smaller query/i);

    await expect(destination.commit()).rejects.toThrow(/aborted/i);
    expect(urls.create).not.toHaveBeenCalled();
    await destination.dispose();
  });

  it('aborts an OPFS quota failure and removes only its owned artifacts', async () => {
    withoutPicker();
    const root = new FakeDirectoryHandle();
    stubOpfs(root);
    stubObjectUrls();

    const destination = await prepareDestination('capture.csv', 'csv');
    const exportRoot = root.directories.get('byteql-exports')!;
    const tabRoot = [...exportRoot.directories.values()][0]!;
    const ownedRoot = [...tabRoot.directories.values()][0]!;
    ownedRoot.files.get('result.csv')!.writable.failWriteAt = 1;

    await expect(destination.write(new Uint8Array([1]))).rejects.toMatchObject({
      name: 'QuotaExceededError',
    });
    expect(ownedRoot.files.get('result.csv')!.writable.abortReasons).toHaveLength(1);
    await destination.dispose();
    expect(exportRoot.directories.get([...exportRoot.directories.keys()][0]!)!.directories.size).toBe(0);
  });

  it('does not report a save when abort begins during commit', async () => {
    const close = deferred();
    const writable = new FakeWritable();
    writable.closeGate = close.promise;
    stubPicker(writable);
    stubOpfs(new FakeDirectoryHandle());
    const destination = await prepareDestination('capture.csv', 'csv');
    await destination.write(new Uint8Array([1]));

    const committing = destination.commit();
    await flush();
    expect(writable.closeCalls).toBe(1);
    const aborting = destination.abort();
    close.resolve();

    await expect(committing).rejects.toMatchObject({ name: 'AbortError' });
    await aborting;
    expect(writable.abortReasons).toHaveLength(1);
    await destination.dispose();
  });

  it('waits for an in-flight write before removing OPFS artifacts during disposal', async () => {
    withoutPicker();
    const root = new FakeDirectoryHandle();
    stubOpfs(root);
    stubObjectUrls();
    const destination = await prepareDestination('capture.csv', 'csv');
    const exportRoot = root.directories.get('byteql-exports')!;
    const tabRoot = [...exportRoot.directories.values()][0]!;
    const ownedRoot = [...tabRoot.directories.values()][0]!;
    const writer = ownedRoot.files.get('result.csv')!.writable;
    const write = deferred();
    writer.writeGate = write.promise;

    const writing = destination.write(new Uint8Array([1]));
    const disposing = destination.dispose();
    await flush();

    expect(exportRoot.directories.size).toBe(1);
    write.resolve();
    await writing;
    await disposing;
    expect(exportRoot.directories.get([...exportRoot.directories.keys()][0]!)!.directories.size).toBe(0);
  });

  it('still removes owned OPFS artifacts when writable abort itself fails', async () => {
    withoutPicker();
    const root = new FakeDirectoryHandle();
    stubOpfs(root);
    stubObjectUrls();
    const destination = await prepareDestination('capture.csv', 'csv');
    const exportRoot = root.directories.get('byteql-exports')!;
    const tabRoot = [...exportRoot.directories.values()][0]!;
    const ownedRoot = [...tabRoot.directories.values()][0]!;
    const writer = ownedRoot.files.get('result.csv')!.writable;
    const abortFailure = new DOMException('abort denied', 'NotAllowedError');
    writer.abortError = abortFailure;

    await expect(destination.abort()).rejects.toBe(abortFailure);
    const first = destination.dispose();
    const second = destination.dispose();

    expect(second).toBe(first);
    await expect(first).rejects.toBe(abortFailure);
    expect(exportRoot.directories.get([...exportRoot.directories.keys()][0]!)!.directories.size).toBe(0);
  });
});
