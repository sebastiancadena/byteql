import { describe, expect, it } from 'vitest';

import { buildPcap } from './build-pcap.js';
import { parsePcapContainer } from '../src/container.js';

describe('parsePcapContainer', () => {
  it('parses global header magic → endianness and µs/ns', () => {
    const le = parsePcapContainer(buildPcap({ magic: 'le_ns', linktype: 1, packets: [] }));
    expect(le.header.byteOrder).toBe('le');
    expect(le.header.timeUnit).toBe('ns');
    expect(le.header.linktype).toBe(1);
  });

  it('yields one packet with an absolute-offset body range', () => {
    const c = parsePcapContainer(
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

  it('normalizes ns fraction to microseconds', () => {
    const c = parsePcapContainer(
      buildPcap({
        magic: 'be_ns',
        linktype: 1,
        packets: [{ tsSec: 0, tsFrac: 2500, data: new Uint8Array([0]) }],
      }),
    );
    expect(c.packets[0].tsFracUs).toBe(2); // 2500 ns → 2 µs (integer)
  });

  it('rewrites raw-IP linktype 101 to 228/229 by peeking the version nibble', () => {
    const v6body = new Uint8Array([0x60, 0, 0, 0]); // version nibble 6
    const c = parsePcapContainer(
      buildPcap({
        magic: 'be_us',
        linktype: 101,
        packets: [{ tsSec: 0, tsFrac: 0, data: v6body }],
      }),
    );
    expect(c.packets[0].linktype).toBe(229);
  });

  it('records a truncated final record as an issue and keeps prior packets', () => {
    const good = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [{ tsSec: 0, tsFrac: 0, data: new Uint8Array([1]) }],
    });
    const truncated = good.subarray(0, good.length - 1); // drop last body byte
    const c = parsePcapContainer(truncated);
    expect(c.packets).toHaveLength(0);
    expect(c.issues[0].code).toBe('TRUNCATED_RECORD');
  });

  it('throws on unknown magic', () => {
    const bad = new Uint8Array(24); // all-zero magic
    expect(() => parsePcapContainer(bad)).toThrow(/UNRECOGNIZED_PCAP_MAGIC/);
  });
});
