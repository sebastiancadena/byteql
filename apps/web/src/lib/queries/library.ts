import { normalizeQueryName } from './display.js';
import { openIndexedDbQueryStore } from './idb-store.js';
import { normalizeSql, serializeQueryFile, type ParsedQueryFile } from './sql-file.js';
import { MemoryQueryStore, trimHistory, type QueryStore, type StoreChange } from './store.js';
import type { HistoryEntry, QuerySettings, SavedQuery } from './types.js';

export const STORAGE_ERROR_MESSAGE = "Couldn't save to browser storage.";

export type LibraryEvent = { type: 'changed' } | { type: 'storage-error'; message: string };

export interface ImportReport {
  imported: number;
  skipped: number;
  rejected: number;
}

export interface RunRecord {
  format: string;
  sql: string;
  status: 'ok' | 'error';
  rowCount: number | null;
}

interface LibraryDeps {
  now?: () => number;
  newId?: () => string;
}

const sortSaved = (queries: SavedQuery[]): SavedQuery[] =>
  queries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

/**
 * The query library's policy over a dumb `QueryStore`. Every mutation applies to memory first and
 * returns synchronously; persistence is queued in order behind it, so the UI never waits on
 * storage and a failed write never loses what the user sees.
 */
export class QueryLibrary {
  readonly persistent: boolean;
  readonly #store: QueryStore;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #listeners = new Set<(event: LibraryEvent) => void>();
  readonly #unsubscribe: () => void;
  #saved: SavedQuery[];
  #history: HistoryEntry[];
  #settings: QuerySettings;
  #queue: Promise<void> = Promise.resolve();

  private constructor(
    store: QueryStore,
    state: { saved: SavedQuery[]; history: HistoryEntry[]; settings: QuerySettings },
    deps: LibraryDeps,
  ) {
    this.#store = store;
    this.persistent = store.persistent;
    this.#now = deps.now ?? Date.now;
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
    this.#saved = state.saved;
    this.#history = state.history;
    this.#settings = state.settings;
    this.#unsubscribe = store.subscribe((change) => this.#reload(change));
  }

  static async open(store: QueryStore, deps: LibraryDeps = {}): Promise<QueryLibrary> {
    const [saved, settings] = await Promise.all([store.listSaved(), store.getSettings()]);
    const history = settings.persistHistory ? await store.listHistory() : [];
    return new QueryLibrary(store, { saved, history, settings }, deps);
  }

  get settings(): QuerySettings {
    return { ...this.#settings };
  }

  savedFor(format: string): readonly SavedQuery[] {
    return this.#saved.filter((query) => query.format === format);
  }

  historyFor(format: string): readonly HistoryEntry[] {
    return this.#history.filter((entry) => entry.format === format);
  }

  find(id: string): SavedQuery | null {
    return this.#saved.find((query) => query.id === id) ?? null;
  }

  subscribe(listener: (event: LibraryEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  save(input: { format: string; name: string; sql: string }): SavedQuery {
    const at = this.#now();
    const query: SavedQuery = {
      id: this.#newId(),
      format: input.format,
      name: normalizeQueryName(input.name),
      sql: input.sql,
      createdAt: at,
      updatedAt: at,
    };
    this.#saved = [...this.#saved, query];
    this.#persist(() => this.#store.putSaved(query));
    this.#changed();
    return query;
  }

  update(id: string, patch: { name?: string; sql?: string }): SavedQuery | null {
    const current = this.find(id);
    if (!current) return null;
    const next: SavedQuery = {
      ...current,
      ...(patch.name !== undefined ? { name: normalizeQueryName(patch.name) } : {}),
      ...(patch.sql !== undefined ? { sql: patch.sql } : {}),
      updatedAt: Math.max(this.#now(), current.updatedAt + 1),
    };
    this.#saved = this.#saved.map((query) => (query.id === id ? next : query));
    this.#persist(() => this.#store.putSaved(next));
    this.#changed();
    return next;
  }

  remove(id: string): SavedQuery | null {
    const current = this.find(id);
    if (!current) return null;
    this.#saved = this.#saved.filter((query) => query.id !== id);
    this.#persist(() => this.#store.deleteSaved(id));
    this.#changed();
    return current;
  }

  restore(query: SavedQuery): void {
    this.#saved = sortSaved([...this.#saved.filter((existing) => existing.id !== query.id), query]);
    this.#persist(() => this.#store.putSaved(query));
    this.#changed();
  }

  recordRun(run: RunRecord): void {
    if (run.sql.trim() === '') return;
    const newest = this.#history.find((entry) => entry.format === run.format);
    const ranAt = this.#now();
    const entry: HistoryEntry =
      newest && newest.sql === run.sql
        ? { ...newest, ranAt, status: run.status, rowCount: run.rowCount }
        : {
            id: this.#newId(),
            format: run.format,
            sql: run.sql,
            ranAt,
            status: run.status,
            rowCount: run.rowCount,
          };
    const limit = this.#settings.historyLimit;
    this.#history = trimHistory(
      [entry, ...this.#history.filter((existing) => existing.id !== entry.id)],
      limit,
    );
    if (this.#settings.persistHistory) this.#persist(() => this.#store.putHistory(entry, limit));
    this.#changed();
  }

  setPersistHistory(persist: boolean): void {
    if (this.#settings.persistHistory === persist) return;
    const settings = { ...this.#settings, persistHistory: persist };
    this.#settings = settings;
    if (persist) {
      const entries = [...this.#history].reverse();
      const limit = settings.historyLimit;
      this.#persist(async () => {
        await this.#store.setSettings(settings);
        for (const entry of entries) await this.#store.putHistory(entry, limit);
      });
    } else {
      // "Off" never means "hidden but still on disk".
      this.#persist(async () => {
        await this.#store.clearHistory();
        await this.#store.setSettings(settings);
      });
    }
    this.#changed();
  }

  clearHistory(): void {
    this.#history = [];
    this.#persist(() => this.#store.clearHistory());
    this.#changed();
  }

  importQueries(format: string, parsed: ParsedQueryFile): ImportReport {
    let imported = 0;
    let skipped = 0;
    for (const entry of parsed.queries) {
      const name = normalizeQueryName(entry.name);
      const sql = normalizeSql(entry.sql);
      const duplicate = this.savedFor(format).some(
        (query) => query.name === name && normalizeSql(query.sql) === sql,
      );
      if (duplicate) {
        skipped += 1;
      } else {
        this.save({ format, name, sql });
        imported += 1;
      }
    }
    return { imported, skipped, rejected: parsed.rejected.length };
  }

  exportFile(format: string): { filename: string; text: string } {
    const safe = format.replace(/[^A-Za-z0-9_-]/gu, '_');
    return {
      filename: `byteql-${safe}-queries.sql`,
      text: serializeQueryFile(format, this.savedFor(format)),
    };
  }

  flush(): Promise<void> {
    return this.#queue;
  }

  dispose(): void {
    this.#unsubscribe();
    this.#listeners.clear();
    this.#store.close();
  }

  #persist(write: () => Promise<void>): void {
    this.#queue = this.#queue.then(write).catch(() => {
      this.#emit({ type: 'storage-error', message: STORAGE_ERROR_MESSAGE });
    });
  }

  #reload(change: StoreChange): void {
    this.#queue = this.#queue
      .then(async () => {
        if (change === 'saved') {
          this.#saved = await this.#store.listSaved();
        } else if (change === 'settings') {
          this.#settings = await this.#store.getSettings();
        } else if (this.#settings.persistHistory) {
          this.#history = await this.#store.listHistory();
        } else {
          return;
        }
        this.#changed();
      })
      .catch(() => undefined);
  }

  #changed(): void {
    this.#emit({ type: 'changed' });
  }

  #emit(event: LibraryEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

/** IndexedDB when it opens; otherwise an in-memory library the UI marks as not persistent. */
export async function openQueryLibrary(): Promise<QueryLibrary> {
  try {
    const store = await openIndexedDbQueryStore();
    try {
      return await QueryLibrary.open(store);
    } catch (error) {
      store.close();
      throw error;
    }
  } catch {
    return QueryLibrary.open(new MemoryQueryStore());
  }
}
