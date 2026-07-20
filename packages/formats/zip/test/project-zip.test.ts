import { ipcToTable, memoryByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { parseAndProjectZip } from '../src/project-zip.js';
import { buildZip } from './build-zip.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const rows = (result: Awaited<ReturnType<typeof parseAndProjectZip>>, name: string) => {
  const table = result.tables.find((t) => t.name === name);
  if (!table) throw new Error(`missing table ${name}`);
  return ipcToTable(table.ipc);
};

describe('parseAndProjectZip', () => {
  it('projects local_files with labels, provenance, and a decoded mod_time', async () => {
    const bytes = buildZip([
      { name: 'a.txt', data: text('hello'), method: 0, modDate: 0x52cf, modTime: 0x63d6 },
      { name: 'b.txt', data: text('xyz'.repeat(20)), method: 8 },
    ]);
    const result = await parseAndProjectZip(memoryByteSource(bytes), new AbortController().signal);

    expect(result.format.id).toBe('zip');
    const local = rows(result, 'local_files');
    expect(local.numRows).toBe(2);
    const compression = local.getChild('compression')!.toArray();
    expect([...compression]).toEqual(['stored', 'deflate']);
    // 2021-06-15 12:30:44 UTC. The column is stored as timestamp_us (microseconds), but
    // apache-arrow's JS reader surfaces Timestamp* vectors as epoch milliseconds (see the
    // `timestamp_us columns` describe block in packages/core/src/arrow/build.test.ts and the
    // matching note in packages/formats/pcap/test/project-pcap.test.ts), so `.get()` here
    // returns milliseconds, not microseconds.
    const modTime = local.getChild('mod_time')!.get(0);
    expect(Number(modTime)).toBe(Date.UTC(2021, 5, 15, 12, 30, 44));
    // Provenance is present on the first row.
    expect(Number(local.getChild('_src_start')!.get(0))).toBe(0);
    expect(Number(local.getChild('_src_end')!.get(0))).toBe(30 + 'a.txt'.length);
  });

  it('emits an end_of_central_dir row and central_dir_entries', async () => {
    const bytes = buildZip([{ name: 'a.txt', data: text('hi'), method: 0 }], { comment: 'note' });
    const result = await parseAndProjectZip(memoryByteSource(bytes), new AbortController().signal);
    expect(rows(result, 'central_dir_entries').numRows).toBe(1);
    const eocd = rows(result, 'end_of_central_dir');
    expect(eocd.numRows).toBe(1);
    expect(eocd.getChild('num_entries')!.get(0)).toBe(1);
    expect(eocd.getChild('comment')!.get(0)).toBe('note');
  });

  it('reports a recoverable issue when the EOCD is missing', async () => {
    const full = buildZip([{ name: 'a.txt', data: text('hello'), method: 0 }]);
    const truncated = full.slice(0, 30 + 'a.txt'.length + 'hello'.length);
    const result = await parseAndProjectZip(memoryByteSource(truncated), new AbortController().signal);
    expect(result.issues.some((i) => i.code === 'EOCD_NOT_FOUND')).toBe(true);
    expect(rows(result, 'local_files').numRows).toBe(1);
  });
});
