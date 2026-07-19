# AGENTS.md — ByteQL orientation for fresh sessions

ByteQL turns record-oriented binary files (MIDI today; pcap, evtx, regf next) into relational
tables you query with DuckDB SQL, entirely in the browser, with every row tracing back to its
exact source bytes. Product requirements, differentiators, and the projection DSL live in
`PRD.md` — read §9 (architecture) and Appendix A (DSL) first.

## Status (2026-07-19)

- **Phase 0 (MIDI spike): shipped.** Two manual exit items remain open — the audible smoke test
  and the unaided external reproduction (`docs/phase-0-external-test.md`).
- **Phase 1a (engine generalization prep): shipped.** Design record with binding runtime
  contracts: `docs/superpowers/specs/2026-07-18-phase1-generalization-prep-design.md` — read its
  **"Implementation notes"** before touching the projection engine; they document the payload
  offset convention, session state semantics, non-transactional emission, and the
  `RecordSource` drain-before-finish contract.
- **Phase 1, slice 1 of 3 (pcap pack): shipped.** `packages/formats/pcap` — vendored + patched
  Kaitai network `.ksy` (`network/PROVENANCE.md`, `PATCHES.md`), classic-pcap streaming framer,
  the 10-parser dissect registry (ethernet → ipv4/ipv6 → tcp/udp → dns/icmp/icmpv6/tls), the
  `pcap.tables.yaml` projection spec (8-table union + dissect graph), and the `FormatPack`
  façade wired into the web app's probe registry, canned queries, and e2e (`pcap.spec.ts`).
  Full-workspace gate (`pnpm -r check`, unit tests incl. MIDI regression, `check:bundle`, e2e)
  is green.
- **Phase 1, slice A (pcap dissect extensions): shipped.** Three targeted extensions to the
  pack's wrappers/dissect graph, no new engine capability or container:
  `ip.length` normalized to total on-wire IP datagram length (v4/v6 comparable), single-segment
  DNS-over-TCP (`dns_tcp_message` parser feeding the existing `dns` table), and ICMPv6 as its
  own `icmpv6` table (byteql-authored `icmpv6.ksy`, `ipv6` `next_header == 58`). TCP stream
  reassembly and its dependents (multi-segment TLS ClientHello, multi-segment DNS-over-TCP)
  shipped in Phase 2, below; pcapng container support is still deferred.
- **Phase 2 (TCP stream reassembly): shipped.** Design record:
  `docs/superpowers/specs/2026-07-18-phase2-tcp-reassembly-design.md`. Engine spec v0.3 adds a
  declarative `streams:` section plus key-extractor/framer registries that sit beside the
  existing parser registry, and a `StreamAssembler` (out-of-order reorder, rebase-while-
  unconsumed, dedup, gap/cap/stall statuses). Runtime adds engine-owned `streams` and
  `stream_segments` tables, injects `stream_id` on message-fed tables, and flushes flow rows at
  finish. `packages/formats/pcap` now reassembles multi-segment TLS ClientHello and
  multi-segment DNS-over-TCP — the single-segment-only limitation is gone — on a 10-parser
  dissect registry projecting 10 tables + `errors`. Documented limitations: no FIN/RST teardown
  (4-tuple reuse merges into one stream), no partial-overlap reconciliation, no sequence-number
  wraparound, single-record ClientHello only, and a tls-before-dns first-match quirk when a TCP
  segment's ports collide on both 443 and 53.
- **Phase 1, slice 2 of 3 (scale & intake): shipped.** Design record:
  `docs/superpowers/specs/2026-07-19-phase1-scale-intake-design.md` — read its
  **"Implementation notes"** for the measured numbers and the engineering discoveries made
  building it. Chunked intake replaces the whole-buffer path end to end: a random-access
  `ByteSource` (`FormatPack.open(source)`) feeds an incremental pcap framer
  (`createPcapFramer`, `PCAP_CHUNK_BYTES` 8 MiB, straddle-copy rule) through
  `ProjectionSession.drain()`/`pendingRowCount()`; the parse worker's request generalized to
  `Blob` (structured-cloned, no buffer transfer — `File` and the demo sample's synthetic
  in-memory `Blob` both flow through one path) and streams batches back over a
  credit-windowed protocol (`batch`/`batchAck`, credit window 4, terminal `finish` carrying
  `TableOverview[]`). `packages/db` gained generation-scoped ingest sessions (`beginIngest`,
  `schemas: 'discover'`, a `'failed'` state so abort can reclaim staging after a failed
  finalize, typed final drops via a catalog-kind registry) and a DuckDB-owned OPFS Parquet
  spill tier: rotating `COPY` to `opfs://byteql-spill/<generation>/<table>/<n>.parquet`
  (96 MiB rotation default), finalized as views over explicit `parquet_scan([...])` arrays
  (opfs glob strings don't enumerate in the pinned duckdb-wasm build), `LOAD parquet` run
  before the hardening loop, and hardening applied in the runtime-forced order
  `allowed_directories` first, then external-access-off, then extensions-off, then lock. Tier
  selection is `TIER_THRESHOLD_BYTES` (64 MiB) with fail-fast `SPILL_UNSUPPORTED` when the
  browser can't support spill. `apps/web` drives it with an unclamped per-packet yield
  (`scheduler.yield()`/`MessageChannel` fallback, `YIELD_INTERVAL_PACKETS` 256), a
  byte-accurate StatusBar (%, MB/s), and a File System Access picker alongside the existing
  `<input>`/drag-drop path. Both Phase-1 exit metrics (PRD §6) are MET, measured directly on
  this machine (arm64, 20 logical cores, Chromium 149): **1 GB pcap queryable in 44.25 s**
  (< 60 s target) and **a 3-column query over a 4 GB capture reads 1.71 %** of the capture
  (< 10 % target; the 1 GB run separately measured 1.72 %) — 4 GB parse 176.4 s
  (44.1 k ms/GB, linear). Bench artifacts: `apps/web/bench/scale-1gb-2026-07-19.json`,
  `apps/web/bench/scale-4gb-2026-07-19.json` (git-ignored `bench/`).
- **Phase 1 slice 3 of 3 (hex-provenance UI and polish): shipped 2026-07-19.** The canvas
  hex pane (`apps/web/src/lib/hex/` + `HexPane.svelte`) with the bidirectional hex↔grid
  link — grid rows light up bytes, byte clicks reveal covering rows (smallest interval,
  cycling), structure shading from the result's `_src_start`/`_src_end` columns, offset
  goto, filter-to-selection — plus the full-shell polish pass (design tokens, app-wide
  drag-drop intake, source chip, status-bar readouts, shortcuts overlay). The "hex↔grid
  round-trip works on every gallery format" exit criterion is e2e-verified on MIDI and
  pcap (`apps/web/e2e/hex-provenance.spec.ts`). **Phase 1 is complete.** Design:
  `docs/superpowers/specs/2026-07-19-phase1-hex-provenance-ui-design.md`; plan:
  `docs/superpowers/plans/2026-07-19-phase1-hex-provenance-ui.md`.
- **Next:** Phase 0's two open manual exit criteria (audible smoke test; unaided external
  reproduction — `docs/phase-0-external-test.md`), then Phase 2 content (forensics pack +
  plugin model, PRD §12).

## Repo map

pnpm workspace (`apps/*`, `packages/*`, `packages/formats/*`). Dependency direction is the
architecture: `app → db → core ← formats`. `packages/core` is zero-DOM (Node- and worker-safe;
its vitest suites run without a browser).

- `packages/core` — the engine
  - `src/projection/spec.ts` — YAML spec schema (v0.1/v0.2: tables, state, `when`/`where`,
    `parent_key`, `dissect`) + zod validation; errors at load, never per-row
  - `src/projection/expression.ts` — jsep-based sandboxed expression evaluator (closed builtin
    set, hex literals, bigint-aware arithmetic)
  - `src/projection/anchors.ts` — anchor-path compile + single-anchor traversal (dissect child
    trees use this)
  - `src/projection/walk.ts` — combined anchor matcher trie + single-pass document-order walker
  - `src/projection/project.ts` — compile + execution: row emit, synthetic keys, state
    registers, dissect chains (key propagation, composed provenance), `IssueCollector` wiring
  - `src/projection/session.ts` — `ProjectionSession`: multi-root projection with persistent
    state/keys over per-table batch builders
  - `src/projection/parsers.ts` — `RecordParser`/`ParserRegistry` seam for dissect child parsers
  - `src/arrow/build.ts` — column vectors + IPC (`timestamp_us` writes exact int64 µs; `binary`)
  - `src/arrow/batch.ts` — `TableBatchBuilder`, the flush-threshold seam Phase 1 streaming
    attaches to
  - `src/issues.ts` — `IssueCollector`: `ParseIssue[]` + the generic per-record `errors` table
  - `src/protocol.ts` — app/worker contracts and `FormatPack`/`RecordSource` (TypeScript mirror
    of the PRD's WIT `record-source`)
- `packages/formats/midi` — first format pack: `src/container.ts` (framer),
  `src/normalize-track.ts` (running-status expansion + byte accounting), `src/kaitai.ts`
  (generated-parser wrapper), `src/project-midi.ts` (spec-driven projection),
  `src/pack.ts` (`midiFormatPack` façade); `midi.tables.yaml` is the projection spec
- `packages/db` — DuckDB-WASM wrapper (`src/browser.ts`): local-asset init, hardening PRAGMAs,
  `replaceTables` (Arrow IPC in-memory only), serialized query path
- `apps/web` — Svelte UI: `src/workers/parse.worker.ts` (probe registry → `FormatPack.open` →
  drain batches → one `ParseResult`), `src/lib/session/` (controller + state machine),
  `src/components/`, `src/lib/viewers/` (capability-gated viewer registry; audio today)

## Commands (from repo root)

- `pnpm -r check` · `pnpm -r test -- --run` · `pnpm build`
- Per package: `pnpm --filter @byteql/core test -- --run` (same for `@byteql/midi`,
  `@byteql/web`)
- Browser acceptance: `pnpm --filter @byteql/web test:e2e` (Playwright; builds the instrumented
  `dist-e2e` — never publish that directory, deployable output is `dist`)
- Privacy/bundle audit: `pnpm --filter @byteql/web check:bundle`
- Markdown: `rumdl fmt <file>` (MD013 line-length warnings up to ~100 chars are accepted repo
  convention)

## Binding constraints

- **Privacy is the product.** No external URLs, CDNs, fonts, analytics, or runtime-loaded code
  anywhere; zero network requests after app readiness. Enforced by `check:bundle` and
  `apps/web/e2e/privacy.spec.ts`; threat model in `docs/privacy.md`.
- **Arrow IPC at every boundary.** Parsers emit Arrow record batches; every table row carries
  hidden `_src_start`/`_src_end` (uint64) provenance columns.
- **Engine invariants:** document-order traversal is load-bearing (state determinism, key
  order); spec/compile errors throw `ProjectionCompileError` at load; row-time evaluation
  returns null, never throws. The prep design doc's Implementation notes are contract, not
  commentary.
- **DuckDB is deliberately locked down** (`external_access` off, configuration locked) — the
  OPFS/Parquet work must revisit those PRAGMAs consciously, together with the privacy tests.
- Parsing treats input as hostile: parse runs in a killable worker; a poison record must never
  take down the session (it becomes an `errors` row).

## Conventions

- Conventional-commit messages; no Co-Authored-By trailers or AI branding in commits, issues,
  or PRs.
- TDD; unit tests co-located as `*.test.ts` (vitest), browser acceptance in `apps/web/e2e`.
- Prettier + eslint run inside `check`; keep test output pristine.

## Key documents

- `PRD.md` — requirements, roadmap (§12), risks, projection DSL (Appendix A)
- `docs/superpowers/specs/` — approved design records · `docs/superpowers/plans/` — executed
  implementation plans
- `docs/phase-0-benchmark.md` · `docs/phase-0-external-test.md` · `docs/privacy.md`
