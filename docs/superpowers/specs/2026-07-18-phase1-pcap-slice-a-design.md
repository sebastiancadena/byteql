# pcap pack — dissect extensions (Slice A) design

Date: 2026-07-18
Status: approved design, pre-implementation

## Context

The pcap pack (Phase 1, slice 1 of 3) shipped 2026-07-18 (`docs/superpowers/specs/2026-07-18-phase1-pcap-pack-design.md`).
Its final review deferred a set of follow-ups. Those follow-ups are not peers: TCP reassembly is a
PRD-designated Phase-2 architectural engine feature, and pcapng is a from-scratch container. This
slice ("Slice A") takes only the three that extend the existing pack's wrappers/dissect graph with
no new engine capability and no new container:

1. `ip.length` v4/v6 semantic normalization.
2. DNS-over-TCP, single-segment only.
3. ICMPv6.

All three are provable headless in Node/vitest against byte-exact fixtures. No UI work: new tables
auto-appear in the existing Explorer. MIDI and the existing pcap suites stay green throughout.

## Scope decisions (settled)

- **`ip.length` means total on-wire IP datagram length** (header + payload), directly comparable
  across v4/v6.
- **ICMPv6 gets its own `icmpv6` table** (not a `version` discriminator on `icmp`) — ICMPv4 and
  ICMPv6 have different type registries, so conflating them under one `type` column would be
  misleading.
- **ICMPv6 is parsed by a byteql-authored `icmpv6.ksy`** (no upstream Kaitai spec exists), compiled
  like the other layer parsers.

## Non-goals (still deferred)

- TCP stream reassembly and anything depending on it: multi-segment TLS ClientHello and
  **multi-segment DNS-over-TCP** (a DNS message split across TCP segments).
- pcapng container support.
- IPv6 extension-header accounting in `ip.length` beyond the fixed 40-byte header (v6
  `payload_length` already includes extension headers, matching v4's inclusion of options).

## Design

### Feature 1 — `ip.length` normalization

Today the `ipv4_packet` wrapper maps `length: parsed.totalLength` (IPv4 `total_length` includes the
header) and the `ipv6_packet` wrapper maps `length: parsed.payloadLength` (IPv6 `payload_length`
excludes the 40-byte fixed header) — so the `ip.length` column is not comparable across versions.

Change: the `ipv6_packet` wrapper maps `length: parsed.payloadLength + 40`. IPv4 is unchanged. Both
now report the full IP datagram length on the wire. This is a one-line wrapper change plus a test;
no YAML, schema, or engine change.

### Feature 2 — DNS-over-TCP (single-segment)

A tcp:53 dissect guard fires on **every** tcp:53 segment, including SYN/ACK handshake and
empty-body segments that carry no DNS payload. Emitting a `dns` row for those (or letting the parser
throw on them) is wrong. So DNS-over-TCP requires **conditional emission**, exactly the pattern the
TLS ClientHello dissector already uses (`tls` anchors `$.client_hello`, absent → no row, no error).

Changes:

- **`dns` table anchor `rows: $` → `rows: $.message`.** A `dns` row is emitted only when the
  parser's root exposes a `message` object.
- **Existing udp `dns_packet` wrapper**: nest its flattened fields under `{ message: … }`. `message`
  is always present (a udp:53 payload is always a complete DNS message). The projected `dns` table
  columns are unchanged, so existing DNS tests and queries keep working — only the wrapper's
  internal shape and the table anchor change.
- **New `dns_tcp_message` RecordParser** (`wrappers.ts` + `parsers.ts`): reads the leading 2-byte
  big-endian length prefix; if `bytes.length >= 2`, `declaredLen > 0`, and `2 + declaredLen <=
  bytes.length`, it parses `dns_packet` over `bytes.subarray(2, 2 + declaredLen)`, flattens with the
  shared `dnsName`/`dnsFlags` helpers, and returns `{ message: { …same fields as the udp path… } }`.
  Otherwise (empty body, handshake segment, or a message whose declared length exceeds this
  segment — i.e. fragmented across segments) it returns `{}` → no row, no error. Multi-segment
  reassembly is the deferred boundary.
- **Dissect graph**: add to the existing `from: tcp_segment` chain a second link
  `{ when: _.dst_port == 53 or _.src_port == 53, parser: dns_tcp_message, table: dns }`. It coexists
  with the existing `port 443 → tls` link; a segment is either 443 or 53, so first-match-wins is
  unambiguous.

Provenance: the tcp DNS row uses the engine's default payload-extent provenance (the whole tcp
payload, including the 2-byte prefix) — consistent with every other dissected layer.

Registry: `dns_tcp_message` is added to `pcapParserRegistry`. `pcap.tables.yaml`'s `dns` table gains
no new columns; `pcapNullability` is unchanged for `dns`.

### Feature 3 — ICMPv6

- **`ksy/icmpv6.ksy`** (byteql-authored; there is no upstream Kaitai ICMPv6 spec). A header comment
  records that it is authored, not vendored, and it has no `network/` pristine counterpart.
  `meta.id: icmpv6_packet`. Minimal shape:
  - `type: u1`, `code: u1`, `checksum: u2`, then a `switch-on: type` exposing an `echo` subtype
    (`identifier: u2`, `seq_num: u2`) for the echo request/reply types (128/129). Other types leave
    `echo` absent. `compile.mjs` already globs `ksy/*.ksy`, so it is compiled to
    `gen/Icmpv6Packet.js` with no script change.
- **New `icmpv6_packet` wrapper** → `{ icmp_type, code, echo_id, echo_seq }`, mirroring the existing
  `icmp_packet` wrapper (`echo_id`/`echo_seq` null when the `echo` subtype is absent). No `body`
  field (ICMPv6 is a leaf in this slice).
- **New `icmpv6` table** in `pcap.tables.yaml`: `rows: $`, `key: icmpv6_id`,
  `parent_key: { table: packets, column: packet_id }`, columns `type` (int16), `code` (int16),
  `echo_id` (uint16), `echo_seq` (uint16).
- **Dissect graph**: add to the existing `from: ipv6_packet` chain a link
  `{ when: _.l4_proto == 58, parser: icmpv6_packet, table: icmpv6 }` (58 is the IPv6 next-header
  value for ICMPv6). IPv4 ICMP is untouched.
- Register `icmpv6_packet` in `pcapParserRegistry`; add the `icmpv6` schema to `pack.ts` `schemas()`
  (column order: key, `packet_id`, spec columns, `_src_start`, `_src_end`); add `icmpv6` to
  `pcapNullability` (`echo_id`, `echo_seq`, `_src_*` nullable).

## Testing

Extend `test/build-pcap.ts` with: control of the IPv6 `payload_length`; a `dnsOverTcp` payload
builder (2-byte BE length prefix + a DNS message, reusing the existing DNS bytes); and an
`icmpv6Echo` builder (and a non-echo ICMPv6 type). New tests:

1. **`ip.length`**: an IPv6 packet with a known `payload_length` projects `ip.length ===
   payload_length + 40`; an IPv4 packet's `ip.length` is unchanged (== `total_length`).
2. **DNS-over-TCP**: a tcp:53 segment carrying a length-prefixed DNS query for a known name projects
   a `dns` row with that `query_name`; a tcp:53 **empty/handshake** segment (no DNS payload)
   projects **no** `dns` row and **no** error; an **over-length** prefix (declared length exceeds
   the segment) projects no row.
3. **DNS regression**: the existing udp:53 DNS path still projects the same `dns` columns after the
   `$.message` refactor.
4. **ICMPv6**: an IPv6 packet with next-header 58 carrying an ICMPv6 echo request projects an
   `icmpv6` row with `type == 128` and the expected `echo_id`/`echo_seq`; a non-echo ICMPv6 type
   projects `echo_id`/`echo_seq` null.
5. **Full-suite regression**: all existing pcap tests, the MIDI suite, `pnpm -r check`,
   `check:bundle`, and the e2e suite stay green.

## Risks & notes

- **The one shipped-code change** is the `dns` table's `$ → $.message` anchor plus nesting the udp
  wrapper's fields under `message`. It is behavior-preserving for the udp path (same projected
  columns) and is the minimal way to get conditional emission for tcp:53. It also makes DNS
  consistent with the TLS conditional-emission pattern.
- **`dns_tcp_message` must return `{}` (not a null root) for non-DNS/fragmented segments** so the
  `$.message` anchor finds no match and emits nothing — mirroring how the TLS wrapper returns `{}`
  for non-ClientHello segments.
- **`icmpv6.ksy` is authored, not vendored** — it carries no `network/` provenance entry; its
  authored status is noted in the file and in `PATCHES.md`/pack docs so a future audit does not
  mistake it for an upstream file.
- ICMPv6 checksum uses an IPv6 pseudo-header; we only read the stored field, so this is irrelevant
  to parsing.
