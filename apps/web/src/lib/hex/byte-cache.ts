export const PAGE_BYTES = 64 * 1024;
export const CACHE_BUDGET_BYTES = 8 * 1024 * 1024;

/** Structural subset of Blob so unit tests can pass plain fakes. */
export interface BlobLike {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export class ByteCache {
  readonly pageBytes: number;
  readonly #blob: BlobLike;
  readonly #maxPages: number;
  /** Map iteration order doubles as LRU order: delete + re-set on touch. */
  readonly #pages = new Map<number, Uint8Array>();
  readonly #inflight = new Map<number, Promise<void>>();
  readonly #listeners = new Set<() => void>();
  #disposed = false;
  #fetchCount = 0;

  constructor(blob: BlobLike, options: { pageBytes?: number; budgetBytes?: number } = {}) {
    this.#blob = blob;
    this.pageBytes = options.pageBytes ?? PAGE_BYTES;
    this.#maxPages = Math.max(1, Math.floor((options.budgetBytes ?? CACHE_BUDGET_BYTES) / this.pageBytes));
  }

  get size(): number {
    return this.#blob.size;
  }

  get fetchCount(): number {
    return this.#fetchCount;
  }

  byteAt(offset: number): number | null {
    if (this.#disposed || offset < 0 || offset >= this.#blob.size) return null;
    const page = Math.floor(offset / this.pageBytes);
    const bytes = this.#touch(page);
    if (bytes) return bytes[offset - page * this.pageBytes] ?? null;
    void this.#fetch(page);
    return null;
  }

  ensureRange(start: number, end: number): Promise<void> {
    if (this.#disposed || this.#blob.size === 0) return Promise.resolve();
    const first = Math.max(0, Math.floor(start / this.pageBytes));
    const last = Math.min(Math.ceil(this.#blob.size / this.pageBytes) - 1, Math.floor((end - 1) / this.pageBytes));
    const fetches: Promise<void>[] = [];
    for (let page = first; page <= last; page += 1) {
      if (!this.#pages.has(page)) fetches.push(this.#fetch(page));
    }
    return Promise.all(fetches).then(() => undefined);
  }

  async copyRange(start: number, end: number): Promise<Uint8Array> {
    const from = Math.max(0, start);
    const to = Math.min(this.#blob.size, end);
    if (to <= from) return new Uint8Array(0);
    await this.ensureRange(from, to);
    const out = new Uint8Array(to - from);
    for (let offset = from; offset < to; offset += 1) {
      const page = this.#pages.get(Math.floor(offset / this.pageBytes));
      out[offset - from] = page?.[offset % this.pageBytes] ?? 0;
    }
    return out;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#disposed = true;
    this.#pages.clear();
    this.#inflight.clear();
    this.#listeners.clear();
  }

  #touch(page: number): Uint8Array | undefined {
    const bytes = this.#pages.get(page);
    if (bytes) {
      this.#pages.delete(page);
      this.#pages.set(page, bytes);
    }
    return bytes;
  }

  #fetch(page: number): Promise<void> {
    const existing = this.#inflight.get(page);
    if (existing) return existing;
    this.#fetchCount += 1;
    const start = page * this.pageBytes;
    const end = Math.min(this.#blob.size, start + this.pageBytes);
    const request = this.#blob
      .slice(start, end)
      .arrayBuffer()
      .then((buffer) => {
        if (this.#disposed) return;
        this.#store(page, new Uint8Array(buffer));
        for (const listener of this.#listeners) listener();
      })
      .finally(() => this.#inflight.delete(page));
    this.#inflight.set(page, request);
    return request;
  }

  #store(page: number, bytes: Uint8Array): void {
    while (this.#pages.size >= this.#maxPages) {
      const oldest = this.#pages.keys().next();
      if (oldest.done) break;
      this.#pages.delete(oldest.value);
    }
    this.#pages.set(page, bytes);
  }
}
