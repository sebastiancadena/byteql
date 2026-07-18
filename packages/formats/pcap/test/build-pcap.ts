/**
 * Deterministic `.pcap` and network-layer byte builders, for tests only.
 *
 * These are hand-rolled `DataView` writers (no network access, no third-party pcap
 * writer library) that produce byte-exact fixtures matching the field order pinned
 * in `packages/formats/pcap/network/*.ksy` (see `PATCHES.md` for how `ksy/` derives
 * from those). Every helper returns a `Uint8Array` and later tasks (framer, wrapper,
 * projection, e2e tests) compose them to build `.pcap` captures without recording
 * real traffic.
 */

// ---------------------------------------------------------------------------
// pcap global/record headers (network/pcap.ksy)
// ---------------------------------------------------------------------------

/** The four magic-number spellings from `network/pcap.ksy`'s `magic` enum. */
export type PcapMagic = 'be_us' | 'be_ns' | 'le_us' | 'le_ns';

/**
 * Magic number bytes, always written in this exact byte order regardless of the
 * endianness the magic selects for the rest of the header — `pcap.ksy` reads
 * `magic_number` as a fixed `u4be` and *that read* is what tells the parser
 * which endianness to use for every other field.
 */
const PCAP_MAGIC_BYTES: Record<PcapMagic, number> = {
  be_us: 0xa1b2c3d4,
  be_ns: 0xa1b23c4d,
  le_us: 0xd4c3b2a1,
  le_ns: 0x4d3cb2a1,
};

function isLittleEndianMagic(magic: PcapMagic): boolean {
  return magic === 'le_us' || magic === 'le_ns';
}

export interface PcapPacket {
  /** `ts_sec`: seconds since epoch. */
  tsSec: number;
  /** `ts_usec`/`ts_nsec` depending on the magic (microseconds or nanoseconds). */
  tsFrac: number;
  /** Captured bytes; `incl_len` and `orig_len` are both set to `data.length`. */
  data: Uint8Array;
}

export interface BuildPcapOptions {
  magic: PcapMagic;
  /** `network` / linktype, e.g. `1` for Ethernet. */
  linktype: number;
  packets: PcapPacket[];
}

const PCAP_GLOBAL_HEADER_SIZE = 24;
const PCAP_RECORD_HEADER_SIZE = 16;

/**
 * Builds a full `.pcap` file: a 24-byte global header followed by one 16-byte
 * record header + raw bytes per packet. Field order and sizes follow
 * `network/pcap.ksy`'s `header` and `packet` types verbatim.
 */
export function buildPcap({ magic, linktype, packets }: BuildPcapOptions): Uint8Array {
  const littleEndian = isLittleEndianMagic(magic);
  const totalDataLength = packets.reduce((sum, packet) => sum + packet.data.length, 0);
  const totalLength = PCAP_GLOBAL_HEADER_SIZE + packets.length * PCAP_RECORD_HEADER_SIZE + totalDataLength;

  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);

  // --- global header (24 bytes) ---
  view.setUint32(0, PCAP_MAGIC_BYTES[magic], false); // magic_number: always big-endian on the wire
  view.setUint16(4, 2, littleEndian); // version_major
  view.setUint16(6, 4, littleEndian); // version_minor
  view.setInt32(8, 0, littleEndian); // thiszone
  view.setUint32(12, 0, littleEndian); // sigfigs
  view.setUint32(16, 65535, littleEndian); // snaplen
  view.setUint32(20, linktype, littleEndian); // network (linktype)

  // --- one record header + body per packet ---
  let offset = PCAP_GLOBAL_HEADER_SIZE;
  for (const packet of packets) {
    view.setUint32(offset, packet.tsSec, littleEndian); // ts_sec
    view.setUint32(offset + 4, packet.tsFrac, littleEndian); // ts_usec / ts_nsec
    view.setUint32(offset + 8, packet.data.length, littleEndian); // incl_len
    view.setUint32(offset + 12, packet.data.length, littleEndian); // orig_len
    bytes.set(packet.data, offset + PCAP_RECORD_HEADER_SIZE);
    offset += PCAP_RECORD_HEADER_SIZE + packet.data.length;
  }

  return bytes;
}

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/** Parses "a.b.c.d" into 4 bytes, in wire order. */
function parseIpv4Address(address: string): Uint8Array {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    throw new Error(`invalid IPv4 address: ${address}`);
  }
  return Uint8Array.from(octets);
}

/**
 * Parses an IPv6 address (full or "::"-compressed form, e.g. "::1" or "2001:db8::1")
 * into 16 bytes, in wire order. Deliberately minimal — enough for deterministic
 * test fixtures, not a full RFC 4291 parser.
 */
function parseIpv6Address(address: string): Uint8Array {
  const [head, tail] = address.split('::');
  const headGroups = head ? head.split(':').filter((g) => g.length > 0) : [];
  const tailGroups = tail ? tail.split(':').filter((g) => g.length > 0) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (address.includes('::') ? missing < 0 : missing !== 0) {
    throw new Error(`invalid IPv6 address: ${address}`);
  }
  const groups = address.includes('::')
    ? [...headGroups, ...Array(missing).fill('0'), ...tailGroups]
    : headGroups;
  if (groups.length !== 8) {
    throw new Error(`invalid IPv6 address: ${address}`);
  }
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  groups.forEach((group, index) => {
    view.setUint16(index * 2, Number.parseInt(group, 16), false);
  });
  return bytes;
}

/** Concatenates byte arrays into one `Uint8Array`. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Encodes a dotted DNS name ("example.com") as QNAME wire format: each label
 * is a length byte followed by its ASCII bytes, terminated by a `0x00` root
 * label (network/dns_packet.ksy's `domain_name`/`label` types).
 */
function encodeQName(name: string): Uint8Array {
  const labels = name.length === 0 ? [] : name.split('.');
  const parts: Uint8Array[] = [];
  for (const label of labels) {
    const labelBytes = textEncoder.encode(label);
    if (labelBytes.length > 63) {
      throw new Error(`DNS label too long: ${label}`);
    }
    parts.push(Uint8Array.of(labelBytes.length), labelBytes);
  }
  parts.push(Uint8Array.of(0)); // root label
  return concatBytes(...parts);
}

// ---------------------------------------------------------------------------
// Ethernet (network/ethernet_frame.ksy)
// ---------------------------------------------------------------------------

export interface EthFrameOptions {
  /** ether_type_1, e.g. 0x0800 for IPv4, 0x86dd for IPv6. */
  etherType: number;
  payload: Uint8Array;
}

// Fixed, deterministic placeholder MAC addresses — the dissect layer routes on
// ether_type, not on these addresses, so any distinct, recognizable values do.
const ETH_DST_MAC = Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x00, 0x01);
const ETH_SRC_MAC = Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x00, 0x02);

/** Builds a minimal Ethernet II frame: dst(6) + src(6) + ethertype(2) + payload. */
export function ethFrame({ etherType, payload }: EthFrameOptions): Uint8Array {
  const bytes = new Uint8Array(14 + payload.length);
  bytes.set(ETH_DST_MAC, 0);
  bytes.set(ETH_SRC_MAC, 6);
  new DataView(bytes.buffer).setUint16(12, etherType, false); // ether_type_1, big-endian
  bytes.set(payload, 14);
  return bytes;
}

// ---------------------------------------------------------------------------
// IPv4 (network/ipv4_packet.ksy)
// ---------------------------------------------------------------------------

export interface Ipv4Options {
  protocol: number;
  src: string;
  dst: string;
  payload: Uint8Array;
}

const IPV4_HEADER_SIZE = 20; // version+ihl(1) + b2(1) + total_length(2) + id(2) + b67(2) + ttl(1) + protocol(1) + checksum(2) + src(4) + dst(4)

/**
 * Builds a minimal (no-options) IPv4 header + payload. `total_length` is set to
 * `20 + payload.length` — the patched parser derives `body size = total_length -
 * ihl_bytes`, so this field must be exact or the body slice is corrupted.
 */
export function ipv4({ protocol, src, dst, payload }: Ipv4Options): Uint8Array {
  const bytes = new Uint8Array(IPV4_HEADER_SIZE + payload.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x45; // b1: version=4 (high nibble), ihl=5 (low nibble) -> 20-byte header, no options
  bytes[1] = 0x00; // b2: DSCP/ECN, unused
  view.setUint16(2, IPV4_HEADER_SIZE + payload.length, false); // total_length
  view.setUint16(4, 0, false); // identification
  view.setUint16(6, 0, false); // b67: flags + fragment offset, no fragmentation
  bytes[8] = 64; // ttl
  bytes[9] = protocol;
  view.setUint16(10, 0, false); // header_checksum (unvalidated by the parser)
  bytes.set(parseIpv4Address(src), 12);
  bytes.set(parseIpv4Address(dst), 16);
  bytes.set(payload, IPV4_HEADER_SIZE);
  return bytes;
}

// ---------------------------------------------------------------------------
// IPv6 (network/ipv6_packet.ksy)
// ---------------------------------------------------------------------------

export interface Ipv6Options {
  nextHeader: number;
  src: string;
  dst: string;
  payload: Uint8Array;
}

const IPV6_HEADER_SIZE = 40;

/** Builds a minimal (no extension headers) IPv6 header + payload. */
export function ipv6({ nextHeader, src, dst, payload }: Ipv6Options): Uint8Array {
  const bytes = new Uint8Array(IPV6_HEADER_SIZE + payload.length);
  const view = new DataView(bytes.buffer);
  // version(4 bits)=6, traffic_class(8 bits)=0, flow_label(20 bits)=0, packed
  // big-endian MSB-first across the 32 bits: 0110 0000 0000... = 0x60000000.
  view.setUint32(0, 6 << 28, false);
  view.setUint16(4, payload.length, false); // payload_length
  bytes[6] = nextHeader; // next_header_type
  bytes[7] = 64; // hop_limit
  bytes.set(parseIpv6Address(src), 8);
  bytes.set(parseIpv6Address(dst), 24);
  bytes.set(payload, IPV6_HEADER_SIZE);
  return bytes;
}

// ---------------------------------------------------------------------------
// TCP (network/tcp_segment.ksy)
// ---------------------------------------------------------------------------

export interface TcpOptions {
  srcPort: number;
  dstPort: number;
  /** Raw flags byte (cwr|ece|urg|ack|psh|rst|syn|fin, MSB to LSB). */
  flags: number;
  payload: Uint8Array;
}

const TCP_HEADER_SIZE = 20;

/** Builds a minimal (no options) TCP header + payload. */
export function tcp({ srcPort, dstPort, flags, payload }: TcpOptions): Uint8Array {
  const bytes = new Uint8Array(TCP_HEADER_SIZE + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, srcPort, false);
  view.setUint16(2, dstPort, false);
  view.setUint32(4, 0, false); // seq_num
  view.setUint32(8, 0, false); // ack_num
  bytes[12] = 0x50; // data_offset=5 (high nibble) -> 20-byte header, reserved=0 (low nibble)
  bytes[13] = flags & 0xff;
  view.setUint16(14, 65535, false); // window_size
  view.setUint16(16, 0, false); // checksum (unvalidated by the parser)
  view.setUint16(18, 0, false); // urgent_pointer
  bytes.set(payload, TCP_HEADER_SIZE);
  return bytes;
}

// ---------------------------------------------------------------------------
// UDP (network/udp_datagram.ksy)
// ---------------------------------------------------------------------------

export interface UdpOptions {
  srcPort: number;
  dstPort: number;
  payload: Uint8Array;
}

const UDP_HEADER_SIZE = 8;

/** Builds a UDP header + payload; `length` is `8 + payload.length`. */
export function udp({ srcPort, dstPort, payload }: UdpOptions): Uint8Array {
  const bytes = new Uint8Array(UDP_HEADER_SIZE + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, srcPort, false);
  view.setUint16(2, dstPort, false);
  view.setUint16(4, UDP_HEADER_SIZE + payload.length, false); // length
  view.setUint16(6, 0, false); // checksum (unvalidated by the parser)
  bytes.set(payload, UDP_HEADER_SIZE);
  return bytes;
}

// ---------------------------------------------------------------------------
// DNS (network/dns_packet.ksy)
// ---------------------------------------------------------------------------

export interface DnsQueryOptions {
  txId: number;
  /** Dotted name, e.g. "example.com". */
  name: string;
  /** Query type, e.g. 1 = A, 28 = AAAA. */
  type: number;
}

/** Builds a 12-byte DNS header (qdcount=1, opcode=0, RD=1) + one question. */
export function dnsQuery({ txId, name, type }: DnsQueryOptions): Uint8Array {
  const qname = encodeQName(name);
  const bytes = new Uint8Array(12 + qname.length + 4);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, txId, false); // transaction_id
  view.setUint16(2, 0x0100, false); // flags: opcode=0 (query, valid), rd=1, everything else 0
  view.setUint16(4, 1, false); // qdcount
  view.setUint16(6, 0, false); // ancount
  view.setUint16(8, 0, false); // nscount
  view.setUint16(10, 0, false); // arcount
  bytes.set(qname, 12); // question.name (QNAME)
  const afterName = 12 + qname.length;
  view.setUint16(afterName, type, false); // question.type
  view.setUint16(afterName + 2, 1, false); // question.query_class = IN
  return bytes;
}

/**
 * Builds a single-segment DNS-over-TCP payload: a 2-byte BE length prefix
 * followed by a `dnsQuery` message, per RFC 1035 §4.2.2.
 */
export function dnsOverTcp(opts: DnsQueryOptions): Uint8Array {
  const msg = dnsQuery(opts);
  const out = new Uint8Array(2 + msg.length);
  new DataView(out.buffer).setUint16(0, msg.length, false); // 2-byte BE length prefix
  out.set(msg, 2);
  return out;
}

// ---------------------------------------------------------------------------
// ICMP echo (network/icmp_packet.ksy)
// ---------------------------------------------------------------------------

export interface IcmpEchoOptions {
  id: number;
  seq: number;
}

/**
 * Builds an ICMP echo request: type(8)=echo, code(0) (the `.ksy` fixes `code`
 * to the literal byte `0x00` for `echo_msg`), checksum(0, unvalidated),
 * identifier, sequence. No trailing data.
 */
export function icmpEcho({ id, seq }: IcmpEchoOptions): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  bytes[0] = 8; // icmp_type: echo (request)
  bytes[1] = 0x00; // code: fixed to 0 by echo_msg's `contents: [0]`
  view.setUint16(2, 0, false); // checksum (unvalidated by the parser)
  view.setUint16(4, id, false); // identifier
  view.setUint16(6, seq, false); // seq_num
  return bytes;
}

// ---------------------------------------------------------------------------
// TLS ClientHello (network/tls_client_hello.ksy)
// ---------------------------------------------------------------------------

export interface TlsClientHelloOptions {
  sni: string;
}

// Deterministic 32-byte "random": 4-byte gmt_unix_time=0 + 28 zero bytes.
const TLS_RANDOM = new Uint8Array(32);
// A single deterministic cipher suite (TLS_AES_128_GCM_SHA256).
const TLS_CIPHER_SUITE = 0x1301;

/**
 * Builds a full TLS record(0x16, 0x03 0x03, len) + handshake(0x01, u24 len) +
 * ClientHello body with one SNI extension. `network/tls_client_hello.ksy`'s
 * generated parser only covers the ClientHello body (from `version` onward) —
 * callers that need to feed it must strip these first 9 header bytes first.
 */
export function tlsClientHello({ sni }: TlsClientHelloOptions): Uint8Array {
  const hostNameBytes = textEncoder.encode(sni);

  // server_name: name_type(1) + length(2) + host_name
  const serverName = concatBytes(
    Uint8Array.of(0x00), // name_type: host_name
    (() => {
      const b = new Uint8Array(2);
      new DataView(b.buffer).setUint16(0, hostNameBytes.length, false);
      return b;
    })(),
    hostNameBytes,
  );
  // sni: list_length(2) + server_name
  const sniBody = concatBytes(
    (() => {
      const b = new Uint8Array(2);
      new DataView(b.buffer).setUint16(0, serverName.length, false);
      return b;
    })(),
    serverName,
  );
  // extension: type(2)=0x0000 (server_name) + len(2) + body
  const sniExtension = concatBytes(
    Uint8Array.of(0x00, 0x00), // type: server_name
    (() => {
      const b = new Uint8Array(2);
      new DataView(b.buffer).setUint16(0, sniBody.length, false);
      return b;
    })(),
    sniBody,
  );
  // extensions: len(2) + extensions
  const extensions = concatBytes(
    (() => {
      const b = new Uint8Array(2);
      new DataView(b.buffer).setUint16(0, sniExtension.length, false);
      return b;
    })(),
    sniExtension,
  );

  const clientHelloBody = concatBytes(
    Uint8Array.of(0x03, 0x03), // client_version: TLS 1.2
    TLS_RANDOM, // random
    Uint8Array.of(0x00), // session_id.len = 0 (empty session_id.sid)
    (() => {
      // cipher_suites.len(2) + one cipher suite(2)
      const b = new Uint8Array(4);
      const view = new DataView(b.buffer);
      view.setUint16(0, 2, false);
      view.setUint16(2, TLS_CIPHER_SUITE, false);
      return b;
    })(),
    Uint8Array.of(0x01, 0x00), // compression_methods.len=1, methods=[null compression]
    extensions,
  );

  const handshake = concatBytes(
    Uint8Array.of(0x01), // handshake type: client_hello
    (() => {
      // u24be handshake length
      const b = new Uint8Array(3);
      b[0] = (clientHelloBody.length >>> 16) & 0xff;
      b[1] = (clientHelloBody.length >>> 8) & 0xff;
      b[2] = clientHelloBody.length & 0xff;
      return b;
    })(),
    clientHelloBody,
  );

  const record = concatBytes(
    Uint8Array.of(0x16, 0x03, 0x03), // record type: handshake, legacy version 3.3
    (() => {
      const b = new Uint8Array(2);
      new DataView(b.buffer).setUint16(0, handshake.length, false);
      return b;
    })(),
    handshake,
  );

  return record;
}
