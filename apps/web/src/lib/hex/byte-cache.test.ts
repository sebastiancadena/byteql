import { describe, expect, it } from 'vitest';

import { ByteCache, type BlobLike } from './byte-cache.js';

interface Deferred {
  resolve: () => void;
}

/** Blob double that counts slice reads and can hold responses open. */
function fakeBlob(size: number, options: { manual?: boolean } = {}) {
  const reads: Array<{ start: number; end: number }> = [];
  const pending: Deferred[] = [];
  const blob: BlobLike = {
    size,
    slice(start, end) {
      reads.push({ start, end });
      return {
        arrayBuffer() {
          const buffer = new ArrayBuffer(end - start);
          new Uint8Array(buffer).fill(start % 251);
          if (!options.manual) return Promise.resolve(buffer);
          return new Promise((resolve) => {
            pending.push({ resolve: () => resolve(buffer) });
          });
        },
      };
    },
  };
  return { blob, reads, pending };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('ByteCache', () => {
  it('misses synchronously, fetches the page, then hits', async () => {
    const { blob, reads } = fakeBlob(1024);
    const cache = new ByteCache(blob, { pageBytes: 256 });
    expect(cache.byteAt(300)).toBeNull();
    await flush();
    expect(cache.byteAt(300)).toBe(256 % 251);
    expect(reads).toEqual([{ start: 256, end: 512 }]);
    expect(cache.byteAt(-1)).toBeNull();
    expect(cache.byteAt(1024)).toBeNull();
  });

  it('coalesces concurrent requests for the same page into one read', async () => {
    const { blob, reads, pending } = fakeBlob(1024, { manual: true });
    const cache = new ByteCache(blob, { pageBytes: 256 });
    cache.byteAt(10);
    cache.byteAt(20);
    void cache.ensureRange(0, 100);
    expect(reads).toHaveLength(1);
    pending[0]?.resolve();
    await flush();
    expect(cache.byteAt(10)).not.toBeNull();
    expect(cache.fetchCount).toBe(1);
  });

  it('evicts least-recently-used pages past the budget', async () => {
    const { blob, reads } = fakeBlob(4096);
    const cache = new ByteCache(blob, { pageBytes: 256, budgetBytes: 512 }); // 2 pages max
    await cache.ensureRange(0, 256); // page 0
    await cache.ensureRange(256, 512); // page 1
    expect(cache.byteAt(0)).not.toBeNull(); // touch page 0 → page 1 is now LRU
    await cache.ensureRange(512, 768); // page 2 evicts page 1
    expect(cache.byteAt(300)).toBeNull(); // page 1 gone → refetch scheduled
    await flush();
    expect(reads.filter((r) => r.start === 256)).toHaveLength(2);
  });

  it('notifies subscribers when a page lands and stops after dispose', async () => {
    const { blob, pending } = fakeBlob(1024, { manual: true });
    const cache = new ByteCache(blob, { pageBytes: 256 });
    let notified = 0;
    cache.subscribe(() => {
      notified += 1;
    });
    cache.byteAt(0);
    cache.byteAt(600);
    cache.dispose();
    pending.forEach((p) => p.resolve());
    await flush();
    expect(notified).toBe(0); // disposed → deliveries dropped, listeners never fire
  });

  it('copyRange assembles bytes across page boundaries', async () => {
    const { blob } = fakeBlob(1024);
    const cache = new ByteCache(blob, { pageBytes: 256 });
    const bytes = await cache.copyRange(250, 262);
    expect(bytes).toHaveLength(12);
    expect(bytes[0]).toBe(0 % 251); // from page 0 (fill = start % 251 = 0)
    expect(bytes[6]).toBe(256 % 251); // from page 1
  });

  it('byteAt swallows the fire-and-forget fetch rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    const existing = process.listeners('unhandledRejection');
    existing.forEach((listener) => process.off('unhandledRejection', listener));
    process.on('unhandledRejection', onRejection);
    try {
      const blob: BlobLike = {
        size: 1024,
        slice: () => ({ arrayBuffer: () => Promise.reject(new Error('read failed')) }),
      };
      const cache = new ByteCache(blob, { pageBytes: 256 });
      expect(cache.byteAt(300)).toBeNull(); // miss schedules a rejecting fetch
      await flush();
      await flush();
      expect(rejections).toEqual([]); // the miss path attaches .catch → nothing escapes
    } finally {
      process.off('unhandledRejection', onRejection);
      existing.forEach((listener) => process.on('unhandledRejection', listener as (reason: unknown) => void));
    }
  });

  it('refreshes LRU recency on ensureRange for cached pages', async () => {
    const { blob, reads } = fakeBlob(4096);
    const cache = new ByteCache(blob, { pageBytes: 256, budgetBytes: 512 }); // 2 pages max
    await cache.ensureRange(0, 256); // load page 0
    await cache.ensureRange(256, 512); // load page 1
    await cache.ensureRange(0, 256); // touch page 0 via ensureRange → page 1 becomes LRU
    await cache.ensureRange(512, 768); // load page 2 (evicts page 1, not page 0)
    expect(cache.byteAt(0)).not.toBeNull(); // page 0 should still be cached
    expect(reads.filter((r) => r.start === 0)).toHaveLength(1); // page 0 read exactly once
  });
});
