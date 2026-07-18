/**
 * Pure field-flatten helpers: turn already-parsed Kaitai nodes / raw scalars
 * into the simple primitives the pcap projection YAML reads. No Kaitai
 * instantiation happens here — callers pass nodes produced by the compiled
 * `packages/formats/pcap/gen/` parsers (kaitai-struct's JS runtime camelCases
 * `.ksy` field names).
 */

/** TCP flag bits, MSB→LSB order matching `network/tcp_segment.ksy`. */
const TCP_FLAG_BITS: Array<[name: string, mask: number]> = [
  ['CWR', 0x80],
  ['ECE', 0x40],
  ['URG', 0x20],
  ['ACK', 0x10],
  ['PSH', 0x08],
  ['RST', 0x04],
  ['SYN', 0x02],
  ['FIN', 0x01],
];

/**
 * Renders a TCP flags byte as a `|`-joined list of set flag names, e.g.
 * `"SYN|ACK"`. No flags set → `""`.
 */
export function tcpFlags(flagsByte: number): string {
  const set: string[] = [];
  for (const [name, mask] of TCP_FLAG_BITS) {
    if ((flagsByte & mask) !== 0) {
      set.push(name);
    }
  }
  return set.join('|');
}

/** One label of a `DnsPacket.DomainName` (gen/DnsPacket.js `Label`). */
interface DnsLabelNode {
  length: number;
  /** Present only when `length < 192` (i.e. not a compression pointer). */
  name?: string;
}

/** A `DnsPacket.DomainName` node (gen/DnsPacket.js `DomainName`). */
interface DnsDomainNameNode {
  name: DnsLabelNode[];
}

/**
 * Joins a `DomainName` node's uncompressed labels with `.`, e.g.
 * `"www.example.com"`. Returns `null` if the first label is a compression
 * pointer (`length >= 192`) — resolving pointers is out of scope here.
 */
export function dnsName(domainNameNode: DnsDomainNameNode): string | null {
  const labels = domainNameNode.name;
  const first = labels[0];
  if (first === undefined || first.length >= 192) {
    return null;
  }

  const parts: string[] = [];
  for (const label of labels) {
    if (label.length === 0 || label.length >= 192) {
      break;
    }
    parts.push(label.name ?? '');
  }
  return parts.join('.');
}

export interface DnsFlags {
  qr: number;
  opcode: number;
  rcode: number;
}

/** Splits a raw 16-bit DNS flags word into `qr`/`opcode`/`rcode`. */
export function dnsFlags(flag16: number): DnsFlags {
  return {
    qr: (flag16 & 0b1000_0000_0000_0000) >>> 15,
    opcode: (flag16 & 0b0111_1000_0000_0000) >>> 11,
    rcode: (flag16 & 0b0000_0000_0000_1111) >>> 0,
  };
}

/** A `TlsClientHello.ServerName` node. */
interface TlsServerNameNode {
  hostName: Uint8Array;
}

/** A `TlsClientHello.Sni` node — the body of an `Extension` with `type === 0`. */
interface TlsSniNode {
  serverNames: TlsServerNameNode[];
}

/** A `TlsClientHello.Extension` node. */
interface TlsExtensionNode {
  type: number;
  body: unknown;
}

/** A `TlsClientHello` node's optional top-level `extensions` field. */
interface TlsClientHelloNode {
  extensions?: {
    extensions: TlsExtensionNode[];
  };
}

/**
 * Walks a `ClientHello` node's extensions, finds the SNI extension
 * (`type === 0`), and decodes its first server name's host bytes as ASCII.
 * Returns `null` if there is no SNI extension (or no extensions at all).
 */
export function tlsSni(clientHelloNode: TlsClientHelloNode): string | null {
  const extensions = clientHelloNode.extensions?.extensions;
  if (extensions === undefined) {
    return null;
  }

  const sniExtension = extensions.find((extension) => extension.type === 0);
  const sni = sniExtension?.body as TlsSniNode | undefined;
  const hostName = sni?.serverNames[0]?.hostName;
  if (hostName === undefined) {
    return null;
  }
  return new TextDecoder().decode(hostName);
}
