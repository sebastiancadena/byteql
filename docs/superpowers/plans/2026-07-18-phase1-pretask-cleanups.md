# Phase 1 Pre-task Cleanups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the eleven reviewer-triaged minor findings deferred from the generalization-prep milestone, per the approved design at `docs/superpowers/specs/2026-07-18-phase1-pretask-cleanups-design.md`.

**Architecture:** Three independent work packages (core polish; dissect/spec hardening; pack/worker + DuckDB proof). Every change is behavior-preserving for valid inputs — new guards fire only on inputs that were already broken.

**Tech Stack:** unchanged (TypeScript strict ESM, pnpm, vitest, Playwright, zod, jsep 1.4, apache-arrow 21).

## Global Constraints

- Behavior-preserving: every existing test passes unmodified unless a task explicitly says otherwise. Zero-DOM core; no new dependencies; no external URLs.
- Conventional commits on main, one commit per task, no Co-Authored-By, no AI-assistant branding.
- Verification per task: `pnpm -r check` plus the named suites; prettier-clean on touched files.

---

### Task 1: WP1 — core polish

**Files:** `packages/core/src/projection/expression.ts`, `packages/core/src/arrow/build.ts`, `packages/core/src/issues.ts` + `issues.test.ts`, `packages/core/src/projection/anchors.ts`, `packages/core/src/projection/walk.ts`, `packages/core/src/arrow/batch.ts` + `batch.test.ts`

- [ ] Replace the local `JsepParserState` interface with `import type { HookScope } from 'jsep'` (verify the export exists in the installed jsep 1.4 typings first; if its shape doesn't cover `expr`/`index`/`throwError`, keep the local type and record why in the report instead of forcing it). Drop the `/u` flag from `hexDigitPattern`. Existing hex tests are the oracle.
- [ ] In `build.ts`, extract one helper, e.g. `const requireInt64 = (value: number | bigint, table: string, column: string, kind: string): bigint`, that performs the safe-integer check for numbers and the int64-range check for bigints and returns the value as bigint, throwing the existing `ARROW_UNSAFE_INT64` message formats. Use it in both the int64/uint64 `valuesForType` path and the timestamp path. All existing build tests unchanged (they pin the messages). Confirm the positive-path number-input timestamp test exists (it landed with commit ea0578a, values written with numeric separators); add nothing if present.
- [ ] In `issues.ts`, constructor guard: `ordinalColumn` colliding with any of `error_id`, `stage`, `code`, `message`, `recoverable`, `_src_start`, `_src_end` throws `new Error('ISSUE_ORDINAL_COLUMN_RESERVED: ...')` naming the column. New test in `issues.test.ts`: `new IssueCollector({ ordinalColumn: 'code' })` throws `/ISSUE_ORDINAL_COLUMN_RESERVED/`; `'record'` and `'track'` still work.
- [ ] Export `missingProperty` and `readOwnDataProperty` from `anchors.ts`; delete the duplicated copies in `walk.ts` and import instead. Semantics must be byte-identical — `walk.test.ts` and `project.test.ts` are the oracle. (Note: `anchors.ts` and old `walk.ts` copies are already textually identical — this is pure consolidation.)
- [ ] In `batch.ts`, clamp: `this.#threshold = Math.max(1, options.flushRowThreshold ?? DEFAULT_FLUSH_ROW_THRESHOLD)`. New test: threshold `0` behaves as `1` (3 appended rows → 3 batches, correct values).
- [ ] Verify: `pnpm --filter @byteql/core test -- --run && pnpm -r check`, prettier on touched files.
- [ ] Commit: `chore(core): apply deferred review polish to expression, arrow, issues, and walk`

### Task 2: WP2 — dissect/spec hardening

**Files:** `packages/core/src/projection/spec.ts`, `packages/core/src/projection/expression.ts`, `packages/core/src/projection/project.ts`, `packages/core/src/projection/spec-v02.test.ts`, `packages/core/src/projection/dissect.test.ts`

- [ ] `spec.ts`: add `z.literal(0.2)` to the version union, transforming to `'0.2'` (mirror the existing numeric `0.1` handling). Test: a spec with unquoted `version: 0.2` and a `dissect` block parses.
- [ ] Four negative tests in `spec-v02.test.ts` (all branches already implemented — these pin them): (a) `parent_key` present under `version: '0.1'` with NO dissect block → `/PROJECTION_VERSION_REQUIRED/`; (b) `parent_key.table` names an undeclared table → `/PROJECTION_PARENT_KEY_INVALID/`; (c) a table declares `parent_key` but no chain link feeds it → `/PROJECTION_DISSECT_INVALID/`; (d) a state name referenced in a dissect `payload` or `when` → compile error (empty declared-state set → `/EXPRESSION_STATE_UNDECLARED/` — assert whichever code the existing implementation throws, and record it).
- [ ] Nested payload containment in `project.ts`: thread the enclosing payload's byte length into deeper `fireDissect` recursion (root level: `null` = unchecked, with a comment noting the engine never sees the file length). When a nested payload's `start + bytes.length` exceeds the enclosing length, report `DISSECT_PAYLOAD_INVALID` (message naming the overrun) and skip the chain — never throw. Test in `dissect.test.ts`: an `inner_parser` variant returning `trailer: { bytes: Uint8Array.of(9), start: 5000 }` (far beyond the 1-byte enclosing payload) yields a childless inner layer plus one `dissecting`/`DISSECT_PAYLOAD_INVALID` issue; the parent tables are unaffected.
- [ ] Compile-time context rejection in `project.ts` + `expression.ts`: add an AST-walking helper in `expression.ts` (pattern-match `getExpressionStateReferences`) that reports whether a compiled expression references `_parent` or calls `_index`. In `compileProjection`, for dissect entries whose `from` is a parser id (not a declared table), reject `payload`/`when` expressions using either, with `PROJECTION_DISSECT_INVALID` at the entry's path. Tests: parser-from entry with `when: '_index(0) == 0'` → throws; the same guard on a table-from entry still compiles (row context legitimately has both).
- [ ] Verify: `pnpm --filter @byteql/core test -- --run && pnpm --filter @byteql/midi test -- --run && pnpm -r check`, prettier on touched files.
- [ ] Commit: `feat(core): harden dissect payload containment and spec v0.2 validation`

### Task 3: WP3 — pack/worker + multi-batch DuckDB proof

**Files:** `apps/web/src/workers/parse.worker.ts`, `apps/web/src/lib/session/controller.test.ts`, `packages/formats/midi/src/pack.ts` + `pack.test.ts`, a MIDI large-fixture generator (follow the existing fixture helpers in `packages/formats/midi/test/fixtures.ts`), one new MIDI unit test, one new e2e case in `apps/web/e2e/`

- [ ] `mergeBatches` nullable fallback: `nullable: nullable?.get(field.name) ?? field.nullable`. Extend the existing multi-batch merge test: a column absent from the fake pack's `schemas()` reports the arrow field's own nullability instead of `false`.
- [ ] MIDI pack error memo: `open()` captures a failed parse (rejected `parseAndProjectMidi` promise); `finish()` rethrows that original error instead of `RECORD_SOURCE_NOT_DRAINED`. Test in `pack.test.ts`: open with an already-aborted signal, `nextBatch()` rejects, then `finish()` rethrows the abort error (assert it is NOT the NOT_DRAINED message).
- [ ] Large-fixture generator: build a valid type-0 MIDI with ~66_000 events (note_on/note_off pairs, delta 1, plus end-of-track) as a helper next to the existing fixture builders. Unit test in the MIDI package: `parseAndProjectMidi` on it succeeds, the `events` table rowCount is exact, and `ipcToTable(events.ipc).batches.length >= 2` (the 64 Ki flush threshold was crossed — the multi-batch claim proven at the pack boundary).
- [ ] e2e case (new spec file or extend `open-query-inspect.spec.ts`, following its upload pattern): generate the same large MIDI bytes in the test, open via the normal upload path, run `select count(*) as n from events`, assert the exact expected count — real DuckDB ingesting genuinely multi-batch IPC. Keep the fixture generation in-test (no large binary committed).
- [ ] Verify: `pnpm --filter @byteql/midi test -- --run && pnpm --filter @byteql/web test -- --run && pnpm -r check && pnpm --filter @byteql/web test:e2e`, prettier on touched files.
- [ ] Commit: `test: prove multi-batch DuckDB ingestion and fix pack finish error masking`

### Task 4: closing sweep

- [ ] `pnpm -r check && pnpm -r test -- --run && pnpm build && pnpm --filter @byteql/web check:bundle`
- [ ] Update `.superpowers/sdd/progress.md`: mark the deferred list closed with the three commit SHAs.
- [ ] No spec-doc changes expected; add an implementation note to the cleanup design doc only if a task deviated.
