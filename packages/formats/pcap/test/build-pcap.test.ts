import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
  buildPcap,
  dnsQuery,
  ethFrame,
  icmpEcho,
  ipv4,
  ipv6,
  tcp,
  tlsClientHello,
  udp,
} from './build-pcap.js';

const require = createRequire(import.meta.url);

describe('buildPcap', () => {
  it('writes a 24-byte global header then one record', () => {
    const pcap = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [{ tsSec: 1, tsFrac: 2, data: new Uint8Array([9, 9]) }],
    });
    const view = new DataView(pcap.buffer, pcap.byteOffset, pcap.byteLength);
    expect(view.getUint32(0, false)).toBe(0xa1b2c3d4); // be microseconds
    expect(view.getUint32(20, false)).toBe(1); // linktype ethernet
    expect(view.getUint32(24, false)).toBe(1); // ts_sec of record 0
    expect(view.getUint32(32, false)).toBe(2); // incl_len = data.length
    expect([...pcap.subarray(40, 42)]).toEqual([9, 9]); // record body
  });

  it('honors little-endian magics for header fields', () => {
    const pcap = buildPcap({
      magic: 'le_ns',
      linktype: 1,
      packets: [{ tsSec: 7, tsFrac: 42, data: new Uint8Array([1]) }],
    });
    const view = new DataView(pcap.buffer, pcap.byteOffset, pcap.byteLength);
    expect(view.getUint32(0, false)).toBe(0x4d3cb2a1); // magic bytes are wire-order, not endian-flipped
    expect(view.getUint32(20, true)).toBe(1); // linktype, little-endian
    expect(view.getUint32(24, true)).toBe(7); // ts_sec, little-endian
    expect(view.getUint32(28, true)).toBe(42); // ts_nsec, little-endian
  });

  it('concatenates multiple records back to back', () => {
    const pcap = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [
        { tsSec: 1, tsFrac: 0, data: new Uint8Array([1, 2, 3]) },
        { tsSec: 2, tsFrac: 0, data: new Uint8Array([4, 5]) },
      ],
    });
    // 24 (global) + 16 + 3 (record 0) + 16 + 2 (record 1)
    expect(pcap.byteLength).toBe(24 + 19 + 18);
    const view = new DataView(pcap.buffer, pcap.byteOffset, pcap.byteLength);
    expect(view.getUint32(24, false)).toBe(1); // record 0 ts_sec
    expect(view.getUint32(24 + 16 + 3, false)).toBe(2); // record 1 ts_sec
  });
});

describe('layer helpers round-trip through the compiled parsers', () => {
  it('ipv4 sets a correct total_length and body so the gen parser reads it back', () => {
    const KaitaiStream = require('kaitai-struct/KaitaiStream.js');
    const { Ipv4Packet } = require('../gen/Ipv4Packet.js');
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const bytes = ipv4({ protocol: 6, src: '10.0.0.1', dst: '10.0.0.2', payload });
    const p = new Ipv4Packet(
      new KaitaiStream(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
    );
    p._read();
    expect(bytes[0]).toBe(0x45); // version 4, IHL 5
    expect(p.protocol).toBe(6);
    expect(p.totalLength).toBe(20 + payload.length);
    expect([...p.body]).toEqual([...payload]);
  });

  it('tcp sets data_offset=5 and the flags byte so the gen parser reads seq/ack/flags back', () => {
    const KaitaiStream = require('kaitai-struct/KaitaiStream.js');
    const { TcpSegment } = require('../gen/TcpSegment.js');
    const payload = new Uint8Array([1, 2]);
    const bytes = tcp({ srcPort: 1234, dstPort: 80, flags: 0x02, payload }); // SYN
    const p = new TcpSegment(
      new KaitaiStream(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
    );
    p._read();
    expect(bytes[12]).toBe(0x50); // data_offset=5, reserved=0
    expect(p.srcPort).toBe(1234);
    expect(p.dstPort).toBe(80);
    expect(p.flags.syn).toBe(true);
    expect([...p.body]).toEqual([...payload]);
  });

  it('tcp writes a caller-supplied seq_num so the gen parser reads it back', () => {
    const KaitaiStream = require('kaitai-struct/KaitaiStream.js');
    const { TcpSegment } = require('../gen/TcpSegment.js');
    const payload = new Uint8Array([1, 2]);
    const bytes = tcp({ srcPort: 1234, dstPort: 80, flags: 0x18, payload, seq: 1000 });
    const p = new TcpSegment(
      new KaitaiStream(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
    );
    p._read();
    expect(p.seqNum).toBe(1000);
  });

  it('udp sets length = 8 + payload.length', () => {
    const KaitaiStream = require('kaitai-struct/KaitaiStream.js');
    const { UdpDatagram } = require('../gen/UdpDatagram.js');
    const payload = new Uint8Array([7, 8, 9, 10]);
    const bytes = udp({ srcPort: 53, dstPort: 5353, payload });
    const p = new UdpDatagram(
      new KaitaiStream(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
    );
    p._read();
    expect(p.length).toBe(8 + payload.length);
    expect([...p.body]).toEqual([...payload]);
  });

  it('dnsQuery encodes a QNAME the gen parser can decode', () => {
    const KaitaiStream = require('kaitai-struct/KaitaiStream.js');
    const { DnsPacket } = require('../gen/DnsPacket.js');
    const bytes = dnsQuery({ txId: 0xabcd, name: 'example.com', type: 1 });
    const p = new DnsPacket(new KaitaiStream(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
    p._read();
    expect(p.transactionId).toBe(0xabcd);
    expect(p.qdcount).toBe(1);
    expect(p.queries[0].name.name.map((label: { name: string }) => label.name)).toEqual([
      'example',
      'com',
      '',
    ]);
    expect(p.queries[0].type).toBe(1);
  });

  it('icmpEcho round-trips identifier and sequence', () => {
    const KaitaiStream = require('kaitai-struct/KaitaiStream.js');
    const { IcmpPacket } = require('../gen/IcmpPacket.js');
    const bytes = icmpEcho({ id: 42, seq: 7 });
    const p = new IcmpPacket(
      new KaitaiStream(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
    );
    p._read();
    expect(p.echo.identifier).toBe(42);
    expect(p.echo.seqNum).toBe(7);
  });

  it('tlsClientHello starts with a record header (0x16) and a ClientHello handshake type (0x01) at byte 5', () => {
    const bytes = tlsClientHello({ sni: 'example.com' });
    expect(bytes[0]).toBe(0x16); // TLS record type: handshake
    expect(bytes[1]).toBe(0x03); // legacy record version 3.3
    expect(bytes[2]).toBe(0x03);
    expect(bytes[5]).toBe(0x01); // handshake type: client_hello

    // The gen/TlsClientHello parser only covers the ClientHello body (no record/handshake
    // header), so a wrapper must strip the first 9 bytes before feeding it in — do that here
    // to prove the body itself is well-formed.
    const KaitaiStream = require('kaitai-struct/KaitaiStream.js');
    const { TlsClientHello } = require('../gen/TlsClientHello.js');
    const body = bytes.subarray(9);
    const p = new TlsClientHello(
      new KaitaiStream(new DataView(body.buffer, body.byteOffset, body.byteLength)),
    );
    p._read();
    const sniExtension = p.extensions.extensions[0];
    expect(sniExtension.type).toBe(0);
    const hostName = sniExtension.body.serverNames[0].hostName as Uint8Array;
    expect(new TextDecoder().decode(hostName)).toBe('example.com');
  });

  it('ethFrame + ipv6 round-trip through gen parsers', () => {
    const KaitaiStream = require('kaitai-struct/KaitaiStream.js');
    const { EthernetFrame } = require('../gen/EthernetFrame.js');
    const { Ipv6Packet } = require('../gen/Ipv6Packet.js');
    const inner = new Uint8Array([1, 2, 3, 4]);
    const ip6 = ipv6({ nextHeader: 17, src: '::1', dst: '::2', payload: inner });
    const frame = ethFrame({ etherType: 0x86dd, payload: ip6 });
    const eth = new EthernetFrame(
      new KaitaiStream(new DataView(frame.buffer, frame.byteOffset, frame.byteLength)),
    );
    eth._read();
    expect([...eth.body]).toEqual([...ip6]);
    const p = new Ipv6Packet(new KaitaiStream(new DataView(ip6.buffer, ip6.byteOffset, ip6.byteLength)));
    p._read();
    expect(p.nextHeaderType).toBe(17);
    expect(p.payloadLength).toBe(inner.length);
    expect([...p.body]).toEqual([...inner]);
  });
});
