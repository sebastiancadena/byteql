import { DEFAULT_SETTINGS, type HistoryEntry, type QuerySettings, type SavedQuery } from './types.js';

export type StoreChange = 'saved' | 'history' | 'settings';

/**
 * Durable storage for the query library. Deliberately dumb: policy (per-format views, dedup, the
 * persistence switch) belongs to `QueryLibrary`. Every read returns fresh copies.
 */
export interface QueryStore {
  /** Whether records survive the tab. False for the in-memory fallback. */
  readonly persistent: boolean;
  /** All saved queries, oldest first (`createdAt`, then `id`). */
  listSaved(): Promise<SavedQuery[]>;
  /** Inserts or replaces by `id`. */
  putSaved(query: SavedQuery): Promise<void>;
  deleteSaved(id: string): Promise<void>;
  /** All history entries, newest first (`ranAt`). */
  listHistory(): Promise<HistoryEntry[]>;
  /** Inserts or replaces by `id`, then removes the oldest entries beyond `limit`. */
  putHistory(entry: HistoryEntry, limit: number): Promise<void>;
  clearHistory(): Promise<void>;
  getSettings(): Promise<QuerySettings>;
  setSettings(settings: QuerySettings): Promise<void>;
  /** Notified when ANOTHER tab changed the store. Never for this store's own writes. */
  subscribe(listener: (change: StoreChange) => void): () => void;
  close(): void;
}

export const bySavedOrder = (a: SavedQuery, b: SavedQuery): number =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id);

export const byNewestRun = (a: HistoryEntry, b: HistoryEntry): number =>
  b.ranAt - a.ranAt || a.id.localeCompare(b.id);

export function trimHistory(entries: readonly HistoryEntry[], limit: number): HistoryEntry[] {
  return [...entries].sort(byNewestRun).slice(0, Math.max(0, limit));
}

/** Test double and runtime fallback when IndexedDB is unavailable (private windows, blocked data). */
export class MemoryQueryStore implements QueryStore {
  readonly persistent = false;
  readonly #saved = new Map<string, SavedQuery>();
  readonly #listeners = new Set<(change: StoreChange) => void>();
  #history: HistoryEntry[] = [];
  #settings: QuerySettings = { ...DEFAULT_SETTINGS };

  async listSaved(): Promise<SavedQuery[]> {
    return [...this.#saved.values()].sort(bySavedOrder).map((query) => ({ ...query }));
  }

  async putSaved(query: SavedQuery): Promise<void> {
    this.#saved.set(query.id, { ...query });
  }

  async deleteSaved(id: string): Promise<void> {
    this.#saved.delete(id);
  }

  async listHistory(): Promise<HistoryEntry[]> {
    return this.#history.map((entry) => ({ ...entry }));
  }

  async putHistory(entry: HistoryEntry, limit: number): Promise<void> {
    this.#history = trimHistory(
      [{ ...entry }, ...this.#history.filter((existing) => existing.id !== entry.id)],
      limit,
    );
  }

  async clearHistory(): Promise<void> {
    this.#history = [];
  }

  async getSettings(): Promise<QuerySettings> {
    return { ...this.#settings };
  }

  async setSettings(settings: QuerySettings): Promise<void> {
    this.#settings = { ...settings };
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    // Never fires: a single tab has nothing else to be notified by. Still tracked so
    // `unsubscribe` behaves like the real store instead of silently doing nothing.
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {}
}
