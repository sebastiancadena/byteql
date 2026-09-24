# TCP connection identity — lifecycle, wraparound, and overlap design

Date: 2026-09-24
Status: approved design, pre-implementation
Roadmap: priority 5, "Harden TCP connection identity" (`ROADMAP.md`)

## Context

Phase 2 (`2026-07-18-phase2-tcp-reassembly-design.md`) shipped declarative stream reassembly with
three documented TCP limitations: no FIN/RST teardown, no sequence-number wraparound, and no
partial-overlap reconciliation. This design removes all three.

The root cause of tuple-reuse merging is structural: `contributeToStream` returns early on an
empty payload (`packages/core/src/projection/project.ts`), so SYN, FIN, and RST segments never
reach the stream engine, and a flow is identified by the key extractor's directional tuple string
alone for the whole capture. The engine cannot see one connection end and the next begin.

The remaining failures follow from the assembler's contract: any partial overlap marks the stream
`error`, a below-base segment after consumption marks it `error`, and a sequence number crossing
2^32 looks like a ~4 GB extent (`truncated`) or a below-base segment (`error`).

## Scope decisions (settled)

- **One spec, two implementation phases.** Phase A: lifecycle (generations, close reasons, SYN
  anchoring, control-only flows). Phase B: wraparound and overlap. They are designed together
  because the SYN anchor sets the base that unwrapping depends on, and retransmissions after FIN
  exercise the overlap policy.
- **The engine stays protocol-agnostic.** TCP semantics enter through declarative expressions in
  the `streams:` section (spec v0.5), the same way `offset` already does. (Rejected: a registered
  `segment_classifier` code hook — code for what a boolean expression expresses, and hides the
  lifecycle rules from the spec; a stateful key extractor appending a generation counter — breaks
  the pure-function contract and still never shows the engine control segments.)
- **Overlap policy: first bytes win, conflicts flagged, stream continues.** Matches Wireshark and
  Snort's "first" policy. Conflicting retransmissions are a known IDS-evasion technique, so they
  are counted and reported, but they do not stop reassembly.
- **Control-only connections get flow rows.** A SYN answered by RST, or a handshake that closes
  without data, produces a `streams` row with `byte_count = 0`.
- **Each direction stays its own flow.** An RST closes only the direction it travels in.

## Non-goals (still deferred)

- Bidirectional stream pairing (each direction is its own flow row).
- Idle-timeout connection splitting.
- Early flushing of closed flows to release their buffers (flows still flush at `finish()`).
- TLS handshake messages spanning multiple TLS records.
- Validating that data after a FIN in the same direction is a protocol violation.

## Design

### Lifecycle semantics

**What reaches the engine.** A stream link contributes when its payload is non-empty (as today)
**or** when any of the stream's `open`, `close`, or `reset` expressions evaluates true. Pure ACKs
(empty payload, no signal) still contribute nothing.

**Generations.** A flow entry is identified by (stream declaration, key, generation). The engine
keeps one *current* generation per (declaration, key); retired generations are kept for flush.
When a segment carries `open`:

- It **joins the current generation** when either:
  - its offset equals the current generation's recorded open offset (a retransmitted SYN), or
  - the current generation has no open yet, is not closed, and the offset equals its assembler
    base (a SYN captured after that connection's first data — the mid-stream flow is adopted and
    its `opened` becomes true).
- Otherwise it **starts a new generation**: the current entry is retired (still flushed at
  `finish()` exactly as today), and a new entry reserves a fresh `stream_id` from the flow table
  runtime, with `generation` one higher than the retired entry's.

Both join tests compare offsets after wraparound unwrapping (below) against the current
generation; a new generation restarts unwrapping from its own first offset.

Segments without `open` always go to the current generation, including after it has closed —
late retransmissions after a FIN are normal. When no current generation exists, any contributing
segment creates generation 1 (with `opened` false unless the segment carries `open`).

`close` sets `closed_by` to `'close'`; `reset` sets it to `'reset'`. Reset takes precedence: a
later `close` never overwrites `'reset'`, and a later `reset` overwrites `'close'`.

**The open segment anchors the base.** An `open` segment sets the assembler base to its offset
even with an empty payload (a new assembler operation, `anchor(offset)`, with the same rebase
rules as `add`: allowed while nothing has been consumed). For TCP the open offset is ISN+1, so a
capture that misses the first data segment now reports `gap` instead of silently starting at the
second segment and failing in the framer.

**Control segments are recorded.** Every contributing segment with an empty payload is recorded as
a `stream_segments` row, so `stream_segments` becomes the complete packet-to-connection map.
Because it has no payload bytes, its provenance is the **feeding row's** source range (the TCP
header whose flags carried the signal), passed from `fireDissect`'s `parentRange`. Control ranges
also join the flow row's span and `_src_ranges`. They never contribute to message provenance.

### Wraparound

A stream may declare `offset_bits: N`. Raw offsets are then modular in 2^N, and the engine
converts each to an **extended offset** per generation before calling the assembler:

- The generation's first offset maps to `raw + 2^N` (the bias keeps a retransmission from just
  before a wrap non-negative).
- Every later offset maps to the value `raw + k * 2^N` closest to the generation's highest
  extended end so far (RFC 1982 serial arithmetic; correct for any segment within ±2^(N-1)).

The bias is invisible in output: `stream_segments.offset` is already base-relative. Streams
without `offset_bits` keep raw offsets, unchanged.

This matters even under the 1 MiB `max_buffer` cap: ISNs are random, so about one connection in
4096 crosses 2^32 within its first MiB.

### Overlap reconciliation

`StreamAssembler.add` no longer treats any overlap as fatal:

1. Split the incoming range into parts already covered by stored segments and new parts.
2. Compare the covered parts' incoming bytes with the stored bytes. Any mismatch is a conflict;
   the stored (first-arrived) bytes are kept.
3. Store only the new parts, each as its own segment, with its source sub-range computed from its
   position within the incoming segment (`srcStart + (pieceStart - offset)`).

Stored segments stay non-overlapping, so the frontier scan, `segmentsOverlapping`, and exact
`_src_ranges` provenance keep their invariants: a message's pieces point at the bytes reassembly
actually used, never at a discarded retransmission.

Results (replacing `'overlap'`):

| result | meaning |
| --- | --- |
| `'duplicate'` | fully covered, identical (generalizes today's exact-duplicate rule) |
| `'conflict'` | fully covered, different; nothing stored |
| `'added'` / `'rebased'` | new bytes stored; a `conflicted` flag says whether covered bytes differed |
| `'truncated'` | the new parts would exceed `max_buffer` (checked on the new parts only) |

Each conflicting segment increments the flow's `conflict_count` and reports one
`STREAM_OVERLAP_CONFLICT` issue with that segment's source range. Status stays `ok`.

**Below-base after consumption.** `'below_base'` no longer ends the stream. The below-base part is
trimmed, the remainder goes through the overlap logic, and one `STREAM_BELOW_BASE` issue is
reported per flow (not per segment). After this change a stream only reaches `error` from a
stalled framer or an invalid offset.

**Cost.** The common in-order append path stays one comparison; overlap splitting scans only the
stored segments the incoming range touches.

### Spec surface (v0.5)

Four optional stream fields. Specs at `0.3` and `0.4` stay valid and behave exactly as today.

```yaml
streams:
  - name: tls_stream
    key: tcp_flow_key
    offset: '_.seq_num + (_.syn ? 1 : 0)'
    offset_bits: 32
    open: _.syn
    close: _.fin
    reset: _.rst
    framer: tls_record
    table: streams
    segments_table: stream_segments
    max_buffer: 1048576
    messages:
      - { when: _.offset == 0, parser: tls_client_hello, table: tls }
```

Compile-time rules (`ProjectionCompileError`, `PROJECTION_STREAM_INVALID` unless noted):

- Any of the four fields requires `version: '0.5'` (spec-load error, like `nullable` requires
  `0.4`).
- `offset_bits` is an integer in `[8, 48]`, so an extended offset plus its bias stays a safe
  integer.
- `open`, `close`, `reset` compile like `offset`: against the feeding link's row context with no
  declared state.
- `close` or `reset` without `open` is rejected — without an open signal no generation can start.

Runtime: lifecycle expressions follow the existing never-throw rule; a null or non-boolean result
counts as false.

**Flow-root fields.** The synthetic flow root gains `opened` (bool), `closed_by`
(`'close' | 'reset' | null`), `generation` (1-based), and `conflict_count`. Streams that use no
v0.5 feature get neutral values: `false`, `null`, `1`, `0`. The engine-synthesized
`stream_segments` schema is unchanged.

### pcap pack changes

- **`src/wrappers.ts`:** the `tcp` root gains raw `fin` and `rst` booleans next to `syn`.
- **`pcap.tables.yaml`:** `version: '0.5'`; both stream declarations gain `offset_bits: 32`,
  `open: _.syn`, `close: _.fin`, `reset: _.rst`. The `streams` table gains:
  - `handshake` (bool) — `_.opened`; false means the capture started mid-connection.
  - `close_reason` (utf8, nullable) — `'fin'` / `'rst'` mapped from `closed_by`; null means the
    connection was still open when the capture ended.
  - `generation` (uint32) — 2 or more means the tuple was reused.
  - `conflict_count` (uint32).
- **`queries.yaml`:** one canned query, "Reused or reset connections", over
  `generation > 1 or close_reason = 'rst'`.
- Key extractor and framers are unchanged; generation is engine state, not part of the key.

## Error handling

New recoverable issue codes through the existing `IssueCollector`, each with a source range:

- `STREAM_OVERLAP_CONFLICT` — one per conflicting segment.
- `STREAM_BELOW_BASE` — once per flow, at the first trimmed segment.

`STREAM_ERROR` narrows to framer stalls and invalid offsets. `STREAM_GAP`, `STREAM_TRUNCATED`,
and `STREAM_KEY_INVALID` are unchanged.

## Testing

TDD throughout; every behavior starts as a test that fails on current `main`.

**Engine (`packages/core`)**, against a small synthetic spec with a fixed-length framer:

- `streams.test.ts` (assembler): wraparound unwrapping, including a pre-wrap retransmission and a
  stream crossing 2^32 twice within a small extent; overlap splitting (covered-identical →
  `duplicate`, covered-different → `conflict`, partial overlap stores only the new tail with the
  correct source sub-range, a bridging segment stores two pieces); below-base trimming; `anchor`;
  a randomized-sequence invariant check that stored segments never overlap.
- `stream-runtime.test.ts`: generation rules (retransmitted SYN joins; late SYN at the base
  adopts; SYN after close or with a different open offset starts a new generation with a fresh
  `stream_id`); reset precedence over close; SYN-only flow row with `byte_count = 0`;
  control-segment `stream_segments` rows and their provenance; SYN anchor turning a missing first
  data segment into `gap`; `conflict_count` and issue codes; neutral values on non-v0.5 streams.
- `stream-compile.test.ts`: each compile rule above.

**pcap adversarial fixtures** (hand-built with `test/build-pcap.ts`), each committed first as a
failing test:

1. Tuple reuse: two DNS-over-TCP connections on one 4-tuple separated by FIN → two flows,
   generations 1 and 2, each response in its own stream (today: one merged flow).
2. RST reuse: as 1, first connection ends with RST.
3. Wraparound: ISN `0xFFFFFF00`, DNS response straddling 2^32 (today: `truncated` or `error`).
4. Consistent overlap: a repacked retransmission spanning two original segments → `ok`, message
   intact (today: `error`).
5. Conflicting overlap: first bytes kept, `conflict_count = 1`, issue row at the conflicting packet.
6. Reset before data: SYN answered by RST → two control-only flows, `close_reason = 'rst'`.
7. Missing first segment after SYN → `gap`, not a framer `error`.

**Regression guards.** Existing TLS and DNS fixtures keep identical message rows and provenance.
Golden and `schemas.snapshot.json` diffs must be explained by exactly three intended changes: the
new `streams` columns, new control-only flow rows, and control-segment `stream_segments` rows.
MIDI and ZIP goldens stay byte-identical. `describePackConformance` keeps passing.

**Browser.** `pcap.spec.ts` asserts the new canned query runs and the new `streams` columns appear
on the sample capture; a hex-provenance assertion confirms a control-segment `stream_segments` row
highlights the TCP header.

**Performance.** One 1 GB classic `run-scale-bench.mjs` run against the 42.6 s/GB median. Bar:
under 60 s/GB; any regression over 5% is explained in the implementation notes.

**Gate:** `pnpm -r check`, unit tests, `check:bundle`, e2e.

## Documentation

- Amendment note in `2026-07-18-phase2-tcp-reassembly-design.md` (like the 2026-09-22 note).
- `AGENTS.md` status, `ROADMAP.md` priority 5, `CHANGELOG.md`.
- Documented TCP limitations shrink to the non-goals above.

## Implementation notes

**Performance.** One 1 GB classic `run-scale-bench.mjs` run (arm64, 20 logical cores, Chromium
149) measured **42,965 ms parse / GB** (42.97 s/GB), against the pre-branch median of 42.6 s/GB —
a 0.86% difference, well inside the 5% threshold and far under the 60 s/GB bar. Both the parse and
read-fraction targets are met (`parseTargetMet: true`, `readTargetMet: true`,
`bytesReadFraction: 0.0171`). No profiling of `contributeToStream` was needed: lifecycle
evaluation only runs for segments actually routed to a stream link, and pure-ACK segments (the
overwhelming majority of TCP traffic in the bundled captures) still short-circuit before it.
Artifact: `apps/web/bench/scale-1gb-2026-09-24.json` (git-ignored).

**Golden diffs and why.** Regenerated pcap goldens fall into exactly the two categories the design
implies (fresh `stream_id` on generation creation; control ranges joining the flow span), plus the
new columns themselves:

1. **New `streams` columns only**, neutral values, on fixtures with no TCP traffic or no
   SYN/FIN/RST in their captured packets (`le-ns-dns.pcap`, `linux-sll2.pcapng`, `linux-sll.pcap`,
   `multi-section.pcapng`, `sample.pcap`, `SkypeIRC.cap`, `v6.pcap`, `dns-stream.pcap`,
   `dns-stream.pcapng`, `interleaved-stream.pcap`) — every other column byte-identical.
2. **`stream_id` renumbering plus span widening**, on `http2-16-ssl.pcapng`: two new control-only
   flow rows appear (a previously invisible IPv6 SYN/RST probe, `byte_count: 0`), and because new
   generations are created — and therefore assigned `stream_id`s — before the framer reaches the
   two data-bearing flows in document order, those two flows renumber `1,2 -> 3,4`. Their
   `_src_start`/`_src_end`/`_src_ranges` widen to include the SYN and FIN control segments' TCP
   header ranges (e.g. flow 3: `_src_start` 1138 -> 790, `_src_end` 4533 -> 4966, with new range
   entries at the front/back), per "control ranges also join the flow row's span and
   `_src_ranges`". `stream_segments` grows 12 -> 18 (2 for the new control-only flows' SYN/RST, 2
   each — SYN and FIN — for the two original flows). `tls`'s one row is unchanged except its
   `stream_id` following the same renumbering. No other table or row value changed in any golden.

**`segment_count` vs `stream_segments` row count.** `streams.segment_count` counts accepted
data-bearing contributions only (`entry.dataSegmentCount`, incremented once per contribution the
assembler actually stores). `stream_segments` also holds one row per control segment (SYN/FIN/RST
with an empty payload), so the two diverge for any flow with a handshake or teardown — a flow can
show `segment_count: 0` and still have `stream_segments` rows for its SYN and FIN.

**`stream_segments.offset` describes the contributing packet, not the bytes actually used.** A
retransmission that partially overlaps, or is fully below the base, keeps its full original offset
and source range in `stream_segments` even though only part (or none) of its bytes were stored by
the assembler — the row is a record of what arrived, not of what was kept. Consequently:

- Offsets can overlap between rows (a retransmission and the original both show their offsets).
- Offsets can be negative: a control segment recorded below the flow's data base (for example a
  retransmitted FIN that arrives before the base-anchoring SYN's offset in raw terms) reports a
  negative base-relative offset, unclamped.
- For a control-only flow (never anchored by an `open` segment against real data), offsets are
  relative to the minimum offset recorded across that flow's segments, not to any assembler base.

The exact bytes a message actually used are always in that message row's `_src_ranges`, never in
`stream_segments`.

**Deviation found and fixed during implementation, not part of the approved design.** The
control-only-flow base fallback (used when no `open`-anchored assembler base exists yet) initially
computed `Math.min(...entry.segments.map(...))`, spreading every recorded segment as a call
argument; a flow with 100k+ control segments and no `open` (an RST storm or a port scan with no
completed handshake) overflowed the call stack. Fixed in `55e5e57` with an iterative min instead of
a spread — behavior-identical, no spec or contract change, covered by a 200,000-segment regression
test.

**Known pre-existing e2e failure, unrelated to this work.**
`apps/web/e2e/panel-resize.spec.ts`'s "a diagnostic arriving mid-drag cancels it and leaves nothing
behind" fails on the pre-branch commit (`9d5ecca`) too; it is not a regression from this design and
was not investigated further here.
