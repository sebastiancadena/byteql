# AGENTS.md — ByteQL orientation for fresh sessions

ByteQL turns record-oriented binary files (MIDI today; pcap, evtx, regf next) into relational
tables you query with DuckDB SQL, entirely in the browser, with every row tracing back to its
exact source bytes. Product requirements, differentiators, and the projection DSL live in
`PRD.md` — read §9 (architecture) and Appendix A (DSL) first.

## Status (2026-07-18)

- **Phase 0 (MIDI spike): shipped.** Two manual exit items remain open — the audible smoke test
  and the unaided external reproduction (`docs/phase-0-external-test.md`).
- **Phase 1a (engine generalization prep): shipped.** Design record with binding runtime
  contracts: `docs/superpowers/specs/2026-07-18-phase1-generalization-prep-design.md` — read its
  **"Implementation notes"** before touching the projection engine; they document the payload
  offset convention, session state semantics, non-transactional emission, and the
  `RecordSource` drain-before-finish contract.
- **Phase 1, slice 1 of 3 (pcap pack): shipped.** `packages/formats/pcap` — vendored + patched
  Kaitai network `.ksy` (`network/PROVENANCE.md`, `PATCHES.md`), classic-pcap streaming framer,
  the 8-parser dissect registry (ethernet → ipv4/ipv6 → tcp/udp → dns/icmp/tls), the
  `pcap.tables.yaml` projection spec (7-table union + dissect graph), and the `FormatPack`
  façade wired into the web app's probe registry, canned queries, and e2e (`pcap.spec.ts`).
  Full-workspace gate (`pnpm -r check`, unit tests incl. MIDI regression, `check:bundle`, e2e)
  is green.
- **Next: Phase 1 slice 2 of 3 (scale & intake)** — worker-protocol streaming, DuckDB
  incremental append, OPFS/Parquet spill (revisit the DuckDB hardening PRAGMAs deliberately),
  File System Access intake with size-tiering. **Then slice 3 of 3**: hex-provenance UI and
  polish. Start slice 2 with a pre-task batching any review-deferred cleanups listed in
  `.superpowers/sdd/progress.md` (git-ignored scratch; recover from `git log` and
  `.superpowers/sdd/task-*-report.md` if cleaned).

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
