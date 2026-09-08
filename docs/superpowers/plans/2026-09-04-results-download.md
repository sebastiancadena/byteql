# Results Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download the entire current result as CSV or Parquet, locally, without rerunning SQL.

**Architecture:** Finish the existing cursor into its bounded Arrow page store, then read pages
sequentially. CSV uses a worker with acknowledged chunks; Parquet uses the existing DuckDB
instance and OPFS shards, conditional on a real-browser compatibility gate. The controller
owns cancellation and result generation, while destination adapters own file commitment.

**Tech Stack:** TypeScript, Svelte 5, Apache Arrow 21 (DuckDB bridge: Arrow 17), the pinned
DuckDB-WASM 1.33.1-dev57.0, OPFS, Vitest, and Playwright. Reuse bundled dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-results-download-design.md` (approved).

## Global Constraints

- The exporter never reruns SQL.
- The first release downloads one CSV or one Parquet file.
- Export is entirely local.
- Parquet requires OPFS in this release.
- Without OPFS, support CSV through a byte-counted Blob fallback capped at 64 MiB of encoded output.
- Never label an incomplete file as a successful export.
- No deployment is part of this feature task.
- Keep all application assets available before readiness; test zero subsequent requests.
- Preserve page-store ownership, the 64 MiB cache, and the current grid window.
- No new runtime dependency or DuckDB version change is planned.
- Use generated export paths, exact SQL quoting, and per-export cleanup ownership.
- Use TDD for behavior changes. Keep the design and plan uncommitted until a commit is requested.

## Execution order and file responsibilities

Execute Task 1 before production implementation. A failed feasibility gate blocks Tasks 2–8;
record the observed failure and revise the writer design rather than weakening the contract.
Tasks 2–7 each have a focused test cycle. Task 8 validates their integration. Read the spec and
the root `AGENTS.md` before executing this plan. Do not touch the projection engine.

| Files | Responsibility |
| --- | --- |
| `packages/db/src/export-probe.ts` | Browser-only feasibility experiment and report |
| `packages/db/src/export-types.ts` | Parquet operation contract |
| `packages/db/src/export-files.ts` | Export-owned OPFS files and cleanup |
| `packages/db/src/export-parquet.ts` | Page import, shards, ordered final COPY |
| `packages/db/src/browser.ts`, `types.ts`, `index.ts` | Connection ownership and public integration |
| `apps/web/src/lib/export/options.ts` | Column selection, schema preflight, filename |
| `apps/web/src/lib/export/csv.ts` | Exact scalar formatting and bounded UTF-8 encoding |
| `apps/web/src/lib/export/csv-protocol.ts`, `csv-client.ts` | Worker transport and backpressure |
| `apps/web/src/workers/csv.worker.ts` | CSV encoding off the UI thread |
| `apps/web/src/lib/export/destination.ts` | Picker, OPFS and capped Blob sinks |
| `apps/web/src/lib/export/operation.ts` | Export state and injected test seams |
| `apps/web/src/lib/session/controller.ts`, `state.ts` | Generation ownership and cancellation |
| `apps/web/src/components/ResultsDownload.svelte` | Options, progress, errors, Save and Cancel |
| `apps/web/src/components/Workbench.svelte` | Place the new control beside result count |
| `apps/web/src/lib/e2e-harness.ts`, `docs/privacy.md` | Acceptance diagnostics and privacy contract |

Every new behavior module gets a colocated `.test.ts` unless its authoritative test is the
real browser gate. Do not move unrelated controller or database code just to reduce file size.

### Task 1: Prove the Parquet writer path in the hardened browser

**Files:** Create `packages/db/src/export-probe.ts`,
`apps/web/e2e/results-export-probe.spec.ts`; modify `packages/db/src/index.ts` and the existing
`apps/web/src/lib/e2e-harness.ts` only to expose the experiment in the instrumented build.
Record results in `docs/results-download-compatibility.md`.

**Interfaces:** Export the following from the probe and call it from the E2E harness.
It must own its test database and generated directories, never the user's current database.

```ts
export interface ExportProbeReport {
  variant: 'mvp' | 'eh';
  rows: number;
  inputIpcBytes: number;
  ordered: boolean;
  exactTypes: boolean;
  emptySchema: boolean;
  releasedFileReadable: boolean;
  cancellationPreservesResult: boolean;
  peakWasmBytes: number;
  peakJsBytes: number | null;
  peakTemporaryBytes: number;
  requestsAfterReady: string[];
}
export function probeResultsExport(
  variant: 'mvp' | 'eh', rows: number,
): Promise<ExportProbeReport>;
```

- [ ] Add a failing Playwright test for each WASM variant. Attach the report as JSON.
  The harness method `probeResultsExport` has the same arguments and return type above.

```ts
for (const variant of ['mvp', 'eh'] as const) {
  test(`Parquet export gate: ${variant}`, async ({ page }) => {
    await openMidiSample(page);
    const report = await page.evaluate(
      (v) => window.__BYTEQL_E2E__!.probeResultsExport(v, 1_000_000), variant,
    );
    expect(report).toMatchObject({
      rows: 1_000_000, ordered: true, exactTypes: true, emptySchema: true,
      releasedFileReadable: true, cancellationPreservesResult: true,
    });
    expect(report.inputIpcBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(report.requestsAfterReady).toEqual([]);
  });
}
```

- [ ] Run `pnpm --filter @byteql/web test:e2e -- results-export-probe.spec.ts` and confirm
  the missing probe is the failure. Follow `spill-probe.ts` for lifecycle, but use the real
  initialization order from `browser.ts`: local extension load, allowlist, external access
  off, extension loading off, configuration lock. Initialize experiment assets before its
  readiness marker; separately retain the production app's readiness network test.
- [ ] Build the experiment using Arrow IPC pages, a generated temporary table, and explicit
  shard paths. Use the existing Arrow 21/17 IPC bridge rather than passing incompatible Table
  objects between versions. Exercise these SQL operations with internally generated names:

```sql
COPY "__export_page" TO 'opfs://byteql-exports/<owned-id>/0.parquet'
  (FORMAT PARQUET, COMPRESSION SNAPPY);
COPY (
  SELECT * FROM parquet_scan([
    'opfs://byteql-exports/<owned-id>/0.parquet',
    'opfs://byteql-exports/<owned-id>/1.parquet'
  ])
) TO 'opfs://byteql-exports/<owned-id>/result.parquet'
  (FORMAT PARQUET, COMPRESSION SNAPPY);
```

  Substitute a generated UUID for `<owned-id>` and quote all paths with the existing SQL
  string quoting rule. Register each OPFS filename before COPY; release each owned DuckDB
  file handle before browser `getFile()`. Never call `dropFiles()` on the app's database.

- [ ] Generate shuffled sequence keys and 128-byte payloads, so the million-row result
  exceeds the cache. Compare every output row to the captured Arrow sequence, including
  non-key values. Include distinct null/empty/binary values, uint64 max, signed int64 min,
  decimals, and sub-millisecond timestamps in a separate fixture. Test empty schema output
  by importing a zero-row Arrow table. Compare types with a Parquet reader, not stringified
  grid values. Store all diagnostics in the report, including readback mismatches.
- [ ] Measure 250,000, 1,000,000, and 2,000,000 rows after warmup, using the same width.
  Sample worker WASM allocation and available JS heap instrumentation separately; record
  unavailable measurements explicitly. Count actual intermediate file sizes. Distinguish
  allocator high-water marks from live buffers. Confirm encoding does not retain all pages
  or grow proportionally with output bytes. Test cancelling COPY and then reading the
  completed result, plus an out-of-allowlist operation that must fail.
- [ ] Rerun the probe. Write commands, versions, sequence/type evidence, resource figures,
  and pass/fail conclusions to the compatibility report. Do not treat an unavailable heap
  measurement as proof of a memory bound. Resolve an unsupported variant before promising
  Parquet there. A failed gate triggers a writer-design revision before Task 2.

### Task 2: Define options and exact CSV encoding

**Files:** Create `apps/web/src/lib/export/options.ts`, `options.test.ts`, `csv.ts`,
`csv.test.ts`.

**Interfaces:** `options.ts` exports `ExportFormat = 'csv' | 'parquet'`,
`ExportOptions = { format: ExportFormat; includeProvenance: boolean }`,
`selectExportColumns(schema: Schema, options: ExportOptions): number[]`, and
`exportFilename(names: readonly string[], format: ExportFormat): string`.
`csv.ts` exports the generator below. Column indices always refer to the original schema.

```ts
export function* csvChunks(
  table: Table, columns: readonly number[], includeHeader: boolean,
): Generator<Uint8Array>;
```

- [ ] Add failing tests using real Arrow tables. This fixture verifies quoting and the
  empty/null distinction without relying on the encoder's parser:

```ts
it('preserves quoted text, null, and empty strings', () => {
  const table = tableFromArrays({ text: ['a,"b"\n', '', null] });
  const text = Array.from(csvChunks(table, [0], true))
    .map((chunk) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(chunk)).join('');
  expect(text).toBe('\uFEFF"text"\r\n"a,""b""\n"\r\n""\r\n\r\n');
});
```

- [ ] Run `pnpm --filter @byteql/web exec vitest run src/lib/export/csv.test.ts
  src/lib/export/options.test.ts` and confirm the unimplemented module is the failure.
- [ ] Implement preflight before acquiring files: at least one selected column, supported
  scalar type, and unique Parquet names under DuckDB's identifier comparison rules. CSV
  retains duplicate names. The current grid hides names starting with `_`, not only `_src_`:
  match that predicate as the spec requires, and explain that the option includes hidden
  columns. Test a user alias `_custom` explicitly. An unchecked option must never delete a
  non-hidden selected column or inject provenance into aggregates.
- [ ] Implement filename sanitization by taking the final path component, removing its last
  extension, replacing control and path-invalid characters, and appending `-results` plus
  the format suffix. Multiple/empty names use `byteql-results`. Limit the generated stem to
  120 Unicode code points; preserve the extension.
- [ ] Implement scalar formatting by Arrow type, not generic row JSON. For timestamps,
  times, dates, and decimals read underlying typed data with the correct chunk offset and
  null bitmap. Avoid Arrow accessors that downcast temporal precision. Decode signed
  decimal limbs using BigInt and apply scale exactly. Use BigInt division with floor
  correction for negative timestamps. Use explicit ISO date/time formatting for the source
  unit; append `Z` only for timezone-aware timestamps normalized to UTC.
- [ ] Add exact expectations for uint64 max, int64 min, scaled negative decimals, timestamps
  before the epoch, microseconds/nanoseconds, dictionary scalars, sliced vectors with nulls,
  binary `0x00ff`, NaN/infinities, quoted headers, emoji across chunk boundaries, and a text
  cell larger than 1 MiB. Reject unsupported nested/interval types with their column name.
  Formula-like strings stay verbatim. Header-only empty results contain the selected schema.
- [ ] Bound emitted UTF-8 chunks to 64 KiB. Carry Unicode boundaries across chunks and avoid
  building a whole escaped row for huge text/binary cells. Emit BOM and header exactly once.
  Rerun both unit files; all encoded chunks must satisfy the byte bound.

### Task 3: Add acknowledged CSV worker transport

**Files:** Create `apps/web/src/lib/export/csv-protocol.ts`, `csv-client.ts`,
`csv-client.test.ts`, `apps/web/src/workers/csv.worker.ts`; integrate initialization and
disposal through `SessionController` in Task 6.

**Interfaces:** A worker client serializes one page at a time and awaits every output write.

```ts
export interface CsvClientPort {
  initialize(): Promise<void>;
  encode(ipc: Uint8Array, columns: readonly number[], header: boolean,
    write: (chunk: Uint8Array) => Promise<void>, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}
export type CsvRequest =
  | { type: 'encode'; id: number; ipc: ArrayBuffer; columns: number[]; header: boolean }
  | { type: 'ack'; id: number; sequence: number }
  | { type: 'cancel'; id: number };
export type CsvResponse =
  | { type: 'ready' }
  | { type: 'chunk'; id: number; sequence: number; bytes: ArrayBuffer }
  | { type: 'done'; id: number }
  | { type: 'error'; id: number; message: string };
```

- [ ] Add a fake worker-port test that emits one chunk into an unresolved destination
  promise. Assert no acknowledgment is sent until the promise settles, stale operation IDs
  are ignored, and abort rejects the pending call and releases listeners.
- [ ] Run `pnpm --filter @byteql/web exec vitest run src/lib/export/csv-client.test.ts`.
- [ ] Implement a `ready` handshake. Transfer a newly serialized IPC buffer from each page,
  never a buffer retained by `QueryPageStore`. In the worker, decode once, iterate
  `csvChunks`, post a chunk, and wait for its exact acknowledgment before advancing:

```ts
for (const chunk of csvChunks(table, columns, header)) {
  signal.throwIfAborted();
  postChunk(id, sequence, chunk);
  await waitForAck(id, sequence, signal);
  sequence += 1;
}
```

  Define `postChunk` and `waitForAck` as private worker helpers using the protocol above.
  Cancellation must interrupt acknowledgment waits and yield between bounded chunks.
  Unexpected worker failure rejects the current operation; mark CSV unavailable instead of
  loading a new worker after readiness. Startup retry may recreate it before readiness.

- [ ] Rerun tests for cancellation, sink rejection, worker errors, duplicate acknowledgments,
  wrong IDs, header once across pages, and preservation of the original page's buffers.

### Task 4: Implement export-owned files and destination adapters

**Files:** Create `packages/db/src/export-files.ts`, `export-files.test.ts`,
`apps/web/src/lib/export/destination.ts`, `destination.test.ts`.

**Interfaces:** The destination adapter is independent of query fetching and format encoding.

```ts
export interface ExportDestination {
  write(bytes: Uint8Array): Promise<void>;
  commit(): Promise<'saved' | 'ready-to-save'>;
  save(): void;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
export function prepareDestination(
  filename: string, format: ExportFormat,
): Promise<ExportDestination>;
```

`save()` is a no-op for already saved direct files; for fallback it starts the prepared
download from a fresh user gesture. `export-files.ts` exports
`createExportFiles(): Promise<ExportFiles>` where `ExportFiles` has
`path(name: string): string`, `file(name: string): Promise<File>`, and
`dispose(): Promise<void>`. Accept only internally generated basenames, not paths.

- [ ] Add a failing sink test with a writable that rejects its second write; require abort,
  no close, and idempotent disposal. Add an exact 64 MiB limit test and an over-limit test
  using repeated bounded chunks instead of allocating a single oversized fixture.
- [ ] Run focused DB and web destination tests with Vitest.
- [ ] Implement picker acquisition immediately when `prepareDestination` is called. If the
  picker exists and the user dismisses it, return an AbortError; do not fall back to another
  download. Choose OPFS only when the picker is absent, and the capped CSV Blob only when
  OPFS is unavailable. Reject Parquet without OPFS even if a picker exists.
- [ ] Implement sink state transitions that prevent write/commit after abort, close only on
  commit, and dispose by awaiting pending writes before removing owned artifacts:

```ts
type SinkState = 'open' | 'committing' | 'committed' | 'aborted' | 'disposed';
```

  Blob fallback tracks encoded bytes before retaining each chunk. OPFS fallback returns
  `ready-to-save` after producing a File; the UI displays Save file. Keep the object URL and
  file until dismissal, replacement, or app disposal rather than deleting immediately
  after clicking the link. Exercise actual browser delivery in Task 8.

- [ ] Use a per-tab UUID plus per-export UUID below `byteql-exports`. Remove only owned
  directories after DuckDB handles close. For orphan cleanup use an exclusive Web Lock per
  owner and probe it non-blockingly; never sweep an active owner. If locks are unavailable,
  limit cleanup to the current owner and document potential crash leftovers.
- [ ] Rerun tests covering two owners, quota errors, permission errors, abort during commit,
  repeated disposal, fallback retention, and file-picker rejection.

### Task 5: Implement the proven Parquet path

**Files:** Create `packages/db/src/export-types.ts`, `export-parquet.ts`,
`export-parquet.test.ts`; modify `browser.ts`, `types.ts`, `index.ts`, and `browser.test.ts`.

**Interfaces:** Add `exportParquet` to `ByteqlDatabase`; keep selection indices positional.

```ts
export interface ParquetExportOptions {
  columns: readonly number[];
  signal: AbortSignal;
  onProgress(rows: number): void;
}
export interface ParquetArtifact {
  file: File;
  dispose(): Promise<void>;
}
// ByteqlDatabase method:
exportParquet(result: QuerySession, options: ParquetExportOptions): Promise<ParquetArtifact>;
```

- [ ] Add failing database tests that reject an incomplete or superseded session, avoid
  calling `startQuery`, and close only export-owned handles after a COPY failure. Update
  interface mocks explicitly. Run `pnpm --filter @byteql/db exec vitest run
  src/export-parquet.test.ts src/browser.test.ts`.
- [ ] Add the export root to the initialization allowlist before locking. Add a regression
  proving external access and extension autoload stay disabled. Route exports through the
  existing operation queue, with an export connection owning encoder statements so its
  cancellation cannot invalidate the exhausted result session.
- [ ] Implement the Task 1 validated sequence. Name intermediate columns `c0`, `c1`, and so
  on; use the original schema field at each selected index for the final quoted alias.
  Read one page, import it, COPY its shard, drop its table, then advance. For zero pages
  import the empty schema and create a valid zero-row final file.

```ts
for (const page of result.pages()) {
  options.signal.throwIfAborted();
  const stored = await result.readPage(page.index);
  await writeShard(stored.table, options.columns, page.index);
  options.onProgress(page.startRow + page.rowCount);
}
```

  Define private `writeShard(table: Table, columns: readonly number[], index: number)` in
  the writer using the proven IPC import and COPY sequence. Build an explicit path array
  in page order for final COPY. Do not introduce an unmeasured sort to repair ordering;
  ordering must already have passed the feasibility gate.

- [ ] Connect the AbortSignal to the export connection's pending-query cancellation API
  verified in the installed package. Await statement settlement before dropping tables,
  releasing handles, and cleaning up files. Preserve primary errors if cleanup also fails,
  while reporting cleanup failure rather than claiming complete removal.
- [ ] Rerun unit tests and the actual browser probe using the production writer. Read back
  all supported scalar types, empty output, and million-row sequence. Reject unsupported
  Parquet Arrow types during preflight with an explicit column error rather than coercing.

### Task 6: Coordinate export with the current result lifecycle

**Files:** Create `apps/web/src/lib/export/operation.ts`; modify
`apps/web/src/lib/session/controller.ts`, `controller.test.ts`, `state.ts`, and `state.test.ts`.

**Interfaces:** Inject `CsvClientPort` and destination factory through controller options.
Add `downloadResults(options: ExportOptions): Promise<void>`,
`cancelResultsDownload(): Promise<void>`, `saveResultsDownload(): void`, and
`dismissResultsDownload(): Promise<void>` to `SessionController`.

```ts
export interface ExportState {
  generation: number;
  phase: 'picking' | 'loading' | 'encoding' | 'saving' | 'cancelling'
    | 'ready-to-save' | 'saved' | 'cancelled' | 'failed';
  rows: number;
  totalRows: number | null;
  bytes: number;
  message: string | null;
}
```

`SessionState` gets `download: ExportState | null`; use a generation-checked reducer event
`downloadUpdated` carrying `ExportState | null`. Keep promises, sinks, and abort controllers
in the controller, never in serializable state.

- [ ] Extend the existing deferred fake query tests: begin export while `fetchNext` is
  unresolved, cancel, resolve the fetch, and assert the query remains readable and the sink
  never commits. Add a replacement test requiring sink abort to settle before query dispose.
- [ ] Run `pnpm --filter @byteql/web exec vitest run src/lib/session/controller.test.ts
  src/lib/session/state.test.ts` to observe the missing export behavior.
- [ ] Initialize the CSV client inside `initializeOnce` and await its ready handshake before
  returning. Ensure failed initialization and controller disposal release it. Pass the fake
  client explicitly in unit tests; do not create real workers in Node tests.
- [ ] In `downloadResults`, validate synchronously and capture result identity. Call the
  destination factory before any await, then fence its return against result replacement.
  Wait for current result demand, suspend new fetch demand, and finish the cursor with
  cancellation checks. Refresh counts without advancing `windowStart` or selection.
- [ ] Encode complete result pages using the CSV client, or invoke `database.exportParquet`
  and stream its File into the destination. For zero-row CSV send an empty table with the
  original schema and `header: true`. Do not use `completeTable` or change page pinning to
  retain the whole result. Honor backpressure in the artifact copy as well.
- [ ] Fence the final commit against the result generation. On query/input replacement,
  increment the export cancellation token synchronously and await cleanup before closing
  the old query. Handle picker promises that return after replacement by aborting their
  newly acquired destination. Keep successful fallback artifacts until explicit dismissal
  or replacement, so the Save button can retain a user gesture.
- [ ] Route page-store failures through existing retryable result errors and export failure
  state; a cancelled export is not a query cancellation. Resume grid demand in `finally`.
  Rerun tests for concurrent scrolling, export twice, SQL edited without execution, picker
  dismissal, cancellation in each phase, quota retry, and disposal during startup.

### Task 7: Add the accessible results download control

**Files:** Create `apps/web/src/components/ResultsDownload.svelte` and
`ResultsDownload.test.ts`; modify `Workbench.svelte` and narrowly scoped styles as needed.

**Interfaces:** Props are `controller: SessionController` and `session: SessionState`.
The component owns only popover state and `ExportOptions`, defaulting to CSV and provenance on.

- [ ] Write a Svelte component test: open Download results, verify CSV and inclusion defaults,
  choose Parquet, and assert the controller receives exactly the selected options. Verify
  Escape closes the popover and restores focus. Start with the failing component test.
- [ ] Implement a labelled popover with a native format select, inclusion checkbox, concise
  format help, and a Download button. Treat schema/OPFS errors as disabled choices with
  accessible explanations. Clarify that inclusion covers hidden columns, including `_`
  aliases. Use an inline `role="status"` for progress and `role="alert"` for errors.

```svelte
<button type="button" onclick={() => controller.downloadResults(options)}>
  Download
</button>
```

  Catch rejections at the controller boundary so event handlers do not emit unhandled
  promises. The synchronous portion of that method must invoke the picker factory.

- [ ] Place the control in `.results-heading-meta` without adding overflow to `.result-grid`.
  Show Cancel for active work, Cancelling while settling, Save file for `ready-to-save`,
  and success wording consistent with direct saving versus browser handoff. Keep zero-row
  results exportable and error rows actionable. Avoid percentage progress during COPY if
  the underlying engine cannot measure it.
- [ ] Run component tests for keyboard controls, no-result state, zero rows, provenance-only
  exclusion, duplicate Parquet names, missing OPFS, cancellation, errors, and fallback Save.

### Task 8: Verify actual downloaded files, privacy, and resource limits

**Files:** Create `apps/web/e2e/results-download.spec.ts`; extend `privacy.spec.ts` and
`e2e-harness.ts` with instrumented-build-only artifact readback. Update `docs/privacy.md`
and the compatibility report with actual measurements and limitations.

**Interfaces:** Reuse `openMidiSample`, the labelled SQL editor, and existing
`queryResultMetrics()` diagnostics. Add only test-build methods needed for failure
injection and independent DuckDB CSV/Parquet readback of downloaded files.

- [ ] Write a failing browser test that downloads immediately after the initial 1,024 rows
  of a 20,000-row result appear. Capture the browser download and verify complete contents:

```ts
await page.getByRole('textbox', { name: 'SQL query' }).fill(
  'select i, random() as sample from range(20000) t(i)',
);
await page.getByRole('button', { name: 'Run query' }).click();
await expect(page.locator('.results-heading-meta')).toContainText('1,024 loaded');
await page.getByRole('button', { name: 'Download results', exact: true }).click();
await page.getByRole('button', { name: 'Download', exact: true }).click();
await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();
const pending = page.waitForEvent('download');
await page.getByRole('button', { name: 'Save file', exact: true }).click();
const download = await pending;
expect(await download.failure()).toBeNull();
expect((await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics())).sendCount).toBe(1);
```

  Force the no-picker path before startup for this case. Save the artifact to Playwright's
  test output and read it independently. Compare all 20,000 random values to the stored
  result pages, not a second evaluation of the SQL. Cover the direct writable route through
  a real OPFS-backed injected picker and separately document native-picker manual validation.

- [ ] Exercise CSV special values through DuckDB's CSV reader with explicit types and
  null/quoted-empty rules. Exercise Parquet using DuckDB readback of the downloaded file,
  checking schema and sequence. Register test inputs inside the allowed export root;
  do not relax production hardening for readback.
- [ ] Test both formats after SQL edits, after scrolling, with empty and provenance-only
  results, while replacement races a delayed writer, and when destination quota fails.
  Confirm no downloadable successful artifact after abort and that results remain usable.
- [ ] Run the large-result probe at the three sizes in Task 1 using the final implementation.
  Verify the one-million-row tail and captured order, bounded queues/cache, cancellation
  responsiveness, temporary file cleanup, and cross-tab ownership. Report measured WASM
  and JS limits honestly; any material failing gate returns to the writer task.
- [ ] Install request listeners after `[data-app-ready="true"]`, then exercise both formats,
  fallback saving, errors, and repeated exports. Require an empty request list. Ensure the
  probe/report APIs and test sentinels are absent from the production bundle.
- [ ] Run final checks once, broadening only for new failures or edits:

```bash
pnpm check
pnpm lint
pnpm --filter @byteql/db exec vitest run
pnpm --filter @byteql/web test -- --run
pnpm --filter @byteql/web test:e2e -- results-export-probe.spec.ts results-download.spec.ts privacy.spec.ts query-result-scrolling.spec.ts
pnpm --filter @byteql/web check:bundle
git diff --check
```

- [ ] Record actual results in `docs/results-download-compatibility.md`; update privacy docs
  to cover export assets, local temporary files, and no post-readiness network. Hand off the
  implementation with changed files, tested browser routes, and material limitations. Leave
  commit and deployment actions outside this execution unless subsequently requested.

## Plan self-review

- Spec coverage: Task 1 covers the compatibility gate; Tasks 2–3 cover exact CSV and worker
  backpressure; Tasks 4–5 cover local destinations, Parquet, ownership, and resource bounds;
  Task 6 covers snapshot identity and cancellation; Task 7 covers the interaction; Task 8
  covers independent readback, large results, privacy, and final verification.
- The Parquet implementation is conditional on measured results; it is not marked proven.
- The option uses the grid's actual `_` predicate and explains its effect on custom aliases.
- There is no whole-result materialization, SQL rerun, unsafe extension loading, or deployment.
- Each cross-task interface is defined above; preserve these signatures while executing.
