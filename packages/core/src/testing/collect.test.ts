import { describe, expect, it } from 'vitest';

import { projectedTableToArrow, tableToIpc } from '../arrow/build.js';
import type { FormatPack } from '../protocol.js';
import { collectSource } from './collect.js';

const batch = (ids: bigint[]) =>
  tableToIpc(
    projectedTableToArrow({ name: 'a', rowCount: ids.length, columns: { id: ids }, types: { id: 'int64' } }),
  );

const pack: FormatPack = {
  id: 'fake',
  title: 'Fake',
  probe: () => 1,
  queries: [],
  schemas: () => [
    { name: 'a', columns: [{ name: 'id', type: 'int64', nullable: false }] },
    { name: 'empty', columns: [{ name: 'x', type: 'utf8', nullable: true }] },
  ],
  open: () => {
    const queue = [
      { table: 'a', ipc: batch([1n]), rowCount: 1 },
      { table: 'a', ipc: batch([2n, 3n]), rowCount: 2 },
    ];
    return {
      nextBatch: async () => queue.shift() ?? null,
      finish: () => ({ issues: [], capabilities: {} }),
    };
  },
};

describe('collectSource', () => {
  it('merges same-table batches and backfills declared empty tables', async () => {
    const result = await collectSource(pack, new Uint8Array());
    const names = result.tables.map((t) => t.name).sort();
    expect(names).toEqual(['a', 'empty']);
    expect(result.tables.find((t) => t.name === 'a')!.rowCount).toBe(3);
    expect(result.tables.find((t) => t.name === 'empty')!.rowCount).toBe(0);
    expect(result.tables.find((t) => t.name === 'a')!.columns).toEqual([
      { name: 'id', type: 'Int64', nullable: false },
    ]);
  });
});
