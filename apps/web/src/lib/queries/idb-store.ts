import { byNewestRun, bySavedOrder, type QueryStore, type StoreChange } from './store.js';
import { DEFAULT_SETTINGS, type HistoryEntry, type QuerySettings, type SavedQuery } from './types.js';

export const QUERY_DB_NAME = 'byteql-queries';
export const QUERY_CHANNEL_NAME = 'byteql-queries';
const DB_VERSION = 1;
const SETTINGS_KEY = 'settings';

type StoreName = 'saved' | 'history' | 'settings';

export interface IndexedDbStoreOptions {
  indexedDB?: IDBFactory;
  name?: string;
  channelName?: string;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException('The storage transaction was aborted.', 'AbortError'));
  });
}

const isStoreChange = (value: unknown): value is StoreChange =>
  value === 'saved' || value === 'history' || value === 'settings';

export async function openIndexedDbQueryStore(
  options: IndexedDbStoreOptions = {},
): Promise<IndexedDbQueryStore> {
  const factory = 'indexedDB' in options ? options.indexedDB : globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is unavailable.');
  const request = factory.open(options.name ?? QUERY_DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('saved', { keyPath: 'id' }).createIndex('format', 'format');
    db.createObjectStore('history', { keyPath: 'id' }).createIndex('ranAt', 'ranAt');
    db.createObjectStore('settings');
  };
  const db = await requestResult(request);
  return new IndexedDbQueryStore(db, options.channelName ?? QUERY_CHANNEL_NAME);
}

export class IndexedDbQueryStore implements QueryStore {
  readonly persistent = true;
  readonly #db: IDBDatabase;
  readonly #channel: BroadcastChannel | null;
  readonly #listeners = new Set<(change: StoreChange) => void>();

  constructor(db: IDBDatabase, channelName: string) {
    this.#db = db;
    this.#channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null;
    this.#channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
      const change = (event.data as { change?: unknown } | null)?.change;
      if (!isStoreChange(change)) return;
      for (const listener of this.#listeners) listener(change);
    });
  }

  async listSaved(): Promise<SavedQuery[]> {
    const all = await this.#read<SavedQuery[]>('saved', (store) => store.getAll());
    return all.sort(bySavedOrder);
  }

  putSaved(query: SavedQuery): Promise<void> {
    return this.#write('saved', (transaction) => {
      transaction.objectStore('saved').put({ ...query });
    });
  }

  deleteSaved(id: string): Promise<void> {
    return this.#write('saved', (transaction) => {
      transaction.objectStore('saved').delete(id);
    });
  }

  async listHistory(): Promise<HistoryEntry[]> {
    const all = await this.#read<HistoryEntry[]>('history', (store) => store.getAll());
    return all.sort(byNewestRun);
  }

  putHistory(entry: HistoryEntry, limit: number): Promise<void> {
    return this.#write('history', (transaction) => {
      const store = transaction.objectStore('history');
      store.put({ ...entry });
      // Queued after the put, so the cursor already sees the new entry.
      let kept = 0;
      const cursorRequest = store.index('ranAt').openCursor(null, 'prev');
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        kept += 1;
        if (kept > limit) cursor.delete();
        cursor.continue();
      };
    });
  }

  clearHistory(): Promise<void> {
    return this.#write('history', (transaction) => {
      transaction.objectStore('history').clear();
    });
  }

  async getSettings(): Promise<QuerySettings> {
    const stored = await this.#read<Partial<QuerySettings> | undefined>('settings', (store) =>
      store.get(SETTINGS_KEY),
    );
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  setSettings(settings: QuerySettings): Promise<void> {
    return this.#write('settings', (transaction) => {
      transaction.objectStore('settings').put({ ...settings }, SETTINGS_KEY);
    });
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#listeners.clear();
    this.#channel?.close();
    this.#db.close();
  }

  async #read<T>(name: StoreName, query: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const transaction = this.#db.transaction(name, 'readonly');
    return (await requestResult(query(transaction.objectStore(name)))) as T;
  }

  async #write(name: StoreName, body: (transaction: IDBTransaction) => void): Promise<void> {
    const transaction = this.#db.transaction(name, 'readwrite');
    const done = transactionDone(transaction);
    body(transaction);
    await done;
    // Only the kind of change crosses tabs — never a record, so no SQL leaves this store.
    this.#channel?.postMessage({ change: name });
  }
}
