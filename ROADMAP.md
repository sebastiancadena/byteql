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

### 4. Add saved queries and opt-in local history

The current "Example queries" are format-pack examples, not user-saved work. Make repeat
investigations easier with:

- Named queries.
- Recent executions.
- SQL import and export.
- Explicit persistence controls, because SQL can contain sensitive literals.

Existing behavior: [Workbench tests](apps/web/src/components/Workbench.test.ts).

### 5. Harden TCP connection identity

FIN/RST teardown and sequence wraparound remain unsupported. Repeated connections using the
same address/port tuple can merge into one stream.

- Start with connection lifecycle and visible incomplete/error states.
- Follow with sequence wraparound and overlap handling, verified with adversarial fixtures.

Documented limitations:
[TCP reassembly design](docs/superpowers/specs/2026-07-18-phase2-tcp-reassembly-design.md).

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
- **Refresh roadmap documentation — done (2026-09-22).** `PRD.md`, `README.md`, and
  `AGENTS.md` now point to this file for priority order.

## Next development cycle

1. Duplicate-column correctness. **Done, 2026-09-16.**
2. Truthful multi-range provenance. **Done, 2026-09-22.**
3. Pcapng intake. **Done, 2026-09-23.**

Saved queries are the next usability feature after that cycle.

## Evidence boundary

This roadmap was based on a read-only review of the current code and documented limitations
on 2026-09-15. The review did not reproduce the documented failures or run the test suite.
Implementation work should establish a failing reproduction where applicable and verify the
result against the repository's existing contracts and acceptance checks.
