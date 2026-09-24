# Saved Queries and Opt-in Local History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user save named SQL queries per format, recall recent executions (persisted only
on opt-in), and move a format's library in and out as one annotated `.sql` file, all without any
network request.

**Architecture:** A zero-Svelte module `apps/web/src/lib/queries/` holds the data model, a
`QueryStore` interface with an IndexedDB implementation and an in-memory fallback, the `.sql`
file codec, and a `QueryLibrary` that owns policy (per-format views, history dedup/trim, the
persistence switch, import dedup, ordered write-behind persistence, storage-error events). Two
Svelte components consume it: `SaveQueryPopover` in the editor toolbar and `QueryLibraryPanel`
(Saved + Recent) in the Explorer. `App.svelte` opens the library at startup and hands it to
`Workbench`; `packages/db` and the session controller do not change.

**Tech Stack:** Svelte 5 runes, TypeScript, IndexedDB, `BroadcastChannel`, vitest (+ jsdom,
Testing Library), `fake-indexeddb` (new dev dependency), Playwright (Chromium).

**Spec:** `docs/superpowers/specs/2026-09-24-saved-queries-design.md`

## Global Constraints

- Zero network requests after app readiness; no external URLs, CDNs, or runtime-loaded code
  (`check:bundle`, `apps/web/e2e/privacy.spec.ts` stay authoritative).
- IndexedDB database name `byteql-queries`, version 1, object stores `saved`, `history`,
  `settings`. `BroadcastChannel` name `byteql-queries`; messages carry `{ change }` only, never
  SQL.
- Settings defaults: `persistHistory: false`, `historyLimit: 100` (across all formats).
- History is written to IndexedDB **only while `persistHistory` is true**; turning it off clears
  the stored `history` store in the same operation.
- Import: file at most 1 MiB (`QUERY_FILE_MAX_BYTES = 1048576`), UTF-8 decoded with
  `fatal: true`; per-query SQL at most 64 KiB (`QUERY_SQL_MAX_BYTES = 65536`, UTF-8 bytes).
- File header line `-- byteql-queries v1`, then `-- format: <id>`, then `-- name: <name>` blocks.
  Export filename `byteql-<format>-queries.sql`. History is never exported.
- Default query name: first non-comment line of the SQL, whitespace-collapsed, truncated to 60
  characters (59 + `…`); fallback `Untitled query`.
- Only one new dependency: `fake-indexeddb` as a dev dependency of `@byteql/web`. No `fast-check`.
- Saving, loading, and importing never run a query.
- UI copy, verbatim: `Save query`, `Saved queries`, `Save a query to keep it for later visits.`,
  `Recent`, `Keep history after this tab closes`,
  `Stored only in this browser. SQL may contain sensitive values.`, `Clear history`,
  `This browser is blocking storage — queries last until the tab closes.`,
  `Couldn't save to browser storage.`, `Already saved`.
- Commits: conventional-commit messages, **no** `Co-Authored-By` or other trailers, and never
  any AI-tool branding or absolute local home-directory paths in committed files (the pre-commit hook enforces this).
- Gates per task: `pnpm --filter @byteql/web test -- --run`, `pnpm --filter @byteql/web check`,
  `pnpm lint`, and Prettier run from `apps/web` (`pnpm exec prettier --check <files>`). Keep test
  output pristine (no stray console output).
- Browser globals used in `.svelte` files are declared in the file's leading `/* global ... */`
  comment, as sibling components do.

## Review Focus

1. **A run that never settles or is superseded** (cancel, a rejected `runQuery`, or a second
   run) must not record the wrong SQL or outcome in Recent. Pinned in Task 6, Step 1
   ("records the run that settled, not a stale one").
2. **Changing format after loading a saved query** (open a ZIP after a pcap) must not offer
   `Update "<pcap query>"` in the new format. Pinned in Task 5, Step 1 ("forgets the loaded
   saved query when the format changes").
3. **A saved query deleted in another tab** while this tab has it loaded: Update must fall back
   to saving a new query rather than silently doing nothing. Pinned in Task 4, Step 1
   (`update` returns `null` for a missing id) and Task 5, Step 1 ("saves as new when the loaded
   query was deleted elsewhere").
4. **Import files written by other tools**: a UTF-8 BOM, CRLF line endings, and an exported
   empty library (header only) must import cleanly — no `\r` in names, no BOM in SQL, and zero
   queries (not one comment-only query) from an empty export. Pinned in Task 3, Step 1.
5. **Storage failing mid-session** (quota exceeded, aborted transaction): the in-memory library
   keeps the change and the user sees `Couldn't save to browser storage.` Pinned in Task 4,
   Step 1 ("keeps memory state and reports a storage error when a write fails").

---

## File structure

Create:

- `apps/web/src/lib/queries/types.ts` — `SavedQuery`, `HistoryEntry`, `QuerySettings`,
  `DEFAULT_SETTINGS`.
- `apps/web/src/lib/queries/store.ts` — `QueryStore` interface, `StoreChange`,
  `MemoryQueryStore`, `trimHistory`.
- `apps/web/src/lib/queries/idb-store.ts` — `openIndexedDbQueryStore`, `IndexedDbQueryStore`.
- `apps/web/src/lib/queries/sql-file.ts` — `.sql` codec: `serializeQueryFile`,
  `parseQueryFile`, `decodeQueryFile`, `QueryFileError`, size constants.
- `apps/web/src/lib/queries/display.ts` — `defaultQueryName`, `normalizeQueryName`,
  `sqlPreview`, `relativeTime`, `fileStem`.
- `apps/web/src/lib/queries/library.ts` — `QueryLibrary`, `LibraryEvent`, `ImportReport`,
  `STORAGE_ERROR_MESSAGE`, `openQueryLibrary`.
- `apps/web/src/lib/queries/download.ts` — `saveTextFile`.
- `apps/web/src/test-support/query-store-contract.ts` — shared `QueryStore` contract suite.
- `apps/web/src/components/SaveQueryPopover.svelte` — the Save/Update/Save-as-new popover.
- `apps/web/src/components/QueryLibraryPanel.svelte` — Saved + Recent Explorer sections,
  import/export.
- Tests: `store.test.ts`, `idb-store.test.ts`, `sql-file.test.ts`, `display.test.ts`,
  `library.test.ts` (all in `lib/queries/`), `SaveQueryPopover.test.ts`,
  `QueryLibraryPanel.test.ts` (in `components/`), `apps/web/e2e/saved-queries.spec.ts`.

Modify:

- `apps/web/package.json` — `fake-indexeddb` dev dependency.
- `apps/web/src/components/SqlEditor.svelte` — `onsave` prop, `Mod-s` keymap.
- `apps/web/src/components/ShortcutsOverlay.svelte` — `Save query` entry.
- `apps/web/src/components/Workbench.svelte` — `queryLibrary` prop, Save button + popover,
  loaded-saved tracking, library notices, history recording.
- `apps/web/src/components/Explorer.svelte` — renders `QueryLibraryPanel`.
- `apps/web/src/App.svelte` — opens the library at startup.
- `apps/web/e2e/privacy.spec.ts` — saved-query steps under the request listener.
- `docs/privacy.md`, `ROADMAP.md`, `AGENTS.md`, the spec's "Implementation notes".

There is no `CHANGELOG.md` in the repository, so none is updated.

---

### Task 1: Data model, in-memory store, and the store contract suite

**Files:**

- Modify: `apps/web/package.json` (dev dependency)
- Create: `apps/web/src/lib/queries/types.ts`
- Create: `apps/web/src/lib/queries/store.ts`
- Create: `apps/web/src/test-support/query-store-contract.ts`
- Test: `apps/web/src/lib/queries/store.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `interface SavedQuery { id: string; format: string; name: string; sql: string; createdAt: number; updatedAt: number }`
  - `interface HistoryEntry { id: string; format: string; sql: string; ranAt: number; status: 'ok' | 'error'; rowCount: number | null }`
  - `interface QuerySettings { persistHistory: boolean; historyLimit: number }`,
    `const DEFAULT_SETTINGS: QuerySettings`
  - `type StoreChange = 'saved' | 'history' | 'settings'`
  - `interface QueryStore` (below), `class MemoryQueryStore implements QueryStore`
  - `function trimHistory(entries: readonly HistoryEntry[], limit: number): HistoryEntry[]`
  - `function describeQueryStoreContract(label: string, create: () => Promise<QueryStore>): void`
- [ ] **Step 1: Add the dev dependency**

Run from the repo root: `pnpm --filter @byteql/web add -D fake-indexeddb`
Expected: `apps/web/package.json` lists `fake-indexeddb` under `devDependencies`; the lockfile
updates.

- [ ] **Step 2: Write the types**

`apps/web/src/lib/queries/types.ts`:

```ts
/** A named query the user deliberately saved, scoped to the format pack active at save time. */
export interface SavedQuery {
  id: string;
  /** `FormatPack` id, e.g. `pcap`. */
  format: string;
  /** Single line; not unique. */
  name: string;
  sql: string;
  createdAt: number;
  updatedAt: number;
}

/** One executed query. Kept in memory per tab; stored only while history persistence is on. */
export interface HistoryEntry {
  id: string;
  format: string;
  sql: string;
  ranAt: number;
  status: 'ok' | 'error';
  /** Null on error, or when the result was not fully loaded. */
  rowCount: number | null;
}

export interface QuerySettings {
  persistHistory: boolean;
  /** Maximum history entries across all formats. */
  historyLimit: number;
}

export const DEFAULT_SETTINGS: QuerySettings = Object.freeze({
  persistHistory: false,
  historyLimit: 100,
});
```

- [ ] **Step 3: Write the contract suite (the failing tests)**

`apps/web/src/test-support/query-store-contract.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QueryStore } from '../lib/queries/store.js';
import { DEFAULT_SETTINGS, type HistoryEntry, type SavedQuery } from '../lib/queries/types.js';

export const savedQuery = (overrides: Partial<SavedQuery> = {}): SavedQuery => ({
  id: 'q1',
  format: 'pcap',
  name: 'Top talkers',
  sql: 'select 1',
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
});

export const historyEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: 'h1',
  format: 'pcap',
  sql: 'select 1',
  ranAt: 1_000,
  status: 'ok',
  rowCount: 1,
  ...overrides,
});

/** Behaviour every `QueryStore` implementation must share. */
export function describeQueryStoreContract(label: string, create: () => Promise<QueryStore>): void {
  describe(`${label} QueryStore contract`, () => {
    let store: QueryStore;

    beforeEach(async () => {
      store = await create();
    });

    afterEach(() => {
      store.close();
    });

    it('starts empty with default settings', async () => {
      expect(await store.listSaved()).toEqual([]);
      expect(await store.listHistory()).toEqual([]);
      expect(await store.getSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it('inserts, replaces, and deletes saved queries, listed oldest first', async () => {
      await store.putSaved(savedQuery({ id: 'b', createdAt: 2_000 }));
      await store.putSaved(savedQuery({ id: 'a', createdAt: 1_000 }));
      await store.putSaved(savedQuery({ id: 'b', createdAt: 2_000, name: 'Renamed' }));
      expect((await store.listSaved()).map((query) => [query.id, query.name])).toEqual([
        ['a', 'Top talkers'],
        ['b', 'Renamed'],
      ]);
      await store.deleteSaved('a');
      expect((await store.listSaved()).map((query) => query.id)).toEqual(['b']);
    });

    it('returns copies, so callers cannot mutate stored records', async () => {
      await store.putSaved(savedQuery());
      const [first] = await store.listSaved();
      first!.name = 'mutated';
      expect((await store.listSaved())[0]!.name).toBe('Top talkers');
    });

    it('lists history newest first and trims the oldest beyond the limit', async () => {
      await store.putHistory(historyEntry({ id: 'h1', ranAt: 1 }), 2);
      await store.putHistory(historyEntry({ id: 'h2', ranAt: 2, format: 'midi' }), 2);
      await store.putHistory(historyEntry({ id: 'h3', ranAt: 3 }), 2);
      expect((await store.listHistory()).map((entry) => entry.id)).toEqual(['h3', 'h2']);
    });

    it('replaces a history entry with the same id instead of adding one', async () => {
      await store.putHistory(historyEntry({ id: 'h1', ranAt: 1 }), 10);
      await store.putHistory(historyEntry({ id: 'h1', ranAt: 5, status: 'error', rowCount: null }), 10);
      expect(await store.listHistory()).toEqual([
        historyEntry({ id: 'h1', ranAt: 5, status: 'error', rowCount: null }),
      ]);
    });

    it('clears history without touching saved queries', async () => {
      await store.putSaved(savedQuery());
      await store.putHistory(historyEntry(), 10);
      await store.clearHistory();
      expect(await store.listHistory()).toEqual([]);
      expect(await store.listSaved()).toHaveLength(1);
    });

    it('stores settings', async () => {
      await store.setSettings({ persistHistory: true, historyLimit: 5 });
      expect(await store.getSettings()).toEqual({ persistHistory: true, historyLimit: 5 });
    });
  });
}
```

`apps/web/src/lib/queries/store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { describeQueryStoreContract, historyEntry } from '../../test-support/query-store-contract.js';
import { MemoryQueryStore, trimHistory } from './store.js';

describeQueryStoreContract('MemoryQueryStore', async () => new MemoryQueryStore());

describe('MemoryQueryStore', () => {
  it('is not persistent', () => {
    expect(new MemoryQueryStore().persistent).toBe(false);
  });
});

describe('trimHistory', () => {
  it('keeps the newest entries up to the limit, newest first', () => {
    const entries = [1, 3, 2].map((ranAt) => historyEntry({ id: `h${ranAt}`, ranAt }));
    expect(trimHistory(entries, 2).map((entry) => entry.id)).toEqual(['h3', 'h2']);
  });

  it('keeps nothing for a zero limit', () => {
    expect(trimHistory([historyEntry()], 0)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/queries/store.test.ts`
Expected: FAIL — `Cannot find module './store.js'`.

- [ ] **Step 5: Implement the store interface and memory store**

`apps/web/src/lib/queries/store.ts`:

```ts
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

  subscribe(): () => void {
    return () => undefined;
  }

  close(): void {}
}
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/queries/store.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Gate and commit**

Run `pnpm --filter @byteql/web check` and `pnpm lint`; both clean.

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/lib/queries/types.ts \
  apps/web/src/lib/queries/store.ts apps/web/src/lib/queries/store.test.ts \
  apps/web/src/test-support/query-store-contract.ts
git commit -m "feat(web): add the query library data model and in-memory store"
```

---

### Task 2: IndexedDB store with cross-tab change notices

**Files:**

- Create: `apps/web/src/lib/queries/idb-store.ts`
- Test: `apps/web/src/lib/queries/idb-store.test.ts`

**Interfaces:**

- Consumes: `QueryStore`, `StoreChange`, `bySavedOrder`, `byNewestRun` from `store.ts`;
  `DEFAULT_SETTINGS` and record types from `types.ts`; `describeQueryStoreContract`.
- Produces:
  - `interface IndexedDbStoreOptions { indexedDB?: IDBFactory; name?: string; channelName?: string }`
  - `function openIndexedDbQueryStore(options?: IndexedDbStoreOptions): Promise<IndexedDbQueryStore>`
    — rejects when IndexedDB is missing or `open` fails.
  - `class IndexedDbQueryStore implements QueryStore` (`persistent === true`).
  - `const QUERY_DB_NAME = 'byteql-queries'`, `const QUERY_CHANNEL_NAME = 'byteql-queries'`.
- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/queries/idb-store.test.ts`:

```ts
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeQueryStoreContract, savedQuery } from '../../test-support/query-store-contract.js';
import { openIndexedDbQueryStore, type IndexedDbQueryStore } from './idb-store.js';

let channelCounter = 0;
const uniqueChannel = (): string => `byteql-queries-test-${++channelCounter}`;

describeQueryStoreContract('IndexedDbQueryStore', () =>
  openIndexedDbQueryStore({ indexedDB: new IDBFactory(), channelName: uniqueChannel() }),
);

describe('IndexedDbQueryStore', () => {
  const opened: IndexedDbQueryStore[] = [];
  afterEach(() => {
    for (const store of opened.splice(0)) store.close();
  });

  async function open(factory: IDBFactory, channelName: string): Promise<IndexedDbQueryStore> {
    const store = await openIndexedDbQueryStore({ indexedDB: factory, channelName });
    opened.push(store);
    return store;
  }

  it('is persistent and survives reopening the same database', async () => {
    const factory = new IDBFactory();
    const channel = uniqueChannel();
    const first = await open(factory, channel);
    expect(first.persistent).toBe(true);
    await first.putSaved(savedQuery());
    first.close();
    const second = await open(factory, channel);
    expect(await second.listSaved()).toEqual([savedQuery()]);
  });

  it('tells other stores on the same channel what changed, without the record', async () => {
    const factory = new IDBFactory();
    const channel = uniqueChannel();
    const writer = await open(factory, channel);
    const reader = await open(factory, channel);
    const own = vi.fn();
    const remote = vi.fn();
    writer.subscribe(own);
    reader.subscribe(remote);

    await writer.putSaved(savedQuery());

    await vi.waitFor(() => expect(remote).toHaveBeenCalledWith('saved'));
    expect(own).not.toHaveBeenCalled();
  });

  it('rejects when IndexedDB is unavailable', async () => {
    await expect(
      openIndexedDbQueryStore({ indexedDB: undefined as unknown as IDBFactory, channelName: uniqueChannel() }),
    ).rejects.toThrow(/IndexedDB is unavailable/u);
  });
});
```

Note: the third test passes `undefined` explicitly; the implementation must treat an explicitly
provided `undefined` the same as a missing global (use `'indexedDB' in options` to decide whether
to fall back to `globalThis.indexedDB`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/queries/idb-store.test.ts`
Expected: FAIL — `Cannot find module './idb-store.js'`.

- [ ] **Step 3: Implement**

`apps/web/src/lib/queries/idb-store.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/queries/idb-store.test.ts`
Expected: PASS (7 contract tests + 3). The run must exit without hanging (every store is closed in
`afterEach`, which closes its `BroadcastChannel`).

- [ ] **Step 5: Gate and commit**

Run `pnpm --filter @byteql/web check` and `pnpm lint`.

```bash
git add apps/web/src/lib/queries/idb-store.ts apps/web/src/lib/queries/idb-store.test.ts
git commit -m "feat(web): persist the query library in IndexedDB"
```

---

### Task 3: The annotated `.sql` file codec

**Files:**

- Create: `apps/web/src/lib/queries/sql-file.ts`
- Test: `apps/web/src/lib/queries/sql-file.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `const QUERY_FILE_MAX_BYTES = 1048576`, `const QUERY_SQL_MAX_BYTES = 65536`
  - `class QueryFileError extends Error`
  - `interface QueryFileEntry { name: string; sql: string }`
  - `interface RejectedBlock { name: string; reason: 'empty' | 'too-large' }`
  - `interface ParsedQueryFile { format: string | null; queries: QueryFileEntry[]; rejected: RejectedBlock[] }`
  - `function decodeQueryFile(bytes: Uint8Array): string` — throws `QueryFileError`
  - `function parseQueryFile(text: string, fallbackName: string): ParsedQueryFile`
  - `function serializeQueryFile(format: string, queries: readonly QueryFileEntry[]): string`
  - `function normalizeSql(sql: string): string` — CRLF→LF, leading blank lines and trailing
    whitespace removed. Import dedup and round-trip equality use this form.
- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/queries/sql-file.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  decodeQueryFile,
  normalizeSql,
  parseQueryFile,
  QUERY_FILE_MAX_BYTES,
  QUERY_SQL_MAX_BYTES,
  QueryFileError,
  serializeQueryFile,
} from './sql-file.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('serializeQueryFile', () => {
  it('writes the header, the format, and one block per query', () => {
    expect(
      serializeQueryFile('pcap', [
        { name: 'Top talkers', sql: 'select src, count(*) from ip\ngroup by 1 order by 2 desc;\n' },
        { name: 'TLS SNI list', sql: 'select distinct sni from tls;' },
      ]),
    ).toBe(
      [
        '-- byteql-queries v1',
        '-- format: pcap',
        '',
        '-- name: Top talkers',
        'select src, count(*) from ip',
        'group by 1 order by 2 desc;',
        '',
        '-- name: TLS SNI list',
        'select distinct sni from tls;',
        '',
      ].join('\n'),
    );
  });

  it('keeps names on one line', () => {
    expect(serializeQueryFile('pcap', [{ name: 'two\nlines\r\n', sql: 'select 1' }])).toContain(
      '-- name: two lines\n',
    );
  });

  it('escapes marker-like lines inside SQL so they survive a round trip', () => {
    const sql = 'select 1\n-- name: not a marker\n  --\\ format: already escaped';
    const text = serializeQueryFile('pcap', [{ name: 'q', sql }]);
    expect(text).toContain('\n--\\ name: not a marker\n');
    expect(text).toContain('\n  --\\\\ format: already escaped\n');
    expect(parseQueryFile(text, 'x').queries).toEqual([{ name: 'q', sql }]);
  });
});

describe('parseQueryFile', () => {
  it('reads the format and every named block', () => {
    const parsed = parseQueryFile(
      '-- byteql-queries v1\n-- format: pcap\n\n-- name: A\nselect 1;\n\n-- name: B\nselect 2;\n',
      'file',
    );
    expect(parsed).toEqual({
      format: 'pcap',
      queries: [
        { name: 'A', sql: 'select 1;' },
        { name: 'B', sql: 'select 2;' },
      ],
      rejected: [],
    });
  });

  it('imports a plain .sql file with no markers as one query named after the file', () => {
    expect(parseQueryFile('\n\nselect *\nfrom packets;\n\n', 'triage')).toEqual({
      format: null,
      queries: [{ name: 'triage', sql: 'select *\nfrom packets;' }],
      rejected: [],
    });
  });

  it('imports an exported empty library as zero queries', () => {
    expect(parseQueryFile('-- byteql-queries v1\n-- format: zip\n', 'lib')).toEqual({
      format: 'zip',
      queries: [],
      rejected: [],
    });
  });

  it('handles a BOM and CRLF line endings from other editors', () => {
    const parsed = parseQueryFile('﻿-- format: pcap\r\n-- name: Windows\r\nselect 1;\r\n', 'f');
    expect(parsed.format).toBe('pcap');
    expect(parsed.queries).toEqual([{ name: 'Windows', sql: 'select 1;' }]);
  });

  it('rejects empty and oversized blocks one at a time, keeping the rest', () => {
    const huge = `select '${'x'.repeat(QUERY_SQL_MAX_BYTES)}'`;
    const parsed = parseQueryFile(`-- name: Empty\n\n-- name: Huge\n${huge}\n-- name: Fine\nselect 1`, 'f');
    expect(parsed.queries).toEqual([{ name: 'Fine', sql: 'select 1' }]);
    expect(parsed.rejected).toEqual([
      { name: 'Empty', reason: 'empty' },
      { name: 'Huge', reason: 'too-large' },
    ]);
  });

  it('names a block with an empty name "Untitled query"', () => {
    expect(parseQueryFile('-- name:   \nselect 1', 'f').queries[0]!.name).toBe('Untitled query');
  });
});

describe('decodeQueryFile', () => {
  it('decodes UTF-8 and drops a BOM', () => {
    expect(decodeQueryFile(encode('﻿select é'))).toBe('select é');
  });

  it('rejects invalid UTF-8', () => {
    expect(() => decodeQueryFile(new Uint8Array([0x73, 0xff, 0xfe]))).toThrow(QueryFileError);
  });

  it('rejects a file over 1 MiB before decoding', () => {
    expect(() => decodeQueryFile(new Uint8Array(QUERY_FILE_MAX_BYTES + 1))).toThrow(/1 MiB/u);
  });
});

describe('round trip', () => {
  /** Small deterministic PRNG (mulberry32), so failures reproduce from the seed. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const PIECES = [
    'select',
    ' ',
    '\n',
    '\r\n',
    '\t',
    '--',
    '-- name:',
    '--\\ name:',
    '-- format:',
    '  --  name: x',
    "'lit'",
    'é',
    ';',
    '*',
    'from ip',
  ];

  it('parse(serialize(q)) returns every query with normalized SQL and single-line names', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      const pick = (): string => PIECES[Math.floor(next() * PIECES.length)]!;
      const queries = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, index) => ({
        name: `q${index}${pick()}`,
        sql: `select ${index}${Array.from({ length: Math.floor(next() * 12) }, pick).join('')}`,
      }));
      const parsed = parseQueryFile(serializeQueryFile('pcap', queries), 'fallback');
      expect(parsed.format, `seed ${seed}`).toBe('pcap');
      expect(parsed.rejected, `seed ${seed}`).toEqual([]);
      expect(parsed.queries, `seed ${seed}`).toEqual(
        queries.map((query) => ({
          name: query.name.replace(/\s+/gu, ' ').trim(),
          sql: normalizeSql(query.sql),
        })),
      );
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/queries/sql-file.test.ts`
Expected: FAIL — `Cannot find module './sql-file.js'`.

- [ ] **Step 3: Implement**

`apps/web/src/lib/queries/sql-file.ts`:

```ts
export const QUERY_FILE_MAX_BYTES = 1024 * 1024;
export const QUERY_SQL_MAX_BYTES = 64 * 1024;

const HEADER = '-- byteql-queries v1';
const UNTITLED = 'Untitled query';
const NAME_MARKER = /^[ \t]*--[ \t]*name:(.*)$/u;
const FORMAT_MARKER = /^[ \t]*--[ \t]*format:(.*)$/u;
/**
 * A line that reads as a marker, optionally already escaped with backslashes after `--`.
 * Export adds one backslash to every such line inside SQL; import removes one from every line
 * that has at least one. A literal `--\ name:` in SQL therefore round-trips too.
 */
const MARKER_LIKE = /^([ \t]*)--(\\*)([ \t]*(?:name|format):)/u;
const ESCAPED_MARKER = /^([ \t]*)--\\(\\*)([ \t]*(?:name|format):)/u;

export class QueryFileError extends Error {
  override name = 'QueryFileError';
}

export interface QueryFileEntry {
  name: string;
  sql: string;
}

export interface RejectedBlock {
  name: string;
  reason: 'empty' | 'too-large';
}

export interface ParsedQueryFile {
  format: string | null;
  queries: QueryFileEntry[];
  rejected: RejectedBlock[];
}

const singleLine = (name: string): string => name.replace(/\s+/gu, ' ').trim() || UNTITLED;

/** CRLF to LF, leading blank lines dropped, trailing whitespace trimmed. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/\r\n?/gu, '\n')
    .replace(/^(?:[ \t]*\n)+/u, '')
    .trimEnd();
}

const escapeLine = (line: string): string =>
  line.replace(MARKER_LIKE, (_match, indent: string, slashes: string, rest: string) => `${indent}--\\${slashes}${rest}`);

const unescapeLine = (line: string): string =>
  line.replace(ESCAPED_MARKER, (_match, indent: string, slashes: string, rest: string) => `${indent}--${slashes}${rest}`);

export function decodeQueryFile(bytes: Uint8Array): string {
  if (bytes.byteLength > QUERY_FILE_MAX_BYTES) {
    throw new QueryFileError('The file is larger than 1 MiB.');
  }
  try {
    // `ignoreBOM: false` (the default) strips a leading UTF-8 BOM.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new QueryFileError('The file is not valid UTF-8 text.');
  }
}

export function serializeQueryFile(format: string, queries: readonly QueryFileEntry[]): string {
  let text = `${HEADER}\n-- format: ${singleLine(format)}\n`;
  for (const query of queries) {
    const body = normalizeSql(query.sql).split('\n').map(escapeLine).join('\n');
    text += `\n-- name: ${singleLine(query.name)}\n${body}\n`;
  }
  return text;
}

function addBlock(result: ParsedQueryFile, name: string, raw: string): void {
  const sql = normalizeSql(raw);
  if (sql.trim() === '') {
    result.rejected.push({ name, reason: 'empty' });
  } else if (new TextEncoder().encode(sql).byteLength > QUERY_SQL_MAX_BYTES) {
    result.rejected.push({ name, reason: 'too-large' });
  } else {
    result.queries.push({ name, sql });
  }
}

export function parseQueryFile(text: string, fallbackName: string): ParsedQueryFile {
  const lines = text.replace(/^﻿/u, '').replace(/\r\n?/gu, '\n').split('\n');
  const result: ParsedQueryFile = { format: null, queries: [], rejected: [] };
  const firstName = lines.findIndex((line) => NAME_MARKER.test(line));
  const preamble = firstName === -1 ? lines : lines.slice(0, firstName);
  const isLibraryFile = preamble.find((line) => line.trim() !== '')?.trim() === HEADER;

  // A plain no-marker .sql file never has a `-- format:` comment interpreted.
  if (firstName !== -1 || isLibraryFile) {
    for (const line of preamble) {
      const match = FORMAT_MARKER.exec(line);
      if (match) {
        result.format = match[1]!.trim() || null;
        break;
      }
    }
  }

  if (firstName === -1) {
    // A library file with no blocks is an empty export; anything else is one plain query.
    if (!isLibraryFile) addBlock(result, singleLine(fallbackName), lines.join('\n'));
    return result;
  }

  let name: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (name !== null) addBlock(result, name, body.map(unescapeLine).join('\n'));
  };
  for (const line of lines.slice(firstName)) {
    const match = NAME_MARKER.exec(line);
    if (match) {
      flush();
      name = singleLine(match[1]!);
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return result;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/queries/sql-file.test.ts`
Expected: PASS (all tests, including 300 seeded round trips).

- [ ] **Step 5: Gate and commit**

```bash
git add apps/web/src/lib/queries/sql-file.ts apps/web/src/lib/queries/sql-file.test.ts
git commit -m "feat(web): read and write annotated .sql query files"
```

---

### Task 4: `QueryLibrary` policy and display helpers

**Files:**

- Create: `apps/web/src/lib/queries/display.ts`
- Create: `apps/web/src/lib/queries/library.ts`
- Test: `apps/web/src/lib/queries/display.test.ts`, `apps/web/src/lib/queries/library.test.ts`

**Interfaces:**

- Consumes: `QueryStore`, `StoreChange`, `MemoryQueryStore`, `trimHistory` (Task 1);
  `openIndexedDbQueryStore` (Task 2); `ParsedQueryFile`, `serializeQueryFile`, `normalizeSql`
  (Task 3).
- Produces (`display.ts`):
  - `function defaultQueryName(sql: string): string`
  - `function normalizeQueryName(name: string): string` — whitespace collapsed, trimmed,
    `Untitled query` when empty
  - `function sqlPreview(sql: string): string` — first non-blank, non-comment line (else first
    non-blank line), whitespace-collapsed, max 80 characters (79 + `…`); `…` appended when more
    lines follow and it is not already truncated
  - `function relativeTime(then: number, now: number): string`
  - `function fileStem(name: string): string`
- Produces (`library.ts`):
  - `const STORAGE_ERROR_MESSAGE = "Couldn't save to browser storage."`
  - `type LibraryEvent = { type: 'changed' } | { type: 'storage-error'; message: string }`
  - `interface ImportReport { imported: number; skipped: number; rejected: number }`
  - `interface RunRecord { format: string; sql: string; status: 'ok' | 'error'; rowCount: number | null }`
  - `class QueryLibrary` with:
    - `static open(store: QueryStore, deps?: { now?: () => number; newId?: () => string }): Promise<QueryLibrary>`
    - `readonly persistent: boolean`, `get settings(): QuerySettings`
    - `savedFor(format: string): readonly SavedQuery[]` (oldest first)
    - `historyFor(format: string): readonly HistoryEntry[]` (newest first)
    - `find(id: string): SavedQuery | null`
    - `subscribe(listener: (event: LibraryEvent) => void): () => void`
    - `save(input: { format: string; name: string; sql: string }): SavedQuery`
    - `update(id: string, patch: { name?: string; sql?: string }): SavedQuery | null` — `null`
      when the id no longer exists
    - `remove(id: string): SavedQuery | null`
    - `restore(query: SavedQuery): void`
    - `recordRun(run: RunRecord): void`
    - `setPersistHistory(persist: boolean): void`
    - `clearHistory(): void`
    - `importQueries(format: string, parsed: ParsedQueryFile): ImportReport`
    - `exportFile(format: string): { filename: string; text: string }`
    - `flush(): Promise<void>` — resolves after every queued store write/reload settles
    - `dispose(): void`
  - `function openQueryLibrary(): Promise<QueryLibrary>` — IndexedDB when it opens, otherwise the
    memory store. Never rejects.
- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/queries/display.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { defaultQueryName, fileStem, normalizeQueryName, relativeTime, sqlPreview } from './display.js';

describe('defaultQueryName', () => {
  it('uses the first non-comment line, whitespace collapsed', () => {
    expect(defaultQueryName('-- triage\n\n  select   src\nfrom ip')).toBe('select src');
  });

  it('truncates to 60 characters', () => {
    const name = defaultQueryName(`select ${'x'.repeat(80)}`);
    expect(name).toHaveLength(60);
    expect(name.endsWith('…')).toBe(true);
  });

  it('falls back when there is nothing but comments', () => {
    expect(defaultQueryName('-- only a comment\n')).toBe('Untitled query');
  });
});

describe('normalizeQueryName', () => {
  it('keeps one line and never returns an empty name', () => {
    expect(normalizeQueryName(' a\n b ')).toBe('a b');
    expect(normalizeQueryName('  ')).toBe('Untitled query');
  });
});

describe('sqlPreview', () => {
  it('shows the first meaningful line and marks that more follows', () => {
    expect(sqlPreview('-- note\nselect 1\nfrom t')).toBe('select 1 …');
    expect(sqlPreview('select 1')).toBe('select 1');
  });

  it('falls back to a comment line when the SQL is only comments', () => {
    expect(sqlPreview('-- just this')).toBe('-- just this');
  });
});

describe('relativeTime', () => {
  const now = 10_000_000_000;
  it.each([
    [now - 5_000, 'just now'],
    [now - 5 * 60_000, '5 min ago'],
    [now - 3 * 3_600_000, '3 h ago'],
  ])('formats %d', (then, expected) => {
    expect(relativeTime(then, now)).toBe(expected);
  });

  it('falls back to a date after a day', () => {
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe(new Date(now - 2 * 86_400_000).toLocaleDateString());
  });
});

describe('fileStem', () => {
  it('drops the extension only', () => {
    expect(fileStem('triage.queries.sql')).toBe('triage.queries');
    expect(fileStem('.sql')).toBe('.sql');
  });
});
```

`apps/web/src/lib/queries/library.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { QueryLibrary, STORAGE_ERROR_MESSAGE, type LibraryEvent } from './library.js';
import { parseQueryFile } from './sql-file.js';
import { MemoryQueryStore } from './store.js';

async function openLibrary(store = new MemoryQueryStore()) {
  let clock = 1_000;
  let ids = 0;
  const library = await QueryLibrary.open(store, { now: () => (clock += 1), newId: () => `id${++ids}` });
  return { library, store };
}

const run = (overrides: Partial<Parameters<QueryLibrary['recordRun']>[0]> = {}) => ({
  format: 'pcap',
  sql: 'select 1',
  status: 'ok' as const,
  rowCount: 1,
  ...overrides,
});

describe('QueryLibrary saved queries', () => {
  it('saves per format and persists the record', async () => {
    const { library, store } = await openLibrary();
    const saved = library.save({ format: 'pcap', name: ' Top\ntalkers ', sql: 'select 1' });
    library.save({ format: 'midi', name: 'Notes', sql: 'select 2' });

    expect(saved).toMatchObject({ id: 'id1', format: 'pcap', name: 'Top talkers', sql: 'select 1' });
    expect(library.savedFor('pcap').map((query) => query.name)).toEqual(['Top talkers']);
    await library.flush();
    expect((await store.listSaved()).map((query) => query.id)).toEqual(['id1', 'id2']);
  });

  it('updates name and SQL, and returns null for a query deleted elsewhere', async () => {
    const { library } = await openLibrary();
    const saved = library.save({ format: 'pcap', name: 'A', sql: 'select 1' });
    const updated = library.update(saved.id, { sql: 'select 2' });
    expect(updated).toMatchObject({ name: 'A', sql: 'select 2', createdAt: saved.createdAt });
    expect(updated!.updatedAt).toBeGreaterThan(saved.updatedAt);
    expect(library.update('missing', { sql: 'x' })).toBeNull();
  });

  it('removes and restores a query in its original position', async () => {
    const { library } = await openLibrary();
    const first = library.save({ format: 'pcap', name: 'A', sql: 'select 1' });
    library.save({ format: 'pcap', name: 'B', sql: 'select 2' });
    const removed = library.remove(first.id);
    expect(library.savedFor('pcap').map((query) => query.name)).toEqual(['B']);
    library.restore(removed!);
    expect(library.savedFor('pcap').map((query) => query.name)).toEqual(['A', 'B']);
  });

  it('loads what the store already holds', async () => {
    const store = new MemoryQueryStore();
    const first = (await openLibrary(store)).library;
    first.save({ format: 'pcap', name: 'A', sql: 'select 1' });
    await first.flush();
    const { library } = await openLibrary(store);
    expect(library.savedFor('pcap').map((query) => query.name)).toEqual(['A']);
  });
});

describe('QueryLibrary history', () => {
  it('keeps history in memory only while persistence is off (the default)', async () => {
    const { library, store } = await openLibrary();
    library.recordRun(run());
    expect(library.historyFor('pcap')).toHaveLength(1);
    await library.flush();
    expect(await store.listHistory()).toEqual([]);
  });

  it('collapses a repeat of the newest run of the same format', async () => {
    const { library } = await openLibrary();
    library.recordRun(run({ sql: 'select 1' }));
    library.recordRun(run({ sql: 'select 1', status: 'error', rowCount: null }));
    library.recordRun(run({ format: 'midi', sql: 'select 1' }));
    const pcap = library.historyFor('pcap');
    expect(pcap).toHaveLength(1);
    expect(pcap[0]).toMatchObject({ status: 'error', rowCount: null });
    expect(library.historyFor('midi')).toHaveLength(1);
  });

  it('ignores blank SQL', async () => {
    const { library } = await openLibrary();
    library.recordRun(run({ sql: '   ' }));
    expect(library.historyFor('pcap')).toEqual([]);
  });

  it('trims across formats to the limit', async () => {
    const { library } = await openLibrary();
    for (let index = 0; index < 105; index += 1) {
      library.recordRun(run({ format: index % 2 ? 'pcap' : 'midi', sql: `select ${index}` }));
    }
    expect(library.historyFor('pcap').length + library.historyFor('midi').length).toBe(100);
    expect(library.historyFor('midi').at(-1)!.sql).toBe('select 6');
  });

  it('writes current history through when persistence turns on, and stores new runs', async () => {
    const { library, store } = await openLibrary();
    library.recordRun(run({ sql: 'select 1' }));
    library.setPersistHistory(true);
    library.recordRun(run({ sql: 'select 2' }));
    await library.flush();
    expect((await store.listHistory()).map((entry) => entry.sql)).toEqual(['select 2', 'select 1']);
    expect((await store.getSettings()).persistHistory).toBe(true);
  });

  it('deletes stored history when persistence turns off, keeping the tab history', async () => {
    const { library, store } = await openLibrary();
    library.setPersistHistory(true);
    library.recordRun(run());
    library.setPersistHistory(false);
    await library.flush();
    expect(await store.listHistory()).toEqual([]);
    expect(library.historyFor('pcap')).toHaveLength(1);
    expect(library.settings.persistHistory).toBe(false);
  });

  it('restores persisted history on open only when persistence is on', async () => {
    const store = new MemoryQueryStore();
    const first = (await openLibrary(store)).library;
    first.setPersistHistory(true);
    first.recordRun(run());
    await first.flush();
    expect((await openLibrary(store)).library.historyFor('pcap')).toHaveLength(1);
  });

  it('clears history in memory and in storage', async () => {
    const { library, store } = await openLibrary();
    library.setPersistHistory(true);
    library.recordRun(run());
    library.clearHistory();
    await library.flush();
    expect(library.historyFor('pcap')).toEqual([]);
    expect(await store.listHistory()).toEqual([]);
  });
});

describe('QueryLibrary import and export', () => {
  it('adds new queries, skips exact duplicates, and counts rejected blocks', async () => {
    const { library } = await openLibrary();
    library.save({ format: 'pcap', name: 'A', sql: 'select 1' });
    const parsed = parseQueryFile(
      '-- name: A\nselect 1\n\n-- name: A\nselect 2\n-- name: B\nselect 3\n-- name: B\nselect 3\n-- name: Empty\n',
      'f',
    );
    expect(library.importQueries('pcap', parsed)).toEqual({ imported: 2, skipped: 2, rejected: 1 });
    expect(library.savedFor('pcap').map((query) => [query.name, query.sql])).toEqual([
      ['A', 'select 1'],
      ['A', 'select 2'],
      ['B', 'select 3'],
    ]);
  });

  it('imports into the given format even when the file names another', async () => {
    const { library } = await openLibrary();
    library.importQueries('midi', parseQueryFile('-- format: pcap\n-- name: A\nselect 1', 'f'));
    expect(library.savedFor('midi')).toHaveLength(1);
  });

  it('exports only the format library, round-tripping through import', async () => {
    const { library } = await openLibrary();
    library.save({ format: 'pcap', name: 'A', sql: 'select 1' });
    library.save({ format: 'midi', name: 'M', sql: 'select 2' });
    const { filename, text } = library.exportFile('pcap');
    expect(filename).toBe('byteql-pcap-queries.sql');
    expect(parseQueryFile(text, 'x')).toEqual({ format: 'pcap', queries: [{ name: 'A', sql: 'select 1' }], rejected: [] });
  });
});

describe('QueryLibrary storage failures and other tabs', () => {
  it('keeps memory state and reports a storage error when a write fails', async () => {
    const store = new MemoryQueryStore();
    vi.spyOn(store, 'putSaved').mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    const { library } = await openLibrary(store);
    const events: LibraryEvent[] = [];
    library.subscribe((event) => events.push(event));

    library.save({ format: 'pcap', name: 'A', sql: 'select 1' });
    await library.flush();

    expect(library.savedFor('pcap')).toHaveLength(1);
    expect(events).toContainEqual({ type: 'storage-error', message: STORAGE_ERROR_MESSAGE });
  });

  it('keeps writing after a failed write', async () => {
    const store = new MemoryQueryStore();
    vi.spyOn(store, 'putSaved').mockRejectedValueOnce(new Error('aborted'));
    const { library } = await openLibrary(store);
    library.save({ format: 'pcap', name: 'A', sql: 'select 1' });
    library.save({ format: 'pcap', name: 'B', sql: 'select 2' });
    await library.flush();
    expect((await store.listSaved()).map((query) => query.name)).toEqual(['B']);
  });

  it('reloads saved queries when another tab changes them', async () => {
    const store = new MemoryQueryStore();
    let remote: ((change: 'saved' | 'history' | 'settings') => void) | null = null;
    vi.spyOn(store, 'subscribe').mockImplementation((listener) => {
      remote = listener;
      return () => undefined;
    });
    const { library } = await openLibrary(store);
    const events: LibraryEvent[] = [];
    library.subscribe((event) => events.push(event));

    await store.putSaved({ id: 'x', format: 'pcap', name: 'From B', sql: 'select 9', createdAt: 1, updatedAt: 1 });
    remote!('saved');
    await library.flush();

    expect(library.savedFor('pcap').map((query) => query.name)).toEqual(['From B']);
    expect(events).toContainEqual({ type: 'changed' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/queries/display.test.ts src/lib/queries/library.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `display.ts`**

```ts
const UNTITLED = 'Untitled query';

const collapse = (text: string): string => text.replace(/\s+/gu, ' ').trim();

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function normalizeQueryName(name: string): string {
  return collapse(name) || UNTITLED;
}

export function defaultQueryName(sql: string): string {
  for (const line of sql.split(/\r?\n/u)) {
    const text = collapse(line);
    if (text && !text.startsWith('--')) return truncate(text, 60);
  }
  return UNTITLED;
}

export function sqlPreview(sql: string): string {
  const lines = sql.split(/\r?\n/u).map(collapse);
  const index = lines.findIndex((line) => line && !line.startsWith('--'));
  const at = index === -1 ? lines.findIndex((line) => line !== '') : index;
  if (at === -1) return '';
  const text = truncate(lines[at]!, 80);
  const more = lines.slice(at + 1).some((line) => line !== '');
  return more && !text.endsWith('…') ? `${text} …` : text;
}

export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleDateString();
}

export function fileStem(name: string): string {
  return name.replace(/(?<=.)\.[^.]*$/u, '');
}
```

- [ ] **Step 4: Implement `library.ts`**

```ts
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
        : { id: this.#newId(), format: run.format, sql: run.sql, ranAt, status: run.status, rowCount: run.rowCount };
    const limit = this.#settings.historyLimit;
    this.#history = trimHistory([entry, ...this.#history.filter((existing) => existing.id !== entry.id)], limit);
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
    return { filename: `byteql-${safe}-queries.sql`, text: serializeQueryFile(format, this.savedFor(format)) };
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
    return await QueryLibrary.open(await openIndexedDbQueryStore());
  } catch {
    return QueryLibrary.open(new MemoryQueryStore());
  }
}
```

If the `openQueryLibrary` IndexedDB path opens but `QueryLibrary.open` then fails reading, close
the store before falling back (wrap: `const store = await openIndexedDbQueryStore(); try { return
await QueryLibrary.open(store); } catch (error) { store.close(); throw error; }` inside the
`try`).

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/queries`
Expected: PASS (every file in the directory).

- [ ] **Step 6: Gate and commit**

```bash
git add apps/web/src/lib/queries/display.ts apps/web/src/lib/queries/display.test.ts \
  apps/web/src/lib/queries/library.ts apps/web/src/lib/queries/library.test.ts
git commit -m "feat(web): add the query library with opt-in history persistence"
```

---

### Task 5: Save query popover, `Ctrl/⌘+S`, and app wiring

**Files:**

- Create: `apps/web/src/components/SaveQueryPopover.svelte`
- Test: `apps/web/src/components/SaveQueryPopover.test.ts`
- Modify: `apps/web/src/components/SqlEditor.svelte` (props at line 14, keymap at line 83)
- Modify: `apps/web/src/components/ShortcutsOverlay.svelte` (list at line 18)
- Modify: `apps/web/src/components/Workbench.svelte` (Props ~line 65, `loadQuery` ~line 660,
  toolbar ~line 996)
- Modify: `apps/web/src/App.svelte` (`start()` and the `<Workbench>` element)
- Test: `apps/web/src/components/Workbench.test.ts` (new `describe` block at the end)

**Interfaces:**

- Consumes: `QueryLibrary`, `openQueryLibrary` (Task 4), `SavedQuery`, `defaultQueryName`.
- Produces:
  - `SaveQueryPopover` props:
    `{ library: QueryLibrary; format: string; sql: string; loaded: SavedQuery | null; onsaved: (query: SavedQuery) => void; onclose: () => void }`
  - `SqlEditor` gains optional prop `onsave?: () => void`, bound to `Mod-s` in the editor.
  - `Workbench` gains optional prop `queryLibrary?: QueryLibrary | null` (default `null`; when
    null no library UI renders, so existing tests stay unchanged), and internal
    `loadQuery(sql: string, saved?: SavedQuery | null)`.
- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/SaveQueryPopover.test.ts`:

```ts
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QueryLibrary } from '../lib/queries/library.js';
import { MemoryQueryStore } from '../lib/queries/store.js';
import SaveQueryPopover from './SaveQueryPopover.svelte';

const openLibrary = () => QueryLibrary.open(new MemoryQueryStore());

describe('SaveQueryPopover', () => {
  afterEach(() => cleanup());

  it('saves a new query under a default name taken from the SQL', async () => {
    const library = await openLibrary();
    const onsaved = vi.fn();
    render(SaveQueryPopover, {
      library,
      format: 'pcap',
      sql: '-- note\nselect src from ip',
      loaded: null,
      onsaved,
      onclose: vi.fn(),
    });

    const name = screen.getByLabelText('Query name') as HTMLInputElement;
    expect(name.value).toBe('select src from ip');
    await fireEvent.input(name, { target: { value: 'Sources' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(library.savedFor('pcap').map((query) => query.name)).toEqual(['Sources']);
    expect(onsaved).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sources' }));
  });

  it('saves on Enter and closes on Escape', async () => {
    const library = await openLibrary();
    const onclose = vi.fn();
    render(SaveQueryPopover, { library, format: 'pcap', sql: 'select 1', loaded: null, onsaved: vi.fn(), onclose });
    const name = screen.getByLabelText('Query name');
    await fireEvent.keyDown(name, { key: 'Enter' });
    expect(library.savedFor('pcap')).toHaveLength(1);
    await fireEvent.keyDown(name, { key: 'Escape' });
    expect(onclose).toHaveBeenCalled();
  });

  it('offers Update and Save as new when the loaded query has changed', async () => {
    const library = await openLibrary();
    const loaded = library.save({ format: 'pcap', name: 'Talkers', sql: 'select 1' });
    render(SaveQueryPopover, { library, format: 'pcap', sql: 'select 2', loaded, onsaved: vi.fn(), onclose: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Update "Talkers"' }));
    expect(library.savedFor('pcap')).toEqual([expect.objectContaining({ id: loaded.id, sql: 'select 2' })]);
  });

  it('saves a copy with Save as new', async () => {
    const library = await openLibrary();
    const loaded = library.save({ format: 'pcap', name: 'Talkers', sql: 'select 1' });
    render(SaveQueryPopover, { library, format: 'pcap', sql: 'select 2', loaded, onsaved: vi.fn(), onclose: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Save as new' }));
    expect(library.savedFor('pcap').map((query) => query.sql)).toEqual(['select 1', 'select 2']);
  });

  it('disables saving when the loaded query is unchanged', async () => {
    const library = await openLibrary();
    const loaded = library.save({ format: 'pcap', name: 'Talkers', sql: 'select 1' });
    render(SaveQueryPopover, { library, format: 'pcap', sql: 'select 1', loaded, onsaved: vi.fn(), onclose: vi.fn() });

    expect((screen.getByRole('button', { name: 'Already saved' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves as new when the loaded query was deleted elsewhere', async () => {
    const library = await openLibrary();
    const loaded = library.save({ format: 'pcap', name: 'Talkers', sql: 'select 1' });
    library.remove(loaded.id);
    render(SaveQueryPopover, { library, format: 'pcap', sql: 'select 2', loaded, onsaved: vi.fn(), onclose: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Update "Talkers"' }));
    expect(library.savedFor('pcap')).toEqual([expect.objectContaining({ name: 'Talkers', sql: 'select 2' })]);
  });
});
```

Append to `apps/web/src/components/Workbench.test.ts`, inside the top-level
`describe('Inspector Workbench', ...)` block so its `beforeEach`/`afterEach` apply (add the two
imports at the top of the file):

```ts
// imports to add at the top:
import { QueryLibrary } from '../lib/queries/library.js';
import { MemoryQueryStore } from '../lib/queries/store.js';

  describe('saved queries', () => {
    it('shows no Save query control without a library', () => {
      render(Workbench, { controller: new FakeController(readyState()) });
      expect(screen.queryByRole('button', { name: 'Save query' })).toBeNull();
    });

    it('saves the editor SQL without running it', async () => {
      // `readyState()` already holds SQL and a result, so no overview query auto-runs.
      const controller = new FakeController(readyState());
      const queryLibrary = await QueryLibrary.open(new MemoryQueryStore());
      render(Workbench, { controller, queryLibrary });

      const editor = screen.getByRole('textbox', { name: 'SQL query' });
      EditorView.findFromDOM(editor)!.dispatch({ changes: { from: 0, insert: 'select 42' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save query' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(queryLibrary.savedFor(readyState().format!.id).map((query) => query.sql)).toEqual([
        expect.stringContaining('select 42'),
      ]);
      expect(controller.runQuery).not.toHaveBeenCalled();
    });

    it('forgets the loaded saved query when the format changes', async () => {
      const controller = new FakeController(readyState());
      const queryLibrary = await QueryLibrary.open(new MemoryQueryStore());
      const format = readyState().format!.id;
      queryLibrary.save({ format, name: 'Kept', sql: 'select 1' });
      render(Workbench, { controller, queryLibrary });

      await fireEvent.click(await screen.findByRole('button', { name: 'Kept' }));
      controller.publish({ ...controller.state, format: { id: 'zip', title: 'ZIP archive' } });
      await tick();
      const editor = screen.getByRole('textbox', { name: 'SQL query' });
      EditorView.findFromDOM(editor)!.dispatch({ changes: { from: 0, insert: '-- edited\n' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Save query' }));

      expect(screen.queryByRole('button', { name: 'Update "Kept"' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    });
  });
```

The third test clicks the saved row rendered by Task 6's panel; write it now, and expect it to
keep failing until Task 6 lands. Mark it `it.todo` in this task's commit and replace `it.todo`
with `it` in Task 6 Step 1 — this task's gate must be green.

Also add to `ShortcutsOverlay.test.ts` (if it enumerates entries; otherwise add this test):

```ts
it('lists the save shortcut', () => {
  render(ShortcutsOverlay, { onclose: vi.fn() });
  expect(screen.getByText('Save query')).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/web exec vitest run src/components/SaveQueryPopover.test.ts src/components/Workbench.test.ts src/components/ShortcutsOverlay.test.ts`
Expected: FAIL — `SaveQueryPopover.svelte` missing; Workbench has no `Save query` button.

- [ ] **Step 3: Implement `SaveQueryPopover.svelte`**

```svelte
<script lang="ts">
  /* global HTMLElement, HTMLInputElement, KeyboardEvent */
  import { onMount } from 'svelte';

  import { defaultQueryName } from '../lib/queries/display.js';
  import type { QueryLibrary } from '../lib/queries/library.js';
  import type { SavedQuery } from '../lib/queries/types.js';
  import { containFocus } from '../lib/ui/focus.js';

  interface Props {
    library: QueryLibrary;
    format: string;
    sql: string;
    /** The saved query the editor was last loaded from, if it belongs to `format`. */
    loaded: SavedQuery | null;
    onsaved: (query: SavedQuery) => void;
    onclose: () => void;
  }

  let { library, format, sql, loaded, onsaved, onclose }: Props = $props();
  let panel = $state<HTMLElement>();
  let input = $state<HTMLInputElement>();
  // Seeded once from the props when the popover opens; the user edits it from there.
  // svelte-ignore state_referenced_locally
  let name = $state(loaded?.name ?? defaultQueryName(sql));

  // svelte-ignore state_referenced_locally
  const unchanged = loaded !== null && loaded.sql === sql;
  // svelte-ignore state_referenced_locally
  const offerUpdate = loaded !== null && !unchanged;

  onMount(() => {
    input?.select();
    input?.focus();
  });

  $effect(() => {
    const element = panel;
    if (!element) return;
    return containFocus(element, onclose);
  });

  function saveNew(): void {
    onsaved(library.save({ format, name, sql }));
  }

  function update(): void {
    // A query deleted in another tab cannot be updated; keep the user's work as a new query.
    const updated = loaded ? library.update(loaded.id, { name, sql }) : null;
    onsaved(updated ?? library.save({ format, name, sql }));
  }

  function primary(): void {
    if (unchanged) return;
    if (offerUpdate) update();
    else saveNew();
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      primary();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
  }
</script>

<div bind:this={panel} class="save-query-popover" role="dialog" aria-label="Save query" tabindex="-1">
  <label>
    <span>Query name</span>
    <input bind:this={input} bind:value={name} type="text" maxlength="200" onkeydown={keydown} />
  </label>
  <div class="save-query-actions">
    {#if unchanged}
      <button class="button button-primary button-compact" type="button" disabled>Already saved</button>
    {:else if offerUpdate}
      <button class="button button-primary button-compact" type="button" onclick={update}>
        Update "{loaded?.name}"
      </button>
      <button class="button button-secondary button-compact" type="button" onclick={saveNew}>Save as new</button>
    {:else}
      <button class="button button-primary button-compact" type="button" onclick={saveNew}>Save</button>
    {/if}
    <button class="button button-secondary button-compact" type="button" onclick={onclose}>Cancel</button>
  </div>
</div>

<style>
  .save-query-popover {
    z-index: var(--layer-popover);
    position: absolute;
    top: calc(100% + var(--space-1));
    right: 0;
    display: grid;
    gap: var(--space-2);
    min-width: 18rem;
    padding: var(--space-2);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-overlay);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-overlay);
  }

  .save-query-popover label {
    display: grid;
    gap: var(--space-1);
    font-size: var(--text-sm);
  }

  .save-query-popover input {
    min-height: var(--control-height);
    padding: 0 var(--space-2);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-control);
    color: var(--color-text);
    background: var(--color-surface);
    font: inherit;
  }

  .save-query-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: flex-end;
  }
</style>
```

The `Enter` key handler saves the new query when the popover is showing `Save`; the test
"saves on Enter and closes on Escape" relies on `onclose` not being called by saving (Workbench
closes the popover in its `onsaved`).

- [ ] **Step 4: Editor shortcut and overlay entry**

In `SqlEditor.svelte`, add `onsave?: () => void;` to `Props`, destructure it with default
`undefined`, and add a second keymap binding next to `Mod-Enter`:

```ts
          {
            key: 'Mod-s',
            run() {
              if (!onsave) return false;
              onsave();
              return true;
            },
          },
```

Because the keymap is created once in `onMount`, read `onsave` through the current props at call
time (the existing `onrun` binding does the same; follow its pattern exactly).

In `ShortcutsOverlay.svelte`, insert after the `Run query` entry:

```ts
    { action: 'Save query', keys: `${mod}+S` },
```

- [ ] **Step 5: Wire the Workbench**

In `Workbench.svelte`:

1. Imports:

   ```ts
   import type { QueryLibrary } from '../lib/queries/library.js';
   import type { SavedQuery } from '../lib/queries/types.js';
   import SaveQueryPopover from './SaveQueryPopover.svelte';
   ```

2. Props: add `queryLibrary?: QueryLibrary | null;` to `interface Props` and destructure
   `queryLibrary = null`.

3. State, after `draftSql`:

   ```ts
   /** The saved query the editor was last loaded from; cleared by any other load. */
   let loadedSaved = $state<SavedQuery | null>(null);
   let saveOpen = $state(false);
   /** Bumped on every library change, so derived lookups re-read the library. */
   let libraryVersion = $state(0);
   $effect(() => {
     const library = queryLibrary;
     if (!library) return;
     return library.subscribe(() => (libraryVersion += 1));
   });
   /** Only a saved query of the CURRENT format may be updated from the editor. */
   const loadedForFormat = $derived.by(() => {
     void libraryVersion;
     const saved = loadedSaved;
     if (!saved || saved.format !== session.format?.id) return null;
     return saved;
   });
   ```

   `loadedForFormat` deliberately does not re-look-up the id: a query deleted elsewhere is still
   offered as `Update`, and the popover falls back to saving new (Review Focus 3).

4. Replace `loadQuery`:

   ```ts
   /** Loading a query fills the editor and focuses it; it never runs the query. */
   function loadQuery(sql: string, saved: SavedQuery | null = null): void {
     draftSql = sql;
     loadedSaved = saved;
     saveOpen = false;
     void tick().then(() => sqlEditor?.focus());
   }
   ```

   and `loadQueryFromCatalog(sql: string, saved: SavedQuery | null = null)` passes `saved`
   through.

5. Helpers:

   ```ts
   const canSave = $derived(queryLibrary !== null && session.format !== null && draftSql.trim() !== '');

   function openSave(): void {
     if (canSave) saveOpen = true;
   }

   function closeSave(): void {
     saveOpen = false;
     void tick().then(() => sqlEditor?.focus());
   }

   function querySaved(query: SavedQuery): void {
     loadedSaved = query;
     closeSave();
   }
   ```

6. Toolbar: inside `.query-actions`, before the Run/Cancel `{#if}`, add (the wrapper provides the
   popover's positioning context):

   ```svelte
            {#if queryLibrary && session.format}
              <div class="save-query-anchor">
                <button
                  class="button button-secondary button-compact"
                  type="button"
                  aria-expanded={saveOpen}
                  disabled={!canSave}
                  onclick={() => (saveOpen ? closeSave() : openSave())}
                >
                  Save query
                </button>
                {#if saveOpen}
                  <SaveQueryPopover
                    library={queryLibrary}
                    format={session.format.id}
                    sql={draftSql}
                    loaded={loadedForFormat}
                    onsaved={querySaved}
                    onclose={closeSave}
                  />
                {/if}
              </div>
            {/if}
   ```

   Add `.save-query-anchor { position: relative; }` to the component's styles (or the stylesheet
   that styles `.query-actions`).

7. `SqlEditor`: pass `onsave={openSave}`.

- [ ] **Step 6: Open the library at startup**

In `App.svelte`:

```ts
  import type { QueryLibrary } from './lib/queries/library.js';
  import { openQueryLibrary } from './lib/queries/library.js';
  // ...
  let queryLibrary = $state<QueryLibrary | null>(null);
```

In `start()`, beside `prepareUiFonts()`, start the library once and await it before readiness:

```ts
      const libraryReady = queryLibrary ? Promise.resolve(queryLibrary) : openQueryLibrary();
      // ...after `await fontsReady;`
      const library = await libraryReady;
      if (disposed || attempt !== generation || currentController !== ownedController) return;
      queryLibrary = library;
```

In the `onMount` cleanup, call `queryLibrary?.dispose()`. Pass `{queryLibrary}` to `<Workbench>`.
`openQueryLibrary` never rejects, so startup error handling is unchanged.

- [ ] **Step 7: Run to verify pass**

Run: `pnpm --filter @byteql/web exec vitest run src/components`
Expected: PASS, with the "forgets the loaded saved query" test reported as todo.

- [ ] **Step 8: Gate and commit**

Run the full web gate: `pnpm --filter @byteql/web test -- --run`, `pnpm --filter @byteql/web check`,
`pnpm lint`, and `pnpm exec prettier --check` on the touched files from `apps/web`.

```bash
git add apps/web/src/components/SaveQueryPopover.svelte apps/web/src/components/SaveQueryPopover.test.ts \
  apps/web/src/components/SqlEditor.svelte apps/web/src/components/ShortcutsOverlay.svelte \
  apps/web/src/components/ShortcutsOverlay.test.ts apps/web/src/components/Workbench.svelte \
  apps/web/src/components/Workbench.test.ts apps/web/src/App.svelte
git commit -m "feat(web): save the editor query from the toolbar or Ctrl/Cmd+S"
```

---

### Task 6: Saved and Recent sections, notices, and history recording

**Files:**

- Create: `apps/web/src/components/QueryLibraryPanel.svelte`
- Test: `apps/web/src/components/QueryLibraryPanel.test.ts`
- Modify: `apps/web/src/components/Explorer.svelte` (Props line 7, query section line 129)
- Modify: `apps/web/src/components/Workbench.svelte` (`run`, notices area, `<Explorer>` props)
- Test: `apps/web/src/components/Workbench.test.ts` (the `saved queries` block)

**Interfaces:**

- Consumes: `QueryLibrary`, `LibraryEvent`, `STORAGE_ERROR_MESSAGE` (Task 4), `sqlPreview`,
  `relativeTime`, `SavedQuery`, `HistoryEntry`, `popoverMenu` (`lib/ui/menu.ts`).
- Produces:
  - `interface LibraryNotice { message: string; undo?: () => void }` exported from
    `apps/web/src/lib/queries/notice.ts`.
  - `QueryLibraryPanel` props:
    `{ library: QueryLibrary; format: string; onload: (sql: string, saved: SavedQuery | null) => void; onsaverecent: (sql: string) => void; onnotice: (notice: LibraryNotice) => void }`
  - `Explorer` gains optional props `library?: QueryLibrary | null`,
    `onloadquery?: (sql: string, saved: SavedQuery | null) => void`,
    `onsaverecent?: (sql: string) => void`, `onnotice?: (notice: LibraryNotice) => void`.
- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/queries/notice.ts`:

```ts
/** A short-lived message from the query library, optionally with an Undo action. */
export interface LibraryNotice {
  message: string;
  undo?: () => void;
}
```

`apps/web/src/components/QueryLibraryPanel.test.ts`:

```ts
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QueryLibrary } from '../lib/queries/library.js';
import { MemoryQueryStore } from '../lib/queries/store.js';
import QueryLibraryPanel from './QueryLibraryPanel.svelte';

async function setup(format = 'pcap') {
  const library = await QueryLibrary.open(new MemoryQueryStore());
  const props = { library, format, onload: vi.fn(), onsaverecent: vi.fn(), onnotice: vi.fn() };
  return { library, props };
}

describe('QueryLibraryPanel', () => {
  afterEach(() => cleanup());

  it('shows the empty state and the storage notice for a non-persistent library', async () => {
    const { props } = await setup();
    render(QueryLibraryPanel, props);
    const saved = screen.getByRole('region', { name: 'Saved queries' });
    expect(within(saved).getByText('Save a query to keep it for later visits.')).toBeTruthy();
    expect(
      within(saved).getByText('This browser is blocking storage — queries last until the tab closes.'),
    ).toBeTruthy();
  });

  it('lists only the current format and loads a query without running it', async () => {
    const { library, props } = await setup();
    const kept = library.save({ format: 'pcap', name: 'Talkers', sql: 'select 1' });
    library.save({ format: 'midi', name: 'Notes', sql: 'select 2' });
    render(QueryLibraryPanel, props);

    expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Talkers' }));
    expect(props.onload).toHaveBeenCalledWith('select 1', kept);
  });

  it('updates when the library changes', async () => {
    const { library, props } = await setup();
    render(QueryLibraryPanel, props);
    library.save({ format: 'pcap', name: 'Later', sql: 'select 1' });
    expect(await screen.findByRole('button', { name: 'Later' })).toBeTruthy();
  });

  it('renames inline from the row menu', async () => {
    const { library, props } = await setup();
    library.save({ format: 'pcap', name: 'Old', sql: 'select 1' });
    render(QueryLibraryPanel, props);

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Old' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByLabelText('Rename Old');
    await fireEvent.input(field, { target: { value: 'New' } });
    await fireEvent.keyDown(field, { key: 'Enter' });

    expect(library.savedFor('pcap').map((query) => query.name)).toEqual(['New']);
  });

  it('deletes with an undo notice', async () => {
    const { library, props } = await setup();
    library.save({ format: 'pcap', name: 'Gone', sql: 'select 1' });
    render(QueryLibraryPanel, props);

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Gone' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(library.savedFor('pcap')).toEqual([]);
    const notice = props.onnotice.mock.calls[0]![0];
    expect(notice.message).toBe('Deleted Gone');
    notice.undo();
    expect(library.savedFor('pcap').map((query) => query.name)).toEqual(['Gone']);
  });

  it('copies SQL to the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { library, props } = await setup();
    library.save({ format: 'pcap', name: 'Copy me', sql: 'select 7' });
    render(QueryLibraryPanel, props);

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Copy me' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Copy SQL' }));
    expect(writeText).toHaveBeenCalledWith('select 7');
    vi.unstubAllGlobals();
  });

  it('lists recent runs for this format, loads them, and saves them', async () => {
    const { library, props } = await setup();
    library.recordRun({ format: 'pcap', sql: 'select 1\nfrom ip', status: 'ok', rowCount: 3 });
    library.recordRun({ format: 'midi', sql: 'select 9', status: 'ok', rowCount: 1 });
    render(QueryLibraryPanel, props);

    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(within(recent).getByText('select 1 …')).toBeTruthy();
    expect(within(recent).getByText(/3 rows/u)).toBeTruthy();
    expect(within(recent).queryByText('select 9')).toBeNull();
    await fireEvent.click(within(recent).getByRole('button', { name: /select 1/u }));
    expect(props.onload).toHaveBeenCalledWith('select 1\nfrom ip', null);
    await fireEvent.click(within(recent).getByRole('button', { name: 'Save select 1 …' }));
    expect(props.onsaverecent).toHaveBeenCalledWith('select 1\nfrom ip');
  });

  it('toggles history persistence and clears history', async () => {
    const { library, props } = await setup();
    library.recordRun({ format: 'pcap', sql: 'select 1', status: 'ok', rowCount: 1 });
    render(QueryLibraryPanel, props);

    const keep = screen.getByRole('checkbox', { name: 'Keep history after this tab closes' }) as HTMLInputElement;
    expect(keep.checked).toBe(false);
    await fireEvent.click(keep);
    expect(library.settings.persistHistory).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    expect(library.historyFor('pcap')).toEqual([]);
  });
});
```

In `Workbench.test.ts`'s `saved queries` block: change the Task 5 `it.todo` back to `it`, and
add:

```ts
    it('records the run that settled, not a stale one', async () => {
      // Empty SQL and no result make the Workbench auto-run the pack's overview query on ready.
      const controller = new FakeController({ ...readyState(), sql: '', result: null });
      const queryLibrary = await QueryLibrary.open(new MemoryQueryStore());
      const format = readyState().format!.id;
      // Settle explicitly (runQuery publishes nothing) so the test controls every outcome.
      controller.runQuery.mockImplementation(async () => undefined);
      render(Workbench, { controller, queryLibrary });
      await vi.waitFor(() => expect(controller.runQuery).toHaveBeenCalledWith(queries[0]!.sql));

      // The automatic overview query is not a user run and is never recorded.
      controller.publish({ ...controller.state, resultSettleCount: controller.state.resultSettleCount + 1 });
      await tick();
      expect(queryLibrary.historyFor(format)).toEqual([]);

      const editor = screen.getByRole('textbox', { name: 'SQL query' });
      const view = EditorView.findFromDOM(editor)!;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'select stale' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'select fresh' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
      controller.publish({
        ...controller.state,
        queryError: 'Binder Error: nope',
        resultSettleCount: controller.state.resultSettleCount + 1,
      });
      await tick();

      expect(queryLibrary.historyFor(format)).toEqual([
        expect.objectContaining({ sql: 'select fresh', status: 'error', rowCount: null }),
      ]);
    });

    it('shows library notices with Undo in the query notices', async () => {
      const controller = new FakeController(readyState());
      const queryLibrary = await QueryLibrary.open(new MemoryQueryStore());
      queryLibrary.save({ format: readyState().format!.id, name: 'Gone', sql: 'select 1' });
      render(Workbench, { controller, queryLibrary });

      await fireEvent.click(await screen.findByRole('button', { name: 'Actions for Gone' }));
      await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      const notice = screen.getByRole('status', { name: 'Query library notice' });
      expect(notice.textContent).toContain('Deleted Gone');
      await fireEvent.click(within(notice).getByRole('button', { name: 'Undo' }));
      expect(await screen.findByRole('button', { name: 'Gone' })).toBeTruthy();
    });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/web exec vitest run src/components/QueryLibraryPanel.test.ts src/components/Workbench.test.ts`
Expected: FAIL — panel component missing; Workbench records nothing.

- [ ] **Step 3: Implement `QueryLibraryPanel.svelte`**

```svelte
<script lang="ts">
  /* global HTMLElement, HTMLInputElement, KeyboardEvent, navigator */
  import { tick } from 'svelte';

  import { relativeTime, sqlPreview } from '../lib/queries/display.js';
  import type { QueryLibrary } from '../lib/queries/library.js';
  import type { LibraryNotice } from '../lib/queries/notice.js';
  import type { SavedQuery } from '../lib/queries/types.js';
  import { popoverMenu } from '../lib/ui/menu.js';
  import Icon from './ui/Icon.svelte';

  interface Props {
    library: QueryLibrary;
    format: string;
    onload: (sql: string, saved: SavedQuery | null) => void;
    onsaverecent: (sql: string) => void;
    onnotice: (notice: LibraryNotice) => void;
  }

  let { library, format, onload, onsaverecent, onnotice }: Props = $props();

  let version = $state(0);
  $effect(() => library.subscribe(() => (version += 1)));

  const saved = $derived.by(() => {
    void version;
    return library.savedFor(format);
  });
  const history = $derived.by(() => {
    void version;
    return library.historyFor(format);
  });
  const persistHistory = $derived.by(() => {
    void version;
    return library.settings.persistHistory;
  });

  let menuFor = $state<string | null>(null);
  let menuElement = $state<HTMLElement | null>(null);
  let renaming = $state<string | null>(null);
  let renameValue = $state('');
  let renameInput = $state<HTMLInputElement | null>(null);
  /** Relative times are computed against this; refreshed whenever the list changes. */
  const now = $derived.by(() => {
    void version;
    return Date.now();
  });

  $effect(() => {
    const element = menuElement;
    if (menuFor === null || !element) return;
    return popoverMenu(element, () => (menuFor = null));
  });

  async function startRename(query: SavedQuery): Promise<void> {
    menuFor = null;
    renaming = query.id;
    renameValue = query.name;
    await tick();
    renameInput?.select();
    renameInput?.focus();
  }

  function renameKeydown(event: KeyboardEvent, query: SavedQuery): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      library.update(query.id, { name: renameValue });
      renaming = null;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      renaming = null;
    }
  }

  function remove(query: SavedQuery): void {
    menuFor = null;
    const removed = library.remove(query.id);
    if (removed) onnotice({ message: `Deleted ${removed.name}`, undo: () => library.restore(removed) });
  }

  async function copy(query: SavedQuery): Promise<void> {
    menuFor = null;
    try {
      await navigator.clipboard.writeText(query.sql);
      onnotice({ message: `Copied ${query.name}` });
    } catch {
      onnotice({ message: 'Copying needs clipboard permission.' });
    }
  }

  function outcome(status: 'ok' | 'error', rowCount: number | null): string {
    if (status === 'error') return 'error';
    return rowCount === null ? 'ok' : `ok · ${rowCount.toLocaleString()} rows`;
  }
</script>

<section class="explorer-section query-section" aria-labelledby="saved-queries-heading">
  <div class="query-library-heading">
    <h3 id="saved-queries-heading">Saved queries</h3>
    <!-- Import and Export controls are added in Task 7. -->
  </div>
  {#if !library.persistent}
    <p class="query-library-note">This browser is blocking storage — queries last until the tab closes.</p>
  {/if}
  {#if saved.length === 0}
    <p class="query-library-empty">Save a query to keep it for later visits.</p>
  {:else}
    <ul class="query-list">
      {#each saved as query (query.id)}
        <li class="saved-query-row">
          {#if renaming === query.id}
            <input
              bind:this={renameInput}
              bind:value={renameValue}
              class="saved-query-rename"
              type="text"
              maxlength="200"
              aria-label={`Rename ${query.name}`}
              onkeydown={(event) => renameKeydown(event, query)}
              onblur={() => (renaming = null)}
            />
          {:else}
            <button type="button" title={query.sql} onclick={() => onload(query.sql, query)}>
              <span class="query-glyph" aria-hidden="true"><Icon name="arrow" /></span>
              <span class="truncate">{query.name}</span>
            </button>
          {/if}
          <div class="saved-query-menu">
            <button
              class="saved-query-more"
              type="button"
              aria-label={`Actions for ${query.name}`}
              aria-expanded={menuFor === query.id}
              onclick={() => (menuFor = menuFor === query.id ? null : query.id)}>⋯</button
            >
            {#if menuFor === query.id}
              <div bind:this={menuElement} class="saved-query-options" role="menu" aria-label={`${query.name} actions`}>
                <button type="button" role="menuitem" onclick={() => startRename(query)}>Rename</button>
                <button type="button" role="menuitem" onclick={() => copy(query)}>Copy SQL</button>
                <button type="button" role="menuitem" onclick={() => remove(query)}>Delete</button>
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<section class="explorer-section query-section" aria-labelledby="recent-queries-heading">
  <details class="recent-queries">
    <summary><h3 id="recent-queries-heading">Recent</h3></summary>
    {#if history.length > 0}
      <ul class="query-list recent-list">
        {#each history as entry (entry.id)}
          <li class="recent-row">
            <button type="button" title={entry.sql} onclick={() => onload(entry.sql, null)}>
              <span class="truncate recent-sql">{sqlPreview(entry.sql)}</span>
              <span class="recent-meta">{relativeTime(entry.ranAt, now)} · {outcome(entry.status, entry.rowCount)}</span>
            </button>
            <button
              class="recent-save"
              type="button"
              aria-label={`Save ${sqlPreview(entry.sql)}`}
              onclick={() => onsaverecent(entry.sql)}>Save</button
            >
          </li>
        {/each}
      </ul>
    {/if}
    <div class="recent-controls">
      <label class="recent-keep">
        <input
          type="checkbox"
          checked={persistHistory}
          onchange={(event) => library.setPersistHistory((event.currentTarget as HTMLInputElement).checked)}
        />
        <span>Keep history after this tab closes</span>
      </label>
      <p class="query-library-note">Stored only in this browser. SQL may contain sensitive values.</p>
      <button class="button button-secondary button-compact" type="button" onclick={() => library.clearHistory()}>
        Clear history
      </button>
    </div>
  </details>
</section>
```

Accessible-name notes the tests depend on: the Saved `<section>` is named by its heading
(`Saved queries`) and the Recent `<section>` by `Recent`, so both resolve as `role="region"`.
The Recent `<details>` starts closed; Testing Library still finds content inside a closed
`<details>` in jsdom, and e2e opens it by clicking the `Recent` summary.

Styles: reuse the Explorer's `.query-list` button styles (they are defined in `Explorer.svelte`
— move the `.query-list` rules into a `:global(.query-list ...)` block there, or duplicate the
minimal rules here). Style `.saved-query-options` exactly like `.viewer-options` in
`ViewerMenu.svelte` (absolute, `--layer-popover`, raised surface, overlay shadow, full-width
left-aligned items with hover/focus background), with `.saved-query-menu { position: relative }`.
`.recent-meta` and `.query-library-note` use `--text-sm` and `--color-text-muted`.

- [ ] **Step 4: Render it from the Explorer**

In `Explorer.svelte` add the imports, the four optional props (defaults: `library = null`,
`onloadquery = () => undefined`, `onsaverecent = () => undefined`, `onnotice = () => undefined`),
and directly above `{#if session.queries.length > 0}`:

```svelte
  {#if library && session.format}
    <QueryLibraryPanel {library} format={session.format.id} onload={onloadquery} {onsaverecent} {onnotice} />
  {/if}
```

- [ ] **Step 5: Wire the Workbench: notices, recent-to-save, history recording**

1. Imports: `import type { LibraryNotice } from '../lib/queries/notice.js';` and
   `import { STORAGE_ERROR_MESSAGE } from '../lib/queries/library.js';`.

2. Notices:

   ```ts
   let libraryNotice = $state<LibraryNotice | null>(null);
   let noticeTimer: ReturnType<typeof setTimeout> | undefined;
   function showLibraryNotice(notice: LibraryNotice): void {
     clearTimeout(noticeTimer);
     libraryNotice = notice;
     noticeTimer = setTimeout(() => (libraryNotice = null), 8000);
   }
   $effect(() => {
     const library = queryLibrary;
     if (!library) return;
     return library.subscribe((event) => {
       if (event.type === 'storage-error') showLibraryNotice({ message: STORAGE_ERROR_MESSAGE });
     });
   });
   $effect(() => () => clearTimeout(noticeTimer));
   ```

   Add `setTimeout, clearTimeout` to the file's `/* global */` comment. In `.query-notices-scroll`,
   after the coverage notice:

   ```svelte
            {#if libraryNotice}
              <div class="format-notice" role="status" aria-label="Query library notice">
                <span>{libraryNotice.message}</span>
                {#if libraryNotice.undo}
                  <button
                    class="button button-secondary button-compact"
                    type="button"
                    onclick={() => {
                      libraryNotice?.undo?.();
                      libraryNotice = null;
                    }}>Undo</button
                  >
                {/if}
              </div>
            {/if}
   ```

3. Saving from Recent:

   ```ts
   function saveRecent(sql: string): void {
     closeDrawer();
     loadQuery(sql, null);
     saveOpen = true;
   }
   ```

   `loadQuery` sets `saveOpen = false`; set it to `true` after the call as shown.

4. History recording — replace `run`:

   ```ts
   /**
    * The user run awaiting its outcome. Plain (not reactive): it is only read when the settle
    * count moves. The automatic overview query bypasses `run`, so it is never recorded.
    */
   let pendingRun: { format: string; sql: string; settleCount: number } | null = null;

   function run(sql: string): void {
     if (!sql.trim()) return;
     draftSql = sql;
     pendingRun =
       queryLibrary && session.format
         ? { format: session.format.id, sql, settleCount: session.resultSettleCount }
         : null;
     perform(() => controller.runQuery(sql));
   }

   $effect(() => {
     const settled = session.resultSettleCount;
     const pending = pendingRun;
     const library = queryLibrary;
     if (!pending || !library || settled <= pending.settleCount) return;
     pendingRun = null;
     const failed = session.queryError !== null;
     const result = session.result;
     untrack(() =>
       library.recordRun({
         format: pending.format,
         sql: pending.sql,
         status: failed ? 'error' : 'ok',
         rowCount: !failed && result?.complete ? result.loadedRows : null,
       }),
     );
   });
   ```

   A second `run` before the first settles replaces `pendingRun`, so only the newest run is
   recorded (Review Focus 1).

5. `<Explorer>`: add `library={queryLibrary}`, `onloadquery={loadQueryFromCatalog}`,
   `onsaverecent={saveRecent}`, `onnotice={showLibraryNotice}`.

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter @byteql/web exec vitest run src/components`
Expected: PASS, including the previously-todo "forgets the loaded saved query" test.

- [ ] **Step 7: Gate and commit**

Full web gate as in Task 5 Step 8.

```bash
git add apps/web/src/lib/queries/notice.ts apps/web/src/components/QueryLibraryPanel.svelte \
  apps/web/src/components/QueryLibraryPanel.test.ts apps/web/src/components/Explorer.svelte \
  apps/web/src/components/Workbench.svelte apps/web/src/components/Workbench.test.ts
git commit -m "feat(web): list saved queries and recent runs in the explorer"
```

---

### Task 7: Import and export in the Saved section

**Files:**

- Create: `apps/web/src/lib/queries/download.ts`
- Test: `apps/web/src/lib/queries/download.test.ts`
- Modify: `apps/web/src/components/QueryLibraryPanel.svelte` (heading actions)
- Test: `apps/web/src/components/QueryLibraryPanel.test.ts`

**Interfaces:**

- Consumes: `QueryLibrary.importQueries`, `QueryLibrary.exportFile`, `ImportReport` (Task 4);
  `decodeQueryFile`, `parseQueryFile`, `QueryFileError`, `ParsedQueryFile` (Task 3); `fileStem`.
- Produces: `function saveTextFile(filename: string, text: string): Promise<'saved' | 'cancelled'>`;
  `function importReportMessage(report: ImportReport): string` (in `display.ts`).
- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/queries/download.test.ts`:

```ts
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveTextFile } from './download.js';

describe('saveTextFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('writes through a save handle when the picker exists', async () => {
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    vi.stubGlobal('showSaveFilePicker', vi.fn(async () => ({ createWritable: async () => ({ write, close }) })));
    expect(await saveTextFile('a.sql', 'select 1')).toBe('saved');
    expect(write).toHaveBeenCalledWith('select 1');
    expect(close).toHaveBeenCalled();
  });

  it('reports a dismissed picker as cancelled', async () => {
    vi.stubGlobal('showSaveFilePicker', vi.fn(async () => Promise.reject(new DOMException('no', 'AbortError'))));
    expect(await saveTextFile('a.sql', 'select 1')).toBe('cancelled');
  });

  it('falls back to an object-URL download and revokes it later', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:local');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    expect(await saveTextFile('a.sql', 'select 1')).toBe('saved');
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local');
  });
});
```

Add to `display.test.ts`:

```ts
import { importReportMessage } from './display.js';

describe('importReportMessage', () => {
  it('names only the non-zero counts', () => {
    expect(importReportMessage({ imported: 1, skipped: 0, rejected: 0 })).toBe('Imported 1 query');
    expect(importReportMessage({ imported: 7, skipped: 2, rejected: 1 })).toBe(
      'Imported 7 queries, skipped 2 duplicates, rejected 1',
    );
    expect(importReportMessage({ imported: 0, skipped: 1, rejected: 0 })).toBe(
      'Imported 0 queries, skipped 1 duplicate',
    );
  });
});
```

Add to `QueryLibraryPanel.test.ts`:

```ts
const sqlFile = (text: string, name = 'lib.sql'): File => new File([text], name, { type: 'text/plain' });

  it('imports a file and reports the counts', async () => {
    const { library, props } = await setup();
    render(QueryLibraryPanel, props);
    const input = screen.getByLabelText('Import queries file');
    await fireEvent.change(input, {
      target: { files: [sqlFile('-- byteql-queries v1\n-- format: pcap\n\n-- name: A\nselect 1\n')] },
    });
    await vi.waitFor(() => expect(library.savedFor('pcap')).toHaveLength(1));
    expect(props.onnotice).toHaveBeenCalledWith({ message: 'Imported 1 query' });
  });

  it('asks before importing a file saved for another format', async () => {
    const { library, props } = await setup('midi');
    render(QueryLibraryPanel, props);
    await fireEvent.change(screen.getByLabelText('Import queries file'), {
      target: { files: [sqlFile('-- format: pcap\n-- name: A\nselect 1\n')] },
    });
    const question = await screen.findByText('These queries were saved for pcap. Import them into midi anyway?');
    expect(library.savedFor('midi')).toEqual([]);
    await fireEvent.click(within(question.parentElement!).getByRole('button', { name: 'Import' }));
    expect(library.savedFor('midi')).toHaveLength(1);
  });

  it('rejects a file that is not UTF-8 without importing anything', async () => {
    const { library, props } = await setup();
    render(QueryLibraryPanel, props);
    await fireEvent.change(screen.getByLabelText('Import queries file'), {
      target: { files: [new File([new Uint8Array([0x73, 0xff])], 'bad.sql')] },
    });
    await vi.waitFor(() =>
      expect(props.onnotice).toHaveBeenCalledWith({ message: 'The file is not valid UTF-8 text.' }),
    );
    expect(library.savedFor('pcap')).toEqual([]);
  });

  it('disables Export for an empty library', async () => {
    const { props } = await setup();
    render(QueryLibraryPanel, props);
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true);
  });
```

`fireEvent.change` with `target: { files }` sets the `files` property on the input in jsdom; if
jsdom rejects assigning `files`, use `Object.defineProperty(input, 'files', { value: [file] })`
followed by `await fireEvent.change(input)`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/queries/download.test.ts src/lib/queries/display.test.ts src/components/QueryLibraryPanel.test.ts`
Expected: FAIL — `download.ts` missing, `importReportMessage` missing, no import input.

- [ ] **Step 3: Implement `download.ts` and `importReportMessage`**

`apps/web/src/lib/queries/download.ts`:

```ts
interface SaveHandle {
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveHandle>;

/** Object URLs outlive the click, so the browser can finish the download before revocation. */
const REVOKE_AFTER_MS = 60_000;

/** Saves a small text file locally: a save handle when available, otherwise a download link. */
export async function saveTextFile(filename: string, text: string): Promise<'saved' | 'cancelled'> {
  const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: 'SQL queries', accept: { 'text/plain': ['.sql'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return 'saved';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      throw error;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  return 'saved';
}
```

Append to `display.ts`:

```ts
import type { ImportReport } from './library.js';

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export function importReportMessage(report: ImportReport): string {
  const parts = [`Imported ${plural(report.imported, 'query', 'queries')}`];
  if (report.skipped > 0) parts.push(`skipped ${plural(report.skipped, 'duplicate', 'duplicates')}`);
  if (report.rejected > 0) parts.push(`rejected ${report.rejected}`);
  return parts.join(', ');
}
```

`library.ts` imports `display.ts` and `display.ts` would now import a type from `library.ts`;
that is a type-only import (`import type`), which is erased and creates no runtime cycle.

- [ ] **Step 4: Add the Import/Export controls to the panel**

In `QueryLibraryPanel.svelte`, add the imports (`saveTextFile`, `decodeQueryFile`,
`parseQueryFile`, `QueryFileError`, `ParsedQueryFile`, `fileStem`, `importReportMessage`) and:

```ts
  let fileInput = $state<HTMLInputElement | null>(null);
  /** A parsed file waiting for confirmation because it names another format. */
  let pendingImport = $state<ParsedQueryFile | null>(null);

  function finishImport(parsed: ParsedQueryFile): void {
    pendingImport = null;
    onnotice({ message: importReportMessage(library.importQueries(format, parsed)) });
  }

  async function importFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const text = decodeQueryFile(new Uint8Array(await file.arrayBuffer()));
      const parsed = parseQueryFile(text, fileStem(file.name));
      if (parsed.format !== null && parsed.format !== format) pendingImport = parsed;
      else finishImport(parsed);
    } catch (error) {
      onnotice({ message: error instanceof QueryFileError ? error.message : 'The file could not be read.' });
    }
  }

  async function exportLibrary(): Promise<void> {
    const { filename, text } = library.exportFile(format);
    try {
      if ((await saveTextFile(filename, text)) === 'saved') {
        const count = saved.length;
        onnotice({ message: `Exported ${count} ${count === 1 ? 'query' : 'queries'}` });
      }
    } catch {
      onnotice({ message: 'The queries could not be exported.' });
    }
  }
```

`decodeQueryFile` checks the size before decoding, but check `file.size > QUERY_FILE_MAX_BYTES`
before calling `arrayBuffer()` too, so an oversized file is never read into memory (report
`The file is larger than 1 MiB.`).

Replace the Task 6 placeholder comment in `.query-library-heading` with:

```svelte
    <div class="query-library-actions">
      <button class="button button-secondary button-compact" type="button" onclick={() => fileInput?.click()}>
        Import
      </button>
      <button
        class="button button-secondary button-compact"
        type="button"
        disabled={saved.length === 0}
        onclick={exportLibrary}>Export</button
      >
      <input
        bind:this={fileInput}
        class="visually-hidden"
        type="file"
        accept=".sql,text/plain"
        aria-label="Import queries file"
        onchange={importFile}
      />
    </div>
```

Below the heading, before the storage note:

```svelte
  {#if pendingImport}
    <div class="query-import-confirm" role="group" aria-label="Confirm import">
      <p>These queries were saved for {pendingImport.format}. Import them into {format} anyway?</p>
      <button class="button button-primary button-compact" type="button" onclick={() => finishImport(pendingImport!)}>
        Import
      </button>
      <button class="button button-secondary button-compact" type="button" onclick={() => (pendingImport = null)}>
        Cancel
      </button>
    </div>
  {/if}
```

Add `Event` to the `/* global */` comment. If there is no global `.visually-hidden` utility in
`apps/web/src/app.css`, check how `Workbench.svelte` hides its `Open file input` and reuse that
class instead.

In the Empty state, make "Import" an action too: render
`<button type="button" class="link-button" onclick={() => fileInput?.click()}>Import</button>`
after the empty-state sentence (reuse an existing link-style button class if one exists, otherwise
`button-secondary button-compact`).

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/queries src/components/QueryLibraryPanel.test.ts`
Expected: PASS.

- [ ] **Step 6: Gate and commit**

Full web gate as in Task 5 Step 8.

```bash
git add apps/web/src/lib/queries/download.ts apps/web/src/lib/queries/download.test.ts \
  apps/web/src/lib/queries/display.ts apps/web/src/lib/queries/display.test.ts \
  apps/web/src/components/QueryLibraryPanel.svelte apps/web/src/components/QueryLibraryPanel.test.ts
git commit -m "feat(web): import and export saved queries as annotated .sql files"
```

---

### Task 8: Browser acceptance and privacy coverage

**Files:**

- Create: `apps/web/e2e/saved-queries.spec.ts`
- Modify: `apps/web/e2e/privacy.spec.ts`

**Interfaces:**

- Consumes: the UI names from Tasks 5–7 (`Save query`, `Query name`, `Save`, region
  `Saved queries`, `Recent` summary, checkbox `Keep history after this tab closes`, `Export`,
  `Import queries file`); `waitForAppReady`, `openFixture`, `runSql` from `e2e/support/app.ts`;
  fixtures `sample.pcap` and `sample.pcapng` in `e2e/fixtures/`.
- Produces: nothing consumed later.
- [ ] **Step 1: Write the acceptance spec**

`apps/web/e2e/saved-queries.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';

import { openFixture, runSql, waitForAppReady } from './support/app.js';

interface StoredQuery {
  format: string;
  name: string;
  sql: string;
}

/**
 * Reads one object store of the app's query database. Only call after the app is ready: the app
 * creates the database at startup, and opening a missing database here would create it at
 * version 1 with no stores and break the app's own upgrade.
 */
async function readStore<T>(page: Page, store: 'saved' | 'history'): Promise<T[]> {
  return page.evaluate(
    (name) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open('byteql-queries');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction(name).objectStore(name).getAll();
          request.onsuccess = () => {
            resolve(request.result as T[]);
            db.close();
          };
          request.onerror = () => reject(request.error);
        };
      }),
    store,
  );
}

async function fillEditor(page: Page, sql: string): Promise<void> {
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill(sql);
}

async function saveQuery(page: Page, sql: string, name: string): Promise<void> {
  await fillEditor(page, sql);
  await page.getByRole('button', { name: 'Save query' }).click();
  await page.getByLabel('Query name').fill(name);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Saved queries' }).getByRole('button', { name })).toBeVisible();
}

async function openRecent(page: Page): Promise<void> {
  const details = page.locator('details.recent-queries');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
}

test('a saved query survives a reload and runs on a different capture of the same format', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
  await openFixture(page, 'sample.pcap');
  await saveQuery(page, 'select count(*) as packet_total from packets', 'Packet count');

  await page.reload();
  await waitForAppReady(page);
  await openFixture(page, 'sample.pcapng');
  await page.getByRole('region', { name: 'Saved queries' }).getByRole('button', { name: 'Packet count' }).click();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText('packet_total');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('columnheader', { name: /packet_total/u })).toBeVisible();
});

test('history persists only while opted in, and opting out empties storage', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
  await openFixture(page, 'sample.pcap');

  await runSql(page, 'select 1 as not_kept');
  await expect(page.getByRole('columnheader', { name: /not_kept/u })).toBeVisible();
  expect(await readStore(page, 'history')).toEqual([]);

  await openRecent(page);
  await page.getByRole('checkbox', { name: 'Keep history after this tab closes' }).check();
  await runSql(page, 'select 2 as kept');
  await expect(page.getByRole('columnheader', { name: /kept/u })).toBeVisible();
  await expect.poll(async () => (await readStore<StoredQuery>(page, 'history')).map((entry) => entry.sql)).toContain(
    'select 2 as kept',
  );

  await page.reload();
  await waitForAppReady(page);
  await openFixture(page, 'sample.pcap');
  await openRecent(page);
  await expect(page.getByRole('region', { name: 'Recent' }).getByText('select 2 as kept')).toBeVisible();

  await page.getByRole('checkbox', { name: 'Keep history after this tab closes' }).uncheck();
  await expect.poll(() => readStore(page, 'history')).toEqual([]);
});

test('export then import into a fresh profile reproduces the library', async ({ browser }, testInfo) => {
  const source = await browser.newContext();
  const page = await source.newPage();
  await page.addInitScript(() => Reflect.deleteProperty(window, 'showSaveFilePicker'));
  await page.goto('/');
  await waitForAppReady(page);
  await openFixture(page, 'sample.pcap');
  await saveQuery(page, 'select src, count(*) from ip group by 1', 'Top talkers');
  await saveQuery(page, 'select 1\n-- name: tricky marker line', 'Tricky');

  const pending = page.waitForEvent('download');
  await page.getByRole('region', { name: 'Saved queries' }).getByRole('button', { name: 'Export' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('byteql-pcap-queries.sql');
  const path = testInfo.outputPath('byteql-pcap-queries.sql');
  await download.saveAs(path);
  const original = await readStore<StoredQuery>(page, 'saved');
  await source.close();

  const fresh = await browser.newContext();
  const next = await fresh.newPage();
  await next.goto('/');
  await waitForAppReady(next);
  await openFixture(next, 'sample.pcap');
  await next.getByLabel('Import queries file').setInputFiles(path);
  await expect(next.getByRole('status', { name: 'Query library notice' })).toContainText('Imported 2 queries');
  const imported = await readStore<StoredQuery>(next, 'saved');
  const shape = (queries: StoredQuery[]) => queries.map(({ format, name, sql }) => ({ format, name, sql }));
  expect(shape(imported)).toEqual(shape(original));
  await fresh.close();
});
```

- [ ] **Step 2: Extend the privacy spec**

In `apps/web/e2e/privacy.spec.ts`, after the
`await runSql(page, \`select * from events limit 1 -- ${sqlSentinel}\`);` block and its row
assertions, insert (keep `testInfo` in the test signature: change
`async ({ page }) =>` to `async ({ page }, testInfo) =>`):

```ts
  // Saved queries and opted-in history are local storage only: saving, persisting history,
  // exporting and importing must not produce a request or carry the SQL sentinel anywhere.
  await page.locator('details.recent-queries summary').click();
  await page.getByRole('checkbox', { name: 'Keep history after this tab closes' }).check();
  await page.getByRole('button', { name: 'Save query' }).click();
  await page.getByLabel('Query name').fill('Private sentinel query');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const queriesExport = page.waitForEvent('download');
  await page.getByRole('region', { name: 'Saved queries' }).getByRole('button', { name: 'Export' }).click();
  const queriesPath = testInfo.outputPath('privacy-queries.sql');
  await (await queriesExport).saveAs(queriesPath);
  await page.getByLabel('Import queries file').setInputFiles(queriesPath);
  await expect(page.getByRole('status', { name: 'Query library notice' })).toContainText('skipped 1 duplicate');
```

The editor still holds the sentinel SQL at that point, so the saved and exported query contain
the sentinel; the existing final assertions then prove no request carried it.

- [ ] **Step 3: Build and run the browser suites**

Run from the repo root: `pnpm build`, then
`pnpm --filter @byteql/web test:e2e -- saved-queries.spec.ts privacy.spec.ts`
Expected: PASS (4 tests). If the history test's reload races the library's write-behind, the
`expect.poll` on the stored history already waits for the write before reloading; do not add
fixed sleeps.

- [ ] **Step 4: Run the whole e2e suite once**

Run: `pnpm --filter @byteql/web test:e2e`
Expected: PASS. The new Explorer sections change the catalog height; if a layout or screenshot
spec regresses, fix the spec's expectation only when the new layout is correct, and say so in the
commit body.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/saved-queries.spec.ts apps/web/e2e/privacy.spec.ts
git commit -m "test(web): cover saved queries and history in the browser and privacy suites"
```

---

### Task 9: Documentation and final gate

**Files:**

- Modify: `docs/privacy.md`, `ROADMAP.md`, `AGENTS.md`,
  `docs/superpowers/specs/2026-09-24-saved-queries-design.md`

**Interfaces:** none.

- [ ] **Step 1: `docs/privacy.md`**

Add after "## Local export data":

```markdown
## Local query storage

Saved queries and query-history settings live in the origin's IndexedDB database
`byteql-queries`. Saving a query is an explicit action; the SQL and its name stay in this browser
and are never sent anywhere. Every run is kept in memory for the current tab; runs are written to
IndexedDB only while **Keep history after this tab closes** is on, capped at the most recent 100
across formats. Turning that setting off deletes the stored history in the same operation.
**Clear history** removes history from memory and storage; deleting a saved query removes it.
Clearing the site's data removes everything, and exporting a format's queries as a `.sql` file is
the only backup. Other tabs are told only that the library changed (a `BroadcastChannel` message
with no SQL). When IndexedDB is unavailable the library works in memory for the tab and says so.
The post-readiness privacy test saves, persists, exports, and imports a query containing its SQL
sentinel and still requires zero request events.
```

- [ ] **Step 2: `ROADMAP.md`**

Change the heading to `### 4. Add saved queries and opt-in local history — done (2026-MM-DD)`
using the actual completion date, and replace "Make repeat investigations easier with:" list
intro with a short status paragraph plus evidence and design links:

```markdown
Named queries are saved per format and listed beside the pack's example queries; recent runs are
kept per tab and persisted only when the user opts in; a format's library exports to and imports
from one annotated `.sql` file. Everything is stored in the browser's IndexedDB and never sent.

Evidence: [saved-queries e2e](apps/web/e2e/saved-queries.spec.ts) and
[privacy e2e](apps/web/e2e/privacy.spec.ts).
Design: [saved queries design](docs/superpowers/specs/2026-09-24-saved-queries-design.md).
```

- [ ] **Step 3: `AGENTS.md`**

Update `## Status (…)` to the completion date; add a bullet after the pcapng follow-ups:

```markdown
- **Saved queries and opt-in history: shipped YYYY-MM-DD.** `apps/web/src/lib/queries/` (zero
  Svelte): `QueryStore` over IndexedDB `byteql-queries` with an in-memory fallback,
  `QueryLibrary` (per-format views, write-behind persistence, history dedup/trim, the
  persistence switch that deletes stored history when turned off), and the annotated `.sql`
  codec. UI: `SaveQueryPopover` (toolbar + `Ctrl/⌘+S`), `QueryLibraryPanel` (Saved + Recent in
  the Explorer). Design: `docs/superpowers/specs/2026-09-24-saved-queries-design.md`.
```

Change the **Next** bullet to ROADMAP #5 (TCP connection identity). In the repo map's `apps/web`
line, add `src/lib/queries/` (saved queries and history).

- [ ] **Step 4: Spec status and implementation notes**

In the spec, set `Status: Implemented YYYY-MM-DD.` and add a final `## Implementation notes`
section recording what differed from the design, at minimum:

- The store interface is put-based (`putSaved`, `putHistory(entry, limit)`) with policy in
  `QueryLibrary`, rather than the design's `save/update/delete` store verbs.
- The history store's index is `ranAt` (not `[format, ranAt]`); per-format filtering is in memory
  over at most 100 entries.
- Library notices (delete/undo, import results, storage errors) render in the query-notices row
  as a polite `role="status"` region, not in the status bar.
- The automatic overview query that runs when a file opens is not recorded in history; only runs
  the user starts are.
- Anything else discovered during implementation.
- [ ] **Step 5: Format and final gate**

Run `rumdl fmt` on each edited Markdown file, then from the repo root:
`pnpm check`, `pnpm lint`, `pnpm -r test -- --run`, `pnpm --filter @byteql/web check:bundle`.
Expected: all green; `check:bundle` reports no external URLs.

- [ ] **Step 6: Commit**

```bash
git add docs/privacy.md ROADMAP.md AGENTS.md docs/superpowers/specs/2026-09-24-saved-queries-design.md
git commit -m "docs: record saved queries and opt-in local history"
```
