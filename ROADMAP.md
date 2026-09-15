# ByteQL roadmap

Adopted: 2026-09-15.

This is the current priority order for ByteQL. It supersedes older "next up" ordering in
`PRD.md`, `README.md`, and `AGENTS.md`; existing requirements and runtime contracts still apply.
Items below are planned work, not claims of implementation or completed validation.

## Direction

Prioritize result correctness and provenance, then add pcapng. These changes strengthen
ByteQL's core promise: query real files and trace answers back to their bytes.

## Priorities

### 1. Fix duplicate result-column names

Valid SQL such as `select 10 as dup, 'ten' as dup` has a documented Arrow bridge failure.

- Preserve columns by position through querying, inspection, sorting, and export.
- Include the inspector: it currently keys rendered fields by name.
- Verify duplicate names with different types and values across the full result workflow.

Evidence: [Result column sorting compatibility](docs/result-column-sorting-compatibility.md).

### 2. Make reassembled-message provenance explicit

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

### 3. Add pcapng intake

The current probe accepts only classic pcap. Supporting Wireshark's default capture format
removes a practical import barrier.

- Reuse the existing dissectors.
- Scope the new container reader around sections, interfaces, timestamp resolution, and
  packet blocks, with explicit handling of unsupported cases.
- Preserve streaming intake and source-byte provenance.

References: [Current probe](packages/formats/pcap/src/pack.ts),
[Wireshark file-format documentation](https://www.wireshark.org/docs/wsug_html_chunked/_files_and_folders.html).

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

- **Close manual acceptance gaps.** Unaided use and audible playback remain pending;
  sorting also lacks real screen-reader and touch acceptance. See
  [Phase 0 external test](docs/phase-0-external-test.md) and
  [sorting manual checks](docs/result-column-sorting-compatibility.md#outstanding-manual-checks).
- **Add Firefox/WebKit acceptance coverage.** The current
  [Playwright configuration](apps/web/playwright.config.ts) runs Chromium only. Prioritize
  intake, storage fallbacks, sorting, and downloads.
- **Refresh roadmap documentation.** `PRD.md` still labels already-shipped Phase 1 work as
  "Next." Reconcile the status documents with this priority order.

## Next development cycle

1. Duplicate-column correctness.
2. Truthful multi-range provenance.
3. Pcapng intake.

Saved queries are the next usability feature after that cycle.

## Evidence boundary

This roadmap was based on a read-only review of the current code and documented limitations
on 2026-09-15. The review did not reproduce the documented failures or run the test suite.
Implementation work should establish a failing reproduction where applicable and verify the
result against the repository's existing contracts and acceptance checks.
