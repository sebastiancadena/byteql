import { memoryByteSource, PackFatalError, type ByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { buildPcap } from './build-pcap.js';
import { buildPcapngWithOffsets } from './build-pcapng.js';
import { multiSectionPcapng } from './pcapng-fixtures.js';
import { createPcapngReader, padTo4, type PcapngItem, type PcapngReader } from '../src/pcapng.js';

const drain = async (reader: PcapngReader): Promise<PcapngItem[]> => {
  const items: PcapngItem[] = [];
  for (let item = await reader.next(); item !== null; item = await reader.next()) items.push(item);
  return items;
};

/** Every read lands in ONE reused scratch buffer (see container.test.ts). */
const recyclingByteSource = (bytes: Uint8Array): ByteSource => {
  let scratch = new Uint8Array(0);
  return {
    size: bytes.byteLength,
    async read(offset, length) {
      const end = Math.min(offset + length, bytes.byteLength);
      const span = Math.max(end - offset, 0);
      if (scratch.byteLength < span) scratch = new Uint8Array(span);
      const view = scratch.subarray(0, span);
      view.set(bytes.subarray(offset, end));
      return view;
    },
  };
};

describe('createPcapngReader', () => {
  it('yields interfaces and packets in file order across sections and byte orders', async () => {
    const { bytes, blocks } = multiSectionPcapng();
    const reader = await createPcapngReader(memoryByteSource(bytes));
    const items = await drain(reader);
    expect(items.map((i) => i.kind)).toEqual([
      'interface',
      'interface',
      'packet',
      'packet',
      'interface',
      'packet',
      'packet',
    ]);
    const ifaces = items.flatMap((i) => (i.kind === 'interface' ? [i.iface] : []));
    expect(ifaces.map((f) => [f.ordinal, f.section, f.ifIndex, f.linktype])).toEqual([
      [1, 0, 0, 1],
      [2, 0, 1, 101],
      [3, 1, 0, 1],
    ]);
    expect(ifaces[0]).toMatchObject({
      name: 'eth0',
      description: 'uplink',
      comment: 'primary',
      os: 'Linux',
      snaplen: 262144,
      tsResolution: { base: 10, exponent: 9 },
      tsOffsetS: 0n,
      blockStart: blocks[1]!.start,
      blockEnd: blocks[1]!.end,
    });
    expect(ifaces[1]).toMatchObject({ tsResolution: { base: 2, exponent: 20 }, tsOffsetS: 100n });
    expect(ifaces[2]).toMatchObject({ os: null, tsResolution: { base: 10, exponent: 6 } });
    expect(reader.bytesConsumed()).toBe(bytes.length);
  });

  it('computes timestamps, linktypes, comments, and provenance per packet', async () => {
    const { bytes, blocks } = multiSectionPcapng();
    const packets = (await drain(await createPcapngReader(memoryByteSource(bytes)))).flatMap((i) =>
      i.kind === 'packet' ? [i.packet] : [],
    );
    expect(packets.map((p) => [p.index, p.interfaceOrdinal, p.linktype, p.tsNs, p.comment])).toEqual([
      [0, 1, 1, 1_700_000_000_123_456_789n, 'first'],
      [1, 2, 228, 105_500_000_000n, null],
      [2, 3, 1, 2_000_000_000n, null],
      [3, 3, 1, null, null],
    ]);
    const epb = blocks[3]!;
    expect(packets[0]).toMatchObject({ blockStart: epb.start, blockEnd: epb.end });
    expect(packets[0]!.body.start).toBe(epb.start + 28);
    expect(packets[0]!.body.bytes).toHaveLength(packets[0]!.inclLen);
    const spb = blocks[11]!;
    expect(packets[3]!.body.start).toBe(spb.start + 12);
  });

  it('reports each unknown block type once with a count, and skips known unprojected blocks silently', async () => {
    const { bytes, blocks } = multiSectionPcapng();
    const reader = await createPcapngReader(memoryByteSource(bytes));
    await drain(reader);
    expect(reader.issues()).toEqual([
      {
        code: 'UNSUPPORTED_BLOCK_TYPE',
        message: 'block type 0x0000007f: 1 block(s) skipped',
        sourceStart: blocks[6]!.start,
        sourceEnd: blocks[6]!.end,
      },
    ]);
  });

  it('parses a big-endian-only file identically to its little-endian twin', async () => {
    const make = (endian: 'le' | 'be') =>
      buildPcapngWithOffsets([
        { type: 'shb', endian },
        { type: 'idb', linktype: 1 },
        { type: 'epb', interfaceId: 0, ts: 42n, data: Uint8Array.of(1, 2, 3, 4, 5) },
      ]).bytes;
    const strip = (items: PcapngItem[]) =>
      JSON.stringify(items, (_k, v) => (typeof v === 'bigint' ? `${v}` : v));
    const le = await drain(await createPcapngReader(memoryByteSource(make('le'))));
    const be = await drain(await createPcapngReader(memoryByteSource(make('be'))));
    expect(strip(be)).toBe(strip(le));
  });

  it('keeps a straddling block body intact across later reads on a recycling source', async () => {
    // Layout with chunkBytes 64: SHB [0,28), IDB [28,48), EPB [48,88) reloads the window at 48
    // ([48,112)), EPB [88,144) straddles 112 and fits in one chunk (56 <= 64), so it reloads at 88
    // and must be copied. A block larger than the chunk would take the direct-read path instead.
    const straddling = Uint8Array.from({ length: 24 }, (_, i) => i + 1);
    const { bytes } = buildPcapngWithOffsets([
      { type: 'shb', endian: 'le' },
      { type: 'idb', linktype: 1 },
      { type: 'epb', interfaceId: 0, ts: 1n, data: new Uint8Array(8) },
      { type: 'epb', interfaceId: 0, ts: 2n, data: straddling },
      { type: 'epb', interfaceId: 0, ts: 3n, data: new Uint8Array(8).fill(0xee) },
      { type: 'epb', interfaceId: 0, ts: 4n, data: new Uint8Array(8).fill(0xdd) },
    ]);
    const reader = await createPcapngReader(recyclingByteSource(bytes), 64);
    let held: Uint8Array | null = null;
    for (let item = await reader.next(); item !== null; item = await reader.next()) {
      if (item.kind === 'packet' && item.packet.index === 1) held = item.packet.body.bytes;
    }
    expect([...held!]).toEqual([...straddling]);
  });

  it('reads a block larger than the chunk size', async () => {
    const big = new Uint8Array(300).fill(7);
    const { bytes } = buildPcapngWithOffsets([
      { type: 'shb', endian: 'le' },
      { type: 'idb', linktype: 1 },
      { type: 'epb', interfaceId: 0, ts: 1n, data: big },
    ]);
    const items = await drain(await createPcapngReader(memoryByteSource(bytes), 32));
    const packet = items.find((i) => i.kind === 'packet')!;
    expect(packet.kind === 'packet' && [...packet.packet.body.bytes]).toEqual([...big]);
  });

  it('throws PackFatalError NOT_PCAPNG for a classic pcap', async () => {
    const bytes = buildPcap({ magic: 'le_us', linktype: 1, packets: [] });
    await expect(createPcapngReader(memoryByteSource(bytes))).rejects.toMatchObject({
      name: 'PackFatalError',
      code: 'NOT_PCAPNG',
    });
    await expect(createPcapngReader(memoryByteSource(bytes))).rejects.toBeInstanceOf(PackFatalError);
  });
});

describe('padTo4', () => {
  it('rounds up to a 4-byte boundary', () => {
    expect([0, 1, 2, 3, 4, 5, 8].map(padTo4)).toEqual([0, 4, 4, 4, 4, 8, 8]);
  });

  it('stays exact for uint32 lengths at and above 2^31, where 32-bit bitwise padding goes negative', () => {
    expect(padTo4(2 ** 31 - 1)).toBe(2 ** 31);
    expect(padTo4(2 ** 31)).toBe(2 ** 31);
    expect(padTo4(2 ** 31 + 1)).toBe(2 ** 31 + 4);
    expect(padTo4(0xffff_fffd)).toBe(2 ** 32);
    expect(((2 ** 31 + 1 + 3) & ~3) < 0).toBe(true);
  });
});
