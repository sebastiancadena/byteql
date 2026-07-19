# Scale & intake — Phase 1 slice 2 design

Date: 2026-07-19
Status: approved design, pre-implementation

## Context

The pipeline today is whole-buffer end-to-end: `SessionController.openFile` reads the entire
`File` into one `Uint8Array`, transfers it to the parse worker, the pack parses and projects
everything eagerly, the worker merges all batches per table and posts a single result, and
`replaceTables` drops-and-recreates in-memory DuckDB tables. That path cannot meet the two
Phase-1 exit metrics this slice owns (PRD §5):

- a 1 GB pcap becomes queryable in < 60 s;
- a query over 3 columns of a 4 GB capture reads < 10 % of the file (projection/predicate
  pushdown verified).

The 4 GB case cannot even materialize a single buffer, so intake must become genuinely chunked,
and query storage must move to a columnar at-rest form DuckDB can scan lazily. This slice
rebuilds the transport (intake → worker → DB) without changing what is parsed or projected:
same tables, same rows, same provenance, same issues.

## Scope decisions (settled)

- **Full chunked intake, one read path.** `FormatPack.open` takes a random-access `ByteSource`
  instead of a `Uint8Array`; the whole file never lives in memory. (Rejected: whole-buffer with
  streamed output — meets the 1 GB metric only; a dual-path hybrid — two intake paths to
  maintain.) The production source wraps `File.slice()`, which works identically for `<input>`,
  drag-drop, and `showOpenFilePicker` files in every browser.
- **Tiered storage: memory small, Parquet large.** Below `TIER_THRESHOLD_BYTES` (initial value
  64 MB, tunable constant) projected batches append into in-memory DuckDB tables; at or above
  it they rotate through OPFS Parquet and the final tables are views over `parquet_scan`.
  (Rejected: always-Parquet — OPFS overhead and hard dependency for tiny files;
  spill-on-memory-pressure — most complex state machine.)
- **Spill is DuckDB-owned (Approach A).** Batches enter DuckDB staging tables; DuckDB itself
  writes Parquet chunks to OPFS via `COPY` and reads them back via `parquet_scan`. No new
  dependency; one engine owns storage. (Rejected: parquet-wasm writer in the parse worker —
  new wasm dependency, Arrow→Parquet type mapping owned by us; kept as the last-rung fallback.
  Spill-once-at-finish — peak memory ≈ whole capture, defeats the 4 GB goal.)
- **Hardening posture: whitelist the spill directory only.** Keep `enable_external_access`
  disabled and extensions locked; whitelist `opfs://byteql-spill/` via `allowed_directories`;
  `lock_configuration = true` stays, applied last. Fallback ladder in the Design section.
- **Metric verification: scaled CI + full-size manual bench.** CI asserts throughput and
  read-fraction on a generated ~64–128 MB capture; a checked-in bench script generates
  deterministic 1 GB / 4 GB captures and emits the exit-criterion benchmark JSON, run manually
  like the Phase 0 benchmark.
- **Session stays gated until ready.** No querying over partially-loaded tables; the investment
  goes into real progress (bytes-based %, MB/s, per-table row counts). Progressive querying is
  a possible later enhancement, not this slice.

## Non-goals

- Progressive querying / partial results during parse.
- pcapng; any new format, table, or projection behavior. Every existing table keeps identical
  values (regression bar).
- Persistent captures across sessions (re-openable FSA handles, saved workspaces). Spill files
  are session-scoped scratch, deleted on replacement/dispose/startup-sweep.
- Parquet **export** as a user feature (PRD v1 scope but a separate concern; the spill work
  makes it near-free later).
- Multi-file sessions; worker pools (one parse worker remains).

## Design

### ByteSource and the pack contract (`@byteql/core`)

```ts
export interface ByteSource {
  readonly size: number;
  /** Resolves a copy; shorter than `length` only at EOF. */
  read(offset: number, length: number): Promise<Uint8Array>;
}
```

`FormatPack.open(source: ByteSource, opts: OpenOptions): RecordSource`. `probe(head)` is
unchanged — the worker reads the first 4 KB once and probes every pack with it.

Contract notes recorded alongside the interface:

- Small-file packs may slurp: MIDI adapts with a single `await source.read(0, source.size)`
  and keeps its whole-buffer internals.
- **Copy-on-retention rule:** chunk buffers are transient. Any bytes that outlive the record
  currently being framed must be copied. Verified: the `StreamAssembler` already copies segment
  payloads on ingest (`#data.set(bytes, relStart)` in `add()`), not merely views into the
  caller's buffer — no assembler change was needed. This is now pinned by a regression test
  (`streams.test.ts`: mutate the caller's buffer after `add()`, assert reassembly is
  unaffected). Provenance columns are absolute offsets, never views, and are unaffected.
- `RecordSource.nextBatch()` keeps its pull contract and the drain-before-finish rule, but each
  pull now does real work: advance the framer until some table's batch builder crosses its
  flush threshold (or input is exhausted), then emit that one `BatchTransfer`. The Phase-2
  ordering (flush streams into issues before materializing the errors table) is unchanged.

### Incremental pcap framer (`@byteql/pcap`)

The framer reads fixed-size chunks (~8 MB) through the `ByteSource`, carrying over the partial
record that straddles a chunk boundary. `body.bytes` become views into the transient chunk;
`body.start` stays the absolute file offset. Downstream dissection is per-record and completes
before the next chunk is read, so only the stream assembler needs the copy-on-ingest change.
Truncated-tail behavior (truncate-and-stop, keep prior packets) is unchanged.

### Worker protocol (`apps/web`)

Request: `{ type: 'parse', taskId, file: File, formatId? }` — the `File` is structured-cloned;
no buffer transfer. Responses:

- `{ type: 'batch', taskId, seq, table, ipc, rowCount }` — one per `BatchTransfer`, IPC buffer
  transferred, `seq` monotonic.
- `{ type: 'progress', taskId, stage, completed, total, label }` — `completed`/`total` are now
  bytes (framer position / file size).
- `{ type: 'finish', taskId, format, issues, capabilities, queries, schemas }` — terminal;
  everything `ParseResult` carried except tables.
- `error` / `cancelled` — unchanged.

**Backpressure:** credit-based window of 4. The worker sends up to 4 unacknowledged batches,
then awaits `{ type: 'batchAck', seq }` before pulling `nextBatch()` again. The main thread
acks only after DuckDB has consumed the batch, so worker memory is bounded at
window × batch size. `ParseResult.tables` disappears from the app path; `TableTransfer`
survives only at the DB append boundary.

`ParseWorkerClient` gains a streaming `parse` variant taking `onBatch`/`onProgress` callbacks
and resolving with the finish payload. `SessionController.completeOpen` becomes: begin ingest
session → forward each batch (then ack) → on finish, finalize and dispatch `ready`. The
`registering` phase folds into parsing; `ready` metadata (table names, row counts, columns)
comes from the finish message plus ingest counters. Cancellation keys off the existing
`AbortSignal`/generation plumbing and additionally aborts the ingest session.

### Ingest sessions and spill (`@byteql/db`)

`replaceTables` is superseded by:

```ts
beginIngest(opts: { schemas; tier: 'memory' | 'spill'; generation }): Promise<IngestSession>
// IngestSession:
appendBatch(table: string, ipc: Uint8Array): Promise<void>
finalize(): Promise<readonly TableSummary[]>  // { name, rowCount } per table
abort(): Promise<void>
```

Both tiers append into generation-scoped staging tables `__ingest_<generation>_<table>` via
`insertArrowFromIPCStream` (create on first append, append after).

- **Memory tier:** `finalize()` renames staging tables to their final names.
- **Spill tier:** `appendBatch` tracks staged bytes per table; when a table crosses the
  rotation threshold (~96 MB staged, test-tunable), run
  `COPY __ingest_… TO 'opfs://byteql-spill/<generation>/<table>/<n>.parquet' (FORMAT parquet)`
  and truncate the staging table. `finalize()` flushes residuals the same way, then creates
  each final table as a view over
  `parquet_scan('opfs://byteql-spill/<generation>/<table>/*.parquet')`. Pushdown through those
  views is what the < 10 %-read metric measures.

**Atomicity and rollback:** the committed generation's tables/views and spill directory are
never touched while a new ingest runs. `abort()` drops the new generation's staging tables and
deletes its spill directory. `finalize()` performs the swap (drop old finals, install new) and
only then deletes the old generation's spill directory. This replaces the controller's
`committedTables` re-registration; no retained IPC anywhere.

**Hardening**, in order at init: `SET allowed_directories = ['opfs://byteql-spill/']` first
(it cannot be changed once external access is disabled — empirically verified at runtime),
then disable external access; extension autoinstall/autoload/community off;
`lock_configuration = true` last. **Day-one spike task** confirms on the pinned
`duckdb-wasm 1.33.1-dev57.0`: (a) `COPY ... TO` an `opfs://` path, (b) `allowed_directories`
honored with external access disabled, (c) `parquet_scan` over `opfs://` globs, (d) the
`collectFileStatistics` API for read accounting. Fallback ladder, in order:

1. Whitelist as specced (preferred).
2. `enable_external_access = true`, everything else still locked (browser sandbox + DuckDB's
   virtual FS remain the boundary).
3. Approach B (parquet-wasm writer in the parse worker) — only if OPFS *writing* through
   DuckDB is unsupported. The spike's finding and the chosen rung are recorded here.

**Spike findings (Task 1, recorded)**: run against real Chromium via
`apps/web/e2e/spill-capability.spec.ts` on the pinned `duckdb-wasm 1.33.1-dev57.0`:
`opfsAvailable: true`, `copyToOpfs: true`, `allowedDirectories: true`, `parquetScanGlob: true`,
`fileStatistics: true`, `detail: ""`. `allowedDirectories: true` selects **rung 1** (whitelist
as specced). One correction to the design as written above: this build's `parquet_scan`/
`read_parquet` do not implement real directory enumeration for `opfs://` glob strings —
`SELECT ... FROM parquet_scan('opfs://.../*.parquet')` and `db.globFiles()` both report zero
matches even though the file exists and reads fine at its exact registered path. The probe's
`parquetScanGlob` instead confirms the mechanism the spill tier actually needs: unioning
multiple registered OPFS parquet parts via an explicit path array,
`parquet_scan(['opfs://.../0.parquet', 'opfs://.../1.parquet'])`, which works. Since
`appendBatch`'s rotation loop already knows every part-file name it wrote, `finalize()`'s
per-table views must be built from that tracked array rather than a `*.parquet` wildcard
string.

**OPFS lifecycle:** request `navigator.storage.persist()` on first spill-tier ingest;
`QuotaExceededError` fails the ingest (abort + cleanup + surfaced message); startup sweeps
`byteql-spill/` for directories from crashed sessions; `dispose()` deletes everything.

### Intake and tiering (`apps/web`)

`EmptyState` keeps `<input type=file>` + drag-drop as the universal path and adds
`showOpenFilePicker` where available. All paths yield a `File`; tier is
`file.size >= TIER_THRESHOLD_BYTES`. If the spill tier is required but OPFS or the
spike-confirmed DuckDB support is unavailable in the running browser, the open fails fast with
a clear "this browser cannot handle files over N MB" message — the PRD's documented
degradation, never a silent in-memory attempt.

### Progress

Status bar shows stage, a percentage (bytes-based for pcap; MIDI reports track counts instead —
see the amendment below), and a cumulative-average MB/s rate once enough of the file has been
seen for the rate to be meaningful. Per-table row counts are not shown live during intake; the
Explorer's per-table counts come from the terminal `finish`/`finalize` summary once the file is
ready (see the amendment below).

## Error handling

Worker crash, quota exhaustion, parse failure, schema-mismatch on append (a programming error,
not a recoverable issue), and cancellation all funnel through `IngestSession.abort()` —
staging tables and spill directories never leak. The issues/errors-table flow is unchanged;
issues arrive in the `finish` message.

## Testing

- **Unit:** chunk-boundary framing (record split across reads, truncated tail, record larger
  than a chunk); the `File`-backed `ByteSource`; `StreamAssembler` copy-on-ingest (mutate the
  source buffer after ingest, assert reassembly unaffected); ingest-session SQL against real
  duckdb-wasm where the `browser.test.ts` harness allows; protocol credit/ack ordering and
  cancellation mid-window.
- **E2E regression bar:** every existing suite passes with identical values; MIDI behavior
  untouched.
- **E2E spill path:** a generated ~8 MB capture with test-lowered tier threshold and rotation
  size proves intake → rotation → views → query → provenance end-to-end in CI cheaply.
- **Scaled CI metric spec:** generates a ~64–128 MB capture; asserts throughput consistent
  with 1 GB < 60 s and read-fraction < 10 % on a 3-column query via `collectFileStatistics`
  (fallback: instrumented OPFS read counter).
- **Manual bench:** checked-in script generates deterministic 1 GB / 4 GB synthetic captures
  (seeded PRNG, DNS/TCP/TLS mix) and emits the exit-criterion benchmark JSON, like the Phase 0
  benchmark artifact.

## Risks & notes

- **duckdb-wasm OPFS write support is the load-bearing unknown** — hence the day-one spike and
  the recorded fallback ladder. Do not build past the DB layer until the spike lands on a rung.
- The `apache-arrow-duckdb` (arrow 17) pin exists because duckdb-wasm's IPC ingestion lags the
  workspace's arrow 21; staging-table ingestion inherits this. Any arrow version work is out of
  scope; the append path must keep using the same IPC bytes the batch builders emit today.
- Credit window (4), chunk size (8 MB), tier threshold (64 MB), and rotation threshold (96 MB)
  are all named constants with test overrides; the bench script is the tool for tuning them,
  not guesswork.
- `File.slice().arrayBuffer()` on a dying/removed-drive file rejects; that surfaces through
  the normal parse-failure path.
- Firefox/Safari get the same chunked read path (it is Blob-based); only the spill tier is
  capability-gated. This exceeds the PRD's "in-memory fallback with size cap" floor.

## Implementation notes (recorded post-execution)

Recorded 2026-07-19 after all 12 implementation tasks plus reviews landed
(`71cb8c5..74596de`, 25 commits on main). The full slice-2 span, from the implementation plan
through the doc-status commit that closed it out, is `f38aa7b..728f172` (26 commits) — the
final-review fix wave below (C1, I1, I2, and trivia items) landed as further commits on top of
that range.

### Measured numbers

Both Phase-1 exit metrics (PRD §6) are **MET**, measured directly on this machine (arm64,
20 logical cores, Chromium 149):

- **1 GB pcap queryable in 44.25 s** (< 60 s target).
- **A 3-column query over a 4 GB capture reads 1.71 %** of the capture (< 10 % target; the
  1 GB run separately measured 1.72 %).
- 4 GB parse: 176.4 s (44.1 k ms/GB — linear with the 1 GB figure).
- Bench artifacts (git-ignored `bench/`, regenerate with `run-scale-bench.mjs --gb 1|4`):
  `apps/web/bench/scale-1gb-2026-07-19.json`, `apps/web/bench/scale-4gb-2026-07-19.json`.

### The recorded rung

Task 1's day-one spike (`apps/web/e2e/spill-capability.spec.ts`, pinned `duckdb-wasm
1.33.1-dev57.0`) confirmed **rung 1** (whitelist `allowed_directories` as specced) — see
"Spike findings (Task 1, recorded)" above for the full probe result and the opfs-glob
correction it carries (spill views must be built from explicit `parquet_scan([...])` arrays
of tracked chunk paths, not `*.parquet` glob strings, which don't enumerate on this build).

### The `schemas: 'discover'` decision

`beginIngest` accepts `schemas: 'discover'` alongside a static schema list. Table schemas are
format-specific (pcap and MIDI project different table sets), and the worker's `appendBatch`
calls for a generation arrive before the terminal `finish` message that would otherwise carry
schema information up front. Discovery mode creates each staging table from the shape of the
first batch it sees for that table rather than requiring the caller to predeclare every table.

### Amendments accumulated during execution

- **Worker request carries a `Blob`, not a `File` as drafted above.** `openSample` builds an
  in-memory `Blob` for the bundled demo sample rather than a real `File`; generalizing the
  `parse` request to `{ type: 'parse', taskId, name, blob: Blob, formatId? }` (`File` is a
  `Blob`) lets both intake paths share one worker protocol instead of branching.
- **Hardening order is stricter than first specced:** `allowed_directories` must be set
  *before* `enable_external_access` is disabled, not merely "first" among the app's own
  PRAGMAs — setting it after leaves the app unable to boot. The Design section's hardening
  order above reflects the corrected, runtime-verified order (Task 7).
- **`LOAD parquet` must run before the hardening loop**, not after: the extension never loads
  once autoinstall/autoload are off and configuration is locked, so `COPY ... FORMAT parquet`
  would otherwise fail (Task 11).
- **DuckDB throws a Catalog Error on a type-mismatched `DROP ... IF EXISTS`** in both
  directions (dropping a view where a table is expected, and vice versa). The finals registry
  now records each final table/view's catalog kind so cleanup issues one correctly-typed
  `DROP` per name (Task 7).
- **Detached-buffer staged-bytes bug:** `appendBatch` read a buffer's `byteLength` *after*
  `insertArrowFromIPCStream` had already transferred (detached) it, so the spill tier's
  rotation threshold never tripped and ingest silently stayed on the memory tier regardless of
  size. Fixed by capturing `byteLength` before the insert call — a real-browser-only bug no
  mock harness could see (Task 11).
- **Errors-table issue ordering:** at EOF materialization, framing issues must be flushed into
  the collector ahead of dissect issues so the `errors` table's row order matches arrival
  order, not construction order — a Phase-2 finding re-verified against the incremental
  framer's rewrite in this slice.
- **`finish()`-vs-`drain()` `rowCount` divergence:** `FinishedTable.rowCount` is cumulative
  across every prior `drain()` plus the final flush, not just the last chunk — documented
  directly on the type after a reviewer flagged the ambiguity (Task 3).
- **`setTimeout` nesting clamp:** the per-packet yield (`setTimeout(0)`) hit Chromium's ~4 ms
  timer-nesting clamp, costing roughly 40 s/GB even batched at a 256-packet interval
  (`YIELD_INTERVAL_PACKETS`). Replacing it with an unclamped yield (`scheduler.yield()`,
  `MessageChannel` fallback) is what closed the 1 GB metric from an initial 80.6 s miss to the
  44.25 s reported above (Task 12).
- **`finish` carries `schemas` after all — this field was dropped during implementation and
  restored in the final-review fix wave (C1).** The Worker protocol section above always
  documented `{ type: 'finish', ..., schemas }`, but the shipped worker omitted it, and
  discover-mode `finalize()` only ever created tables an `appendBatch` had actually touched. A
  capture that produces zero rows for a pack table (e.g. no `tcp` packets) therefore left that
  table entirely absent from the catalog — regressing pre-slice-2 behavior, where every compiled
  table always existed — and broke the AUTO-RUN `overview` query (a `UNION ALL` across every
  table) with a Catalog Error. The fix wave restores `schemas: pack.schemas()` on `finish`,
  threads it through `ParseWorkerClient`'s `StreamedParseResult`, and has `IngestSession.finalize`
  accept an optional `backfillSchemas` argument: any schema table that received no `appendBatch`
  call is created as an empty table at finalize, in both the memory and spill tiers, reusing the
  Task 6 empty-table `CREATE TABLE` path. The controller mirrors the same backfill into the
  `ready` state's `tables` list so the Explorer shows the zero-row table too.
- **Progress section corrected (see "Progress" above):** per-table live row counts were never
  actually shipped in the status bar (only the Explorer's post-`ready` summary shows per-table
  counts); the reported MB/s is a cumulative average over the whole open so far, not a rolling
  (windowed) rate; and the bytes-based percentage is pcap-only — MIDI's `progress.total` reports
  track counts by design, since a MIDI file has no meaningful byte-position notion for the UI.
