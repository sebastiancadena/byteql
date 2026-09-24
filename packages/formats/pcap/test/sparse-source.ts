import type { ByteSource } from '@byteql/core';

export interface SparseByteSource extends ByteSource {
  /** Length of the largest single `read` served so far. */
  readonly largestRead: number;
}

/**
 * A `size`-byte source that is all zeros except for the given patches, and never materializes
 * more than one read at a time. Lets a test declare a multi-megabyte record inside a file without
 * allocating the file, and check afterwards that the reader never read it whole.
 */
export function sparseByteSource(
  size: number,
  patches: readonly { offset: number; bytes: Uint8Array }[],
): SparseByteSource {
  let largestRead = 0;
  return {
    size,
    get largestRead() {
      return largestRead;
    },
    async read(offset, length) {
      const end = Math.min(offset + length, size);
      const out = new Uint8Array(Math.max(end - offset, 0));
      largestRead = Math.max(largestRead, out.length);
      for (const patch of patches) {
        const from = Math.max(patch.offset, offset);
        const to = Math.min(patch.offset + patch.bytes.length, end);
        if (from < to) out.set(patch.bytes.subarray(from - patch.offset, to - patch.offset), from - offset);
      }
      return out;
    },
  };
}
