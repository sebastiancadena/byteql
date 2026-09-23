# pcapng intake

Date: 2026-09-23

Status: Implemented.

## Purpose and accepted behavior

Accept pcapng — Wireshark's default capture format — so users no longer convert captures
before importing them (`ROADMAP.md` priority 3). pcapng becomes a second container of the
existing `pcap` pack, as the pack-kit design anticipated
(`docs/superpowers/specs/2026-09-23-pack-kit-design.md`): one spec, one dissect graph, one set of
streams and queries, and a multi-file session can mix `.pcap` and `.pcapng` because both share
the pack id.

**Success criterion.** The same packets written as classic pcap and as pcapng produce identical
rows in every table (`packets`, `ip`, `tcp`, `udp`, `dns`, `icmp`, `icmpv6`, `tls`, `streams`,
`stream_segments`), ignoring the `_src_*` provenance columns and the pcapng-only interface
details. Streaming intake and exact source-byte provenance are preserved.

Accepted scope decisions:

- **Parity plus interfaces.** Packets flow through the existing tables unchanged. A new
  `interfaces` table exposes one row per Interface Description Block; `packets` gains
  `interface_id`, `comment`, and `ts_ns`. Name resolution, interface statistics, decryption
  secrets, and a generic options table are not projected.
- **Microsecond `ts` plus exact `ts_ns`.** `packets.ts` stays `timestamp_us` (floored), so
  existing queries and joins are unchanged. A new `ts_ns` int64 column carries exact epoch
  nanoseconds for both containers; classic ns-pcap gains it too.
- **Synthetic interface for classic pcap.** A classic capture yields one `interfaces` row built
  from its 24-byte global header, and every classic packet carries `interface_id = 1`, so
  `packets join interfaces` behaves identically for both containers.
- **Approach: hand-written block reader on a shared chunk window.** Chosen over a Kaitai
  `pcapng.ksy` parsed per block (per-block object allocation, byte order passed as a parameter
  per section, no simplification of the chunking/skipping framer, and the 1 GB benchmark has
  about 6 % headroom) and over a generic TLV-block framer in `@byteql/core` (no other planned
  format shares the block shape; declarative framers are deferred by the pack-kit design).
- **One real pcapng demo sample.** A small Wireshark-wiki TLS capture joins the "Try sample"
  picker, finally showcasing `tls`/`streams` from real traffic (the motivation recorded in
  `docs/superpowers/specs/2026-07-20-pcap-sample-picker-design.md`).

Out of scope: compressed captures (`.pcapng.gz`, `.pcapng.zst`), using Decryption Secrets
Blocks or Name Resolution Blocks, per-packet options other than `opt_comment`, interface
statistics, and resynchronizing after broken block-length framing.

## Current evidence

Inspected at `2ebb1fe`.

- `packages/formats/pcap/pack.yaml` declares one container, `pcap`, probed by the four classic
  magic numbers; a pcapng file is rejected as unrecognized.
- `packages/formats/pcap/src/container.ts` holds `createPcapFramer`: the chunk-window `ensure()`
  (straddle copy on reload, oversized direct reads, generation counter, `PCAP_CHUNK_BYTES`
  8 MiB), header parsing, raw-IP 101 → 228/229 normalization, and ns → µs flooring
  (`ts_frac_us`).
- `packages/formats/pcap/src/framer.ts` maps each packet to a `FramedRecord` with
  `tables: ['packets']` and provenance `{ start: recordStart, end: bodyEnd }`.
- `pcap.tables.yaml` (spec v0.4) anchors `packets` at `$` with an engine-assigned `packet_id`;
  the dissect graph keys the first hop on `_.linktype`. Engine keys are required on every table
  and assigned sequentially per file in emission order.
- `docs/pack-authoring.md` "Adding a container to an existing pack" gives the recipe this
  design follows; the `Framer` contract needs no change.
- The web app has no file-type filter on intake; format selection is purely probe-based.

## Design

### Components

Files under `packages/formats/pcap/`:

- `pack.yaml` — adds the second container:

  ```yaml
  - id: pcapng
    framer: pcapng
    probe: { hook: pcapng }
  ```

  The `pcapng` probe hook requires both the Section Header Block type `0A 0D 0D 0A` at offset 0
  and a byte-order magic (`1A 2B 3C 4D` or `4D 3C 2B 1A`) at offset 8, returning confidence 1.
  The block type alone is the text `\n\r\r\n` and is weak evidence.
- `src/chunk-window.ts` (new, extracted from `container.ts`) — the chunk-window reader:
  `ensure(absoluteStart, length)` returning a view or an isolated copy, the
  straddle-copy/generation rule, oversized direct reads, and `bytesConsumed` bookkeeping. Both
  readers use it; the classic reader's observable behavior is unchanged.
- `src/container.ts` — classic reader refactored onto `ChunkWindow`. It additionally exposes the
  raw fractional timestamp and the header's time unit so the framer can compute `ts_ns`.
- `src/pcapng.ts` (new) — `createPcapngReader(source, chunkBytes)`. `next()` returns a tagged
  item (`{ kind: 'interface', … }` or `{ kind: 'packet', … }`) or `null` at the end, and
  `issues()`/`bytesConsumed()` mirror the classic reader. Per-section state: byte order, section
  ordinal, and the list of interfaces (linktype, snaplen, timestamp resolution, timestamp
  offset, file-global interface ordinal).
- `src/options.ts` (new) — the TLV option walker (code u16, length u16, value padded to 4,
  terminated by `opt_endofopt` or the end of the options area) and decoders for the options
  kept.
- `src/framer.ts` — `pcapFramer` yields one synthetic interface record before its packets;
  the new `pcapngFramer` maps reader items to `FramedRecord`s with `tables: ['interfaces']` or
  `tables: ['packets']`. Both call `ctx.bytes()` before each `yield` and report reader issues
  through `ctx.report`.
- `src/index.ts` — registers `framers: { pcap, pcapng }` and `probes: { pcapng }`.

### Data model

`packets` gains three columns; existing columns keep their values:

| Column | Type | Source |
|---|---|---|
| `interface_id` | int64 | File-global 1-based ordinal of the packet's interface (always 1 for classic pcap) |
| `comment` | utf8, nullable | First `opt_comment` of the packet block; null for classic pcap |
| `ts_ns` | int64, nullable | Exact epoch nanoseconds; null only for Simple Packet Blocks |

`ts` becomes `nullable: true` (Simple Packet Blocks carry no timestamp). For classic pcap this is
a nullability-only schema change; no value changes.

New table `interfaces` (`rows: $`, `key: interface_id`), one row per Interface Description Block
or one synthetic row per classic capture:

| Column | Type | Source |
|---|---|---|
| `section` | uint32 | 0-based Section Header Block ordinal (0 for classic pcap) |
| `if_index` | uint32 | Interface index within its section (0 for classic pcap) |
| `linktype` | uint32 | IDB `LinkType`, or the classic global header's linktype (raw-IP 101 kept as written) |
| `snaplen` | uint32 | IDB `SnapLen`, or the classic header's snaplen |
| `name` | utf8, nullable | `if_name` |
| `description` | utf8, nullable | `if_description` |
| `os` | utf8, nullable | The enclosing section's `shb_os` |
| `comment` | utf8, nullable | First `opt_comment` of the IDB |
| `ts_resolution` | utf8 | `10^-n` or `2^-n`; `10^-6` default, `10^-9` for classic ns-pcap |
| `ts_offset_s` | int64 | `if_tsoffset`, default 0 |

**Key alignment.** The framer numbers the interface records it yields 1..n per file in yield
order, which is exactly the order in which the engine assigns `interfaces.interface_id`, and
writes that number into each packet root as `interface_id`. An interface whose IDB is skipped
for an error is never yielded and never numbered. A test asserts every `packets.interface_id`
exists in `interfaces` for the same file, including multi-section fixtures.

Per-packet `linktype` is resolved from the packet's interface, with the same raw-IP
101 → 228/229 normalization as today, so the dissect graph, streams, and every downstream table
are unchanged.

`queries.yaml`: the table-overview query adds `interfaces`, and a new "Packets by interface"
preset joins `packets` to `interfaces` on `interface_id` and `_src_file` (keys restart per file,
per the existing multi-file key-identity decision).

### Block framing

At the cursor the reader reads the 8-byte block header (type, total length) in the current
section's byte order and validates that the length is at least 12, is a multiple of 4, fits in
the file, and equals the trailing length copy. Blocks are then handled as follows:

| Block | Handling |
|---|---|
| SHB `0x0A0D0D0A` | Byte order from the magic at +8 (read before the length, since the length's byte order depends on it); resets the interface list; increments `section`; requires major version 1; `section_length` is ignored (it may be -1); keeps `shb_os` |
| IDB `1` | LinkType (u16), SnapLen (u32), options `if_name` (2), `if_description` (3), `if_tsresol` (9), `if_tsoffset` (14), `opt_comment` (1) → one interface record |
| EPB `6` | Interface ID (u32), timestamp high/low, captured and original length, data padded to 4, `opt_comment` → packet record |
| OPB `2` (obsolete) | As EPB with a u16 interface ID and a u16 drops count (ignored) |
| SPB `3` | Interface 0 of the section; captured length = min(original length, snaplen, space in the block), where snaplen 0 means unlimited; no timestamp, so `ts` and `ts_ns` are null |
| NRB `4`, ISB `5`, DSB `10`, systemd journal `9`, custom `0xBAD` / `0x40000BAD` | Valid but not projected; skipped by length without reading the body |
| Any other type | Skipped by length; one `UNSUPPORTED_BLOCK_TYPE` errors row per distinct type code, with the first occurrence's block range as provenance and the occurrence count in the message |

Skipped blocks never materialize their bodies. Only IDB options and the packet block's
`opt_comment` are decoded; other packet options are walked past, not decoded.

### Timestamps

For EPB/OPB, `units = high · 2³² + low` as a bigint. With interface resolution `10^-n` or `2^-n`
(the `if_tsresol` MSB selects the base; default `10^-6`):

- `ts_ns = floor(units · 10⁹ / 10ⁿ)` or `floor(units · 10⁹ / 2ⁿ)`, plus `ts_offset_s · 10⁹`.
- `ts` is `floor(ts_ns / 1000)` µs.

Classic pcap computes `ts_ns = ts_sec · 10⁹ + fraction`, where the fraction is the µs field
·1000 or the ns field as written; `ts` keeps its current value.

### Provenance

- A pcapng packet row's range is its whole block `[blockStart, blockEnd)`. The packet body's
  `start` is the absolute offset of the packet data field, so dissector provenance
  (`ip`, `tcp`, …, `_src_ranges`) stays exact.
- An interface row's range is its whole IDB.
- The synthetic classic-pcap interface row's range is the global header `[0, 24)`.
- Classic packet provenance is unchanged.

### Errors

Same contract as today: recoverable problems become `errors` rows, and only unreadable input is
fatal.

- **Fatal (`PackFatalError`):** the first block is not a Section Header Block, its byte-order
  magic is invalid, or its major version is not 1 — no packets could be read at all.
- **Stop, keeping earlier rows:** length below 12, not a multiple of 4, or trailer mismatch
  (`BLOCK_LENGTH_MISMATCH`); block extends past end of file (`TRUNCATED_BLOCK`); a later SHB
  with an invalid byte-order magic (`BAD_BYTE_ORDER_MAGIC`) or a major version other than 1
  (`UNSUPPORTED_SECTION_VERSION`). Once length framing is untrustworthy there is no safe resync.
- **Skip the block, continue:** a packet referencing an interface not declared in its section
  (`UNKNOWN_INTERFACE`, since its linktype is unknown); a captured length that exceeds the
  block's space, or block fields that do not fit their block (`MALFORMED_BLOCK`). A malformed
  IDB still occupies its positional index in the section, so later packets that reference it
  report `UNKNOWN_INTERFACE` rather than binding to the wrong interface. A Section Header Block
  shorter than its 28-byte minimum stops instead, since every later block depends on it.
- **Keep the block, drop its options:** an option whose length runs past the options area
  (`MALFORMED_OPTION`); the packet or interface is still emitted with defaults for the options
  not decoded.
- **Keep the packet, null its timestamps:** a computed `ts_ns` outside the int64 range
  (`TIMESTAMP_OUT_OF_RANGE`, reachable with hostile resolutions or offsets).

Every issue carries the block's absolute range as provenance and the record ordinal where one
exists.

### Performance

The classic 1 GB benchmark must not regress. A 1 GB pcapng (converted with `editcap`) is
measured against the same < 60 s target. The bigint `ts_ns` arithmetic is the hot-path cost to
watch; if it threatens the target, fast paths for `10^-6` and `10^-9` are allowed as long as
results stay identical. Both numbers go in this spec's implementation notes.

## Testing

- **Fixtures.** A new `test/build-pcapng.ts` builder (beside `build-pcap.ts`) writes SHB, IDB,
  EPB, SPB, OPB, NRB, and unknown blocks with options in either byte order. Checked-in fixtures
  cover little- and big-endian files; multiple sections including an endianness flip; multiple
  interfaces with mixed linktypes (Ethernet plus raw IP); ns and base-2 `if_tsresol` and
  `if_tsoffset`; SPB and OPB packets; comments; skipped and unknown blocks; and the existing
  reassembled TLS and DNS-over-TCP flows rewritten as pcapng.
- **Reader unit tests** (`pcapng.test.ts`): every row of the block table, every error code with
  its exact provenance, chunk-edge straddles, and oversized blocks.
- **Chunk window** (`chunk-window.test.ts`): the extracted helper. The existing
  `container.test.ts` stays green without modification.
- **Parity test:** the same packets as pcap and pcapng give identical rows in every table,
  excluding `_src_*`/`_src_ranges` and the `interfaces` details that differ by container.
- **Key alignment:** every `packets.interface_id` exists in `interfaces` per file.
- **Conformance:** pcapng fixtures are added to `test/fixtures.list.ts` tagged
  `container: 'pcapng'`, gaining the probe, golden, schema, chunk-invariance, abort, and fuzz
  checks.
- **Classic goldens and `schemas.snapshot.json`** are regenerated once, in their own commit, and
  reviewed as a diff. The only acceptable changes are additive: the synthetic `interfaces` row,
  the `interface_id`/`comment`/`ts_ns` columns, and nullable `ts`. Any other change is a
  regression.
- **Web e2e:** `pcapng.spec.ts` loads the demo sample and asserts `tls` has SNI rows and
  `interfaces` is populated, then loads a mixed `.pcap` + `.pcapng` session and runs the
  "Packets by interface" join. `hex-provenance.spec.ts` gains a pcapng case, keeping the
  "hex↔grid round-trip works on every gallery format" criterion.

## Demo sample

One real pcapng from the Wireshark wiki sample captures joins the "Try sample" picker
(`apps/web/src/lib/session/samples.ts`). Selection happens during planning, verified with
`tshark`: TLS over TCP/443 with an SNI-bearing ClientHello, Ethernet linktype, roughly 500 KB or
smaller, and redistributable under the same terms as the existing `SkypeIRC.cap` and `v6.pcap`
samples. It is vendored under `apps/web/src/assets/` with the same attribution and
`check:bundle` URL-audit handling as the existing samples.

## Documentation

- `docs/pack-authoring.md` — the "Adding a container to an existing pack" recipe cites pcapng
  as its worked example.
- `AGENTS.md` status, the `README.md` format list and pcap package row, and `ROADMAP.md`
  priority 3 marked done.
- Implementation notes appended to this spec: benchmark numbers and engineering discoveries.

## Implementation notes

**1 GB benchmark, 2026-09-23, Linux arm64, 20 logical processors, Chromium 149.0.7827.0, single
sample each:**

- `BYTEQL_SCALE_BENCH_SUMMARY gb=1 container=pcap bytes=1000000148 parseElapsedMs=58515.7
  msPerGb=58515.7 parseTargetMet=true bytesReadFraction=0.017088509470900598
  readTargetMet=true`
- `BYTEQL_SCALE_BENCH_SUMMARY gb=1 container=pcapng bytes=1000000484 parseElapsedMs=56487.5
  msPerGb=56487.4 parseTargetMet=true bytesReadFraction=0.01638399207014784
  readTargetMet=true`

The `toNs` fast path this design allowed for was not needed: bigint `ts_ns` arithmetic did not
threaten the target for either container. Classic pcap is now at 58.5 s/GB, about 2.5% under the
60 s target — it measured ~56 s/GB before this branch and 44 s/GB in July, so headroom is nearly
gone. This is a single-sample measurement, not a trend, but worth tracking before the next change
that touches the hot parse path.

**Engineering discoveries made during Tasks 1–8:**

- The shared chunk window's first (priming) load does not bump `generation`; only reloads do.
  The plan's original snippet bumped `generation` on the first load too, which contradicted its
  own test. Classic-pcap output is unaffected.
- `interfaces.interface_id` is an engine-assigned key (`int64`/JS `bigint`). `packets.interface_id`
  was first declared `uint32`, which forced JS-side comparisons to normalize; the final review
  changed it to `int64`, like every other key reference in the pack, so both sides now come back
  as `bigint` and compare directly. The framers pass bigint keys (`1n` for classic pcap, one
  cached bigint per pcapng interface), so the int64 column allocates nothing per packet.
- Regenerating `test/schemas.snapshot.json` also normalized stale `_src_start`/`_src_end`
  nullability on untouched tables; this was already inert, since the conformance test's
  `relax()` forced that nullability regardless of the snapshot's literal value.
- The options-area pad computation uses non-bitwise arithmetic so a hostile `inclLen` near 2^31
  cannot go negative.
- pcapng framing issues carry no record ordinal (`errors.record` is null), matching classic
  framing issues.
- Parsed blocks are read whole with no size cap, the same as classic pcap's `incl_len` handling
  — a hostile giant block forces one large allocation. This is a hardening candidate, not fixed
  here.
- `packages/formats/pcap/dist` must be rebuilt (`pnpm --filter @byteql/pcap build`) before web
  e2e sees pack changes.
- `scripts/run-scale-bench.mjs` spawns `playwright` without a shell and needs
  `apps/web/node_modules/.bin` on `PATH`.

**Documented limitations (unchanged from the design's scope decisions):** no compressed captures
(`.pcapng.gz`/`.pcapng.zst`); Decryption Secrets Blocks and Name Resolution Blocks are skipped,
not used; only `opt_comment` is decoded from packet options; no resync after broken block-length
framing.
