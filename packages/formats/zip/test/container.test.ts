import { memoryByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { readZipContainer } from '../src/container.js';
import { buildZip } from './build-zip.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

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
});
