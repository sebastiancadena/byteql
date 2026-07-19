/**
 * pcap stream hooks: the flow-key extractor and message framers the projection
 * YAML's `streams:` section references by id (see `parsers.ts` for the parser
 * registry counterpart). Pure functions over already-parsed wrapper roots
 * (`wrappers.ts`) and raw reassembled bytes.
 */

import type { StreamFramer, StreamKeyExtractor, StreamRegistries } from '@byteql/core';
import { formatIpv4, formatIpv6 } from '@byteql/core';

/** Innermost dissect ancestor that looks like an ip wrapper root. */
interface IpAncestor {
  is_v4: boolean;
  src_addr?: Uint8Array;
  dst_addr?: Uint8Array;
}

const isIpAncestor = (value: unknown): value is IpAncestor =>
  typeof value === 'object' && value !== null && typeof (value as IpAncestor).is_v4 === 'boolean';

/**
 * Directional TCP flow key: "src:sport→dst:dport" plus the flow metadata the
 * `streams` table projects. Null when no IP ancestor or malformed ports — the
 * engine reports STREAM_KEY_INVALID and skips the segment.
 */
export const tcpFlowKey: StreamKeyExtractor = ({ node, ancestors }) => {
  const tcp = node as { src_port?: unknown; dst_port?: unknown };
  if (typeof tcp.src_port !== 'number' || typeof tcp.dst_port !== 'number') return null;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (!isIpAncestor(ancestor)) continue;
    const format = ancestor.is_v4 ? formatIpv4 : formatIpv6;
    const src = format(ancestor.src_addr);
    const dst = format(ancestor.dst_addr);
    if (src === null || dst === null) return null;
    return {
      key: `${src}:${tcp.src_port}→${dst}:${tcp.dst_port}`,
      root: { src_addr: src, src_port: tcp.src_port, dst_addr: dst, dst_port: tcp.dst_port },
    };
  }
  return null;
};

/** TLS content types run 0x14 (change_cipher_spec) through 0x18 (heartbeat). */
const TLS_CONTENT_TYPE_MIN = 0x14;
const TLS_CONTENT_TYPE_MAX = 0x18;
/** TLSPlaintext max fragment (2^14) plus expansion headroom (RFC 8446 record_overflow). */
const TLS_MAX_RECORD_BODY = 16384 + 2048;

export const tlsRecord: StreamFramer = (buffer) => {
  if (buffer.length < 5) return null;
  const contentType = buffer[0]!;
  if (contentType < TLS_CONTENT_TYPE_MIN || contentType > TLS_CONTENT_TYPE_MAX) {
    throw new Error(`not a TLS record: content type ${contentType}`);
  }
  const length = (buffer[3]! << 8) | buffer[4]!;
  if (length === 0 || length > TLS_MAX_RECORD_BODY) {
    throw new Error(`not a TLS record: body length ${length}`);
  }
  return 5 + length;
};

export const dnsTcp: StreamFramer = (buffer) => {
  if (buffer.length < 2) return null;
  const length = (buffer[0]! << 8) | buffer[1]!;
  if (length === 0) throw new Error('zero-length DNS-over-TCP message');
  return 2 + length;
};

export const pcapStreamRegistries: StreamRegistries = {
  keyExtractors: new Map([['tcp_flow_key', tcpFlowKey]]),
  framers: new Map([
    ['tls_record', tlsRecord],
    ['dns_tcp', dnsTcp],
  ]),
};
