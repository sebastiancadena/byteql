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
      await store.setSettings({ persistHistory: true, historyLimit: 100 });
      await store.putHistory(historyEntry({ id: 'h1', ranAt: 1 }), 2);
      await store.putHistory(historyEntry({ id: 'h2', ranAt: 2, format: 'midi' }), 2);
      await store.putHistory(historyEntry({ id: 'h3', ranAt: 3 }), 2);
      expect((await store.listHistory()).map((entry) => entry.id)).toEqual(['h3', 'h2']);
    });

    it('replaces a history entry with the same id instead of adding one', async () => {
      await store.setSettings({ persistHistory: true, historyLimit: 100 });
      await store.putHistory(historyEntry({ id: 'h1', ranAt: 1 }), 10);
      await store.putHistory(historyEntry({ id: 'h1', ranAt: 5, status: 'error', rowCount: null }), 10);
      expect(await store.listHistory()).toEqual([
        historyEntry({ id: 'h1', ranAt: 5, status: 'error', rowCount: null }),
      ]);
    });

    it('clears history without touching saved queries', async () => {
      await store.setSettings({ persistHistory: true, historyLimit: 100 });
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

    it('writes nothing to history while stored persistence is off', async () => {
      await store.putHistory(historyEntry(), 10);
      expect(await store.listHistory()).toEqual([]);
    });
  });
}
