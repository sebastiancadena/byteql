import type { ByteSource } from './protocol.js';

const assertRange = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ByteSource ${name} must be a non-negative integer, got ${value}`);
  }
};

/** In-memory source for tests and small-file callers; every read is a copy. */
export const memoryByteSource = (bytes: Uint8Array): ByteSource => ({
  size: bytes.byteLength,
  async read(offset, length) {
    assertRange(offset, 'offset');
    assertRange(length, 'length');
    return bytes.slice(offset, Math.min(offset + length, bytes.byteLength));
  },
});

/** Convenience for packs that deliberately slurp (small-file formats). */
export const readAll = (source: ByteSource): Promise<Uint8Array> => source.read(0, source.size);
