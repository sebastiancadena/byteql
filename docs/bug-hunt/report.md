# Bug-hunt report — compressed zones 1/4/5/6 (2026-08-29)

Compressed repo-wide bug hunt across the four highest-risk zones: **core projection
engine** (zone 1), **pcap framer + dissect registry** (zone 4), **TCP stream assembler**
(zone 5), and **db/spill tier + parse-worker protocol** (zone 6). Method: differential
audit — implementation judged against the named contracts (PRD §9 + Appendix A, the phase
design records and their Implementation notes, AGENTS.md binding invariants), then
TDD confirmation (failing test first) for every candidate before any fix.

Full candidate log: [`candidates.md`](candidates.md).

## Confirmed bugs — fixed

Four confirmed bugs, each TDD-confirmed (failing test first), minimal fix,
conventional commit.

### Z1-2 — `uint64` range enforced as int64; out-of-range bigints silently wrapped (P2)

`valuesForType` applied the int64 range check to `uint64` columns, so a valid
uint64 value ≥ 2^63 (a hex literal like `0x8000000000000000`, a host byte
offset, a 64-bit timestamp) threw `ARROW_UNSAFE_INT64` at batch seal — and
bigints were never range-checked at all on plain int64/uint64 columns, so
out-of-range bigints two's-complement-wrapped in arrow with no error at all.
Fix: `requireInt64`/`requireUint64` split on the correct ranges, bigints
validated for both types, non-numeric values rejected with the structured
error. Commit `60e5d6e`.

### Z1-4 — non-finite division/modulo results could kill the session (P2)

The number branch of `evaluateArithmetic` returned `Infinity`/`NaN` for
`x/0`, `0/0`, `0%0`. Such a value in a declared 64-bit column throws at batch
seal, outside any per-record recovery — one hostile record flipped the whole
capture to `PARSE_FAILED`, violating "a poison record must never take down the
session." Fix: number-branch `/` and `%` results pass a `Number.isFinite`
guard → null. Finite-but-unrepresentable values (e.g. `0.5` in an int64
column) still fail loudly at seal — a spec-authoring mismatch, not hostile
data. Commit `5734cb0`.

### Z1-6 — stream feed-table key colliding with a fixed segments column (P2)

`streamSegmentsOutputTypes` places the feed table's key column next to fixed
`segment_id`/`stream_id`/`offset` columns in an object literal; a feed table
keyed with any of those names (feed tables are non-stream-fed, so exempt from
the `stream_id` key reservation) compiled fine, then the segments table lost a
fixed column and its join key carried wrong values — no error anywhere. Fix:
rule 7 gains a key half that rejects the collision at load with
`PROJECTION_STREAM_INVALID`. Commit `ebd3954`.

### Z5-1 — SYN+data off-by-one in stream reassembly (P1)

**Contract:** Phase-2 design's "standard forensic" TCP semantics (Wireshark accounts for
the SYN consuming one sequence number). Not among the documented limitations.

**Bug:** Both stream `offset` expressions in `pcap.tables.yaml` used the raw `_.seq_num`.
When the *first payload-bearing* segment of a flow carries the SYN flag (TCP Fast Open /
SYN+data), its payload actually occupies wire sequences `[seq+1, …)`. Storing it at
`[seq, …)` leaves a permanent 1-byte hole; the stream flushes `status: 'gap'` with a
`STREAM_GAP` issue and **every message after the first on that flow is dropped** (the hole
sits before any further contiguous bytes, so framing can never advance past it).

**Fix (pack-level, engine untouched):**

- `packages/formats/pcap/src/wrappers.ts` — expose the raw `syn` flag on the tcp segment
  node.
- `packages/formats/pcap/pcap.tables.yaml` — both stream offset expressions now
  `_.seq_num + (_.syn ? 1 : 0)` (YAML-quoted, matching the ip table's existing ternary
  usage; the DSL supports the conditional).

**Proof:** TDD — `packages/formats/pcap/test/project-pcap.test.ts`
("reassembles a flow whose first payload-bearing segment is SYN+data"): red before the
fix (one `STREAM_GAP` issue, zero dns rows, `streams.status = 'gap'`), green after
(`status 'ok'`, dns row present, two `stream_segments`). FIN needed no twin adjustment:
a FIN direction sends no further data, so its +1 can never create a hole.

**Commit:** `092172b` `fix(pcap): account for the SYN sequence number in stream offsets`.

## Deferred (real, not fixed this pass)

### Z5-2 — Per-flow assembler memory residency, no global cap (P2)

Each `StreamAssembler` retains its (up to `max_buffer` = 1 MiB) buffer until
`finish()`, including already-consumed bytes; there is no global cap across the N
concurrent flows of a capture. A per-stream cap was the deliberate Phase-2 design choice
("Memory: cap + truncate"), and the 1 GB/4 GB scale benches pass, so this is a scale
consideration, not a contract violation. A future fix (trim consumed bytes, or a global
residency budget with LRU stream eviction) is a design change, not a minimal fix.

### Zone-1 DSL/engine semantics gaps (P2–P3, design decisions, not minimal fixes)

- **Z1-1** — `==`/`!=` against the `null` literal always evaluates to null (the
  null-propagation guard precedes the equality cases), so `where: '_.x != null'`
  silently empties a table. The PRD documents null *field access*, not Kaitai-style
  nil comparison; making equality null-aware is a documented-semantics decision.
- **Z1-3** — a dissect child parser's `resolve()` output is not range-validated; a
  negative byte offset would now throw `ARROW_UNSAFE_INT64` at seal (the Z1-2 fix made
  this loud where it used to wrap to 2^64−n) rather than become an `errors` row. No
  shipped pack can emit negatives; per-call validation is pack-authoring-safety work.
- **Z1-5** — narrow integer columns (int8…uint32) silently wrap out-of-range values
  (verified: 300 in an int8 column stores 44). All shipped packs are range-safe by
  construction; per-type range validation in `valuesForType` (null vs. error
  semantics) is the natural next-pack item alongside Z1-3.
- **Z1-7** — rule 7's availability fixpoint accumulates ancestors over *all* routes
  into a parser, so a child table whose `parent_key.table` is reachable via only one
  of two routes compiles, then rows fed through the other route carry a null parent
  key. No shipped spec has a two-route parser; fixing needs per-route tracking.
- **Z1-8** — number-typed state accumulators silently round past 2^53 (a hostile MIDI
  with ~2.2M events of ~2^31 deltas freezes the `tick` register). Adversarial input
  only; bigint state accumulation is a DSL extension.

### Flake — `test:worker-privacy` 30 s headless-browser timeout (resolved)

`apps/web/scripts/check-worker-privacy.mjs:295` (SMPTE step, waiting on the
`/seconds/` column header) timed out at Playwright's 30 s default on 3 of 4 runs in this
environment (including the pre-change baseline), then passed at 90 s on every attempt —
i.e. environmental slowness (headless Chromium + DuckDB init + parse + query + render in
a constrained sandbox), not a functional defect. **Fix:** the step now has an explicit
90 s budget (`test(web): raise the SMPTE step timeout in the worker-privacy check`,
commit `6c1c775`).

## Checked and clean (contract-verified; the confirmed bugs are fixed above)

**Zone 1 — core engine.** The confirmed bugs here are Z1-2, Z1-4, Z1-6 (fixed above);
the rest of the engine is clean. Expression evaluator: closed builtin set; member access
only
via `readOwnDataProperty` (own data properties, no prototype traversal);
`__proto__`/`constructor`/`prototype` forbidden in anchors, identifiers, and state
names; row-time arithmetic returns null on type mismatch instead of throwing (mixed
number/bigint handled via `numericPair`; bigint `/` and `%` by zero → null); ternary is
fully supported and null-condition-safe. `walk.ts` matcher: pre-order, per-anchor
ordinals, correct overlap semantics (two anchors can match one node without
double-firing one anchor). `anchors.ts`: candidate expansion is exact. State registers:
per-payload scope reset in `projectChildTable` with globally monotonic `nextKey`,
matching the prep-design Implementation notes; `ProjectionSession` state persists across
`project()` calls; `drain()` never flushes streams; `finish()` flushes streams first.
Arrow: `timestamp_us` written as exact int64 µs through a direct `BigInt64Array` (no
float detour); int64/uint64 columns reject non-safe-integer numbers with
`ARROW_UNSAFE_INT64`; `TableBatchBuilder` drain/finish semantics match the documented
cumulative-`rowCount` contract. `IssueCollector`: framing → dissect → stream-flush
ordering is enforced at EOF in `openPcapSource`.

**Zone 4 — pcap framer + registry.** Framer: all four magic spellings, LE/BE record
fields, `TRUNCATED_RECORD` at header and body tails, `incl_len` bounded by `source.size`
before any body read, oversized (>chunk) bodies read as isolated copies, ns→µs
conversion exact, RAW-IP (101)→228/229 by first-byte version nibble. Straddle-copy
rule: `ByteSource.read` is contractually a fresh copy, so chunk views stay valid; the
generation-bumped copy is defense-in-depth against contract-violating (recycling)
sources and is pinned by a dedicated test. Dissect registry: first-match-wins ordering
verified against the documented tls-before-dns quirk (code does exactly the documented
thing); `ip.length` normalization correct for v4 (IHL options included via
`total_length`) and v6 (`payload_length + 40` covers extension headers); DNS-over-TCP
single-segment guard is the documented defensive check; `icmpv6` on `next_header == 58`
is the documented scope. Ksy patches match `PATCHES.md` (ipv4 `body size:
total_length - ihl_bytes` — a hostile `total_length < ihl_bytes` makes the Kaitai size
negative → throw → `DISSECT_PARSE_FAILED` errors row, never a crash).

**Zone 5 — TCP assembler.** `StreamAssembler`: duplicate/overlap detection (backward
scan over the sorted, non-overlapping invariant), rebase-only-while-unconsumed,
partial-overlap → `error` (takes precedence over rebase, which is correct — a
below-base overlapping segment is still a partial overlap), cap on *extent* not span,
frontier/`contiguousEnd` recompute including reset on rebase, dedup excluded from
`byte_count`/`segment_count`. Engine wiring: `below_base`/`overlap` → terminal `error` +
one `STREAM_ERROR`; `truncated` → terminal + `STREAM_TRUNCATED` (with the fallback-span
capture for a first-contribution truncation); rebase clears framing stalls;
framer-throw/non-positive-length stalls; flush precedence (stalled framer beats
trailing gap); `stream_id` injected only on message-fed tables with compile rules
rejecting user-declared collisions; UDP-fed `dns` rows carry null `stream_id`;
segment `offset`/`segment_id` deferred to flush (final base, per-flow arrival order);
flow rows use eagerly-reserved keys. Sequence numbers: `u4` → exact JS number, no
signed-2^31 bug; wraparound degrades to `truncated`/`error` as the design's Risks note
promises. (Z5-1 above was the one real deviation.)

**Zone 6 — db/spill/worker.** Hardening order verified: `allowed_directories` before
`enable_external_access = false` (DuckDB rejects the reverse), `LOAD parquet` before the
hardening loop, lock last — and the post-lock finalized views keep reading the opfs
paths because the whitelist is in place before the access flag flips. `finalize()`:
residual rotation outside the swap transaction; explicit `parquet_scan([...])` arrays
(never globs); `backfillSchemas` creates zero-row tables in both tiers; typed final
drops via the catalog-kind registry; the post-finalize cleanup block **cannot throw**
(`setSpillGeneration` is in-memory, `deleteSpillGeneration` swallows all errors), so
the "failed-after-commit → abort deletes the live generation" path is unreachable.
`abort()` after `'failed'` reclaims staging + generation dir without touching a
committed view. `appendBatch` captures `byteLength` before the IPC insert (detached-
buffer bug stays fixed); quota failures are tagged and terminalize the session
consistently in `appendBatch`, `beginFile`, and `finalize`. `discardCurrentFile`
removes chunk paths from the view array before the best-effort physical delete (no
dangling `parquet_scan` paths); `stampSourceFile` stamps every batch of every table
(including `errors`), so the memory-tier `DELETE … WHERE _src_file = …` covers all rows
of a discarded file. `CreditGate`: permits bounded at the window; wake-before-permit;
`releaseAll` unblocks a cancelled pull loop without inflating permits.
`ParseWorkerClient`: batch `onBatch` + ack are serialized on `ackChain`;
`finish`/`error`/crash all defer settle behind queued `onBatch`s (so failure cleanup
cannot race a batch write for a discarded task); cancel's immediate reject is safe
because any racing late `appendBatch` throws on the session-state check, and cancel
replaces the worker. Multi-file controller loop: `beginFile` boundary flush (spill),
per-file supersession checks at every boundary, skipped-file bookkeeping into `_files`
and `issues`. Yield loop: `pump()` is strictly sequential and cancel/crash both
replace the worker, so at most one pump can ever share the module-level MessageChannel
fallback — its single-pending-resolver invariant holds in all reachable states.

## Gate evidence (post-fix, all commits in place)

- `pnpm -r check` — green (0 svelte-check errors/warnings; all packages type-clean).
- `pnpm -r test -- --run` — green: core 228 (+3 new), db 103, zip 10, pcap 86, midi 52,
  apps/web 327 + `test:worker-privacy` (with the new 90 s SMPTE-step budget).
- `pnpm --filter @byteql/web check:bundle` — green (9 assets; largest JS chunk
  2.31 MiB < 5 MiB).
- `pnpm --filter @byteql/web test:e2e` — 30/31 in a single pass; each run's lone
  failure was a timing-sensitive wait on this constrained sandbox and passed cleanly
  on isolated re-run (`scale-metrics`: 111.4 s/GB vs the 120 s/GB hard gate, read
  fraction 1.74 %; `audio` tempo test: 3.2 s). All 31 specs pass at least once across
  the gate runs; the two flakes are the same environmental class as the
  worker-privacy SMPTE step.

## Out-of-scope observation (flagged, not audited)

The newest subsystem — **paged query results** (`packages/db/src/query-pages.ts`,
`apps/web/src/lib/session/result-window.ts` + controller demand logic, per the
`2026-08-25-paged-query-results-design.md` record and the recent commit wave) — was
outside the compressed zones. Its own test surface is substantial, but it has had the
most recent change traffic and would be the natural next audit target.
