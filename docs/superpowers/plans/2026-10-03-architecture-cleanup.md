# Architecture cleanup — implementation plan

Date: 2026-10-03. Branch: `feature/architecture-cleanup` (from `main` at `b9d2fa8`).

Source: the 2026-10-03 architecture review (three read-only reviews of `packages/core`,
`packages/db`, and `apps/web`). The user approved the review's recommended order: (1) fix the
stream-assembler buffer defect, (2) the low-risk cleanup batch, (3) split the three god-files,
(4) write the spec v0.6 design record. No separate spec exists; this plan is the authority, and
`AGENTS.md` "Binding constraints" plus the prep design doc's "Implementation notes"
(`docs/superpowers/specs/2026-07-18-phase1-generalization-prep-design.md`) stay contract.

## Global constraints

- **Behavior-preserving, except Task 1.** Tasks 2–11 are refactors: Arrow goldens, schema
  snapshots, e2e behavior, and public user-visible behavior must not change. If a refactor
  appears to require a behavior change, stop and report it instead of making it.
- **Gate per task:** `pnpm check` (build + per-package check + prettier), `pnpm lint`, and
  `pnpm -r test -- --run` must pass. Tasks touching `apps/web` or a pack's runtime behavior also
  run `pnpm --filter @byteql/web test:e2e` (rebuild packs first: `pnpm build`). Run prettier from
  the repo root (`pnpm format`) — per-package prettier picks the wrong config. Keep test output
  pristine.
- **Privacy is the product:** no new network access, URLs, or runtime-loaded code;
  `pnpm check:bundle` must stay green for tasks touching `packages/db` or `apps/web`.
- **TDD:** a behavior change (Task 1) starts with a failing test. Refactors rely on existing
  tests; add a test only where a moved seam lost coverage.
- **Commits:** conventional-commit messages, one or more per task. NO `Co-Authored-By` or other
  trailers, and no AI-tool branding and no absolute home-directory paths in commits, code,
  or docs.
- **Dependency direction** `app → db → core ← formats` stays; `packages/core` stays zero-DOM.
- Don't widen public exports. Removing an export is fine only when nothing outside tests uses it.

## Task 1: Stream assembler frees consumed bytes

Defect (verified): in `packages/core/src/projection/streams.ts`, `consume()` (≈line 149) only
advances `#consumed`; `#base`, `#data`, and `#segments` never shrink. The `max_buffer` check in
`add()` (≈line 225, `newExtent = max(freshEnd, highestEndAbs) - newBase`) therefore caps the
flow's whole lifetime: any pcap TLS/DNS-over-TCP flow direction carrying > 1 MiB
(`max_buffer: 1048576`, `pcap.tables.yaml:189,206`) goes `truncated`, holds ~1 MiB until
`finish()`, and `segmentsOverlapping()` filters every stored segment per message (quadratic).

Required behavior:

- After bytes are consumed, the assembler releases them: segments wholly below the consumed
  point are dropped, the base slides forward to the consumed point, and `#data` is compacted
  (amortized — e.g. compact when the dead prefix is ≥ half the buffer or ≥ some threshold, not
  on every consume; the in-order append fast path must stay O(1) amortized).
- `max_buffer` becomes a cap on **outstanding** (unconsumed, buffered) bytes:
  `max(freshEnd, highestEnd) - consumedPoint`.
- Everything observable that is expressed relative to the stream must stay correct: message
  offsets, `segmentsOverlapping()` results (exact `_src_ranges`), `stream_segments` rows and
  their relative offsets computed at flush, `hasGap()`, `pendingBytes()`, the below-base trim
  path (`STREAM_BELOW_BASE`), first-bytes-win overlap reconciliation, the close-past-data gap
  check (`closeOffset` vs contiguous end), and wraparound unwrap. If any consumer stores
  base-relative offsets, convert it to absolute offsets or rebase it consistently.
- Also check `StreamRuntimeEntry.segments` in `project.ts` (≈line 1074): if it grows without
  bound per flow independently of the assembler, note it in the report (fix only if it's the
  same mechanism and small).

Tests (write first, see them fail): in `packages/core` — a flow delivering e.g. 3 MiB of
in-order messages with `max_buffer` 1 MiB reassembles every message with `status` not
`truncated`; a flow whose **unconsumed** backlog exceeds `max_buffer` still truncates; message
provenance/segment ranges after compaction match the uncompacted expectation; a pcap-level test
in `packages/formats/pcap/test/` with a synthetic capture whose TLS (or DNS-over-TCP) direction
exceeds 1 MiB across many records, asserting no `truncated` status. Existing goldens must stay
identical (no shipped fixture exceeds 1 MiB per flow — if one changes, explain why in the report).

## Task 2: Core dead code and duplicates

In `packages/core`:

- `projectTree` (`project.ts` ≈2156) is test-only: move it (and its private column sink) out of
  production code into a test helper, or delete it if tests can use `ProjectionSession` instead.
- `flushStreams`, `createStreamsRuntime`, `streamSegmentsOutputTypes`: stop exporting from the
  public barrel if only tests use them (a pcap test uses `flushStreams` — point it at an internal
  path or at `@byteql/core/testing`).
- Remove the unreachable `continue` guards for key/`_src_*` columns in emit (≈1263, ≈1301) —
  compile already rejects those names (≈287–315). Verify that before removing.
- `StreamAssembler.add`'s unused `srcEnd` parameter (with its eslint-disable): remove it and
  update callers. Remove the test-only `srcSpan` getter if only tests use it (adapt tests).
- `readOwnDataProperty`/`missingProperty` are defined in both `anchors.ts` (≈97) and
  `expression.ts` (≈414) with two different Symbols: unify into one module.

Do NOT drop spec versions v0.1–v0.3 or the pre-0.4 nullable branch here (deferred to the v0.6
design, Task 12).

## Task 3: One hardening routine for every DuckDB connection

The hardening PRAGMA list exists in `packages/db/src/browser.ts:73-80` and is copied into
`result-columns-probe.ts`, `export-probe.ts` (twice), `sort-probe.ts`, and partially
`spill-probe.ts`; the copies drifted (probes allow only `opfs://byteql-exports/`, production also
allows `byteql-spill/`). Extract one exported-internal helper (e.g. `hardenConnection(conn,
{ allowedDirectories })`, preserving the runtime-forced order: `allowed_directories` first, then
external-access off, then extensions off, then lock) plus one local-instantiation helper
(bundle selection, `prepareWasmModule`, `LOAD parquet` before hardening) and make production and
every probe call them. Probes keep passing their own allowed-directory list explicitly, but the
statements and order come from the shared helper. Probes that assert `lock_configuration` now
verify the production routine.

## Task 4: Test-only code out of production surfaces

- Move the four probe modules (`sort-probe.ts`, `export-probe.ts`, `spill-probe.ts`,
  `result-columns-probe.ts`) under `packages/db/src/testing/` and export them from a new
  `@byteql/db/testing` subpath (package.json `exports`, same pattern as `@byteql/core/testing`);
  remove them from the main barrel. `LOCAL_BUNDLES` should no longer need to be exported from the
  main entry as "@internal" — expose what the probes need via the testing entry.
- `collectFileStatistics`/`exportFileStatistics` (`types.ts` ≈130–137, documented "never called in
  production"): move off the production `ByteqlDatabase` interface onto a testing-only extension
  reachable from `@byteql/db/testing`.
- `apps/web`: `e2e-harness.ts` imports probes from `@byteql/db/testing`.
  `SessionController.queryResultDiagnostics()` and `drainQueryResult()` (≈300, ≈329) are only
  used by the harness: move them into the harness behind a small read-only port, or gate them so
  they are absent from the production bundle. `check:bundle` must stay green and confirm no
  harness/probe markers leak into `dist`.
- The e2e control object is published under two globals (`App.svelte:17-18`: `__byteqlE2E` and
  `window.__BYTEQL_E2E__`). Keep one name (`__BYTEQL_E2E__`, matching the compile-time define)
  and migrate every spec to access it through typed helpers in `apps/web/e2e/support/app.ts`.

## Task 5: Typed db errors

`packages/db` throws plain `Error`s with codes in the message (`SPILL_UNSUPPORTED:`,
`SPILL_QUOTA_EXCEEDED:`, `RESULT_SPILL_…`, e.g. `browser.ts` ≈335/≈1024, `query-pages.ts` ≈67);
the controller matches with `message.includes(...)` (`controller.ts` ≈1040, ≈1134–1137,
≈1716–1724). Add a typed `ByteqlDbError` (with a `code` union) exported from `@byteql/db`,
modeled on the existing `ResultSortError`; throw it at every coded site, keep the message text
(it may be user-visible), and switch the controller to match on `code`
(`instanceof`/code check). Errors that cross a worker or structured-clone boundary must still be
identifiable — check whether any do.

## Task 6: Parse worker protocol simplification

`ParseWorkerClient.cancel()` posts `cancel` then immediately `replaceWorker()` (terminate)
(`apps/web/src/lib/parse-worker-client.ts` ≈141–146), so the worker's `cancelled` Set,
`CreditGate.releaseAll`, and `'cancelled'` replies (`parse.worker.ts` ≈161/181/205–207) never run
in production; the worker also tracks tasks in Maps though the client runs one task at a time.

- Make terminate the only cancellation path: remove the `cancel` request, `cancelled` response,
  and the multi-task Maps; keep the credit window, `batch`/`batchAck`, and the ack-chain ordering
  of `finish`/`error` exactly as they are.
- Move request and response types into one shared `apps/web/src/lib/parse-protocol.ts` imported
  by both sides (like `export/csv-protocol.ts`).
- Rename the worker from `'byteql-midi-parser'` (≈L73) to `'byteql-parser'`. Check that no
  test/e2e or `check:bundle` rule depends on the old name.
- Update/remove the worker unit tests that exercised the dead cancel path; keep tests for the
  credit window and ordering.

## Task 7: Shared Parquet shard workspace for sort and export

`packages/db/src/sort-result.ts` and `export-parquet.ts` each have their own register,
`runStatement` (cancel on abort), handle release / registered-path drop, ordinal snapshot, and
page→`COPY` shard loop (compare `export-parquet.ts:127-238` with `sort-result.ts:155-370`), and
they diverged: export creates and drops a regular table per page while sort uses a TEMP table
seeded once then TRUNCATE; export rethrows cancellation cleanup failures as `AggregateError`
while sort swallows them (≈301).

- Extract one `ShardWorkspace` (files, connection, registered paths, `runStatement`,
  `writeShard(...)`, `release()`); sort and export become short scripts on it. Use the TEMP
  table + TRUNCATE strategy for both if export's tests and golden outputs stay identical;
  otherwise keep per-caller strategy as a parameter and say why.
- Cleanup-failure policy: one policy for both — report cleanup failures (sort must stop
  swallowing them silently; it may still surface the primary error first, aggregating cleanup
  failures as export does). Keep the `onCleanupFailure` retry registry behavior.
- In `browser.ts`, replace the duplicated exclusive-operation pattern of `createSortedView`
  (≈1194–1261)/`exportParquet` (≈1263–1297) and `abortActiveSort`/`abortActiveExport` with one
  `runExclusive(slot, signal, fn)` helper.
- Consolidate `quoteIdentifier`/`quoteString` (defined in 5 files) into one `sql.ts`, and the
  NotSupported/Security error-name check (`query-pages.ts` ≈55, `sort-result.ts` ≈43) into one
  helper.

## Task 8: Remove declared-schema ingest mode

The app always calls `beginIngest` with `schemas: 'discover'` (`controller.ts` ≈968); the
declared mode of the `SchemaMode` union is used only by ≈30 tests in `browser.test.ts` and adds
branches in `browser.ts` (≈252–254, ≈288–295, ≈460–466). Remove declared mode: `'discover'` +
backfill becomes the only path (make the backfill schemas a required part of `beginIngest`
options if that's what discover needs; drop the `schemas` option if it then has one value).
Rewrite the affected tests to the discover path, preserving what each test asserts (ingest,
spill, finalize, abort, failure reclamation). Coverage of those behaviors must not drop.

## Task 9: Split `packages/core/src/projection/project.ts`

Split the 2196-line file along its existing seams (after Tasks 1–2 changed it):

- `compile.ts` — `compileProjection` and the graph validation rules (≈237–993).
- `stream-runtime.ts` — the stream runtime (≈1024–1188, ≈1482–1862, ≈1993–2154 pre-task numbers).
- `emit.ts` — row emission and dissect chains (`EmitContext`).
- `project.ts` stays as the thin entry re-exporting what other modules import today.

While there: merge the near-identical rule-7 ancestors fixpoint (≈759–823) and rule-9
availability fixpoint (≈883–949) into one reachability pass that does both stream hops, then run
both parent-key checks against it — same accepted/rejected specs and same error messages
(the compile-error tests are the oracle). Replace `emitRow`'s 13 positional parameters with one
frame/context object, and stop passing the sink twice. Pure move + these two refactors; no
behavior or performance change (do not attempt the hot-path allocation work here).

## Task 10: Split `packages/db/src/browser.ts`

After Tasks 3, 5, 7, 8, split along the seams:

- `ingest-session.ts` — `IngestSessionImpl` + DDL type map.
- `query-session.ts` — `QuerySessionImpl`.
- `runtime.ts` — bundles, init, hardening wiring, enqueue (may already partly exist from Task 3).
- `browser.ts` — just the `BrowserDatabase` coordinator.

Plus: replace `IngestSessionImpl`'s 11-parameter constructor (6 callbacks, get/set pairs for
`finalNames` and `spillGeneration`) with a small `Catalog` object owning final names + kinds, the
current spill generation, and `swap(finals, generation)`; move `dropFinal` and finalize's
reclamation into it. Extract the rotate-on-quota-error block repeated three times
(≈315–327, ≈358–374, ≈436–448) into one `rotateOrAbort()`.

## Task 11: Split `apps/web/src/lib/session/controller.ts`

The 1835-line `SessionController` holds intake (`openBatch`/`completeBatchOpen`, ≈910–1130),
query paging (≈1490–1730), sort (≈358–680), and export (≈681–815, ≈1143–1490), with four
generation counters. Extract collaborators — e.g. `IntakeOrchestrator`, `ResultSession` (query,
paging, viewer table), `SortOperation`, `ExportOperation` — each owning its generation fence and
publishing to the existing pure reducer (`state.ts`, unchanged as the single source of truth).
`SessionController` stays as a thin façade so `ControllerPort` (used by `Workbench.svelte`) is
unchanged. The cross-checks ("no sort during download" and vice versa) go through one shared busy
predicate (reuse `resultSortInteractionBlocked`/`hasActiveDownload`).

Also, while in intake/results:

- `_files` overview columns are hand-coded in the controller (≈1094–1105) and built separately in
  `batch.ts` (≈98–127): derive both from one definition.
- `buildResultState` always materializes up to 64 MiB for viewers (`baseViewerInput` ≈1657 →
  `materialize` ≈1694) even when no viewer capability is enabled (pcap/zip declare
  `capabilities: []`): materialize only when an enabled capability needs it. This is a memory
  improvement with no visible behavior change; the MIDI audio viewer must keep working (e2e).

Full e2e must pass.

## Task 12: Spec v0.6 design record

Write `docs/superpowers/specs/2026-10-03-spec-v0.6-pack-boundary-design.md` (design only, no
code). It must ground every claim in the code as it stands after Tasks 1–11, and cover:

- Framers hard-coding spec table names (`tables: ['packets']` in `pcap/src/framer.ts`,
  `midi/src/framer.ts`) → a spec-level record kind per root table.
- MIDI's sparse `tracks` arrays used only to reset state per record → an explicit per-record
  state reset.
- ZIP omitting a key instead of null because a null single-object anchor still emits a row →
  null as "no match" on non-wildcard anchors (semantics + migration).
- TCP rules in the generic engine (`startsNewGeneration` SYN-retransmit logic; flow-row injected
  columns `segment_count`/`opened`/`closed_by`/`generation`/`conflict_count` silently overwriting
  same-named key-extractor fields) and format builtins in core (`ip4_str`, `ip6_str`, `dos_dttm`,
  `u24be`) → collision rejection and pack-registered builtins validated at compile time.
- Engine-owned tables special-cased in four places, and `errors` built through a second Arrow
  path → compile emits one `OutputTable` list.
- `IssueCollector` unbounded and shipped twice → streamed `errors` batches + capped issues.
- Minimum supported spec version (drop v0.1–v0.3 and the pre-0.4 nullable branch).
- EVTX (ROADMAP #6) as the acceptance case for the new boundary.
- Migration plan for midi/zip/pcap with golden-identical output as the bar, alternatives
  considered, and open questions.

Format with `rumdl fmt`.

## Task 13: Docs

Update `AGENTS.md` (status entry for this cleanup with the Task 1 behavior change, and the repo
map for the moved/split files and the `@byteql/db/testing` subpath) and `ROADMAP.md` (a short
"Supporting work" note: architecture cleanup done, v0.6 design written, still-open items from
the review: hot-path allocation work, `Workbench.svelte` split, e2e suite cleanup —
`panel-resize.spec.ts` split and fixed sleeps → polls — and the `mvp` bundle decision, which is
the user's call). Run `rumdl fmt` on both.
