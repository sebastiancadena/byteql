import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deleteSpillChunks,
  deleteSpillGeneration,
  isQuotaError,
  spillPath,
  sweepSpillOrphans,
} from './spill-files.js';

/** A minimal fake directory handle: records `removeEntry` calls and answers `entries()`. */
class FakeDirectoryHandle {
  readonly removeEntry = vi.fn<(name: string, options?: { recursive?: boolean }) => Promise<void>>(
    async (name: string) => {
      this.children.delete(name);
    },
  );

  private readonly children = new Map<string, FakeDirectoryHandle>();

  constructor(childNames: readonly string[] = []) {
    for (const name of childNames) {
      this.children.set(name, new FakeDirectoryHandle());
    }
  }

  async *entries(): AsyncIterableIterator<[string, FakeDirectoryHandle]> {
    for (const [name, handle] of this.children) {
      yield [name, handle];
    }
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing) {
      return existing;
    }
    if (!options?.create) {
      throw Object.assign(new Error(`not found: ${name}`), { name: 'NotFoundError' });
    }
    const created = new FakeDirectoryHandle();
    this.children.set(name, created);
    return created;
  }

  has(name: string): boolean {
    return this.children.has(name);
  }
}

describe('spillPath', () => {
  it('composes the documented layout', () => {
    expect(spillPath(3, 'packets', 0)).toBe('opfs://byteql-spill/3/packets/0.parquet');
  });
});

describe('deleteSpillGeneration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes the generation directory recursively', async () => {
    const spillRoot = new FakeDirectoryHandle();
    const getDirectoryHandle = vi.fn().mockResolvedValue(spillRoot);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue({ getDirectoryHandle }) },
    });

    await deleteSpillGeneration(9);

    expect(getDirectoryHandle).toHaveBeenCalledWith('byteql-spill', { create: false });
    expect(spillRoot.removeEntry).toHaveBeenCalledWith('9', { recursive: true });
  });

  it('tolerates an absent spill root directory', async () => {
    const getDirectoryHandle = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('nope'), { name: 'NotFoundError' }));
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue({ getDirectoryHandle }) },
    });

    await expect(deleteSpillGeneration(9)).resolves.toBeUndefined();
  });

  it('tolerates an absent generation directory inside an existing spill root', async () => {
    const spillRoot = new FakeDirectoryHandle();
    spillRoot.removeEntry.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'NotFoundError' }));
    const getDirectoryHandle = vi.fn().mockResolvedValue(spillRoot);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue({ getDirectoryHandle }) },
    });

    await expect(deleteSpillGeneration(9)).resolves.toBeUndefined();
  });

  it('treats a missing navigator.storage.getDirectory as OPFS-unavailable rather than throwing', async () => {
    vi.stubGlobal('navigator', {});

    await expect(deleteSpillGeneration(9)).resolves.toBeUndefined();
  });
});

describe('sweepSpillOrphans', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes every generation directory not in keep', async () => {
    const spillRoot = new FakeDirectoryHandle(['3', '7', '9']);
    const getDirectoryHandle = vi.fn().mockResolvedValue(spillRoot);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue({ getDirectoryHandle }) },
    });

    await sweepSpillOrphans([7]);

    expect(spillRoot.removeEntry).toHaveBeenCalledTimes(2);
    expect(spillRoot.removeEntry).toHaveBeenCalledWith('3', { recursive: true });
    expect(spillRoot.removeEntry).toHaveBeenCalledWith('9', { recursive: true });
    expect(spillRoot.removeEntry).not.toHaveBeenCalledWith('7', expect.anything());
  });

  it('removes nothing and tolerates an absent spill root when the keep list is empty', async () => {
    const getDirectoryHandle = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('nope'), { name: 'NotFoundError' }));
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue({ getDirectoryHandle }) },
    });

    await expect(sweepSpillOrphans([])).resolves.toBeUndefined();
  });
});

describe('deleteSpillChunks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes the named chunk files and tolerates absences', async () => {
    const spillRoot = new FakeDirectoryHandle();
    const generationDir = await spillRoot.getDirectoryHandle('7', { create: true });
    const tableDir = await generationDir.getDirectoryHandle('packets', { create: true });
    await tableDir.getDirectoryHandle('0.parquet', { create: true });
    await tableDir.getDirectoryHandle('1.parquet', { create: true });
    const getDirectoryHandle = vi.fn().mockResolvedValue(spillRoot);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue({ getDirectoryHandle }) },
    });

    await deleteSpillChunks([
      'opfs://byteql-spill/7/packets/0.parquet',
      'opfs://byteql-spill/7/packets/99.parquet', // absent — must not throw
    ]);

    expect(tableDir.has('0.parquet')).toBe(false);
    expect(tableDir.has('1.parquet')).toBe(true);
  });

  it('tolerates an absent generation directory, an absent table directory, and unparseable paths', async () => {
    const spillRoot = new FakeDirectoryHandle();
    const getDirectoryHandle = vi.fn().mockResolvedValue(spillRoot);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue({ getDirectoryHandle }) },
    });

    await expect(
      deleteSpillChunks([
        'opfs://byteql-spill/7/packets/0.parquet', // generation '7' does not exist
        'not-a-chunk-path',
      ]),
    ).resolves.toBeUndefined();
  });

  it('tolerates an absent spill root entirely', async () => {
    vi.stubGlobal('navigator', {});

    await expect(deleteSpillChunks(['opfs://byteql-spill/7/packets/0.parquet'])).resolves.toBeUndefined();
  });
});

describe('isQuotaError', () => {
  it('matches a DOMException named QuotaExceededError', () => {
    expect(isQuotaError(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))).toBe(true);
  });

  it('matches duckdb/OS quota-exhaustion message text', () => {
    expect(isQuotaError(new Error('IO Error: disk quota exceeded'))).toBe(true);
    expect(isQuotaError(new Error('write failed: No space left on device'))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isQuotaError(new Error('syntax error near SELECT'))).toBe(false);
    expect(isQuotaError('a plain string')).toBe(false);
  });
});
