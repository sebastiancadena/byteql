/**
 * Kaitai layer wrappers: each parses one network layer's payload with the compiled `gen/`
 * parser and flattens it into the node the pcap YAML reads; `body` is a `payload()` range (see
 * `@byteql/core/kaitai` for the offset convention). Every root is total: optional fields are
 * explicit `null` when absent, so strict-field projection never sees a missing key.
 */

import type { RecordParser } from '@byteql/core';
import { kaitaiParse as parse, payload } from '@byteql/core/kaitai';

import dnsModule from '../gen/DnsPacket.js';
import ethernetModule from '../gen/EthernetFrame.js';
import icmpModule from '../gen/IcmpPacket.js';
import icmpv6Module from '../gen/Icmpv6Packet.js';
import ipv4Module from '../gen/Ipv4Packet.js';
import ipv6Module from '../gen/Ipv6Packet.js';
import linuxSllModule from '../gen/LinuxSll.js';
import linuxSll2Module from '../gen/LinuxSll2.js';
import tcpModule from '../gen/TcpSegment.js';
import tlsModule from '../gen/TlsClientHello.js';
import udpModule from '../gen/UdpDatagram.js';
import { dnsFlags, dnsName, tcpFlags, tlsSni } from './flatten.js';

const { DnsPacket } = dnsModule;
const { EthernetFrame } = ethernetModule;
const { IcmpPacket } = icmpModule;
const { Icmpv6Packet } = icmpv6Module;
const { Ipv4Packet } = ipv4Module;
const { Ipv6Packet } = ipv6Module;
const { LinuxSll } = linuxSllModule;
const { LinuxSll2 } = linuxSll2Module;
const { TcpSegment } = tcpModule;
const { TlsClientHello } = tlsModule;
const { UdpDatagram } = udpModule;

/** TLS record content type for a handshake record. */
const TLS_RECORD_HANDSHAKE = 0x16;
/** TLS handshake message type for a ClientHello. */
const TLS_HANDSHAKE_CLIENT_HELLO = 0x01;
/** Bytes to skip past the 5-byte TLS record header + 4-byte handshake header. */
const TLS_CLIENT_HELLO_BODY_OFFSET = 9;

export const ethernetFrame: RecordParser = (bytes) => {
  const parsed = parse(EthernetFrame, bytes);
  return { root: { ether_type: parsed.etherType, body: payload(parsed, 'body') } };
};

/** Linux cooked capture v1 (linktype 113): `protocol` is an Ethernet type, like `ether_type`. */
export const linuxSll: RecordParser = (bytes) => {
  const parsed = parse(LinuxSll, bytes);
  return { root: { protocol: parsed.protocol, body: payload(parsed, 'body') } };
};

/** Linux cooked capture v2 (linktype 276). */
export const linuxSll2: RecordParser = (bytes) => {
  const parsed = parse(LinuxSll2, bytes);
  return { root: { protocol: parsed.protocol, body: payload(parsed, 'body') } };
};

export const ipv4Packet: RecordParser = (bytes) => {
  const parsed = parse(Ipv4Packet, bytes);
  return {
    root: {
      version: 4,
      l4_proto: parsed.protocol,
      hop_limit: parsed.ttl,
      length: parsed.totalLength,
      is_v4: true,
      src_addr: parsed.srcIpAddr,
      dst_addr: parsed.dstIpAddr,
      body: payload(parsed, 'body'),
    },
  };
};

export const ipv6Packet: RecordParser = (bytes) => {
  const parsed = parse(Ipv6Packet, bytes);
  return {
    root: {
      version: 6,
      l4_proto: parsed.nextHeaderType,
      hop_limit: parsed.hopLimit,
      length: parsed.payloadLength + 40,
      is_v4: false,
      src_addr: parsed.srcIpv6Addr,
      dst_addr: parsed.dstIpv6Addr,
      body: payload(parsed, 'body'),
    },
  };
};

export const tcpSegment: RecordParser = (bytes) => {
  const parsed = parse(TcpSegment, bytes);
  const f = parsed.flags;
  const flagsByte =
    (f.cwr ? 0x80 : 0) |
    (f.ece ? 0x40 : 0) |
    (f.urg ? 0x20 : 0) |
    (f.ack ? 0x10 : 0) |
    (f.psh ? 0x08 : 0) |
    (f.rst ? 0x04 : 0) |
    (f.syn ? 0x02 : 0) |
    (f.fin ? 0x01 : 0);
  return {
    root: {
      src_port: parsed.srcPort,
      dst_port: parsed.dstPort,
      seq_num: parsed.seqNum,
      ack_num: parsed.ackNum,
      // Raw SYN flag: stream `offset` expressions need it to apply standard-forensic
      // sequence-number semantics (a SYN consumes one sequence number, so a SYN+data
      // payload starts at seq+1).
      syn: f.syn,
      flags: tcpFlags(flagsByte),
      window_size: parsed.windowSize,
      body: payload(parsed, 'body'),
    },
  };
};

export const udpDatagram: RecordParser = (bytes) => {
  const parsed = parse(UdpDatagram, bytes);
  return {
    root: {
      src_port: parsed.srcPort,
      dst_port: parsed.dstPort,
      length: parsed.length,
      body: payload(parsed, 'body'),
    },
  };
};

/** Flattens a parsed `DnsPacket` into the fields the `dns` table's `$.message` anchor reads. */
const flattenDns = (parsed: InstanceType<typeof DnsPacket>) => {
  const { qr, opcode, rcode } = dnsFlags(parsed.flags.flag);
  const qdcount = parsed.qdcount ?? 0;
  const firstQuery = qdcount > 0 ? parsed.queries?.[0] : undefined;
  return {
    transaction_id: parsed.transactionId,
    qr,
    opcode,
    rcode,
    qdcount,
    ancount: parsed.ancount ?? 0,
    query_name: firstQuery ? dnsName(firstQuery.name) : null,
    query_type: firstQuery ? firstQuery.type : null,
  };
};

export const dnsPacket: RecordParser = (bytes) => ({
  root: { message: flattenDns(parse(DnsPacket, bytes)) },
});

/**
 * DNS-over-TCP: a 2-byte BE length prefix followed by the DNS message. Fed exclusively as the
 * `dns_tcp_stream` message parser, on framer-delimited, reassembled bytes where completeness is
 * already guaranteed — a single TCP segment carrying a complete message is just the degenerate,
 * one-contribution case of that same stream path, not a separate feed. Conditional emission
 * (`{ root: {} }`, per the `tlsClientHello` pattern above) covers empty/handshake segments and a
 * declared length that doesn't fit the available bytes; that guard is defensive only — the
 * `dnsTcp` framer (`streams.ts`) never hands this a short buffer.
 */
export const dnsTcpMessage: RecordParser = (bytes) => {
  if (bytes.length < 2) return { root: {} };
  const declaredLen = (bytes[0]! << 8) | bytes[1]!;
  if (declaredLen === 0 || 2 + declaredLen > bytes.length) return { root: {} };
  return { root: { message: flattenDns(parse(DnsPacket, bytes.subarray(2, 2 + declaredLen))) } };
};

export const icmpPacket: RecordParser = (bytes) => {
  const parsed = parse(IcmpPacket, bytes);
  const echo = parsed.echo;
  return {
    root: {
      icmp_type: parsed.icmpType,
      echo_id: echo ? echo.identifier : null,
      echo_seq: echo ? echo.seqNum : null,
    },
  };
};

export const icmpv6Packet: RecordParser = (bytes) => {
  const parsed = parse(Icmpv6Packet, bytes);
  const echo = parsed.echo;
  return {
    root: {
      icmp_type: parsed.icmpType,
      code: parsed.code,
      echo_id: echo ? echo.identifier : null,
      echo_seq: echo ? echo.seqNum : null,
    },
  };
};

export const tlsClientHello: RecordParser = (bytes) => {
  if (bytes[0] !== TLS_RECORD_HANDSHAKE || bytes[5] !== TLS_HANDSHAKE_CLIENT_HELLO) {
    return { root: {} };
  }
  const parsed = parse(TlsClientHello, bytes.subarray(TLS_CLIENT_HELLO_BODY_OFFSET));
  return {
    root: {
      client_hello: {
        tls_version: `${parsed.version.major}.${parsed.version.minor}`,
        sni: tlsSni(parsed),
      },
    },
  };
};
