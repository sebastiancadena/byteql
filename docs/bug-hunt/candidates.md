# Bug-hunt candidate log (compressed zones 1/4/5/6)

Scope: core projection engine · pcap framer + dissect registry · TCP stream assembler ·
db/spill tier + parse-worker protocol. Read-only audits, one subagent per zone; each
candidate must be judged against a named contract (PRD §9/App. A, the phase design
records' Implementation notes, AGENTS.md invariants).

Classification (final):

- `CONFIRMED` — failing test written first, then minimal fix, conventional commit.
- `FALSE_POSITIVE` — auditor reasoning wrong; note why.
- `KNOWN_LIMITATION` — documented in the design record; no fix this pass (documented in report).
- `DEFERRED` — real but out of compressed scope; reported, not fixed.
- `UNRESOLVED` — needs more evidence.

Status: COMPLETE — 4 confirmed bugs (Z1-2, Z1-4, Z1-6, Z5-1 — all fixed TDD-style),
plus the worker-privacy SMPTE-step flake (fixed with an explicit 90 s timeout);
remaining candidates deferred/documented (Z1-1, Z1-3, Z1-5, Z1-7, Z1-8, Z5-2).

## Zone 1 — core projection engine

Audited: expression evaluator sandbox (closed builtins,
`readOwnDataProperty`-only member access, forbidden `__proto__`/`constructor`/
`prototype` in anchors/identifiers/state names; row-time arithmetic returns null on
type mismatch; ternary null-condition-safe), `walk.ts`/`anchors.ts` traversal
(pre-order, per-anchor ordinals, overlap semantics), state-register scope resets +
monotonic keys, `ProjectionSession` drain/finish semantics, Arrow build
(`timestamp_us` exact int64 µs), `TableBatchBuilder` cumulative-rowCount contract,
`IssueCollector` ordering, `spec.ts` load-time validation (zod + rules 1-12, all
failures at load), stream compile rules. **3 confirmed bugs fixed (TDD): Z1-2, Z1-4,
Z1-6.** Remaining candidates deferred/documented below.

- **Z1-2 — P2, CONFIRMED + FIXED — `uint64` range enforced as int64; out-of-range
  bigints on 64-bit columns silently wrapped.**
  `valuesForType` (build.ts) applied `requireInt64` to `uint64` columns, rejecting
  valid uint64 values ≥ 2^63 (a hex literal like `0x8000000000000000`, a host byte
  offset, or a 64-bit timestamp all hit this) with `ARROW_UNSAFE_INT64` at seal —
  and bigints were never range-checked at all on plain int64/uint64 columns, so
  out-of-range bigints two's-complement-wrapped in arrow with no error. Fix:
  `requireInt64`/`requireUint64` split on the correct ranges `[−2^63, 2^63)` /
  `[0, 2^64)`, bigints now validated for both types, non-numeric values rejected with
  the structured error. TDD: `build.test.ts` "accepts bigint values across the full
  uint64 range" (red → green). Status: FIXED.
- **Z1-4 — P2, CONFIRMED + FIXED — non-finite number arithmetic survives row
  evaluation and throws at seal (poison record can kill the session).**
  `evaluateArithmetic`'s number branch returned `Infinity`/`NaN` for `x / 0`, `0 / 0`,
  `0 % 0`. Such a value in a declared 64-bit column throws `ARROW_UNSAFE_INT64` at
  batch seal — outside any per-record recovery, so one hostile record flips the whole
  capture to `PARSE_FAILED`, violating "a poison record must never take down the
  session." Fix: number-branch `/` and `%` results pass a `Number.isFinite` guard →
  null (row-time null, never throw). Finite-but-unrepresentable values (e.g. `0.5` in
  an int64 column) still fail loudly at seal — that is a spec-authoring type mismatch,
  not hostile data, and the existing `ARROW_UNSAFE_INT64` tests pin the loud failure.
  TDD: `expression.test.ts` "returns null for non-finite number division and modulo
  results" (red → green). Status: FIXED.
- **Z1-6 — P2, CONFIRMED + FIXED — stream feed-table key colliding with a fixed
  segments-table column silently corrupts the segments schema.**
  `streamSegmentsOutputTypes` places the feed table's key column next to fixed
  `segment_id`/`stream_id`/`offset` columns in an object literal; a feed table
  (non-stream-fed, so exempt from the `stream_id` key reservation) keyed `offset`,
  `segment_id`, or `stream_id` compiled fine, then the segments table lost a fixed
  column and the join key carried wrong values — no error at load or runtime. Fix:
  rule 7 (key half) rejects feed keys in `streamSegmentsFixedColumns` with
  `PROJECTION_STREAM_INVALID` at load. TDD: `stream-compile.test.ts` "rule 7: rejects
  a feed table whose key collides with a segments-table fixed column" (red → green).
  Status: FIXED.
- **Z1-1 — P2, DEFERRED — `==`/`!=` against `null` returns `null`, never a boolean.**
  The null-propagation guard in `evaluateBinary` runs before the equality cases, so
  `_.x == null` / `_.x != null` always evaluate to null: `where: '_.x != null'`
  silently empties the table. The PRD documents null *field access*, not Kaitai-style
  nil comparison, so this is a DSL-semantics gap rather than a contract violation; a
  fix (null-aware equality) is a documented-semantics decision, not a minimal fix.
  Workaround: guard with a builtin (e.g. `len()` on byte fields).
- **Z1-3 — P2, DEFERRED (now loud) — child-parser `resolve()` output is not
  range-validated; a negative provenance now throws instead of wrapping.**
  The Z1-2 fix rejects negative uint64 values with `ARROW_UNSAFE_INT64` at seal, so
  a pack-level bug emitting a negative byte offset now fails loudly instead of
  wrapping to 2^64−n. No shipped pack can emit negatives (all span computation is
  from validated, non-negative ranges); full row-time validation of `resolve()`
  output is a pack-authoring-safety design item for the next pack.
- **Z1-5 — P2, DEFERRED — narrow integer columns (int8…uint32) silently wrap
  out-of-range values.** `vectorFromArray` wraps (verified: 300 in int8 → 44) with no
  error; a spec expression whose range exceeds its declared column type yields wrapped
  garbage. All shipped packs are range-safe by construction (Kaitai field types match
  declared column types). Fix = per-type range validation in `valuesForType` (null or
  error semantics is a design decision). Natural next-pack work alongside Z1-3.
- **Z1-7 — P2, DEFERRED — multi-origin parser routes null parent keys that rule 7's
  static check claims are guaranteed.** Rule 7's availability fixpoint accumulates
  ancestors over *all* routes into a parser, so a child table whose
  `parent_key.table` is reachable only via one of two routes compiles, then rows fed
  through the other route get a null parent key. No shipped spec has a parser with
  two table-originated routes; fixing requires per-route availability tracking.
- **Z1-8 — P3, DEFERRED — number-typed state accumulators lose precision past 2^53.**
  A hostile MIDI with ~2.2M+ events each carrying a ~2^31 delta pushes the `tick`
  accumulator past the safe-integer bound; additions then silently round. Adversarial
  input only; bigint state accumulation is a DSL extension, not a bug fix.

## Zone 4 — pcap framer + dissect registry

No confirmed bugs. Audited: framer magic/endianness/tail-truncation/oversized-body/
straddle-copy (ByteSource.read is contractually a fresh copy; the generation-bumped
copy is pinned defense-in-depth), RAW-IP linktype mapping, dissect first-match quirk
(code matches the documented behavior exactly), `ip.length` v4/v6 normalization,
DNS-over-TCP guard, `icmpv6` next-header scope, ksy patches vs `PATCHES.md`
(hostile `total_length < ihl_bytes` → negative Kaitai size → throw → `errors` row).

## Zone 5 — TCP stream assembler

- **Z5-1 — P1, medium confidence — SYN+data off-by-one.**
  `pcap.tables.yaml:134,143` uses `offset: _.seq_num` with no SYN adjustment. If the
  first payload-bearing segment of a flow has the SYN flag set (TCP Fast Open / SYN+data),
  its payload actually sits at `seq+1`; storing it at `seq` leaves a permanent 1-byte hole
  → stream flushes `status: 'gap'` + `STREAM_GAP`, and all subsequent messages on the flow
  are dropped. Design contract: "standard forensic" (Wireshark accounts for the SYN
  consuming one sequence number). Not among the documented limitations. FIN twin is
  unreachable (FIN direction sends no further data).
  Status: CONFIRMING (failing test first).
- **Z5-2 — P2, medium confidence — per-flow memory retention, no global cap.**
  Each `StreamAssembler.#data` retains consumed bytes until `finish()`; N distinct flows ×
  up to 1 MiB `max_buffer` residency for the whole capture. Deliberate per-stream cap was a
  design choice; no global bound. Status: DEFERRED candidate (report-only; not a contract
  violation).

## Zone 6 — db/spill tier + parse-worker protocol

Audited by 3 failed subagent attempts + full manual pass (all prime suspects checked by hand).
**No confirmed bugs.** Areas verified clean:

- Hardening order (`allowed_directories` → external-access-off → extensions-off → lock;
  `LOAD parquet` before the loop) — `browser.ts:44-61`.
- `finalize()`/`abort()` state machine, `backfillSchemas`, typed final drops. Post-finalize
  cleanup cannot throw (`setSpillGeneration` in-memory; `deleteSpillGeneration` swallows all
  errors) — so the "failed-after-commit abort deletes live generation" path is unreachable.
- `appendBatch` byteLength-before-detach, quota tagging, `beginFile` boundary flush,
  `discardCurrentFile` chunk bookkeeping (chunk paths removed from the view array before the
  best-effort physical delete — no dangling `parquet_scan` paths).
- `beginIngest` tier fail-fast (`SPILL_UNSUPPORTED`), generation validation.
- `CreditGate` (parse.worker.ts:31): permits bounded at the window, wake-before-permit,
  `releaseAll` unblocks cancel without inflating permits. No off-by-one at window=4.
- `ParseWorkerClient` ack-chain deferral: finish/error/crash all defer settle behind the
  queued `onBatch`s; cancel's immediate reject is safe because the DB session-state check
  makes any racing late `appendBatch` throw cleanly, and cancel replaces the worker.
- Multi-file loop (controller `completeBatchOpen`): per-file `beginFile`/discard, skipped
  bookkeeping, supersession checks at every boundary; `stampSourceFile` stamps every batch of
  every table (incl. `errors`), so the memory-tier `DELETE ... WHERE _src_file = ...` covers
  all rows of a discarded file.
- Yield loop (project-pcap.ts): `pump()` is strictly sequential, and cancel/crash replace the
  worker, so at most one pump can ever share the module-level MessageChannel fallback —
  the single-pending-resolver invariant holds in all reachable states.

## Out-of-scope observations

- `test:worker-privacy` (SMPTE step, `check-worker-privacy.mjs:295`) timed out at the
  30 s default 3 of 4 runs in this environment (incl. the pre-change baseline), then
  passed at 90 s on every attempt — environmental slowness, not a functional defect.
  Fixed with an explicit 90 s budget on the step (commit `6c1c775`).
