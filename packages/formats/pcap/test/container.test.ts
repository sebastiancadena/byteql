import { memoryByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { buildPcap } from './build-pcap.js';
import { createPcapFramer, parsePcapContainer } from '../src/container.js';

describe('parsePcapContainer', () => {
  it('parses global header magic → endianness and µs/ns', async () => {
    const le = await parsePcapContainer(buildPcap({ magic: 'le_ns', linktype: 1, packets: [] }));
    expect(le.header.byteOrder).toBe('le');
    expect(le.header.timeUnit).toBe('ns');
    expect(le.header.linktype).toBe(1);
  });

  it('yields one packet with an absolute-offset body range', async () => {
    const c = await parsePcapContainer(
      buildPcap({
        magic: 'be_us',
        linktype: 1,
        packets: [{ tsSec: 7, tsFrac: 500000, data: new Uint8Array([1, 2, 3, 4]) }],
      }),
    );
    expect(c.packets).toHaveLength(1);
    expect(c.packets[0].body.start).toBe(40); // 24 global + 16 record header
    expect([...c.packets[0].body.bytes]).toEqual([1, 2, 3, 4]);
    expect(c.packets[0].tsFracUs).toBe(500000);
  });

  it('normalizes ns fraction to microseconds', async () => {
    const c = await parsePcapContainer(
      buildPcap({
        magic: 'be_ns',
        linktype: 1,
        packets: [{ tsSec: 0, tsFrac: 2500, data: new Uint8Array([0]) }],
      }),
    );
    expect(c.packets[0].tsFracUs).toBe(2); // 2500 ns → 2 µs (integer)
  });

  it('rewrites raw-IP linktype 101 to 228/229 by peeking the version nibble', async () => {
    const v6body = new Uint8Array([0x60, 0, 0, 0]); // version nibble 6
    const c = await parsePcapContainer(
      buildPcap({
        magic: 'be_us',
        linktype: 101,
        packets: [{ tsSec: 0, tsFrac: 0, data: v6body }],
      }),
    );
    expect(c.packets[0].linktype).toBe(229);
  });

  it('records a truncated final record as an issue and keeps prior packets', async () => {
    const good = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [{ tsSec: 0, tsFrac: 0, data: new Uint8Array([1]) }],
    });
    const truncated = good.subarray(0, good.length - 1); // drop last body byte
    const c = await parsePcapContainer(truncated);
    expect(c.packets).toHaveLength(0);
    expect(c.issues[0].code).toBe('TRUNCATED_RECORD');
  });

  it('throws on unknown magic', async () => {
    const bad = new Uint8Array(24); // all-zero magic
    await expect(parsePcapContainer(bad)).rejects.toThrow(/UNRECOGNIZED_PCAP_MAGIC/);
  });
});

describe('createPcapFramer', () => {
  /** Drains a framer into an array, the same shape `parsePcapContainer` returns as `packets`. */
  async function drain(framer: Awaited<ReturnType<typeof createPcapFramer>>) {
    const packets = [];
    for (let packet = await framer.next(); packet !== null; packet = await framer.next()) {
      packets.push(packet);
    }
    return packets;
  }

  it('frames records identically to parsePcapContainer across a chunk boundary', async () => {
    // header(24) + 3 records * header(16): record0 body 20B, record1 body 20B, record2 body 40B.
    // chunkBytes=64 means the first chunk read [24,88) ends inside record1's body (bodyStart=76,
    // bodyEnd=96), so record1 straddles the chunk edge.
    const bytes = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [
        { tsSec: 1, tsFrac: 111, data: new Uint8Array(20).fill(1) },
        { tsSec: 2, tsFrac: 222, data: new Uint8Array(20).fill(2) },
        { tsSec: 3, tsFrac: 333, data: new Uint8Array(40).fill(3) },
      ],
    });

    const expected = await parsePcapContainer(bytes);
    const framer = await createPcapFramer(memoryByteSource(bytes), 64);
    const framed = await drain(framer);

    expect(framed).toHaveLength(expected.packets.length);
    framed.forEach((packet, i) => {
      const want = expected.packets[i];
      expect(packet.index).toBe(want.index);
      expect(packet.tsSec).toBe(want.tsSec);
      expect(packet.tsFracUs).toBe(want.tsFracUs);
      expect(packet.inclLen).toBe(want.inclLen);
      expect(packet.recordStart).toBe(want.recordStart);
      expect(packet.bodyEnd).toBe(want.bodyEnd);
      expect(packet.body.start).toBe(want.body.start);
      expect([...packet.body.bytes]).toEqual([...want.body.bytes]);
    });
  });

  it('yields a straddling record whose body bytes survive later chunk reads', async () => {
    const straddlingBody = new Uint8Array(20).fill(2);
    const bytes = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [
        { tsSec: 1, tsFrac: 111, data: new Uint8Array(20).fill(1) },
        { tsSec: 2, tsFrac: 222, data: straddlingBody },
        { tsSec: 3, tsFrac: 333, data: new Uint8Array(40).fill(3) },
        { tsSec: 4, tsFrac: 444, data: new Uint8Array(40).fill(4) },
        { tsSec: 5, tsFrac: 555, data: new Uint8Array(40).fill(5) },
      ],
    });

    const framer = await createPcapFramer(memoryByteSource(bytes), 64);
    let held: Awaited<ReturnType<typeof framer.next>> = null;
    let packet = await framer.next();
    while (packet !== null) {
      if (packet.index === 1) held = packet;
      packet = await framer.next();
    }

    expect(held).not.toBeNull();
    expect([...held!.body.bytes]).toEqual([...straddlingBody]);
  });

  it('handles a record larger than the chunk size', async () => {
    const bigBody = new Uint8Array(100).fill(7);
    const bytes = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [{ tsSec: 9, tsFrac: 99, data: bigBody }],
    });

    const framer = await createPcapFramer(memoryByteSource(bytes), 32);
    const framed = await drain(framer);

    expect(framed).toHaveLength(1);
    expect(framed[0].inclLen).toBe(100);
    expect([...framed[0].body.bytes]).toEqual([...bigBody]);
    expect(framer.bytesConsumed()).toBe(bytes.length);
  });

  it('reports truncated tails as TRUNCATED_RECORD and stops, keeping prior packets', async () => {
    const good = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [
        { tsSec: 0, tsFrac: 0, data: new Uint8Array(20).fill(1) },
        { tsSec: 0, tsFrac: 0, data: new Uint8Array(20).fill(2) },
      ],
    });
    const truncated = good.subarray(0, good.length - 1); // drop last body byte

    const expected = await parsePcapContainer(truncated);
    const framer = await createPcapFramer(memoryByteSource(truncated), 32);
    const framed = await drain(framer);

    expect(framed).toHaveLength(expected.packets.length);
    expect(framed).toHaveLength(1);
    expect(framer.issues()).toHaveLength(1);
    expect(framer.issues()[0]).toEqual(expected.issues[0]);
  });

  it('normalizes raw-IP linktype 101 per packet from the first body byte', async () => {
    const v4body = new Uint8Array(20).fill(0);
    v4body[0] = 0x40; // version nibble 4
    const v6body = new Uint8Array(20).fill(0);
    v6body[0] = 0x60; // version nibble 6

    const bytes = buildPcap({
      magic: 'be_us',
      linktype: 101,
      packets: [
        { tsSec: 0, tsFrac: 0, data: v4body },
        { tsSec: 0, tsFrac: 0, data: v6body },
      ],
    });

    const framer = await createPcapFramer(memoryByteSource(bytes), 32);
    const framed = await drain(framer);
    expect(framed[0].linktype).toBe(228);
    expect(framed[1].linktype).toBe(229);
  });

  it('tracks bytesConsumed as record framing advances', async () => {
    const bytes = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [
        { tsSec: 0, tsFrac: 0, data: new Uint8Array(20).fill(1) },
        { tsSec: 0, tsFrac: 0, data: new Uint8Array(20).fill(2) },
      ],
    });

    const framer = await createPcapFramer(memoryByteSource(bytes), 32);
    expect(framer.bytesConsumed()).toBe(24); // nothing framed yet

    const first = await framer.next();
    expect(framer.bytesConsumed()).toBe(first!.bodyEnd);

    const second = await framer.next();
    expect(framer.bytesConsumed()).toBe(second!.bodyEnd);
    expect(framer.bytesConsumed()).toBe(bytes.length);

    expect(await framer.next()).toBeNull();
    expect(framer.bytesConsumed()).toBe(bytes.length);
  });
});
