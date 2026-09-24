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
      openIndexedDbQueryStore({
        indexedDB: undefined as unknown as IDBFactory,
        channelName: uniqueChannel(),
      }),
    ).rejects.toThrow(/IndexedDB is unavailable/u);
  });
});
