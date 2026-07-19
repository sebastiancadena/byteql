import { describe, expect, it } from 'vitest';
import { dnsTcp, tcpFlowKey, tlsRecord } from '../src/streams.js';

const ip4 = (a: number, b: number, c: number, d: number) => Uint8Array.of(a, b, c, d);

describe('tcpFlowKey', () => {
  const tcpNode = { src_port: 40000, dst_port: 53 };
  it('builds a directional key from the innermost IP ancestor', () => {
    const result = tcpFlowKey({
      node: tcpNode,
      ancestors: [
        { linktype: 1 },
        { ether_type: 0x0800 },
        { is_v4: true, src_addr: ip4(10, 0, 0, 1), dst_addr: ip4(10, 0, 0, 2) },
      ],
    });
    expect(result).toEqual({
      key: '10.0.0.1:40000→10.0.0.2:53',
      root: { src_addr: '10.0.0.1', src_port: 40000, dst_addr: '10.0.0.2', dst_port: 53 },
    });
  });
  it('formats IPv6 ancestors', () => {
    const addr = new Uint8Array(16);
    addr[15] = 1; // ::1
    const result = tcpFlowKey({
      node: tcpNode,
      ancestors: [{ is_v4: false, src_addr: addr, dst_addr: addr }],
    });
    expect(result!.root.src_addr).toBe('::1');
  });
  it('returns null without an IP ancestor or with malformed ports', () => {
    expect(tcpFlowKey({ node: tcpNode, ancestors: [{ ether_type: 0x0800 }] })).toBeNull();
    expect(
      tcpFlowKey({
        node: {},
        ancestors: [{ is_v4: true, src_addr: ip4(1, 1, 1, 1), dst_addr: ip4(2, 2, 2, 2) }],
      }),
    ).toBeNull();
  });
});

describe('framers', () => {
  it('tlsRecord frames the 5-byte header + body length, waiting on short headers', () => {
    expect(tlsRecord(Uint8Array.of(0x16, 3, 3))).toBeNull();
    expect(tlsRecord(Uint8Array.of(0x16, 3, 3, 0x00, 0x10))).toBe(5 + 16);
    expect(tlsRecord(Uint8Array.of(0x16, 3, 3, 0x00, 0x10, 1, 2))).toBe(21); // exceeds buffer: engine waits
  });
  it('tlsRecord throws on impossible content types and lengths', () => {
    expect(() => tlsRecord(Uint8Array.of(0x42, 3, 3, 0, 1))).toThrowError(/content type/);
    expect(() => tlsRecord(Uint8Array.of(0x16, 3, 3, 0, 0))).toThrowError(/length/);
    expect(() => tlsRecord(Uint8Array.of(0x16, 3, 3, 0x48, 0x01))).toThrowError(/length/); // > 18432
  });
  it('dnsTcp frames the 2-byte prefix + message, throwing on zero length', () => {
    expect(dnsTcp(Uint8Array.of(0))).toBeNull();
    expect(dnsTcp(Uint8Array.of(0x00, 0x05))).toBe(7);
    expect(() => dnsTcp(Uint8Array.of(0, 0))).toThrowError(/zero-length/);
  });
});
