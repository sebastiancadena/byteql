/**
 * The pcap dissect parser registry: the eight layer wrappers keyed by the
 * parser ids the projection YAML references in its `dissect` chains. The
 * projection engine looks each id up here, calls the `RecordParser` with the
 * enclosing layer's payload bytes, and projects the flattened `root` (see
 * `wrappers.ts`).
 */

import type { ParserRegistry, RecordParser } from '@byteql/core';

import {
  dnsPacket,
  ethernetFrame,
  icmpPacket,
  ipv4Packet,
  ipv6Packet,
  tcpSegment,
  tlsClientHello,
  udpDatagram,
} from './wrappers.js';

export const pcapParserRegistry: ParserRegistry = new Map<string, RecordParser>([
  ['ethernet_frame', ethernetFrame],
  ['ipv4_packet', ipv4Packet],
  ['ipv6_packet', ipv6Packet],
  ['tcp_segment', tcpSegment],
  ['udp_datagram', udpDatagram],
  ['dns_packet', dnsPacket],
  ['icmp_packet', icmpPacket],
  ['tls_client_hello', tlsClientHello],
]);
