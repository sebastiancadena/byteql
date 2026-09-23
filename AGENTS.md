# AGENTS.md — ByteQL orientation for fresh sessions

ByteQL turns record-oriented binary files (MIDI, pcap/pcapng, and ZIP today; evtx planned)
into relational tables you query with DuckDB SQL, entirely in the browser, with every row tracing
back to its exact source bytes. Product requirements, differentiators, and the projection DSL live in
`PRD.md` — read §9 (architecture) and Appendix A (DSL) first.

## Status (2026-09-23)

Priority order lives in `ROADMAP.md` (adopted 2026-09-15); it supersedes any "next" ordering here
or in `PRD.md` §12.

- **Phase 0 (MIDI spike): shipped.** The audible smoke test passed on 2026-09-22 (owner check on
  byteql.dev); the unaided external reproduction remains open (`docs/phase-0-external-test.md`).
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
  shipped in Phase 2, below; pcapng container support shipped 2026-09-23, below.
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
- **Result column sorting: shipped.** Click a result column header to reorder **every row of the
  current execution** (ascending -> descending -> original query order), without re-running the
  SQL: the rows come from the pages the session already retains, staged as private Parquet shards
  and ordered by DuckDB on its own connection, then published as a complete immutable
  `QueryResultView` that the grid, the inspector and both exporters read through one contract.
  Design: `docs/superpowers/specs/2026-09-14-result-column-sorting-design.md`; plan:
  `docs/superpowers/plans/2026-09-14-result-column-sorting.md`; measured limits and evidence:
  `docs/result-column-sorting-compatibility.md`. Documented limitation: sorting is refused on
  the `mvp` DuckDB bundle (its `ORDER BY` over `parquet_scan` fails for a full-range signed 16/32-bit
  key — a runtime defect, measured with the snapshot path removed).
- **Duplicate result-column names: shipped 2026-09-16.** Queries such as
  `select 10 as dup, 'ten' as dup` are preserved by position through querying, inspection,
  sorting, and CSV/Parquet export (Parquet gets unique export names). Byte provenance stays
  unavailable when a result repeats a provenance column. Design:
  `docs/superpowers/specs/2026-09-15-duplicate-result-columns-design.md`; evidence:
  `docs/result-column-sorting-compatibility.md#duplicate-output-column-names`.
- **Exact reassembled-message provenance: shipped 2026-09-22.** A reserved `_src_ranges` column
  (`List<Struct<start, end>>`, nullable, last engine column after `_src_end`) is engine-injected
  on pcap's `dns`, `tls`, and `streams`: null means `_src_start`/`_src_end` is exact, non-null
  means it is a bounding span and the list holds the exact contributing byte ranges. The hex pane
  highlights only those pieces, fills bounding-span gaps with a distinct neutral color, and adds
  a `Range i of n` readout; byte→row lookup and filter-to-selection (now over the executed query,
  not the SQL draft) both honor pieces; `packages/db` admits the shape through ingest, sorting
  (as an unsortable passenger), and Parquet/CSV export. Documented limitations: `errors` rows
  keep bounding spans with no `_src_ranges`, and a query that selects `_src_start`/`_src_end`
  but drops `_src_ranges` falls back to treating the span as exact. Design:
  `docs/superpowers/specs/2026-09-22-exact-reassembled-provenance-design.md`.
- **Also shipped:** the ZIP format pack (`packages/formats/zip`), same-format multi-file
  sessions, the Trace Workspace layout with resizable panels, and results download
  (`docs/superpowers/specs/2026-09-04-results-download-design.md`).
- **Pack kit: shipped 2026-09-23.** Format packs are now a manifest (`pack.yaml`) plus a small
  set of named code hooks instead of hand-copied schemas, drivers, and build scripts: the
  runtime lives in `packages/core/src/pack/` (`definePack`, the `Framer` contract, the generic
  `openFramedSource` driver) plus the `@byteql/core/kaitai` and `@byteql/core/testing` subpath
  exports, and `packages/pack-tools` provides the `byteql-pack build`/`new` CLI. MIDI, ZIP, and
  pcap are migrated onto it with golden-identical Arrow output and schemas now derived from the
  compiled spec rather than hand-written. Design and implementation notes:
  `docs/superpowers/specs/2026-09-23-pack-kit-design.md`; authoring guide:
  `docs/pack-authoring.md`.
- **pcapng intake: shipped 2026-09-23.** Wireshark's default capture format is now the pack's
  second container (`packages/formats/pcap`, `pack.yaml`'s `pcapng` entry), reusing the existing
  dissect graph, streams, and queries. A new `interfaces` table gets one row per Interface
  Description Block (or one synthetic row per classic capture, so `packets join interfaces`
  behaves identically for both containers); `packets` gains `interface_id`, `comment`, and
  `ts_ns`. The web app's "Try sample" picker gained a real pcapng capture
  (`http2-16-ssl.pcapng`), and the scale bench gained `--container pcapng`. Documented
  limitations: no compressed captures (`.pcapng.gz`/`.pcapng.zst`), Decryption Secrets Blocks and
  Name Resolution Blocks are skipped and not used, only `opt_comment` is decoded from packet
  options, and no resync after broken block-length framing. The three new `packets` columns
  cost classic pcap about 4% on the 1 GB bench (median 58.8 s/GB against 56.4 s/GB before, still
  under 60 s). Deployed to byteql.dev 2026-09-23 at `c032a48`. Design and implementation notes:
  `docs/superpowers/specs/2026-09-23-pcapng-intake-design.md`; its **"Deferred follow-ups"**
  section is the resumable list of what was left for later (parse headroom, a hostile block-size
  cap, SLL/SLL2 link types, the bench script's `PATH` bug, and small test/doc gaps).
- **Next (per `ROADMAP.md`):** saved queries. The unaided external Phase 0 test is still open
  supporting work.

## Repo map

pnpm workspace (`apps/*`, `packages/*`, `packages/formats/*`). Dependency direction is the
architecture: `app → db → core ← formats`. `packages/core` is zero-DOM (Node- and worker-safe;
its vitest suites run without a browser).

- `packages/core` — the engine
  - `src/projection/spec.ts` — YAML spec schema (v0.1–v0.4: tables, state, `when`/`where`,
    `parent_key`, `dissect`, and v0.4's `nullable`) + zod validation; errors at load, never
    per-row
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
  - `src/pack/` — the pack kit runtime (zero-DOM), re-exported from `@byteql/core`:
    `manifest.ts` (`pack.yaml` zod schema), `define.ts` (`definePack`), `framer.ts` (the
    `Framer` contract, `PackFatalError`), `driver.ts` (`openFramedSource`, the generic
    pull-driven `RecordSource`), `schemas.ts` (`projectionSchemas`, derives `TableSchema[]`
    from a compiled spec instead of hand-written maps), `yield.ts` (the unclamped yield
    helper, created per `openFramedSource` call, not a module singleton)
  - `src/kaitai/index.ts` — the `@byteql/core/kaitai` subpath export: `kaitaiParse` and
    `payload` (Kaitai parse + payload-offset-range helpers every format pack's wrappers use)
  - `src/testing/` — the `@byteql/core/testing` subpath export (production code never imports
    it): `conformance.ts` (`describePackConformance`, the shared fuzz/golden/invariant suite),
    `collect.ts` (`collectSource`, drains a `RecordSource` into one `ParseResult`),
    `golden.ts` (`goldenText`, `schemaSnapshotText`)
- `packages/formats/midi` — first format pack, migrated onto the pack kit: `src/framer.ts`
  (`smfFramer`, the `Framer` hook), `src/container.ts` (byte-level container parsing),
  `src/normalize-track.ts` (running-status expansion + byte accounting), `src/kaitai.ts`
  (generated-parser wrapper), `src/index.ts` (`definePack` call, exports `midiFormatPack`);
  `midi.tables.yaml` is the projection spec, `pack.yaml` the manifest
- `packages/formats/pcap` — network capture pack, two containers sharing one spec, dissect
  graph, streams, and queries: `src/chunk-window.ts` (the `ChunkWindow` reader both containers
  use — straddle-copy on reload, oversized direct reads, generation counter), `src/container.ts`
  (classic-pcap reader on `ChunkWindow`), `src/pcapng.ts` (`createPcapngReader`: sections,
  interfaces, block framing), `src/options.ts` (the pcapng TLV option walker), `src/probe.ts`
  (the `pcapng` probe hook — block type plus byte-order magic, since the block type alone is
  weak evidence), `src/framer.ts` (`pcapFramer` and `pcapngFramer`, the `Framer` hooks),
  `src/index.ts` (`definePack` call, registers both framers and the probe); `pcap.tables.yaml`
  is the projection spec, `pack.yaml` the manifest
- `packages/pack-tools` — Node-only dev dependency, never bundled into the app: the
  `byteql-pack` CLI (`bin/byteql-pack.mjs`). `src/build.mjs` (`byteql-pack build`: validates
  `pack.yaml` and the spec, compiles `.ksy` schemas, lints `queries.yaml`, emits
  `src/pack.generated.ts`), `src/new.mjs` (`byteql-pack new <id>`: scaffolds a pack from
  `templates/`), `src/ksy.mjs` (Kaitai compilation), `src/emit.mjs`/`src/queries.mjs`
  (generated-file and query-lint helpers). See `docs/pack-authoring.md`.
- `packages/db` — DuckDB-WASM wrapper (`src/browser.ts`): local-asset init, hardening PRAGMAs,
  `replaceTables` (Arrow IPC in-memory only), serialized query path
- `apps/web` — Svelte UI: `src/workers/parse.worker.ts` (probe registry → `FormatPack.open` →
  drain batches → one `ParseResult`), `src/lib/session/` (controller + state machine),
  `src/components/`, `src/lib/viewers/` (capability-gated viewer registry; audio today),
  `src/lib/ui/` (layout-agnostic panel resizing/coordination: `resize-handle.ts`,
  `use-panel-layout.svelte.ts`, `panel-layout.ts`)

## Commands (from repo root)

- `pnpm -r check` · `pnpm -r test -- --run` · `pnpm build`
- Per package: `pnpm --filter @byteql/core test -- --run` (same for `@byteql/midi`,
  `@byteql/web`)
- Browser acceptance: `pnpm --filter @byteql/web test:e2e` (Playwright; builds the instrumented
  `dist-e2e` — never publish that directory, deployable output is `dist`). The app consumes
  format packs through their built `dist/`, so after changing a pack run
  `pnpm --filter @byteql/<pack> build` (or `pnpm build`) before e2e, or the app sees the stale pack
- Privacy/bundle audit: `pnpm --filter @byteql/web check:bundle`
- Scale bench: `node apps/web/scripts/run-scale-bench.mjs --gb 1 [--container pcap|pcapng]` (needs
  `apps/web/node_modules/.bin` on `PATH`); run samples one at a time
- Deploy (manual, no CI): `pnpm release:pages` from the repo root — check, bundle audit, Pages
  artifact prep and verification, then `wrangler pages deploy` to the `byteql` project
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
- `check` is `pnpm build && pnpm -r check && pnpm format:check` (build, per-package
  `svelte-check`/`tsc`, and Prettier); eslint runs separately via `pnpm lint`. Keep test output
  pristine.

## Key documents

- `PRD.md` — requirements, roadmap (§12), risks, projection DSL (Appendix A)
- `docs/superpowers/specs/` — approved design records · `docs/superpowers/plans/` — executed
  implementation plans
- `docs/phase-0-benchmark.md` · `docs/phase-0-external-test.md` · `docs/privacy.md`
