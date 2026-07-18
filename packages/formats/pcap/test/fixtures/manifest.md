# pcap test fixture builders

`test/build-pcap.ts` is a set of deterministic, hand-rolled `DataView` byte
builders — no network access, no third-party pcap writer. Field order and
sizes follow the pristine vendored `.ksy` files in `network/*.ksy` (see
`../../PATCHES.md` for how the compiled `ksy/*.ksy` derive from those). Later
tasks (framer tests, wrapper tests, projection tests, e2e tests) compose these
to assemble `.pcap` captures in-memory.

## `buildPcap({ magic, linktype, packets })`

Builds a full `.pcap` file: a 24-byte global header (`network/pcap.ksy`'s
`header` type) followed by one 16-byte record header + raw bytes per packet
(`network/pcap.ksy`'s `packet` type). `magic` selects one of the four
`be_us` / `be_ns` / `le_us` / `le_ns` spellings, which fixes both the magic
number bytes (always written in the same wire order — the magic number itself
is what a real parser reads as fixed big-endian to _determine_ the
endianness) and the endianness of every other multi-byte header field.
`incl_len` and `orig_len` are both set to `data.length` (no truncated
captures).

## Layer helpers

Each helper returns a minimal, valid-shaped `Uint8Array` for one layer, with
just enough header fields set to be byte-correct and parseable by the
package's compiled (`gen/`) Kaitai parsers. Fields not exposed by the
helper's options (MAC addresses, IP identification, TCP sequence numbers,
checksums, TTL/hop-limit, etc.) are fixed to deterministic placeholder
values — the dissect registry these fixtures exercise routes on typed
fields (`ether_type`, `protocol`, `next_header_type`, DNS `qtype`, ICMP
`icmp_type`, TLS record/handshake type), not on these placeholders.

- **`ethFrame({ etherType, payload })`** — Ethernet II frame: fixed dst/src
  MACs (`00:00:00:00:00:01` / `...:02`), `ether_type_1`, then `payload` as
  the raw body (`network/ethernet_frame.ksy`).
- **`ipv4({ protocol, src, dst, payload })`** — 20-byte header, no options
  (`b1 = 0x45`). `total_length = 20 + payload.length` — this must be exact,
  since the patched parser derives `body size = total_length - ihl_bytes`
  (`network/ipv4_packet.ksy`).
- **`ipv6({ nextHeader, src, dst, payload })`** — 40-byte header, no
  extension headers. `payload_length` is set to `payload.length`, which the
  patched parser uses directly as the body size (`network/ipv6_packet.ksy`).
- **`tcp({ srcPort, dstPort, flags, payload })`** — 20-byte header, no
  options (`data_offset = 5`, byte value `0x50`). `flags` is written
  verbatim as the raw flags byte (`network/tcp_segment.ksy`).
- **`udp({ srcPort, dstPort, payload })`** — 8-byte header;
  `length = 8 + payload.length` (`network/udp_datagram.ksy`).
- **`dnsQuery({ txId, name, type })`** — 12-byte header (`qdcount = 1`,
  `flags = 0x0100`: opcode 0/valid, RD set) followed by one QNAME-encoded
  question (`network/dns_packet.ksy`).
- **`icmpEcho({ id, seq })`** — 8-byte ICMP echo request (`type = 8`,
  `code = 0` — the `.ksy` fixes `code` to the literal byte `0x00` for
  `echo_msg`), no trailing data (`network/icmp_packet.ksy`).
- **`tlsClientHello({ sni })`** — a full TLS record (`0x16`, `0x03 0x03`,
  u16 length) + handshake header (`0x01`, u24 length) + ClientHello body
  (fixed version/random/empty session id/one cipher suite/null compression)
  with a single SNI extension. First byte is `0x16`; byte index 5 (the
  handshake type) is `0x01` — a consuming wrapper strips exactly those 9
  header bytes before handing the rest to the compiled `TlsClientHello`
  parser, which only covers the ClientHello body itself
  (`network/tls_client_hello.ksy`).

## Round-trip sanity checks

`test/build-pcap.test.ts` includes, for every layer helper, a check that the
built bytes parse correctly through the package's compiled `gen/*.js`
parser (protocol/type fields, body length and contents, and for TLS the
SNI host name) — catching byte-layout mistakes here instead of three tasks
later in the framer/wrapper/projection tests that consume these builders.
