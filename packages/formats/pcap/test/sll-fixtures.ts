import { dnsQuery, icmpv6Echo, ipv4, ipv6, sll2Frame, sllFrame, udp, type PcapPacket } from './build-pcap.js';

/**
 * A `tcpdump -i any`-shaped capture: an IPv4 DNS query, an IPv6 ICMPv6 echo, and an ARP frame
 * (protocol 0x0806) that must stop at `packets`, each behind a Linux cooked-capture header.
 */
export function sllCapturePackets(version: 'sll' | 'sll2'): PcapPacket[] {
  const frame = version === 'sll' ? sllFrame : sll2Frame;
  return [
    {
      tsSec: 1,
      tsFrac: 0,
      data: frame({
        protocol: 0x0800,
        payload: ipv4({
          protocol: 17,
          src: '10.0.0.1',
          dst: '10.0.0.53',
          payload: udp({
            srcPort: 40_000,
            dstPort: 53,
            payload: dnsQuery({ txId: 0x51, name: 'any.example', type: 1 }),
          }),
        }),
      }),
    },
    {
      tsSec: 2,
      tsFrac: 0,
      data: frame({
        protocol: 0x86dd,
        payload: ipv6({
          nextHeader: 58,
          src: '::1',
          dst: '::2',
          payload: icmpv6Echo({ id: 7, seq: 1 }),
        }),
      }),
    },
    { tsSec: 3, tsFrac: 0, data: frame({ protocol: 0x0806, payload: new Uint8Array(28) }) },
  ];
}
