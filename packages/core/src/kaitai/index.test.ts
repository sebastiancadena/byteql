import KaitaiStream from 'kaitai-struct/KaitaiStream.js';
import { describe, expect, it } from 'vitest';

import { kaitaiParse, payload } from './index.js';

class TwoByteHeader {
  _debug: Record<string, { start: number; end?: number }> = {};
  header = 0;
  body = new Uint8Array();
  constructor(private readonly _io: KaitaiStream) {}
  _read(): void {
    this.header = this._io.readU2be();
    this._debug.body = { start: this._io.pos };
    this.body = this._io.readBytesFull();
  }
}

describe('kaitai helpers', () => {
  it('parses over a non-zero byteOffset view and returns view-relative payload starts', () => {
    const file = new Uint8Array([9, 9, 9, 0x00, 0x2a, 1, 2, 3]);
    const view = file.subarray(3); // wrapper handed a view at absolute offset 3
    const parsed = kaitaiParse(TwoByteHeader, view);
    expect(parsed.header).toBe(0x2a);
    expect(payload(parsed, 'body')).toEqual({ bytes: new Uint8Array([1, 2, 3]), start: 2 });
  });

  it('propagates a parse throw', () => {
    expect(() => kaitaiParse(TwoByteHeader, new Uint8Array([1]))).toThrow();
  });
});
