import { describe, expect, it, vi } from 'vitest';

import {
  QueryLibrary,
  STORAGE_ERROR_MESSAGE,
  STORAGE_READ_ERROR_MESSAGE,
  type LibraryEvent,
} from './library.js';
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
    expect(parseQueryFile(text, 'x')).toEqual({
      format: 'pcap',
      queries: [{ name: 'A', sql: 'select 1' }],
      rejected: [],
    });
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

    await store.putSaved({
      id: 'x',
      format: 'pcap',
      name: 'From B',
      sql: 'select 9',
      createdAt: 1,
      updatedAt: 1,
    });
    remote!('saved');
    await library.flush();

    expect(library.savedFor('pcap').map((query) => query.name)).toEqual(['From B']);
    expect(events).toContainEqual({ type: 'changed' });
  });
});

describe('QueryLibrary races between local mutations and reloads', () => {
  function mockRemote(store: MemoryQueryStore) {
    let remote: ((change: 'saved' | 'history' | 'settings') => void) | null = null;
    vi.spyOn(store, 'subscribe').mockImplementation((listener) => {
      remote = listener;
      return () => undefined;
    });
    return (change: 'saved' | 'history' | 'settings') => remote!(change);
  }

  it('keeps a local save made right after a remote notification instead of losing it to a stale reload', async () => {
    const store = new MemoryQueryStore();
    const notify = mockRemote(store);
    const { library } = await openLibrary(store);

    notify('saved');
    const saved = library.save({ format: 'pcap', name: 'A', sql: 'select 1' });
    await library.flush();

    expect(library.find(saved.id)).not.toBeNull();
    expect((await store.listSaved()).map((query) => query.id)).toContain(saved.id);
  });

  it('does not let a stale remote settings reload resurrect a newer local turn-off', async () => {
    const store = new MemoryQueryStore();
    const notify = mockRemote(store);
    const { library } = await openLibrary(store);
    library.setPersistHistory(true);
    await library.flush();

    // The store still says persistHistory: true when the notification fires; the local turn-off
    // happens right after, before the queued reload gets a chance to run.
    notify('settings');
    library.setPersistHistory(false);
    await library.flush();

    expect(library.settings.persistHistory).toBe(false);

    library.recordRun(run());
    await library.flush();
    expect(await store.listHistory()).toEqual([]);
  });

  it('reports a storage error instead of silently dropping a failed reload', async () => {
    const store = new MemoryQueryStore();
    const notify = mockRemote(store);
    const { library } = await openLibrary(store);
    vi.spyOn(store, 'listSaved').mockRejectedValueOnce(new Error('boom'));
    const events: LibraryEvent[] = [];
    library.subscribe((event) => events.push(event));

    notify('saved');
    await library.flush();

    expect(events).toContainEqual({ type: 'storage-error', message: STORAGE_READ_ERROR_MESSAGE });
  });
});
