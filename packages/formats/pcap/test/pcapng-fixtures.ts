import { dnsOverTcp, dnsQuery, ethFrame, icmpEcho, icmpv6Echo, ipv4, ipv6, tcp, udp } from './build-pcap.js';
import {
  buildPcapngWithOffsets,
  IF_DESCRIPTION,
  IF_NAME,
  IF_TSOFFSET,
  IF_TSRESOL,
  OPT_COMMENT,
  optI64,
  optText,
  optU8,
  pcapngFromPackets,
  SHB_OS,
} from './build-pcapng.js';

const dnsOverEthernet = (name: string) =>
  ethFrame({
    etherType: 0x0800,
    payload: ipv4({
      protocol: 17,
      src: '10.0.0.1',
      dst: '10.0.0.2',
      payload: udp({ srcPort: 5353, dstPort: 53, payload: dnsQuery({ txId: 1, name, type: 1 }) }),
    }),
  });

/**
 * Two sections (little-endian, then big-endian) exercising every projected block kind:
 *
 * - blocks[0] SHB le, shb_os "Linux"
 * - blocks[1] IDB 0: Ethernet, if_name eth0, if_description uplink, opt_comment "primary", tsresol 10^-9
 * - blocks[2] IDB 1: raw IP (101), tsresol 2^-20, tsoffset 100 s
 * - blocks[3] EPB if 0: DNS "one.example", ts 1_700_000_000_123_456_789 ns, comment "first"
 * - blocks[4] NRB (skipped silently)
 * - blocks[5] EPB if 1: raw IPv4 DNS "two.example", ts 5.5 s + 100 s
 * - blocks[6] unknown block type 0x7f (skipped, reported)
 * - blocks[7] ISB (skipped silently)
 * - blocks[8] SHB be
 * - blocks[9] IDB 0: Ethernet, default 10^-6
 * - blocks[10] OPB if 0: IPv6 ICMPv6 echo, ts 2 s
 * - blocks[11] SPB: IPv4 ICMP echo (no timestamp)
 */
export function multiSectionPcapng() {
  const rawDns = ipv4({
    protocol: 17,
    src: '10.0.0.3',
    dst: '10.0.0.4',
    payload: udp({
      srcPort: 5353,
      dstPort: 53,
      payload: dnsQuery({ txId: 2, name: 'two.example', type: 1 }),
    }),
  });
  return buildPcapngWithOffsets([
    { type: 'shb', endian: 'le', options: [optText(SHB_OS, 'Linux')] },
    {
      type: 'idb',
      linktype: 1,
      snaplen: 262144,
      options: [
        optText(IF_NAME, 'eth0'),
        optText(IF_DESCRIPTION, 'uplink'),
        optText(OPT_COMMENT, 'primary'),
        optU8(IF_TSRESOL, 9),
      ],
    },
    { type: 'idb', linktype: 101, options: [optU8(IF_TSRESOL, 0x80 | 20), optI64(IF_TSOFFSET, 100n)] },
    {
      type: 'epb',
      interfaceId: 0,
      ts: 1_700_000_000_123_456_789n,
      data: dnsOverEthernet('one.example'),
      options: [optText(OPT_COMMENT, 'first')],
    },
    { type: 'raw', blockType: 4, body: new Uint8Array(4) },
    { type: 'epb', interfaceId: 1, ts: (5n << 20n) + (1n << 19n), data: rawDns },
    { type: 'raw', blockType: 0x7f, body: new Uint8Array(8) },
    { type: 'raw', blockType: 5, body: new Uint8Array(12) },
    { type: 'shb', endian: 'be' },
    { type: 'idb', linktype: 1 },
    {
      type: 'opb',
      interfaceId: 0,
      ts: 2_000_000n,
      data: ethFrame({
        etherType: 0x86dd,
        payload: ipv6({
          nextHeader: 58,
          src: '2001:db8::1',
          dst: '2001:db8::2',
          payload: icmpv6Echo({ id: 1, seq: 1 }),
        }),
      }),
    },
    {
      type: 'spb',
      data: ethFrame({
        etherType: 0x0800,
        payload: ipv4({
          protocol: 1,
          src: '10.0.0.5',
          dst: '10.0.0.6',
          payload: icmpEcho({ id: 2, seq: 2 }),
        }),
      }),
    },
  ]);
}

/** The classic dns-stream e2e fixture's two DNS-over-TCP segments, as a one-interface pcapng. */
export function dnsStreamPcapng(): Uint8Array {
  const payload = dnsOverTcp({ txId: 0xbeef, name: 'stream.example', type: 1 });
  const packet = (seq: number, data: Uint8Array) =>
    ethFrame({
      etherType: 0x0800,
      payload: ipv4({
        protocol: 6,
        src: '10.0.0.1',
        dst: '10.0.0.2',
        payload: tcp({ srcPort: 40000, dstPort: 53, flags: 0x18, seq, payload: data }),
      }),
    });
  return pcapngFromPackets({
    endian: 'le',
    linktype: 1,
    packets: [
      { tsSec: 1, tsFrac: 0, data: packet(0, payload.subarray(0, 10)) },
      { tsSec: 1, tsFrac: 100, data: packet(10, payload.subarray(10)) },
    ],
  });
}
