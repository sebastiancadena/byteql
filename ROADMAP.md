# ByteQL roadmap

Adopted: 2026-09-15.

This is the current priority order for ByteQL. It supersedes older "next up" ordering in
`PRD.md`, `README.md`, and `AGENTS.md`; existing requirements and runtime contracts still apply.
Items below are planned work, not claims of implementation or completed validation.

## Direction

Prioritize result correctness and provenance, then add pcapng. These changes strengthen
ByteQL's core promise: query real files and trace answers back to their bytes.

## Priorities

### 1. Fix duplicate result-column names — done (2026-09-16)

Valid SQL such as `select 10 as dup, 'ten' as dup` had a documented Arrow bridge failure.

- Columns are preserved by position through querying, inspection, sorting, and export.
- The inspector reads labels and values by position instead of keying fields by name.
- Duplicate labels with different types and values are verified across the full result workflow in
  a real browser, including a 20,001-row result, both sort directions per duplicate, CSV header
  bytes, and Parquet's unique export names.

Byte provenance stays unavailable when a result repeats a provenance column, and sorting stays
unavailable on the pinned `mvp` bundle; real screen-reader and touch acceptance are still pending.

Evidence:
[Duplicate output column names](docs/result-column-sorting-compatibility.md#duplicate-output-column-names).
Design:
[Duplicate result-column correctness](docs/superpowers/specs/2026-09-15-duplicate-result-columns-design.md).

### 2. Make reassembled-message provenance explicit — done (2026-09-22)

TCP-derived rows carry a bounding span that can include unrelated bytes between contributing
packets. The UI currently represents provenance as one range.

- First distinguish a bounding span from exact source bytes.
- Then support highlighting individual contributions.
- Exact message highlighting needs a message-to-segment mapping, not just every segment
  sharing `stream_id`.
- Verify messages spanning interleaved and out-of-order packets so unrelated bytes are not
  presented as message content.

Current contract:
[TCP reassembly design](docs/superpowers/specs/2026-07-18-phase2-tcp-reassembly-design.md).

Evidence: [hex-provenance e2e](apps/web/e2e/hex-provenance.spec.ts) and
[exact provenance design](docs/superpowers/specs/2026-09-22-exact-reassembled-provenance-design.md).

### 3. Add pcapng intake — done (2026-09-23)

The current probe accepts only classic pcap. Supporting Wireshark's default capture format
removes a practical import barrier.

- Reuse the existing dissectors.
- Scope the new container reader around sections, interfaces, timestamp resolution, and
  packet blocks, with explicit handling of unsupported cases.
- Preserve streaming intake and source-byte provenance.

pcapng is now a second container of the existing `pcap` pack, sharing one spec, dissect graph,
streams, and queries. A new `interfaces` table carries one row per Interface Description Block
(or one synthetic row per classic capture); `packets` gains `interface_id`, `comment`, and
`ts_ns`. Streaming intake and exact source-byte provenance are preserved, and the 1 GB benchmark
target (< 60 s) is still met for both containers. Classic pcap did regress, though: two
interleaved A/B runs (3 samples each) against the commit before this work measured medians of
58.8 s/GB against 56.4 s/GB, about 4% slower. The cause is the three new per-packet columns,
leaving about 2% headroom under the target.

Evidence: [pcapng pack tests](packages/formats/pcap/test/pcapng-pack.test.ts) and
[pcap e2e](apps/web/e2e/pcap.spec.ts).
Design: [pcapng intake design](docs/superpowers/specs/2026-09-23-pcapng-intake-design.md).

### 4. Add saved queries and opt-in local history — done (2026-09-24)

Named queries are saved per format and listed beside the pack's example queries; recent runs are
kept per tab and persisted only when the user opts in; a format's library exports to and imports
from one annotated `.sql` file. Everything is stored in the browser's IndexedDB and never sent.

Evidence: [saved-queries e2e](apps/web/e2e/saved-queries.spec.ts) and
[privacy e2e](apps/web/e2e/privacy.spec.ts).
Design: [saved queries design](docs/superpowers/specs/2026-09-24-saved-queries-design.md).

### 5. Harden TCP connection identity — done (2026-09-24)

FIN/RST teardown and sequence wraparound were unsupported. Repeated connections using the same
address/port tuple could merge into one stream.

- Connection lifecycle: SYN/FIN/RST now reach the engine as control segments, reused tuples split
  into generations with a fresh `stream_id`, and the flow root reports `opened`, `closed_by`, and
  `generation`.
- Sequence wraparound (RFC 1982 serial arithmetic) and first-bytes-win overlap reconciliation,
  verified with adversarial fixtures (tuple reuse, RST reuse, wraparound, consistent and
  conflicting overlap, reset-before-data, missing first segment).

Remaining non-goals: bidirectional stream pairing, idle-timeout connection splitting, and early
flushing of closed flows (they still flush at `finish()`).

Remaining limitations found in the post-implementation review (2026-09-24): every SYN routed to a
stream (ports 443/53 in pcap) creates a flow entry kept until `finish()` (~1.2 KB each measured;
300k unanswered SYNs peaked at ~710 MB heap, 1M at ~1.35 GB), so a SYN-flood or port-scan capture
of a few million SYNs can exhaust the parse worker's heap. Windows-style 1-byte TCP keepalives (one
garbage byte at SND.NXT−1) overlap already-stored bytes and are counted as
`STREAM_OVERLAP_CONFLICT` / `conflict_count` unless the byte happens to match. See the follow-up
bullet under Supporting work.

Evidence: [TCP identity tests](packages/formats/pcap/test/tcp-identity.test.ts) and
[pcap e2e](apps/web/e2e/pcap.spec.ts).
Design: [TCP connection identity design](docs/superpowers/specs/2026-09-24-tcp-connection-identity-design.md).

### 6. Ship one forensic investigation workflow

Choose one format and deliver the complete workflow:

**Import → useful example queries → event inspection → byte provenance → export.**

EVTX is the preferred candidate if security analysts remain the target. Follow with a
cross-file timeline. This gives the plugin boundary a concrete purpose and a clear
acceptance test.

Product context: [PRD roadmap](PRD.md#12-roadmap).

## Supporting work

- **Close manual acceptance gaps.** Audible playback was confirmed by the project owner on
  2026-09-22; the unaided external test remains pending, and sorting and duplicate-label headers also lack real screen-reader and touch acceptance. See
  [Phase 0 external test](docs/phase-0-external-test.md) and
  [sorting manual checks](docs/result-column-sorting-compatibility.md#outstanding-manual-checks).
- **Add Firefox/WebKit acceptance coverage.** The current
  [Playwright configuration](apps/web/playwright.config.ts) runs Chromium only. Prioritize
  intake, storage fallbacks, sorting, and downloads.
- **pcapng follow-ups — done (2026-09-23), except scope extensions.** Classic 1 GB parse
  dropped to a median of 42.6 s/GB, from 59.1 s/GB, through direct Arrow vector construction.
  Hostile record and block sizes are capped at 16 MiB. Linux cooked capture (SLL/SLL2) is now
  dissected, and the bench script finds Playwright on its own. The opt-in scope extensions
  remain in the design's
  [Deferred follow-ups](docs/superpowers/specs/2026-09-23-pcapng-intake-design.md#deferred-follow-ups).
- **Refresh roadmap documentation — done (2026-09-22).** `PRD.md`, `README.md`, and
  `AGENTS.md` now point to this file for priority order.
- **Cap or spill live TCP flow state.** Every SYN routed to a stream keeps its flow entry until
  `finish()` (~1.2 KB each measured), so a SYN-flood or port-scan capture of a few million SYNs can
  exhaust the parse worker's heap; a live-flow cap or spill is needed. Also classify Windows-style
  1-byte TCP keepalives instead of counting them as overlap conflicts. See priority 5's "Remaining
  limitations".

## Next development cycle

1. Duplicate-column correctness. **Done, 2026-09-16.**
2. Truthful multi-range provenance. **Done, 2026-09-22.**
3. Pcapng intake. **Done, 2026-09-23.**
4. Saved queries and opt-in local history. **Done, 2026-09-24.**

Hardening TCP connection identity (priority 5) is next.

## Evidence boundary

This roadmap was based on a read-only review of the current code and documented limitations
on 2026-09-15. The review did not reproduce the documented failures or run the test suite.
Implementation work should establish a failing reproduction where applicable and verify the
result against the repository's existing contracts and acceptance checks.
