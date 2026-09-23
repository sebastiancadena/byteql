import { describe, expect, it } from 'vitest';

import { buildPcapngWithOffsets, OPT_COMMENT, optText, pcapngFromPackets } from './build-pcapng.js';

const u32 = (bytes: Uint8Array, at: number, le: boolean) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, le);

describe('buildPcapng', () => {
  it('writes an SHB with the byte-order magic in the section byte order', () => {
    for (const endian of ['le', 'be'] as const) {
      const { bytes, blocks } = buildPcapngWithOffsets([{ type: 'shb', endian }]);
      const le = endian === 'le';
      expect([...bytes.subarray(0, 4)]).toEqual([0x0a, 0x0d, 0x0d, 0x0a]);
      expect(u32(bytes, 8, le)).toBe(0x1a2b3c4d);
      expect(blocks[0]).toEqual({ start: 0, end: 28 });
      expect(u32(bytes, 4, le)).toBe(28);
      expect(u32(bytes, 24, le)).toBe(28);
    }
  });

  it('pads EPB data and options to 4 bytes and records exact block offsets', () => {
    const { bytes, blocks } = buildPcapngWithOffsets([
      { type: 'shb', endian: 'le' },
      { type: 'idb', linktype: 1 },
      {
        type: 'epb',
        interfaceId: 0,
        ts: 5n,
        data: Uint8Array.of(1, 2, 3),
        options: [optText(OPT_COMMENT, 'hi')],
      },
    ]);
    const epb = blocks[2]!;
    // 28 fixed + 4 (3 data bytes padded) + 8 (comment option: 4 header + 2 padded to 4) + 4 end-of-opt + 4 trailer
    expect(epb.end - epb.start).toBe(48);
    expect(u32(bytes, epb.start, true)).toBe(6);
    expect(u32(bytes, epb.start + 20, true)).toBe(3); // captured length
    expect(bytes.length).toBe(epb.end);
  });

  it('builds a one-interface pcapng from classic packet descriptions', () => {
    const bytes = pcapngFromPackets({
      endian: 'le',
      linktype: 1,
      packets: [{ tsSec: 2, tsFrac: 7, data: Uint8Array.of(9) }],
    });
    // SHB 28 + IDB 20 + EPB 36
    expect(bytes.length).toBe(84);
    expect(u32(bytes, 48 + 16, true)).toBe(2_000_007); // timestamp low word
  });
});
