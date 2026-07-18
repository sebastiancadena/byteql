# Phase 1 — pcap pack design (slice 1 of 3)

Date: 2026-07-18
Status: approved design, pre-implementation

## Context

Phase 1a (engine generalization prep) shipped the dissect engine, `ProjectionSession`,
`IssueCollector`, hex literals, `timestamp_us`/`binary` types, the WIT-aligned
`FormatPack`/`RecordSource` boundary, and a probe registry in the parse worker — all proven
against MIDI as a regression harness, but the dissect engine ships **without a real consumer**
(only a synthetic fixture exercises it). This slice makes pcap that consumer.

Phase 1 "proper" spans three fairly independent subsystems. We are slicing them into separate
spec → plan → build cycles, MIDI green throughout:

1. **pcap pack (this spec)** — framer, layer-parser compile, dissect projection spec, canned
   queries, wired into the existing UI. Provable headless in Node/vitest with byte-exact `.pcap`
   fixtures.
2. **Scale & intake (later)** — worker-protocol streaming, DuckDB incremental append (replacing
   `replaceTables`), OPFS/Parquet spill (revisiting the locked-down hardening PRAGMAs), File
   System Access intake with size-tiering. Owns the "1 GB pcap < 60 s, reads < 10% of file" exit
   metric.
3. **Hex-provenance UI & polish (later)** — the canvas hex viewer, the signature bidirectional
   hex↔grid interaction, and the professional visual pass across the shell.

The review-deferred Phase 1a cleanups are already closed (commits `87729a1`/`c512933`/`24346a8`);
there is nothing to fold in here.

## Scope (decided)

- **Tables/dissect tree:** `packets → ip (v4+v6) → tcp/udp → dns`, plus `icmp` and
  `tls_client_hello`. Ethernet is a **parser-only dissector, no table**.
- **Container:** classic pcap only (24-byte global header + 16-byte record headers). pcapng is a
  follow-up (no vendored `.ksy`; needs a block-model framer).
- **Link layer:** Ethernet (linktype 1) and raw IP (101/228/229). Every other linktype becomes a
  graceful `errors` row.
- **UI:** wire the pack into the existing Explorer/grid so a `.pcap` is openable and queryable
  end-to-end. No visual polish, no hex viewer (slice 3).
- **Fixtures:** hand-built, byte-exact, assembled by a small builder helper. No network, fully
  deterministic for exact-row assertions.

## Vendored formats

11 `.ksy` files are already vendored byte-identical under `packages/formats/pcap/network/`,
pinned to `kaitai_struct_formats` commit `1818b5447c1aaf51084999f1ce2c6c40b57b752e`
(see `network/PROVENANCE.md`). All `CC0-1.0` except `tls_client_hello.ksy` (`MIT`). `protocol_body`
and `packet_ppi` were pulled in only to keep the upstream set self-contained; under our model they
are unused and are not compiled.

## Approach decision — layer parsers stop at a raw blob

Upstream `.ksy` auto-descend (`ipv4.body = protocol_body(protocol)`), which fights the declarative
dissect registry and double-parses each packet. Chosen approach (**A**): patch the layer bodies to
raw byte blobs so each parser stops at "here's a payload," and let the registry route.

- Only **3 files** use typed switch bodies and need patching: `ethernet_frame`, `ipv4_packet`,
  `ipv6_packet`. `tcp_segment.body` is `size-eos`, `udp_datagram.body` is `size: length-8`,
  `dns`/`icmp`/`tls` are already terminal.
- Rejected **B** (keep pristine, override in wrapper): Kaitai still eagerly parses the whole
  descent per packet — wasted work, couples us to upstream routing.
- Rejected **C** (hand-write lean byteql-native `.ksy`): discards vetted upstream specs and their
  edge-case handling.

## Architecture & data flow

```text
File bytes ─► pcap framer (thin, record-by-record) ─► per-packet root
   │                                                   {ts, caplen, len, linktype, body: ByteRange}
   │                                                        │
   │                                      ProjectionSession.project(packet)  ◄─ once per packet
   │                                                        │
   └─ global header (magic → endian/µs·ns, snaplen,         ▼
      linktype)                          dissect registry (declarative, built in Phase 1a)
        packets ─►[eth]─► ip(v4/v6) ─► tcp ─► tls           every dissected table carries
                                    └► udp ─► dns           parent_key = packet_id (root key
                                    └► icmp                 propagates through parser-only layers)
```

Delivery is an **eager in-memory `RecordSource` façade producing one `ParseResult`** — the same
accepted trade-off MIDI uses (`nextBatch()` over a completed parse). Worker-protocol streaming,
DuckDB incremental append, and spill are slice 2; `packages/db` keeps `replaceTables`.

The per-packet model relies on the root anchor: `traverseAnchor` with zero steps returns the root
as exactly one match, so the `packets` table anchors `rows: $` and the framer calls
`session.project(packetRoot)` once per packet (the pcap analogue of MIDI's once-per-track calls).
State registers are not needed by any pcap table in this slice.

## Package layout (`packages/formats/pcap/`, mirrors the MIDI pack)

```text
packages/formats/pcap/
├── network/                      # pristine vendored .ksy + PROVENANCE.md (already present)
├── ksy/                          # compilation inputs: 3 patched + pristine copies of the rest
├── PATCHES.md                    # documents every diff from network/ (pinned commit)
├── pcap.tables.yaml              # projection spec: 7 tables + dissect graph
├── queries.yaml                  # canned queries (chips + LLM few-shots)
├── scripts/compile.mjs           # .ksy → JS parser roots (debug mode on), 8 roots
├── src/
│   ├── container.ts              # framer (global header, record loop, raw-IP normalization)
│   ├── kaitai.ts                 # generated-parser wrappers (payload-relative offsets)
│   ├── parsers.ts                # ParserRegistry: parser id → RecordParser
│   ├── project-pcap.ts           # spec-driven projection via ProjectionSession
│   ├── pack.ts                   # pcapFormatPack façade (FormatPack)
│   └── *.test.ts
├── gen/                          # ksc output, gitignored
├── test/fixtures/                # crafted .pcap fixtures + builder helper + manifest
└── package.json / tsconfig.json
```

## Component design

### 1. Container framer (`src/container.ts`)

- Parse the 24-byte global header. Branch **endianness and timestamp resolution** off the four
  magic variants (`0xa1b2c3d4` be-µs, `0xa1b23c4d` be-ns, `0xd4c3b2a1` le-µs, `0x4d3cb2a1` le-ns).
  Capture `snaplen` and `network` (linktype). Unknown magic → `errors` row (`stage: framing`,
  `code: UNRECOGNIZED_PCAP_MAGIC`) and abort with no tables.
- Iterate records: 16-byte header (`ts_sec`, `ts_usec`, `incl_len`, `orig_len`), then `incl_len`
  body bytes. Use `incl_len` directly for the body length (the upstream
  `incl_len < snaplen ? … : snaplen` size expression is a known quirk we do not replicate). A
  header or body that runs past EOF → `errors` row (`code: TRUNCATED_RECORD`) and clean stop;
  packets already framed are kept.
- The packet `body` is a **`ByteRange` into the original file buffer, not a copy** — load-bearing
  for absolute provenance composition down the dissect chain.
- Normalize the fractional timestamp to microseconds: for ns-magic files, `ts_frac_us =
  ts_usec / 1000` (integer µs); the `packets.ts` column is `ts_sec * 1_000_000 + ts_frac_us`.
- **Raw-IP normalization:** linktype 1 → ethernet. For linktype 101 (LINKTYPE_RAW, which may carry
  either IP version) the framer peeks `body[0] >> 4` per packet and rewrites the packet record's
  `linktype` to 228 (IPv4) or 229 (IPv6). This keeps dissect guards to simple integer equality and
  avoids adding a byte-indexing expression helper. Linktypes 228/229 pass through unchanged.

The framer emits, per packet, a plain object root:
`{ ts_sec, ts_frac_us, incl_len, orig_len, linktype, body: ByteRange }`.

### 2. Parsers, patching & registry

- `scripts/compile.mjs` compiles **8 independent parser roots** from `ksy/`, each invoked
  standalone on payload bytes: patched `ethernet_frame`, `ipv4_packet`, `ipv6_packet`; pristine
  `tcp_segment`, `udp_datagram`, `dns_packet`, `icmp_packet`, `tls_client_hello`. Debug mode on so
  field offsets are recorded for provenance.
- **Patches** (each documented in `PATCHES.md` as a diff against the pinned `network/` file):
  - `ethernet_frame`: `body` switch-on `ether_type` → raw blob (`size-eos`); drop
    `/network/ipv4_packet` and `/network/ipv6_packet` imports.
  - `ipv4_packet`: `body` `protocol_body(protocol)` → raw blob (`size: total_length - ihl_bytes`);
    drop `/network/protocol_body` import.
  - `ipv6_packet`: `body` `protocol_body(next_header_type)` → raw blob; drop import.
  - Patched files keep every other field (ports, addresses, flags, protocol/next_header) intact —
    the dissect guards read those.
- `src/parsers.ts` exposes a `ParserRegistry` mapping the eight parser ids to `RecordParser`
  wrappers `(bytes) => { root }`. Wrappers surface **payload-relative** field offsets; the engine
  threads the enclosing base offset and composes absolute `_src_start`/`_src_end` (the Phase 1a
  nested-payload convention).

### 3. Projection spec (`pcap.tables.yaml`)

`version: 0.2`, `format: pcap`. Seven tables; ethernet is parser-only. Every non-`packets` table
declares `parent_key: {table: packets, column: packet_id}` — one synthetic `packet_id` threads
through every layer (root-key propagation through the parser-only ethernet hop and through
intermediate table layers alike), so any layer joins straight back to `packets`.

Representative columns (final names/types settled during implementation against the `.ksy` type
graph; provenance columns `_src_start`/`_src_end` are automatic on every table):

| table | source parser(s) | columns |
|---|---|---|
| `packets` | framer root `$` | `ts` (timestamp_us), `caplen` (uint32), `len` (uint32), `linktype` (uint32) |
| `ip` | `ipv4_packet` + `ipv6_packet` (union via `when`) | `version` (int8), `src_addr` (utf8), `dst_addr` (utf8), `proto` (int16), `hop_limit` (int16), `length` (uint32) |
| `tcp` | `tcp_segment` | `src_port`, `dst_port` (uint16), `seq`, `ack` (int64), `flags` (utf8), `window` (uint16) |
| `udp` | `udp_datagram` | `src_port`, `dst_port` (uint16), `length` (uint16) |
| `dns` | `dns_packet` | `tx_id` (uint16), `qr` (int8), `query_name` (utf8), `query_type` (int16), `qd_count`, `an_count` (uint16) |
| `icmp` | `icmp_packet` | `type` (int16), `code` (int16) |
| `tls` | `tls_client_hello` | `tls_version` (utf8), `sni` (utf8) |

The `ip` table is a `when`-guarded union: `version`, `proto` (v4 `protocol` / v6 `next_header`),
`hop_limit` (v4 `ttl` / v6 `hop_limit`), `length` (v4 `total_length` / v6 `payload_length`), and
`src_addr`/`dst_addr` rendered by the new `ip4_str`/`ip6_str` helpers.

Dissect graph (guards read the parser's own scope `_`):

```yaml
dissect:
  - from: packets
    payload: _.body
    chain:
      - { when: _.linktype == 1,   parser: ethernet_frame }
      - { when: _.linktype == 228, parser: ipv4_packet, table: ip }
      - { when: _.linktype == 229, parser: ipv6_packet, table: ip }
  - from: ethernet_frame            # parser-only, emits no table
    payload: _.body
    chain:
      - { when: _.ether_type == 0x0800, parser: ipv4_packet, table: ip }
      - { when: _.ether_type == 0x86DD, parser: ipv6_packet, table: ip }
  - from: ipv4_packet
    payload: _.body
    chain:
      - { when: _.protocol == 6,  parser: tcp_segment,  table: tcp }
      - { when: _.protocol == 17, parser: udp_datagram, table: udp }
      - { when: _.protocol == 1,  parser: icmp_packet,  table: icmp }
  - from: ipv6_packet
    payload: _.body
    chain:
      - { when: _.next_header_type == 6,  parser: tcp_segment,  table: tcp }
      - { when: _.next_header_type == 17, parser: udp_datagram, table: udp }
  - from: tcp_segment
    payload: _.body
    chain:
      - { when: _.dst_port == 443 or _.src_port == 443, parser: tls_client_hello, table: tls }
  - from: udp_datagram
    payload: _.body
    chain:
      - { when: _.dst_port == 53 or _.src_port == 53, parser: dns_packet, table: dns }
```

We dissect from the `ipv4_packet`/`ipv6_packet` **parsers** (not the `ip` table), which is correct
because `parent_key` targets the root `packets` table and the root key propagates through parser
hops (Phase 1a rule 7 / root-key propagation). An unmatched chain is not an error — the parent row
simply has no children.

### 4. Expression & type additions (`packages/core/src/projection/expression.ts`)

- Add two functions to the closed library: `ip4_str(bytes)` (4-byte range → dotted quad) and
  `ip6_str(bytes)` (16-byte range → RFC 5952-style compressed hex). Both accept a `binary`
  byte-range value and return `utf8`. These are the "format helpers like `ip4_str`" the PRD flags
  as arriving with pcap.
- No new types: `timestamp_us` and `binary` already shipped in Phase 1a.

### 5. UI wiring (no polish)

- Register `pcapFormatPack` in the parse worker's probe registry (ordered array, now length 2).
  The magic-byte probe cleanly separates pcap (`a1b2c3d4` / `d4c3b2a1` / nanosecond variants) from
  MIDI (`MThd`); confidence ordering picks the winner.
- Author `queries.yaml`: the DNS-join showcase
  (`select p.ts, d.query_name from dns d join packets p using(packet_id) …`), a protocol
  histogram, and a top-talkers aggregate — doubling as query chips and LLM few-shots.
- Ship a small crafted `.pcap` asset for the "Load sample" button.
- Reuse the existing Explorer (already lists multiple tables + canned queries) and grid unchanged.
  No hex viewer, no visual restyle.

## Testing (TDD; MIDI green at every step)

1. **Fixture builder** (`test/fixtures/`): a deterministic helper that assembles byte-exact
   `.pcap` files — global header (each magic variant), record headers, and crafted
   ethernet/IPv4/IPv6/TCP/UDP/DNS/ICMP/TLS-ClientHello payloads. A `manifest.md` documents each
   fixture's intent.
2. **Framer unit tests:** header parsing, all four endianness/resolution variants, truncated
   header and truncated body, snaplen handling, raw-IP version peek (101 → 228/229), linktype
   dispatch, unknown-magic abort.
3. **Parser-wrapper tests:** each patched/pristine parser returns the expected fields and
   payload-relative offsets on a crafted layer buffer.
4. **Projection conformance (the pack's conformance suite):** exact rows, keys, and **absolute
   provenance offsets into the original file** for every table across the dissect tree;
   `parent_key = packet_id` correct across the deepest chain (packets → eth → ipv4 → udp → dns);
   `when`-guarded `ip` union for v4 and v6; unmatched-chain packets produce a childless parent; a
   poison child parser produces an `errors` row and a childless parent, never a failed parse.
5. **e2e (Playwright, `apps/web`):** open the crafted `.pcap` sample, run the DNS-join canned
   query, assert grid rows; confirm the probe registry dispatches pcap vs MIDI. Existing MIDI e2e
   and worker-recovery suites stay green.

## Non-goals (explicitly deferred)

- Worker-protocol streaming, DuckDB incremental append, OPFS/Parquet spill, hardening-PRAGMA
  revisit — slice 2.
- File System Access intake, size-tiering, byte retention for the hex viewer — slice 2/3.
- Hex viewer, bidirectional hex↔grid provenance UI, visual/UX polish — slice 3.
- pcapng; TCP reassembly and multi-segment TLS (ClientHello must fit one segment); DNS-over-TCP
  (length-prefixed); ICMPv6 (protocol 58); a MAC-address `ethernet` table; the `packet_ppi`
  linktype.

## Risks & notes

- **`payload` must be a byte range, not a copy** — carried over from Phase 1a as load-bearing for
  provenance. The framer supplies the range; parser wrappers must expose ranges for `body` fields
  rather than detached `Uint8Array`s.
- **Patched `.ksy` drift:** patches are pinned against a specific upstream commit and documented in
  `PATCHES.md`; a future re-vendor must re-apply them. Kept to 3 files to bound the surface.
- **First real stress of the dissect engine:** some rework is expected and accepted when real pcap
  exercises paths the synthetic fixture did not.
- **DNS/TLS field extraction** (`query_name`, `sni`) depends on the vendored `.ksy` exposing those
  cleanly; column sets above are representative and finalized against the actual type graph during
  implementation.
