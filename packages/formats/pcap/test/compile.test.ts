import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('compile', () => {
  it('ethernet parser stops at a raw blob (no auto-descent)', () => {
    const mod = require('../gen/EthernetFrame.js');
    const KaitaiStream = require('kaitai-struct/KaitaiStream.js');
    // dst(6) src(6) ethertype=0x0800 then 4 payload bytes
    const bytes = new Uint8Array([...Array(12).fill(0), 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    const p = new mod.EthernetFrame(
      new KaitaiStream(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
    );
    p._read();
    expect(p.body).toBeInstanceOf(Uint8Array); // raw blob, not a parsed ipv4 object
    expect([...p.body]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
});
