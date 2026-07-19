import { afterEach, describe, expect, it, vi } from 'vitest';

import { deleteSpillGeneration, isQuotaError, spillPath, sweepSpillOrphans } from './spill-files.js';

/** A minimal fake directory handle: records `removeEntry` calls and answers `entries()`. */
class FakeDirectoryHandle {
  readonly removeEntry = vi.fn<(name: string, options?: { recursive?: boolean }) => Promise<void>>(
    async () => undefined,
  );

  constructor(private readonly childNames: readonly string[] = []) {}

  async *entries(): AsyncIterableIterator<[string, FakeDirectoryHandle]> {
    for (const name of this.childNames) {
      yield [name, new FakeDirectoryHandle()];
    }
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
