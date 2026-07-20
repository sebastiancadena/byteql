import { ipcToTable } from '@byteql/core';
import type { FormatPack } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import {
  buildFilesTableIpc,
  dedupeDisplayNames,
  mergeTableOverviews,
  planBatch,
  type BatchEntry,
} from './batch.js';

const fakePack = (id: string, magic: number): FormatPack => ({
  id,
  title: `${id} title`,
  probe: (head) => (head[0] === magic ? 1 : null),
  schemas: () => [],
  open: () => {
    throw new Error('not used');
  },
  queries: [],
});

const entry = (name: string, firstByte: number): BatchEntry => {
  const blob = new Blob([new Uint8Array([firstByte, 0, 0, 0])]);
  return { name, size: blob.size, blob };
};

const PACKS = [fakePack('midi', 0x4d), fakePack('pcap', 0xd4)];

describe('dedupeDisplayNames', () => {
  it('suffixes duplicates before the extension and avoids re-collisions', () => {
    expect(dedupeDisplayNames(['a.pcap', 'a.pcap', 'a (2).pcap', 'a.pcap'])).toEqual([
      'a.pcap',
      'a (2).pcap',
      'a (2).pcap (2)',
      'a (3).pcap',
    ]);
  });

  it('handles extensionless names', () => {
    expect(dedupeDisplayNames(['dump', 'dump'])).toEqual(['dump', 'dump (2)']);
  });
});

describe('planBatch', () => {
  it('elects the first recognized format and skips mismatches and unknowns', async () => {
    const plan = await planBatch(
      [entry('junk.bin', 0x00), entry('a.pcap', 0xd4), entry('b.mid', 0x4d), entry('c.pcap', 0xd4)],
      PACKS,
    );
    expect(plan.formatId).toBe('pcap');
    expect(plan.formatTitle).toBe('pcap title');
    expect(plan.files.map((file) => file.status)).toEqual(['skipped', 'ok', 'skipped', 'ok']);
    expect(plan.files[0]!.error).toMatch(/No registered format/u);
    expect(plan.files[2]!.error).toMatch(/batch is pcap title/u);
    expect(plan.totalSize).toBe(8);
  });

  it('returns a null format when nothing is recognized', async () => {
    const plan = await planBatch([entry('x.bin', 0x00)], PACKS);
    expect(plan.formatId).toBeNull();
    expect(plan.files[0]!.status).toBe('skipped');
    expect(plan.totalSize).toBe(0);
  });

  it('skips a zero-byte file as unrecognized without failing the batch', async () => {
    const empty: BatchEntry = { name: 'empty.pcap', size: 0, blob: new Blob([]) };
    const plan = await planBatch([empty, entry('a.pcap', 0xd4)], PACKS);
    expect(plan.files[0]!.status).toBe('skipped');
    expect(plan.formatId).toBe('pcap');
  });
});

describe('buildFilesTableIpc', () => {
  it('builds the _files batch with the documented columns and types', () => {
    const table = ipcToTable(
      buildFilesTableIpc([
        { file: 'a.pcap', originalName: 'a.pcap', size: 4, ingestOrder: 0, status: 'ok', error: null },
        {
          file: 'b.pcap',
          originalName: 'b.pcap',
          size: 9,
          ingestOrder: 1,
          status: 'skipped',
          error: 'boom',
        },
      ]),
    );
    expect(table.schema.fields.map((field) => field.name)).toEqual([
      'file',
      'original_name',
      'size',
      'ingest_order',
      'status',
      'error',
    ]);
    expect(table.numRows).toBe(2);
    expect(table.getChild('status')!.get(1)).toBe('skipped');
    expect(Number(table.getChild('size')!.get(1))).toBe(9);
    expect(table.getChild('error')!.get(0)).toBeNull();
  });
});

describe('mergeTableOverviews', () => {
  it('sums row counts by table name, keeping first-seen order and columns', () => {
    const columns = [{ name: 'ts', type: 'Uint64', nullable: false }];
    const merged = mergeTableOverviews([
      [{ name: 'packets', rowCount: 2, columns }],
      [
        { name: 'packets', rowCount: 3, columns },
        { name: 'dns', rowCount: 1, columns },
      ],
    ]);
    expect(merged).toEqual([
      { name: 'packets', rowCount: 5, columns },
      { name: 'dns', rowCount: 1, columns },
    ]);
  });
});
