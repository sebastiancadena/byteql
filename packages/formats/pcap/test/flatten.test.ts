import { describe, expect, it } from 'vitest';

import { dnsFlags, dnsName, tcpFlags, tlsSni } from '../src/flatten.js';

describe('tcpFlags', () => {
  it('decodes ACK|SYN in CWR,ECE,URG,ACK,PSH,RST,SYN,FIN order', () => {
    // 0x12 = 0x10 ACK | 0x02 SYN; ACK sorts before SYN per the stated field order
    // (confirmed by tcp_segment.ksy's own `to-string` template).
    expect(tcpFlags(0x12)).toBe('ACK|SYN');
  });

  it('returns an empty string for no flags set', () => {
    expect(tcpFlags(0)).toBe('');
  });

  it('orders flags CWR,ECE,URG,ACK,PSH,RST,SYN,FIN', () => {
    expect(tcpFlags(0xff)).toBe('CWR|ECE|URG|ACK|PSH|RST|SYN|FIN');
  });
});

describe('dnsName', () => {
  it('joins uncompressed labels with a dot', () => {
    const node = {
      name: [
        { length: 3, name: 'www' },
        { length: 7, name: 'example' },
        { length: 3, name: 'com' },
        { length: 0 },
      ],
    };
    expect(dnsName(node)).toBe('www.example.com');
  });

  it('returns null when the first label is a compression pointer', () => {
    expect(dnsName({ name: [{ length: 0xc0 }] })).toBeNull();
  });
});

describe('dnsFlags', () => {
  it('splits qr/opcode/rcode out of a standard-response flag word', () => {
    expect(dnsFlags(0x8180)).toEqual({ qr: 1, opcode: 0, rcode: 0 });
  });
});

describe('tlsSni', () => {
  it('finds the SNI extension (type 0) and decodes the first server name as ASCII', () => {
    // Shape matches gen/TlsClientHello.js: ClientHello.extensions.extensions[]
    // (Extension { type, body }); for type === 0, body is Sni { listLength, serverNames[] }
    // (ServerName { nameType, length, hostName: Uint8Array }).
    const hostName = new Uint8Array([...'a.com'].map((c) => c.charCodeAt(0)));
    const clientHello = {
      extensions: {
        len: 0,
        extensions: [
          {
            type: 16, // ALPN — not SNI, should be skipped
            len: 0,
            body: {},
          },
          {
            type: 0,
            len: 0,
            body: {
              listLength: 0,
              serverNames: [{ nameType: 0, length: hostName.length, hostName }],
            },
          },
        ],
      },
    };
    expect(tlsSni(clientHello)).toBe('a.com');
  });

  it('returns null when there is no SNI extension', () => {
    const clientHello = { extensions: { len: 0, extensions: [] } };
    expect(tlsSni(clientHello)).toBeNull();
  });

  it('returns null when there are no extensions at all', () => {
    expect(tlsSni({})).toBeNull();
  });
});
