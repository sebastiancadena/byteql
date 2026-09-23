import { memoryByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { readZipContainer } from '../src/container.js';
import { buildZip } from './build-zip.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** Locates a little-endian u32 signature; used to find a record without hand-computing offsets. */
const findSignature = (bytes: Uint8Array, signature: number): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 4 <= bytes.length; i += 1) {
    if (view.getUint32(i, true) === signature) return i;
  }
  throw new Error(`signature ${signature.toString(16)} not found`);
};

describe('readZipContainer', () => {
  it('reads local files, central directory, and EOCD for a stored + deflated archive', async () => {
    const bytes = buildZip(
      [
        { name: 'a.txt', data: text('hello'), method: 0 },
        { name: 'b.txt', data: text('the quick brown fox '.repeat(8)), method: 8 },
      ],
      { comment: 'archive note' },
    );
    const container = await readZipContainer(memoryByteSource(bytes));

    expect(container.issues).toEqual([]);
    expect(container.localFiles.map((f) => f.file_name)).toEqual(['a.txt', 'b.txt']);
    expect(container.centralDirEntries.map((f) => f.file_name)).toEqual(['a.txt', 'b.txt']);
    expect(container.localFiles[0]!.compression_method).toBe(0);
    expect(container.localFiles[1]!.compression_method).toBe(8);
    expect(container.centralDirEntries[0]!.uncompressed_size).toBe(5);
    expect(container.endOfCentralDir?.num_entries).toBe(2);
    expect(container.endOfCentralDir?.comment).toBe('archive note');
    // Provenance: the first local header starts at offset 0, end-exclusive extent covers the header only.
    expect(container.localFiles[0]!._range.start).toBe(0);
    expect(container.localFiles[0]!._range.end).toBe(30 + 'a.txt'.length);
  });

  it('reconciles data-descriptor entries from the central directory', async () => {
    const payload = text('streamed payload');
    const bytes = buildZip([{ name: 's.bin', data: payload, method: 0, dataDescriptor: true }]);
    const container = await readZipContainer(memoryByteSource(bytes));

    // Local header sizes were zeroed (data-descriptor); the reader falls back to the CD sizes.
    expect(container.localFiles[0]!.compressed_size).toBe(payload.length);
    expect(container.localFiles[0]!.uncompressed_size).toBe(payload.length);
    expect(container.centralDirEntries[0]!.compressed_size).toBe(payload.length);
  });

  it('reads an empty archive (EOCD only)', async () => {
    const bytes = buildZip([]);
    const container = await readZipContainer(memoryByteSource(bytes));
    expect(container.localFiles).toEqual([]);
    expect(container.centralDirEntries).toEqual([]);
    expect(container.endOfCentralDir?.num_entries).toBe(0);
  });

  it('falls back to a forward local-header scan when no EOCD is present', async () => {
    const full = buildZip([{ name: 'a.txt', data: text('hello'), method: 0 }]);
    // Truncate off the central directory + EOCD, leaving only the local file record.
    const truncated = full.slice(0, 30 + 'a.txt'.length + 'hello'.length);
    const container = await readZipContainer(memoryByteSource(truncated));

    expect(container.endOfCentralDir).toBeNull();
    expect(container.centralDirEntries).toEqual([]);
    expect(container.localFiles.map((f) => f.file_name)).toEqual(['a.txt']);
    expect(container.issues.some((i) => i.code === 'EOCD_NOT_FOUND')).toBe(true);
  });

  // Regressions from the pack kit's conformance fuzz (seed 1) on the ZIP fixtures: a corrupted
  // or truncated length field let a record's computed `_range.end` claim bytes past the actual
  // archive size, tripping `assertTableInvariants`'s provenance-bounds check even though the
  // container itself never threw.
  it('clamps a forward-scanned local file record truncated mid-name (regression: fuzz truncation, two-entries.zip TRUNC 1/7)', async () => {
    const full = buildZip([{ name: 'a.txt', data: text('hello'), method: 0 }]);
    // Cut off partway through the file name: the declared name length (5) then claims more
    // bytes than remain, and no EOCD survives the cut, so this exercises the forward-scan path.
    const truncated = full.slice(0, 30 + 2);
    const container = await readZipContainer(memoryByteSource(truncated));

    expect(container.endOfCentralDir).toBeNull();
    expect(container.localFiles).toHaveLength(1);
    expect(container.localFiles[0]!._range.end).toBeLessThanOrEqual(truncated.byteLength);
    expect(container.localFiles[0]!._range.end).toBeGreaterThanOrEqual(container.localFiles[0]!._range.start);
  });

  it('clamps a central directory entry whose comment length overruns the archive (regression: fuzz byte flip)', async () => {
    const bytes = buildZip(
      [
        { name: 'a.txt', data: text('hello') },
        { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 3]) },
      ],
      { comment: 'golden' },
    );
    const corrupted = bytes.slice();
    const entryStart = findSignature(corrupted, SIG_CENTRAL);
    // comment_len is the u16 at offset 32 of a central directory entry; inflate it to the max.
    corrupted[entryStart + 32] = 0xff;
    corrupted[entryStart + 33] = 0xff;
    const container = await readZipContainer(memoryByteSource(corrupted));

    for (const entry of container.centralDirEntries) {
      expect(entry._range.end).toBeLessThanOrEqual(corrupted.byteLength);
      expect(entry._range.end).toBeGreaterThanOrEqual(entry._range.start);
    }
  });

  it('clamps the EOCD record whose comment length overruns the archive (regression: fuzz byte flip)', async () => {
    const bytes = buildZip([{ name: 'a.txt', data: text('hello'), method: 0 }]);
    const corrupted = bytes.slice();
    const eocdStart = findSignature(corrupted, SIG_EOCD);
    // comment_len is the u16 at offset 20 of the EOCD record; inflate it to the max.
    corrupted[eocdStart + 20] = 0xff;
    corrupted[eocdStart + 21] = 0xff;
    const container = await readZipContainer(memoryByteSource(corrupted));

    expect(container.endOfCentralDir).not.toBeNull();
    expect(container.endOfCentralDir!._range.end).toBeLessThanOrEqual(corrupted.byteLength);
    expect(container.endOfCentralDir!._range.end).toBeGreaterThanOrEqual(
      container.endOfCentralDir!._range.start,
    );
  });
});
