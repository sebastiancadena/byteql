import { describe, expect, it } from 'vitest';

import { pcapParserRegistry } from '../src/parsers.js';
import {
  dnsOverTcp,
  dnsQuery,
  ethFrame,
  icmpEcho,
  icmpv6Echo,
  icmpv6Type,
  ipv4,
  ipv6,
  tcp,
  tlsClientHello,
  udp,
} from './build-pcap.js';

interface BodyRange {
  bytes: Uint8Array;
  start: number;
}
interface EthernetRoot {
  ether_type: number;
  body: BodyRange;
}
interface Ipv4Root {
  version: number;
  l4_proto: number;
  hop_limit: number;
  length: number;
  is_v4: boolean;
  src_addr: Uint8Array;
  dst_addr: Uint8Array;
  body: BodyRange;
}
interface Ipv6Root {
  version: number;
  l4_proto: number;
  hop_limit: number;
  length: number;
  is_v4: boolean;
  src_addr: Uint8Array;
  dst_addr: Uint8Array;
  body: BodyRange;
}
interface TcpRoot {
  src_port: number;
  dst_port: number;
  seq_num: number;
  ack_num: number;
  flags: string;
  window_size: number;
  body: BodyRange;
}
interface UdpRoot {
  src_port: number;
  dst_port: number;
  length: number;
  body: BodyRange;
}

function parseWith<T>(id: string, bytes: Uint8Array): T {
  const parser = pcapParserRegistry.get(id);
  if (!parser) throw new Error(`no parser registered for ${id}`);
  return parser(bytes).root as T;
}

describe('pcapParserRegistry', () => {
  it('registers all ten layer parsers', () => {
    expect([...pcapParserRegistry.keys()].sort()).toEqual(
      [
        'dns_packet',
        'dns_tcp_message',
        'ethernet_frame',
        'icmp_packet',
        'icmpv6_packet',
        'ipv4_packet',
        'ipv6_packet',
        'tcp_segment',
        'tls_client_hello',
        'udp_datagram',
      ].sort(),
    );
  });

  it('omits a per-row resolver (engine defaults provenance to the payload extent)', () => {
    const result = pcapParserRegistry.get('ethernet_frame')!(
      ethFrame({ etherType: 0x0800, payload: new Uint8Array([1, 2, 3]) }),
    );
    expect(result.resolve).toBeUndefined();
  });

  it('ethernet wrapper exposes ether_type and a payload-relative body range', () => {
    const bytes = ethFrame({ etherType: 0x0800, payload: new Uint8Array([1, 2, 3]) });
    const root = parseWith<EthernetRoot>('ethernet_frame', bytes);
    expect(root.ether_type).toBe(0x0800);
    expect(root.body.start).toBe(14);
    expect([...root.body.bytes]).toEqual([1, 2, 3]);
  });

  it('ipv4 wrapper flattens addresses and exposes a payload-relative body range', () => {
    const bytes = ipv4({
      protocol: 6,
      src: '10.0.0.1',
      dst: '10.0.0.2',
      payload: new Uint8Array([1, 2]),
    });
    const root = parseWith<Ipv4Root>('ipv4_packet', bytes);
    expect(root).toMatchObject({ version: 4, l4_proto: 6, is_v4: true, hop_limit: 64 });
    expect(root.length).toBe(bytes.length);
    expect([...root.src_addr]).toEqual([10, 0, 0, 1]);
    expect([...root.dst_addr]).toEqual([10, 0, 0, 2]);
    expect(root.body.start).toBe(20); // 20-byte header, no options
    expect(root.body.start).toBe(bytes.length - 2);
    expect([...root.body.bytes]).toEqual([1, 2]);
  });

  it('ipv4 body.start stays payload-relative even from a non-zero byteOffset buffer', () => {
    // The real pipeline hands each wrapper a `subarray` view of the file buffer
    // (see container.ts), so `bytes.byteOffset` is non-zero. `body.start` must be
    // relative to bytes[0] (== 20), NOT the absolute ArrayBuffer offset.
    const layer = ipv4({
      protocol: 17,
      src: '1.1.1.1',
      dst: '2.2.2.2',
      payload: new Uint8Array([9, 9]),
    });
    const framed = new Uint8Array(40 + layer.length + 5);
    framed.set(layer, 40);
    const view = framed.subarray(40, 40 + layer.length);
    expect(view.byteOffset).toBe(40);
    const root = parseWith<Ipv4Root>('ipv4_packet', view);
    expect(root.body.start).toBe(20);
    expect([...root.body.bytes]).toEqual([9, 9]);
  });

  it('ipv6 wrapper flattens 16-byte addresses and exposes a 40-byte body range', () => {
    const bytes = ipv6({
      nextHeader: 6,
      src: '::1',
      dst: '2001:db8::1',
      payload: new Uint8Array([7, 8, 9, 10]),
    });
    const root = parseWith<Ipv6Root>('ipv6_packet', bytes);
    expect(root).toMatchObject({ version: 6, l4_proto: 6, is_v4: false, hop_limit: 64 });
    expect(root.length).toBe(44); // payload_length + 40
    expect(root.src_addr.length).toBe(16);
    expect(root.dst_addr.length).toBe(16);
    expect([...root.src_addr.slice(14)]).toEqual([0, 1]);
    expect(root.body.start).toBe(40);
    expect([...root.body.bytes]).toEqual([7, 8, 9, 10]);
  });

  it('ipv6 wrapper reports total on-wire length (payload_length + 40)', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const bytes = ipv6({ nextHeader: 6, src: '::', dst: '::', payload });
    const { root } = pcapParserRegistry.get('ipv6_packet')!(bytes);
    expect(root.length).toBe(payload.length + 40); // 4 + 40 = 44
  });

  it('tcp wrapper renders flags and exposes a 20-byte body range', () => {
    const bytes = tcp({
      srcPort: 1234,
      dstPort: 443,
      flags: 0x12, // ACK|SYN
      payload: new Uint8Array([0xaa, 0xbb]),
    });
    const root = parseWith<TcpRoot>('tcp_segment', bytes);
    expect(root.src_port).toBe(1234);
    expect(root.dst_port).toBe(443);
    expect(root.flags).toBe('ACK|SYN');
    expect(root.window_size).toBe(65535);
    expect(root.body.start).toBe(20);
    expect([...root.body.bytes]).toEqual([0xaa, 0xbb]);
  });

  it('udp wrapper exposes ports, length, and an 8-byte body range', () => {
    const bytes = udp({ srcPort: 5353, dstPort: 53, payload: new Uint8Array([1, 2, 3]) });
    const root = parseWith<UdpRoot>('udp_datagram', bytes);
    expect(root.src_port).toBe(5353);
    expect(root.dst_port).toBe(53);
    expect(root.length).toBe(11); // 8-byte header + 3-byte payload
    expect(root.body.start).toBe(8);
    expect([...root.body.bytes]).toEqual([1, 2, 3]);
  });

  it('dns wrapper flattens the first query name/type and decodes flags', () => {
    const bytes = dnsQuery({ txId: 0x1234, name: 'example.com', type: 1 });
    const root = parseWith<{
      message: {
        transaction_id: number;
        qr: number;
        opcode: number;
        rcode: number;
        qdcount: number;
        ancount: number;
        query_name: string | null;
        query_type: number | null;
      };
    }>('dns_packet', bytes);
    expect(root.message.transaction_id).toBe(0x1234);
    expect(root.message.qr).toBe(0);
    expect(root.message.opcode).toBe(0);
    expect(root.message.rcode).toBe(0);
    expect(root.message.qdcount).toBe(1);
    expect(root.message.ancount).toBe(0);
    expect(root.message.query_name).toBe('example.com');
    expect(root.message.query_type).toBe(1);
  });

  it('icmp wrapper surfaces echo id/seq for an echo request', () => {
    const bytes = icmpEcho({ id: 7, seq: 3 });
    const root = parseWith<{
      icmp_type: number;
      echo_id: number | null;
      echo_seq: number | null;
    }>('icmp_packet', bytes);
    expect(root.icmp_type).toBe(8); // echo
    expect(root.echo_id).toBe(7);
    expect(root.echo_seq).toBe(3);
  });

  it('icmp wrapper leaves echo id/seq null for a non-echo message', () => {
    // destination_unreachable (type 3): icmp_type(1) + code(1) + checksum(2),
    // per network/icmp_packet.ksy's `destination_unreachable_msg` — no `echo` field.
    const bytes = Uint8Array.of(3, 0, 0x00, 0x00);
    const root = parseWith<{
      icmp_type: number;
      echo_id: number | null;
      echo_seq: number | null;
    }>('icmp_packet', bytes);
    expect(root.icmp_type).toBe(3); // destination unreachable
    expect(root.echo_id).toBeNull();
    expect(root.echo_seq).toBeNull();
  });

  it('icmpv6 wrapper flattens an echo request', () => {
    const bytes = icmpv6Echo({ id: 0xabcd, seq: 7 }); // type 128
    const { root } = pcapParserRegistry.get('icmpv6_packet')!(bytes);
    expect(root).toMatchObject({ icmp_type: 128, code: 0, echo_id: 0xabcd, echo_seq: 7 });
  });

  it('icmpv6 wrapper leaves echo fields null for a non-echo type', () => {
    const bytes = icmpv6Type({ type: 1, code: 0 }); // destination unreachable
    const { root } = pcapParserRegistry.get('icmpv6_packet')!(bytes);
    expect(root).toMatchObject({ icmp_type: 1, echo_id: null, echo_seq: null });
  });

  it('dns_tcp_message emits a message for a length-prefixed DNS query', () => {
    const bytes = dnsOverTcp({ txId: 0x1234, name: 'a.ru', type: 1 });
    const { root } = pcapParserRegistry.get('dns_tcp_message')!(bytes);
    expect(root.message.query_name).toBe('a.ru');
  });

  it('dns_tcp_message emits nothing for an empty/handshake segment', () => {
    expect(pcapParserRegistry.get('dns_tcp_message')!(new Uint8Array(0)).root).toEqual({});
    expect(pcapParserRegistry.get('dns_tcp_message')!(new Uint8Array([0, 0])).root).toEqual({});
  });

  it('dns_tcp_message emits nothing when the message spans segments (over-length prefix)', () => {
    const full = dnsOverTcp({ txId: 1, name: 'a.ru', type: 1 });
    const truncated = full.subarray(0, full.length - 1); // declared length now exceeds available
    expect(pcapParserRegistry.get('dns_tcp_message')!(truncated).root).toEqual({});
  });

  it('tls wrapper emits client_hello only for a ClientHello and extracts SNI', () => {
    const hello = tlsClientHello({ sni: 'secure.example' });
    const notHello = new Uint8Array([0x17, 0x03, 0x03, 0, 1, 0]); // app-data record
    expect(pcapParserRegistry.get('tls_client_hello')!(hello).root).toMatchObject({
      client_hello: { sni: 'secure.example', tls_version: '3.3' },
    });
    expect(pcapParserRegistry.get('tls_client_hello')!(notHello).root).toEqual({});
  });
});
