/**
 * Kaitai layer wrappers. Each wrapper parses one network layer's payload bytes
 * with the compiled `gen/` parser and flattens the tree into the simple
 * projection node the pcap YAML reads (see `parsers.ts` for the registry).
 *
 * `body: { bytes, start }` is a `PayloadRange` the projection engine dissects
 * deeper: `bytes` is the layer's payload (a Kaitai `subarray` view) and `start`
 * is that payload's offset **relative to the buffer this wrapper was handed**
 * (i.e. relative to `bytes[0]`). That is exactly Kaitai's `_debug.<field>.start`
 * (`this._io.pos` at the field), and NOT `ioOffset + start`: the engine composes
 * absolute provenance as `baseOffset + payload.start`, and because the real
 * pipeline hands each wrapper a non-zero-`byteOffset` view of the file buffer
 * (see `container.ts`), `ioOffset` is the absolute ArrayBuffer offset — adding it
 * would double-count the enclosing layers. Verified in `wrappers.test.ts`.
 *
 * Wrappers let `_read()` throw on malformed bytes; the engine turns the throw
 * into a `DISSECT_PARSE_FAILED` errors row. None of them attach a `resolve` —
 * the layer tables are all `$`-anchored, so the engine's default (the full
 * payload extent) is the correct provenance for every dissected row.
 */

import KaitaiStream from 'kaitai-struct/KaitaiStream.js';

import type { RecordParser } from '@byteql/core';

import dnsModule from '../gen/DnsPacket.js';
import ethernetModule from '../gen/EthernetFrame.js';
import icmpModule from '../gen/IcmpPacket.js';
import icmpv6Module from '../gen/Icmpv6Packet.js';
import ipv4Module from '../gen/Ipv4Packet.js';
import ipv6Module from '../gen/Ipv6Packet.js';
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
const { TcpSegment } = tcpModule;
const { TlsClientHello } = tlsModule;
const { UdpDatagram } = udpModule;

/** TLS record content type for a handshake record. */
const TLS_RECORD_HANDSHAKE = 0x16;
/** TLS handshake message type for a ClientHello. */
const TLS_HANDSHAKE_CLIENT_HELLO = 0x01;
/** Bytes to skip past the 5-byte TLS record header + 4-byte handshake header. */
const TLS_CLIENT_HELLO_BODY_OFFSET = 9;

interface KaitaiParser {
  _read(): void;
}

/** Constructs `GenClass` over `bytes` and runs `_read()` (may throw). */
function parse<T extends KaitaiParser>(GenClass: new (stream: unknown) => T, bytes: Uint8Array): T {
  const stream = new KaitaiStream(
    new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength),
  );
  const parsed = new GenClass(stream);
  parsed._read();
  return parsed;
}

/** A parsed node whose `body` was read from the top-level stream. */
interface WithBody {
  body: Uint8Array;
  _debug: { body: { start: number } };
}

/** The payload-relative `{ bytes, start }` range the engine dissects deeper. */
function bodyRange(parsed: WithBody): { bytes: Uint8Array; start: number } {
  return { bytes: parsed.body, start: parsed._debug.body.start };
}

export const ethernetFrame: RecordParser = (bytes) => {
  const parsed = parse(EthernetFrame, bytes);
  return { root: { ether_type: parsed.etherType, body: bodyRange(parsed) } };
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
      body: bodyRange(parsed),
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
      body: bodyRange(parsed),
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
      body: bodyRange(parsed),
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
      body: bodyRange(parsed),
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
