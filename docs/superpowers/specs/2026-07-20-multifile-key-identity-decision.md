# Decision: cross-file key identity in multi-file sessions

Date: 2026-07-20
Status: Recommendation — awaiting decision
Related: fix(pcap) f44b9d0 (DNS-by-time join scoped to `_src_file`), test b646fc4

## Context

In a multi-file session, per-table keys (`packet_id`, `ip_id`, `tcp_id`,
`stream_id`, …) **restart at 1 for every file**, so they are not unique across
files. A cross-table join written the natural way — `dns d join packets p using
(packet_id)` — matches a DNS row from one file against same-id packets from
*other* files, inflating rows and attaching wrong timestamps (observed: 744 dns
rows → 822 joined). The pcap presets are now fixed to join on `(packet_id,
_src_file)`, but **ad-hoc user SQL using `using (packet_id)` is still silently
wrong**. Since ByteQL's whole promise is trustworthy, provable answers, a
silently-incorrect join is a real trust hazard worth a deliberate decision.

## How keys work today (investigation)

- Keys are a per-`ProjectionSession` `bigint` counter seeded to `1n`
  (`packages/core/src/projection/project.ts:869-875, 994-995`). One session is
  created per file (`session.ts:76`; driven per-file by
  `apps/web/src/lib/session/controller.ts:326`). There is **no batch-wide
  counter** anywhere in core.
- `parent_key` (e.g. `dns.packet_id → packets.packet_id`) is a **copy** of the
  parent row's own per-file key (`project.ts:1011-1012, 1488, 1515`) — exactly
  as collision-prone as the key itself.
- `_src_start`/`_src_end` are computed in core; **`_src_file` is stamped
  downstream** by the web worker (`apps/web/src/workers/stamp-source-file.ts`)
  as the *deduped display name* (`capture.pcap`, `capture (1).pcap`). Core has
  **no concept of file identity**.
- All files' rows for a table append into **one** staging table
  (`packages/db/src/browser.ts`), renamed to the final table at finalize — a
  plain union, no per-file key namespacing. Raw keys collide.
- Already-global identifiers that exist today:
  - **`(_src_file, _src_start)`** — a de-facto globally-unique row address,
    already used as identity by the hex/provenance layer
    (`apps/web/src/lib/hex/filter-sql.ts`, `coverage.ts`).
  - **`_files.ingest_order`** — a batch-wide `int32` ordinal per file
    (`apps/web/src/lib/session/batch.ts`), computed before parsing.
- No schema carries PK/uniqueness metadata and DuckDB tables are plain
  `CREATE TABLE`s, so changing key *values* needs no DDL; adding a *new* column
  touches the reserved-name set, output types, every `*.tables.yaml`, generated
  queries, and the worker's nullability special-casing.

## The core tension

`packet_id` currently means **"frame number within this capture"** (1, 2, 3… —
matches Wireshark's `frame.number`). That is a genuinely useful, readable
identity. The only way to make `using (packet_id)` "just work" across files is to
make `packet_id` itself globally unique — which **destroys the frame-number
meaning**. No option makes ad-hoc `using (packet_id)` correct *and* keeps
`packet_id` as a readable per-file frame number. So the decision is essentially
binary.

## Options

### A — Keep per-file keys; treat `_src_file` as part of identity (RECOMMENDED)

Do not change the engine. `packet_id` stays the frame number. Cross-file joins
must include `_src_file` (as the presets now do). Harden with:
1. Preset fix — **done** (f44b9d0).
2. Regression tests — **done** (b646fc4): pack test forbids a preset joining
   without `_src_file`; e2e asserts the file-scoped join is 1:1 with `dns`.
3. Documentation — add a short "multi-file joins" note to the pcap format docs
   / a comment in `pcap.tables.yaml`, stating that keys are per-file and joins
   must match `_src_file`.

- **Pros:** zero engine risk; keeps frame-number semantics; matches the identity
  model the provenance layer already uses (`_src_file` is already part of "which
  row"); presets are correct.
- **Cons:** ad-hoc `using (packet_id)` remains a footgun for users who join
  across tables in a multi-file session. Mitigated only by docs, not enforced.

### B — Globally-unique keys via a per-file seed offset

Thread each file's ordinal (`index`, already available at `controller.ts:326`)
down into `createProjectionSession`/`createRuntimes` and seed `nextKey` to an
offset (e.g. `fileIndex << 40 | localId`). `parent_key` flows automatically
(it copies the already-offset key). Key stays `int64` — no DDL/schema change.
Must also cover `stream_id`/`segment_id` counters.

- **Pros:** `using (packet_id)` just works; ad-hoc joins are correct; single
  conceptual change; no schema change.
- **Cons:** `packet_id` stops being the frame number — a row shows
  `packet_id = 1099511627777` instead of `1`, which is worse to read and no
  longer maps to Wireshark. Interface change threads a file id through the core
  session API and **all three** formats' `project-*.ts` (pcap/zip/midi). Needs a
  safe stride (headroom check per format). Provenance/grid display of the key
  gets ugly.

### C — Add a hidden globally-unique surrogate column (e.g. `_row_uid`)

Keep `packet_id` readable; add a hidden batch-global id and point `parent_key`
at it. **Rejected:** it does not fix ad-hoc `using (packet_id)` (users would have
to know to use `_row_uid`, exactly the same education problem as `_src_file`),
while carrying the largest blast radius (reserved names, output types, every
`*.tables.yaml`, generated queries, worker nullability). All cost, no ad-hoc win.

## Recommendation

**Option A.** The composite `(_src_file, key)` is already the system's real row
identity — the provenance/hex layer treats `_src_file` as part of "which row,"
and `packet_id`'s frame-number meaning is worth keeping. The footgun is narrow
(ad-hoc *cross-table* joins in *multi-file* sessions; single-file sessions and
the presets are unaffected), and the fix for it (Option B) pays a real
readability cost and a cross-format interface change to make one SQL idiom
forgiving. Better to make `_src_file`-as-identity explicit and documented than to
sacrifice frame numbers.

Adopt Option B only if "ad-hoc cross-file joins must be correct without the user
knowing about `_src_file`" becomes a hard product requirement — at which point
the seed-offset approach above is the implementation, ideally with a separate
readable `frame_number` column preserved for display.

## If Option A is accepted — remaining work

- Documentation note (pcap format docs + `pcap.tables.yaml` comment) on per-file
  keys and `_src_file`-scoped joins. (Preset fix and tests already landed.)

## If Option B is chosen — implementation sketch

- Add an optional `keySeed`/`fileIndex` to `createProjectionSession` →
  `createRuntimes` (`session.ts`, `project.ts`); seed both table and stream/
  segment runtimes.
- Thread `index` from `controller.ts:326` → parse worker `runParse` →
  `pack.open` → `openPcapSource`/`project-*.ts` for all three formats.
- Choose a stride with per-format headroom; keep key `int64`.
- Preserve a readable `frame_number`/per-file ordinal column if frame identity
  is still wanted.
- Update the regression tests: `using (packet_id)` would then be safe, so the
  pack test's rationale changes.
