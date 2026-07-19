import { describe, expect, it } from 'vitest';
import { memoryByteSource, readAll } from './byte-source.js';

describe('memoryByteSource', () => {
  const source = memoryByteSource(new Uint8Array([1, 2, 3, 4, 5]));

  it('reports size and reads exact ranges as copies', async () => {
    expect(source.size).toBe(5);
    const chunk = await source.read(1, 3);
    expect([...chunk]).toEqual([2, 3, 4]);
    chunk[0] = 99; // mutating the copy must not affect later reads
    expect([...(await source.read(1, 3))]).toEqual([2, 3, 4]);
  });

  it('short-reads only at EOF and returns empty past the end', async () => {
    expect([...(await source.read(3, 10))]).toEqual([4, 5]);
    expect((await source.read(7, 4)).length).toBe(0);
  });

  it('rejects negative or non-integer offsets and lengths', async () => {
    await expect(source.read(-1, 2)).rejects.toThrow(/offset/);
    await expect(source.read(0, 1.5)).rejects.toThrow(/length/);
  });

  it('readAll drains the whole source', async () => {
    expect([...(await readAll(source))]).toEqual([1, 2, 3, 4, 5]);
  });
});
