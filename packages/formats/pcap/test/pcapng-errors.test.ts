import { memoryByteSource, PackFatalError } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import {
  buildPcapngWithOffsets,
  IF_TSOFFSET,
  IF_TSRESOL,
  OPT_COMMENT,
  optI64,
  optText,
  optU8,
  type PcapngBlock,
} from './build-pcapng.js';
import { BLOCK_SHB, createPcapngReader, type PcapngItem } from '../src/pcapng.js';

const base: PcapngBlock[] = [
  { type: 'shb', endian: 'le' },
  { type: 'idb', linktype: 1 },
  { type: 'epb', interfaceId: 0, ts: 1n, data: Uint8Array.of(1, 2, 3, 4) },
];

const run = async (bytes: Uint8Array) => {
  const reader = await createPcapngReader(memoryByteSource(bytes));
  const items: PcapngItem[] = [];
  for (let item = await reader.next(); item !== null; item = await reader.next()) items.push(item);
  return { items, issues: reader.issues(), packets: items.filter((i) => i.kind === 'packet').length };
};

const setU32 = (bytes: Uint8Array, at: number, value: number) =>
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(at, value, true);

describe('pcapng fatal first block', () => {
  it('BAD_BYTE_ORDER_MAGIC on the first SHB is fatal', async () => {
    const { bytes } = buildPcapngWithOffsets([{ type: 'shb', endian: 'le', byteOrderMagic: 0x11223344 }]);
    await expect(createPcapngReader(memoryByteSource(bytes))).rejects.toMatchObject({
      code: 'BAD_BYTE_ORDER_MAGIC',
    });
  });

  it('a first SHB with major version 2 is fatal', async () => {
    const { bytes } = buildPcapngWithOffsets([{ type: 'shb', endian: 'le', major: 2 }]);
    await expect(createPcapngReader(memoryByteSource(bytes))).rejects.toMatchObject({
      code: 'UNSUPPORTED_SECTION_VERSION',
    });
  });

  it('a head too short to hold the SHB block type is NOT_PCAPNG', async () => {
    await expect(createPcapngReader(memoryByteSource(Uint8Array.of(0x0a, 0x0d)))).rejects.toMatchObject({
      code: 'NOT_PCAPNG',
    });
  });

  it('an SHB block type cut off before 16 bytes is a fatal TRUNCATED_BLOCK, not NOT_PCAPNG', async () => {
    // SHB type, total length 28, little-endian byte-order magic: enough for the probe (12 bytes),
    // but the file ends before the version fields, so the first section is unreadable.
    const bytes = buildPcapngWithOffsets([{ type: 'shb', endian: 'le' }]).bytes.subarray(0, 12);
    await expect(createPcapngReader(memoryByteSource(bytes))).rejects.toBeInstanceOf(PackFatalError);
    await expect(createPcapngReader(memoryByteSource(bytes))).rejects.toMatchObject({
      code: 'TRUNCATED_BLOCK',
      message: expect.stringContaining('ends after 12 of the first Section Header Block'),
    });
  });

  it('a first SHB shorter than 28 bytes that still passes the 16-byte pre-check does not throw', async () => {
    // Body: byte-order magic (LE) + major=1 + minor=0 = 8 bytes -> total block length 20 (< 28).
    // The fatal pre-check only reads the first 16 bytes (magic, byte order, major), which this
    // block satisfies; the 28-byte minimum is only enforced once the main loop parses the block.
    const { bytes } = buildPcapngWithOffsets([
      { type: 'raw', blockType: BLOCK_SHB, body: Uint8Array.of(0x4d, 0x3c, 0x2b, 0x1a, 1, 0, 0, 0) },
    ]);
    const { items, issues } = await run(bytes);
    expect(items).toEqual([]);
    expect(issues).toEqual([
      expect.objectContaining({ code: 'MALFORMED_BLOCK', sourceStart: 0, sourceEnd: 20 }),
    ]);
  });
});

describe('pcapng stop-and-keep errors', () => {
  it('BLOCK_LENGTH_MISMATCH when the trailer disagrees, keeping earlier packets', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets([...base, ...base.slice(2)]);
    const second = blocks[3]!;
    setU32(bytes, second.end - 4, 999);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(1);
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'BLOCK_LENGTH_MISMATCH',
        sourceStart: second.start,
        sourceEnd: second.end,
      }),
    ]);
  });

  it('BLOCK_LENGTH_MISMATCH when the length is not a multiple of 4', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets(base);
    setU32(bytes, blocks[2]!.start + 4, 33);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(0);
    expect(issues[0]).toMatchObject({
      code: 'BLOCK_LENGTH_MISMATCH',
      sourceStart: blocks[2]!.start,
      sourceEnd: blocks[2]!.start + 12,
    });
  });

  it('TRUNCATED_BLOCK when a block runs past EOF, and when fewer than 12 bytes remain', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets(base);
    const cut = await run(bytes.subarray(0, bytes.length - 2));
    expect(cut.issues[0]).toMatchObject({ code: 'TRUNCATED_BLOCK', sourceStart: blocks[2]!.start });
    const tail = new Uint8Array(bytes.length + 6);
    tail.set(bytes);
    const short = await run(tail);
    expect(short.packets).toBe(1);
    expect(short.issues[0]).toMatchObject({
      code: 'TRUNCATED_BLOCK',
      sourceStart: bytes.length,
      sourceEnd: bytes.length + 6,
    });
  });

  it('a later SHB with a bad byte-order magic stops with BAD_BYTE_ORDER_MAGIC', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets([
      ...base,
      { type: 'shb', endian: 'le', byteOrderMagic: 0 },
      ...base.slice(1),
    ]);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(1);
    const badShb = blocks[3]!;
    expect(issues[0]).toMatchObject({
      code: 'BAD_BYTE_ORDER_MAGIC',
      sourceStart: badShb.start,
      sourceEnd: badShb.start + 12,
    });
  });

  it('a later SHB with major version 2 stops with UNSUPPORTED_SECTION_VERSION', async () => {
    const { bytes } = buildPcapngWithOffsets([
      ...base,
      { type: 'shb', endian: 'be', major: 2 },
      ...base.slice(1),
    ]);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(1);
    expect(issues[0]!.code).toBe('UNSUPPORTED_SECTION_VERSION');
  });

  it('an SHB shorter than 28 bytes stops with MALFORMED_BLOCK', async () => {
    const { bytes } = buildPcapngWithOffsets([
      ...base,
      { type: 'raw', blockType: 0x0a0d0d0a, body: Uint8Array.of(0x4d, 0x3c, 0x2b, 0x1a) },
      ...base.slice(1),
    ]);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(1);
    expect(issues[0]!.code).toBe('MALFORMED_BLOCK');
  });
});

describe('pcapng skip-and-continue errors', () => {
  it('UNKNOWN_INTERFACE skips the packet and continues', async () => {
    const { bytes } = buildPcapngWithOffsets([
      ...base,
      { type: 'epb', interfaceId: 5, ts: 1n, data: Uint8Array.of(9) },
      ...base.slice(2),
    ]);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(2);
    expect(issues.map((i) => i.code)).toEqual(['UNKNOWN_INTERFACE']);
  });

  it('a malformed IDB keeps its positional index (Review Focus 1)', async () => {
    const { bytes } = buildPcapngWithOffsets([
      { type: 'shb', endian: 'le' },
      { type: 'raw', blockType: 1, body: new Uint8Array(4) }, // IDB index 0, too short
      { type: 'idb', linktype: 1 }, // IDB index 1
      { type: 'epb', interfaceId: 0, ts: 1n, data: Uint8Array.of(1) },
      { type: 'epb', interfaceId: 1, ts: 2n, data: Uint8Array.of(2) },
    ]);
    const { items, issues } = await run(bytes);
    expect(issues.map((i) => i.code)).toEqual(['MALFORMED_BLOCK', 'UNKNOWN_INTERFACE']);
    const packets = items.flatMap((i) => (i.kind === 'packet' ? [i.packet] : []));
    expect(packets.map((p) => [p.interfaceOrdinal, p.tsNs])).toEqual([[1, 2000n]]);
  });

  it('MALFORMED_BLOCK when the captured length exceeds the block', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets([...base, ...base.slice(2)]);
    setU32(bytes, blocks[2]!.start + 20, 400);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(1);
    expect(issues[0]).toMatchObject({
      code: 'MALFORMED_BLOCK',
      sourceStart: blocks[2]!.start,
      sourceEnd: blocks[2]!.end,
    });
  });

  it('MALFORMED_OPTION keeps the packet and the options decoded before the bad one', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets([
      ...base.slice(0, 2),
      {
        type: 'epb',
        interfaceId: 0,
        ts: 1n,
        data: Uint8Array.of(1, 2, 3, 4),
        options: [optText(OPT_COMMENT, 'kept'), optText(OPT_COMMENT, 'x')],
      },
    ]);
    // second option header: after 28 fixed + 4 data + 8 (first option) → length field at +2
    new DataView(bytes.buffer).setUint16(blocks[2]!.start + 28 + 4 + 8 + 2, 0xffff, true);
    const { items, issues } = await run(bytes);
    const packet = items.find((i) => i.kind === 'packet');
    expect(packet?.kind === 'packet' && packet.packet.comment).toBe('kept');
    expect(issues.map((i) => i.code)).toEqual(['MALFORMED_OPTION']);
  });

  it('TIMESTAMP_OUT_OF_RANGE keeps the packet with null timestamps (Review Focus 3)', async () => {
    const { bytes } = buildPcapngWithOffsets([
      { type: 'shb', endian: 'le' },
      { type: 'idb', linktype: 1, options: [optU8(IF_TSRESOL, 0), optI64(IF_TSOFFSET, 2n ** 62n)] },
      { type: 'epb', interfaceId: 0, ts: 0xffff_ffff_ffff_ffffn, data: Uint8Array.of(1) },
    ]);
    const { items, issues } = await run(bytes);
    const packet = items.find((i) => i.kind === 'packet');
    expect(packet?.kind === 'packet' && packet.packet.tsNs).toBeNull();
    expect(issues.map((i) => i.code)).toEqual(['TIMESTAMP_OUT_OF_RANGE']);
  });

  it('UNSUPPORTED_BLOCK_TYPE is one issue per distinct type with a count and first-occurrence range', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets([
      ...base,
      { type: 'raw', blockType: 0x99, body: new Uint8Array(4) },
      { type: 'raw', blockType: 0x99, body: new Uint8Array(8) },
      { type: 'raw', blockType: 0xbad, body: new Uint8Array(4) },
    ]);
    const { issues } = await run(bytes);
    expect(issues).toEqual([
      {
        code: 'UNSUPPORTED_BLOCK_TYPE',
        message: 'block type 0x00000099: 2 block(s) skipped',
        sourceStart: blocks[3]!.start,
        sourceEnd: blocks[3]!.end,
      },
    ]);
  });
});
