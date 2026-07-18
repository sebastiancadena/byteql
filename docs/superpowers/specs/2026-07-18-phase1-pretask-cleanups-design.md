# Phase 1 pre-task — deferred cleanup batch

Date: 2026-07-18
Status: approved (user-confirmed design), pre-implementation

Closes the eleven reviewer-triaged ride-along findings from the generalization-prep milestone
(final whole-branch review at `ea0578a`; list tracked in `.superpowers/sdd/progress.md`).
Grouped into three work packages. One ledger item — `projectTree` executing dissect chains —
was already resolved by recording it in the prep design's implementation notes; no code change.

## WP1 — core polish

1. `expression.ts`: type the jsep hook with jsep's exported `HookScope` instead of the local
   `JsepParserState`; drop the unnecessary `/u` flag on the hex-digit pattern.
2. `arrow/build.ts`: extract the duplicated safe-integer/int64-range guard into one shared
   helper used by both the int64/uint64 path and the timestamp path. (The positive-path
   number-input timestamp test already exists from the final fix wave — verify, don't add.)
3. `issues.ts`: `IssueCollector` constructor throws when `ordinalColumn` collides with a fixed
   errors-table column (`error_id`, `stage`, `code`, `message`, `recoverable`, `_src_start`,
   `_src_end`). The live array returned by `issues()` stays as-is (pre-existing pattern,
   internal consumer only).
4. `anchors.ts`/`walk.ts`: export `missingProperty`/`readOwnDataProperty` from `anchors.ts` and
   import them in `walk.ts` — one copy, so traversal parity cannot silently diverge.
5. `arrow/batch.ts`: clamp `flushRowThreshold` to ≥ 1.

## WP2 — dissect/spec hardening

6. Coverage gaps, all load-time-negative tests in `spec-v02.test.ts`: `parent_key` under
   version 0.1; `parent_key.table` not declared; a `parent_key` table fed by zero chain links;
   a state reference inside `payload`/`when`. Plus: accept numeric `version: 0.2` in the zod
   union (unquoted YAML footgun).
7. Payload containment, nested levels only: a nested payload's `start + bytes.length` must fit
   inside the enclosing payload; violations report `DISSECT_PAYLOAD_INVALID` (issue, never a
   throw). Root-level payloads are absolute file offsets and stay unchecked — the engine never
   sees the file length; a comment records that boundary.
8. Parser-rooted dissect entries (`from: <parser id>`) whose `payload`/`when` reference
   `_parent` or `_index` fail at compile time with `PROJECTION_DISSECT_INVALID` — those names
   evaluate against nothing in a child-tree context and would silently yield null.

## WP3 — pack/worker + the promised DuckDB proof

9. `parse.worker.ts` `mergeBatches`: columns absent from `pack.schemas()` fall back to the
   merged Arrow field's own `nullable` instead of `false`.
10. MIDI `pack.ts`: a failed/aborted parse is remembered; `finish()` rethrows the original
    error instead of masking it with `RECORD_SOURCE_NOT_DRAINED`.
11. Multi-batch DuckDB proof (spec Testing §3 of the prep design promised it): a generated
    ~66k-event MIDI (crosses the 64 Ki flush threshold, so the `events` table ships as
    genuinely multi-batch IPC) — a unit test in the MIDI package asserts the events IPC
    contains ≥ 2 record batches, and a browser e2e case opens the generated file through the
    normal upload path and asserts the exact `count(*)` via SQL against real DuckDB.

## Constraints

Same as the parent milestone: behavior-preserving (all guards fire only on inputs that are
already broken), zero-DOM core, no new dependencies, conventional commits on main. One commit
per work package.
