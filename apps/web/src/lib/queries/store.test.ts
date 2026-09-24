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
