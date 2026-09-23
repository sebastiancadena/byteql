import { readFile } from 'node:fs/promises';

import { ipcToTable, type ParseResult } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { pcapFormatPack } from '../src/index.js';
import {
  buildPcap,
  dnsOverTcp,
  dnsQuery,
  ethFrame,
  icmpv6Echo,
  ipv4,
  ipv6,
  tcp,
  tlsClientHello,
  udp,
  type PcapPacket,
} from './build-pcap.js';
import { pcapngFromPackets } from './build-pcapng.js';
import { multiSectionPcapng } from './pcapng-fixtures.js';
import { parseAndProjectPcap } from './parse-and-project.js';

const rows = (result: ParseResult, name: string) =>
  ipcToTable(result.tables.find((t) => t.name === name)!.ipc)
    .toArray()
    .map((row) => row.toJSON() as Record<string, unknown>);

const parse = (bytes: Uint8Array) => parseAndProjectPcap(bytes, new AbortController().signal);

describe('pcapng probe', () => {
  it('probes pcapng only with both the SHB type and a byte-order magic', () => {
    const le = Uint8Array.of(0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0, 0x4d, 0x3c, 0x2b, 0x1a);
    const be = Uint8Array.of(0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0, 0x1a, 0x2b, 0x3c, 0x4d);
    expect(pcapFormatPack.probeContainer(le)).toEqual({ container: 'pcapng', confidence: 1 });
    expect(pcapFormatPack.probeContainer(be)).toEqual({ container: 'pcapng', confidence: 1 });
    expect(
      pcapFormatPack.probeContainer(Uint8Array.of(0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4)),
    ).toBeNull();
    expect(pcapFormatPack.probeContainer(Uint8Array.of(0x0a, 0x0d, 0x0d, 0x0a))).toBeNull();
    expect(pcapFormatPack.probeContainer(Uint8Array.of(0xd4, 0xc3, 0xb2, 0xa1))?.container).toBe('pcap');
  });
});

describe('pcapng parity with classic pcap', () => {
  const eth4 = (protocol: number, payload: Uint8Array) =>
    ethFrame({ etherType: 0x0800, payload: ipv4({ protocol, src: '10.0.0.1', dst: '10.0.0.2', payload }) });
  const hello = tlsClientHello({ sni: 'parity.example' });
  const dnsTcp = dnsOverTcp({ txId: 9, name: 'tcp.example', type: 1 });
  const packets: PcapPacket[] = [
    {
      tsSec: 1,
      tsFrac: 1,
      data: eth4(
        17,
        udp({ srcPort: 5353, dstPort: 53, payload: dnsQuery({ txId: 1, name: 'udp.example', type: 1 }) }),
      ),
    },
    {
      tsSec: 1,
      tsFrac: 2,
      data: eth4(
        6,
        tcp({ srcPort: 40001, dstPort: 443, flags: 0x18, seq: 0, payload: hello.subarray(0, 20) }),
      ),
    },
    {
      tsSec: 1,
      tsFrac: 3,
      data: eth4(
        6,
        tcp({ srcPort: 40002, dstPort: 53, flags: 0x18, seq: 0, payload: dnsTcp.subarray(0, 5) }),
      ),
    },
    {
      tsSec: 1,
      tsFrac: 4,
      data: eth4(6, tcp({ srcPort: 40001, dstPort: 443, flags: 0x18, seq: 20, payload: hello.subarray(20) })),
    },
    {
      tsSec: 1,
      tsFrac: 5,
      data: eth4(6, tcp({ srcPort: 40002, dstPort: 53, flags: 0x18, seq: 5, payload: dnsTcp.subarray(5) })),
    },
    {
      tsSec: 2,
      tsFrac: 0,
      data: ethFrame({
        etherType: 0x86dd,
        payload: ipv6({
          nextHeader: 58,
          src: '2001:db8::1',
          dst: '2001:db8::2',
          payload: icmpv6Echo({ id: 3, seq: 4 }),
        }),
      }),
    },
  ];

  it('produces identical rows in every table except provenance and interface details', async () => {
    const classic = await parse(buildPcap({ magic: 'le_us', linktype: 1, packets }));
    const ng = await parse(pcapngFromPackets({ endian: 'be', linktype: 1, packets }));
    const strip = (r: Record<string, unknown>) =>
      JSON.stringify(
        Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_src_'))),
        (_k, v) => (typeof v === 'bigint' ? `${v}n` : v),
      );
    const tables = pcapFormatPack
      .schemas()
      .map((s) => s.name)
      .filter((n) => n !== 'interfaces');
    for (const name of tables) {
      const has = (r: ParseResult) => r.tables.some((t) => t.name === name);
      expect(has(ng), name).toBe(has(classic));
      if (!has(classic)) continue;
      expect(rows(ng, name).map(strip), name).toEqual(rows(classic, name).map(strip));
    }
    expect(rows(ng, 'tls').map((r) => r.sni)).toEqual(['parity.example']);
    expect(
      rows(ng, 'dns')
        .map((r) => r.query_name)
        .sort(),
    ).toEqual(['tcp.example', 'udp.example']);
  });
});

describe('pcapng projection', () => {
  it('projects interfaces and packets, with interface_id aligned to the interfaces key', async () => {
    const result = await parse(multiSectionPcapng().bytes);
    const ifaces = rows(result, 'interfaces');
    expect(
      ifaces.map((r) => [
        r.interface_id,
        r.section,
        r.if_index,
        r.linktype,
        r.name,
        r.os,
        r.ts_resolution,
        r.ts_offset_s,
      ]),
    ).toEqual([
      [1n, 0, 0, 1, 'eth0', 'Linux', '10^-9', 0n],
      [2n, 0, 1, 101, null, 'Linux', '2^-20', 100n],
      [3n, 1, 0, 1, null, null, '10^-6', 0n],
    ]);
    const packets = rows(result, 'packets');
    expect(packets.map((r) => [r.interface_id, r.linktype, r.ts_ns, r.comment])).toEqual([
      [1, 1, 1_700_000_000_123_456_789n, 'first'],
      [2, 228, 105_500_000_000n, null],
      [3, 1, 2_000_000_000n, null],
      [3, 1, null, null],
    ]);
    const ids = new Set(ifaces.map((r) => Number(r.interface_id)));
    expect(packets.every((r) => ids.has(Number(r.interface_id)))).toBe(true);
    expect(packets[3]!.ts).toBeNull();
    expect(rows(result, 'dns').map((r) => r.query_name)).toEqual(['one.example', 'two.example']);
    expect(rows(result, 'errors').map((r) => r.code)).toEqual(['UNSUPPORTED_BLOCK_TYPE']);
  });

  it('projects the real Wireshark sample with TLS SNI from reassembled TCP', async () => {
    const bytes = new Uint8Array(
      await readFile(new URL('../../../../apps/web/src/assets/http2-16-ssl.pcapng', import.meta.url)),
    );
    const result = await parse(bytes);
    expect(rows(result, 'packets')).toHaveLength(24);
    expect(rows(result, 'interfaces')).toHaveLength(1);
    expect(rows(result, 'tls').map((r) => r.sni)).toEqual(['localhost']);
    expect(rows(result, 'errors')).toEqual([]);
  });
});
