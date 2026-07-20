import { memoryByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { zipFormatPack } from '../src/pack.js';
import { buildZip } from './build-zip.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const drain = async (bytes: Uint8Array) => {
  const source = zipFormatPack.open(memoryByteSource(bytes), { signal: new AbortController().signal });
  const seen = new Map<string, number>();
  for (let batch = await source.nextBatch(); batch !== null; batch = await source.nextBatch()) {
    seen.set(batch.table, (seen.get(batch.table) ?? 0) + batch.rowCount);
  }
  source.finish();
  return seen;
};

describe('zipFormatPack', () => {
  it('probes ZIP local-file and empty-archive magic, rejects others', () => {
    expect(zipFormatPack.probe(Uint8Array.of(0x50, 0x4b, 0x03, 0x04))).toBeGreaterThan(0.5);
    expect(zipFormatPack.probe(Uint8Array.of(0x50, 0x4b, 0x05, 0x06))).toBeGreaterThan(0.5);
    expect(zipFormatPack.probe(Uint8Array.of(0x4d, 0x54, 0x68, 0x64))).toBeNull();
    expect(zipFormatPack.probe(Uint8Array.of(0x50))).toBeNull();
  });

  it('declares local_files, central_dir_entries, end_of_central_dir, and errors', () => {
    expect(zipFormatPack.schemas().map((s) => s.name).sort()).toEqual([
      'central_dir_entries',
      'end_of_central_dir',
      'errors',
      'local_files',
    ]);
  });

  it('opens an archive and emits per-table batches', async () => {
    const bytes = buildZip([{ name: 'a.txt', data: text('hi'), method: 0 }]);
    const seen = await drain(bytes);
    expect(seen.get('local_files')).toBe(1);
    expect(seen.get('central_dir_entries')).toBe(1);
    expect(seen.get('end_of_central_dir')).toBe(1);
  });
});
