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
  currently being framed must be copied. Concretely: the `StreamAssembler` copies segment
  payloads on ingest (today they are views into the whole-file buffer). Provenance columns are
  absolute offsets, never views, and are unaffected.
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

**Hardening**, in order at init: disable external access; extension autoinstall/autoload/
community off; `SET allowed_directories = ['opfs://byteql-spill/']`;
`lock_configuration = true` last. **Day-one spike task** confirms on the pinned
`duckdb-wasm 1.33.1-dev57.0`: (a) `COPY ... TO` an `opfs://` path, (b) `allowed_directories`
honored with external access disabled, (c) `parquet_scan` over `opfs://` globs, (d) the
`collectFileStatistics` API for read accounting. Fallback ladder, in order:

1. Whitelist as specced (preferred).
2. `enable_external_access = true`, everything else still locked (browser sandbox + DuckDB's
   virtual FS remain the boundary).
3. Approach B (parquet-wasm writer in the parse worker) — only if OPFS *writing* through
   DuckDB is unsupported. The spike's finding and the chosen rung are recorded here.

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

Status bar shows stage, bytes-based percentage, rolling MB/s, and cumulative per-table row
counts from ack'd batches.

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
