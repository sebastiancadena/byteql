import { describe, expect, it } from 'vitest';

import { optionText, walkOptions } from '../src/options.js';

const encode = (le: boolean, entries: [number, number[]][], terminate = true): DataView => {
  const bytes: number[] = [];
  const u16 = (v: number) => (le ? bytes.push(v & 0xff, v >> 8) : bytes.push(v >> 8, v & 0xff));
  for (const [code, value] of entries) {
    u16(code);
    u16(value.length);
    bytes.push(...value);
    while (bytes.length % 4 !== 0) bytes.push(0);
  }
  if (terminate) {
    u16(0);
    u16(0);
  }
  return new DataView(Uint8Array.from(bytes).buffer);
};

describe('walkOptions', () => {
  it('visits options in order with padded advancement, in either byte order', () => {
    for (const le of [true, false]) {
      const view = encode(le, [
        [2, [0x65, 0x74, 0x68]],
        [9, [9]],
      ]);
      const seen: [number, number, number][] = [];
      expect(walkOptions(view, 0, view.byteLength, le, (c, s, n) => seen.push([c, s, n]))).toBe('ok');
      expect(seen).toEqual([
        [2, 4, 3],
        [9, 12, 1],
      ]);
    }
  });

  it('stops at opt_endofopt and ignores bytes after it', () => {
    const view = encode(true, [[1, [0x61]]]);
    const seen: number[] = [];
    walkOptions(view, 0, view.byteLength, true, (c) => seen.push(c));
    expect(seen).toEqual([1]);
  });

  it('accepts an options area without opt_endofopt', () => {
    const view = encode(true, [[1, [0x61]]], false);
    expect(walkOptions(view, 0, view.byteLength, true, () => {})).toBe('ok');
  });

  it('reports malformed when a value runs past the end, keeping earlier visits', () => {
    const view = encode(true, [[1, [0x61]]], false);
    const bytes = new Uint8Array(view.buffer.byteLength + 4);
    bytes.set(new Uint8Array(view.buffer));
    const dv = new DataView(bytes.buffer);
    dv.setUint16(8, 3, true); // second option: code 3
    dv.setUint16(10, 0xffff, true); // length far past the end
    const seen: number[] = [];
    expect(walkOptions(dv, 0, dv.byteLength, true, (c) => seen.push(c))).toBe('malformed');
    expect(seen).toEqual([1]);
  });

  it('reports malformed for 1–3 trailing bytes that cannot hold an option header', () => {
    const view = new DataView(new Uint8Array(2).buffer);
    expect(walkOptions(view, 0, 2, true, () => {})).toBe('malformed');
  });
});

describe('optionText', () => {
  it('decodes UTF-8 and strips trailing NULs', () => {
    const bytes = Uint8Array.of(0x65, 0x74, 0x68, 0x30, 0, 0);
    expect(optionText(bytes, 0, 6)).toBe('eth0');
  });
});
