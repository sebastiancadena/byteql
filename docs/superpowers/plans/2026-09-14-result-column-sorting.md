# Result Column Sorting Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task.
> Steps use checkbox syntax for tracking. Read the complete spec before Task 1.

**Goal:** Sort every row of the current result by one column, preserving original query values,
source provenance, query-order restoration, and matching downloads.

**Architecture:** Keep the original cursor-backed QuerySession. Build complete, privately stored
ordered views from its retained pages using a separate DuckDB connection. Commit a view only
after EOF, validation and first-window preparation; fence all reads by query and order identity.

**Tech stack:** Existing Svelte 5, TypeScript, Apache Arrow 21 plus DuckDB's Arrow 17 bridge,
DuckDB-WASM `1.33.1-dev57.0`, OPFS, Vitest, Playwright. No dependency additions or upgrades.

**Spec:** [Result column sorting design](../specs/2026-09-14-result-column-sorting-design.md).

**Status:** Planning only. The user confirmed current-result semantics; implementation and
the proposed v1 support restrictions still need review. No task below has been executed.

## Global constraints

- V1 uses OPFS for temporary snapshot shards and sorted pages.
- Ship one-column sorting.
- Query generation is unchanged by sorting.
- Repeated sorts always derive from the original result, never a previously sorted view.
- The internal ordinal never appears in the public schema, grid, inspector, or downloads.
- No dependency additions/upgrades, remote assets, external requests after readiness, or
  configuration/hardening changes. Do not publish `dist-e2e`.
- Keep `.grid-scroll` as the sole grid scroll owner, `RESULT_WINDOW_ROWS = 16_384` and
  `RESULT_ROW_HEIGHT = 36`. Keep Workbench's ResultGrid key on query generation only.
- Preserve editor text, draft/undo/selection, current panel positions and mounted components.
- No whole-result JavaScript arrays, SQL rewriting, original SQL resends, or silent type casts.
- Preserve the original complete query table for trusted viewers; display-window order is separate.
- A task passes only with observed checks. Code examples here are implementation kernels;
  integrate them with the existing error/lifecycle plumbing and the explicitly listed cases.
- Execute sequentially. Do not introduce parallel execution of dependent lifecycle tasks.

## Before starting

- [ ] Obtain authorization to implement this spec; do not infer it from the request to brainstorm.
- [ ] Inspect `git status --short`, `git rev-parse HEAD`, applicable AGENTS.md files and skill
  instructions. Baseline inspected for this plan: `8f192c4`. Re-read affected functions if HEAD
  changed. Preserve unrelated changes. Use the worktree skill if isolation is needed.
- [ ] Read PRD §9 and Appendix A, the spec, and the existing paged-query/results-download designs.
- [ ] Run `pnpm --filter @byteql/db build` before interpreting missing package exports.
- [ ] Confirm the intended support tradeoff: OPFS required; unsupported fields anywhere in the
  result disable v1 sorting. Do not quietly implement a partial-results fallback.

## File map

| File | Responsibility |
| --- | --- |
| `packages/db/src/types.ts` | Separate the view-reader contract from cursor demand; add database sort API |
| `packages/db/src/result-sort.ts` (new) | Sort descriptor, capability policy, SQL generation and typed errors |
| `packages/db/src/result-snapshot.ts` (new) | Positional aliases, exact Uint64 ordinals, schema restoration |
| `packages/db/src/arrow-bridge.ts` (new) | Move existing Arrow 17 -> 21 conversion without changing semantics |
| `packages/db/src/stored-result-view.ts` (new) | Complete, immutable QueryPageStore-backed reader |
| `packages/db/src/sort-result.ts` (new) | Page staging, DuckDB ordering, bounded output storage and cleanup |
| `packages/db/src/browser.ts` | Register views to the current base, sort cancellation, family disposal |
| `packages/db/src/index.ts` | Public exports for the new contracts and pure capability helper |
| `packages/db/src/export-parquet.ts` | Accept view reader; guarantee display order with export ordinal |
| `packages/db/src/sort-probe.ts` (new) | Instrumented-build pinned-runtime proof, following export-probe |
| `apps/web/src/lib/session/result-sort.ts` (new) | Pure header-cycle/label/availability helpers |
| `apps/web/src/lib/session/result-view.ts` (new) | Bounded window assembly decoupled from activeQuery identity |
| `apps/web/src/lib/session/result-scroll.ts` | Forward demand for stored windows as well as unfinished cursors |
| `apps/web/src/lib/session/state.ts` | Sort-operation state, orderRevision and fenced reducer events |
| `apps/web/src/lib/session/controller.ts` | Own sort operation; original/display separation; lifecycle guards |
| `apps/web/src/lib/export/operation.ts` | Export captures base, display view and orderRevision |
| `apps/web/src/components/ResultGrid.svelte` | Header controls and in-place order-change reset |
| `apps/web/src/components/Workbench.svelte` | Wire controls/status and committed order to grid |
| `apps/web/src/components/ResultsDownload.svelte` | Disable new downloads during sorting |
| `apps/web/src/styles/workbench.css` | Header-button and sort-status styling using existing tokens |
| `apps/web/src/lib/e2e-harness.ts` | Sort proof hook and bounded diagnostics; instrumented build only |
| `apps/web/e2e/result-column-sorting.spec.ts` (new) | Real browser user-flow acceptance |
| `apps/web/e2e/result-sort-probe.spec.ts` (new) | Real pinned-runtime/type/privacy proof |
| `docs/result-column-sorting-compatibility.md` (new during execution) | Observed support, performance and manual gates |

Tests are co-located beside every new nontrivial module. Extend `browser.test.ts`,
`export-parquet.test.ts`, `controller.test.ts`, `state.test.ts`, `Workbench.test.ts`,
`ResultsDownload.test.ts`, and `ResultGrid.demand.test.ts`; add `ResultGrid.sort.test.ts`.
Do not move the whole QuerySession implementation or refactor parsing/ingest.

## Contract ledger: use these names consistently

Task 1 introduces the pure sort contracts; Task 2 introduces view interfaces; Task 3 produces
the writer; Task 4 exposes it through the database; Tasks 5–7 integrate app and exports.

```ts
// packages/db/src/result-sort.ts
import type { Schema } from 'apache-arrow';

export interface ResultSort {
  readonly columnIndex: number;
  readonly direction: 'asc' | 'desc';
}
export interface ResultSortProgress {
  readonly phase: 'staging' | 'sorting' | 'storing';
  readonly rows: number;
  readonly totalRows: number;
}
export interface ResultSortOptions {
  readonly sort: ResultSort;
  readonly signal: AbortSignal;
  onProgress(progress: ResultSortProgress): void;
}
export type ResultSortEligibility =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };
export function resultSortEligibility(schema: Schema): ResultSortEligibility;
export function buildResultSortSql(paths: readonly string[], schema: Schema, sort: ResultSort): string;
export type ResultSortErrorCode =
  | 'SORT_UNAVAILABLE' | 'SORT_UNSUPPORTED_TYPE' | 'SORT_STORAGE_FULL'
  | 'SORT_FAILED' | 'SORT_CLEANUP_FAILED';
export class ResultSortError extends Error {
  readonly code: ResultSortErrorCode;
  constructor(code: ResultSortErrorCode, message: string, options?: ErrorOptions);
}

// packages/db/src/types.ts: move these read members out of QuerySession.
export interface QueryResultView {
  readonly schema: Schema;
  status(): QueryStatus;
  pages(): readonly QueryPageSummary[];
  readPage(index: number): Promise<QueryPage>;
  pinPages(indexes: readonly number[]): void;
  materialize(maxBytes?: number): Promise<Table | null>;
  dispose(): Promise<void>;
}
export interface QuerySession extends QueryResultView {
  fetchNext(targetRows?: number): Promise<QueryPage | null>;
  retryPending(): Promise<QueryPage>;
  cancel(): Promise<boolean>;
}
// Add to ByteqlDatabase; change exportParquet's first parameter to QueryResultView.
createSortedView(base: QuerySession, options: ResultSortOptions): Promise<QueryResultView>;
```

`QueryStatus.sendCount` on a derived view still reports the original execution's send count.
Add separate diagnostics for sort activity; do not count internal COPY/ORDER BY sends as
original SQL executions. `elapsedMs` remains original query time; show sorting progress/time
separately. The database registry validates object identity, not user-supplied generation IDs.

## Task 1: Validate the storage/ordering approach in the pinned browser runtime

**Files:** Create `result-sort.ts`, `result-snapshot.ts`, their `.test.ts` files,
`sort-probe.ts`, `result-sort-probe.spec.ts`; modify `index.ts`, `e2e-harness.ts`.
Create `docs/result-column-sorting-compatibility.md` with actual evidence after the probe.

**Consumes:** Existing `isSupportedParquetType`, `createExportFiles`, local DuckDB bundles,
Arrow IPC conversion patterns in `export-probe.ts` and `export-parquet.ts`.

**Produces:** Contract-ledger sort types/helpers plus:

```ts
// result-snapshot.ts
export function snapshotPage(table: Table, startRow: number, ordinalName: string): Table;
export function restoreResultSchema(table: Table, schema: Schema): Table;
// sort-probe.ts, exported solely so the instrumented harness can import it.
export interface ResultSortProbeReport {
  variant: 'mvp' | 'eh';
  originalSendCount: number;
  rowCount: number;
  valuesPreserved: boolean;
  schemaPreserved: boolean;
  tiesStable: boolean;
  cancellationSettled: boolean;
  resourcesReleased: boolean;
  externalAccessDenied: boolean;
}
export function probeResultSort(variant: 'mvp' | 'eh'): Promise<ResultSortProbeReport>;
```

- [ ] Write a SQL-generation test first. It must reject negative/out-of-bounds/fractional
  column indexes and invalid runtime directions, and never interpolate user column names.

```ts
it('orders by a positional alias and original ordinal', () => {
  const schema = new Schema([new Field('x"; DROP TABLE events; --', new Int64(), true)]);
  expect(buildResultSortSql(['opfs://byteql-exports/a/b/shard-0.parquet'], schema,
    { columnIndex: 0, direction: 'desc' })).toBe(
    'SELECT "c0" FROM parquet_scan([\'opfs://byteql-exports/a/b/shard-0.parquet\']) ' +
    'ORDER BY "c0" DESC NULLS LAST, "__byteql_sort_ordinal" ASC',
  );
});
```

- [ ] Run `pnpm --filter @byteql/db exec vitest run src/result-sort.test.ts` and observe the
  missing-export/assertion failure. Then implement the helper using generated aliases:

```ts
const quoteString = (s: string) => `'${s.replaceAll("'", "''")}'`;
// After checking nonempty paths, eligibility, safe index bounds and direction membership:
const projection = schema.fields.map((_, i) => `"c${i}"`).join(', ');
const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
return `SELECT ${projection} FROM parquet_scan([${paths.map(quoteString).join(', ')}]) ` +
  `ORDER BY "c${sort.columnIndex}" ${direction} NULLS LAST, "__byteql_sort_ordinal" ASC`;
```

- [ ] Implement `snapshotPage`: validate startRow and end are safe nonnegative integers;
  build a Table of `cN` vectors obtained with getChildAt, plus an explicit Uint64 vector.
  Inputs to ordinalName are internal constants only; reject collision with `cN`.

```ts
const columns: Record<string, Vector> = {};
table.schema.fields.forEach((_, i) => { columns[`c${i}`] = table.getChildAt(i)!; });
const ordinals = new BigUint64Array(table.numRows);
for (let i = 0; i < ordinals.length; i++) ordinals[i] = BigInt(startRow) + BigInt(i);
columns[ordinalName] = vectorFromArray(ordinals, new Uint64());
return new Table(columns);
```

  Import `Table`, `Vector` (type), `Uint64`, `vectorFromArray` from Arrow 21. This aliases
  existing vectors; do not reconstruct user values from `.get()` into JS arrays.

- [ ] Implement schema restoration with field count and recursive/logical Arrow type checks
  (for this scalar set: typeId, signedness/width, precision/scale, time unit/timezone as
  applicable). Check vectors first, then clone RecordBatch schemas using the original
  Schema, as `renameSelectedColumns` does in export-parquet. Do not compare only names.
- [ ] Add unit tests for duplicate names, ordinal values across page boundaries, metadata,
  rejected non-key List, timezone timestamp, and mismatched physical type. Run both new suites.
- [ ] Build the probe by following `export-probe.ts` initialization/teardown. Use the same
  pre-load and hardening sequence as production, separate sorting connection, explicit
  generated Parquet paths, and bounded Arrow pages. It must execute the original SQL once,
  record its values before sort, stage with an ordinal, sort descending, and compare output
  by original ordinal in a **small fixture only**. Do not use mocked DuckDB for this gate.
- [ ] Include 20,000 rows with ties/nulls across page boundaries, plus small typed fixtures:
  integer widths/signs, >2^53 UInt64 and Int64, Decimal128, floating special values including
  negative zero, Unicode/BOM strings, blobs, date, time, micro/nanosecond timestamps. Include
  duplicate and SQL-looking aliases. Confirm user schema metadata and all values survive.
  Exclude timezone-bearing timestamps before staging. Treat a failed allowed type as a
  blocked support gate; document it and revise eligibility/spec explicitly before continuing.
- [ ] Prove cancellation of a sort statement and cleanup under current hardening, including
  a denied external URL and a denied OPFS path outside permitted roots. Reuse the existing
  privacy test's request recorder; no network after readiness is allowed.
- [ ] Add harness method `probeResultSort(variant)` and browser assertions:

```ts
for (const variant of ['mvp', 'eh'] as const) {
  test(`snapshot sorting works in ${variant}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await page.locator('[data-app-ready="true"]').waitFor();
    const report = await page.evaluate(v => window.__BYTEQL_E2E__!.probeResultSort(v), variant);
    expect(report).toMatchObject({
      variant, originalSendCount: 1, rowCount: 20_000,
      valuesPreserved: true, schemaPreserved: true, tiesStable: true,
      cancellationSettled: true, resourcesReleased: true, externalAccessDenied: true,
    });
  });
}
```

- [ ] Run `pnpm --filter @byteql/db build`, then
  `pnpm --filter @byteql/web test:e2e result-sort-probe.spec.ts`.
- [ ] Record runtime/bundle variants, fixture results, cancellation and cleanup observations.
  **Checkpoint:** do not start UI work unless both bundle proofs pass. A browser unavailable
  locally means this execution gate is unverified; do not replace it with a unit-test claim.
- [ ] Commit only this task's files with `test(db): verify stored-result sorting in wasm`.

## Task 2: Add a complete immutable result-view reader

**Files:** Modify `types.ts`, `index.ts`, `browser.ts`; create `stored-result-view.ts`,
`stored-result-view.test.ts`, `arrow-bridge.ts`. Keep existing query tests intact.

**Consumes:** QueryPageStore, QueryStatus, QueryPage; Task 1's ResultSortOptions.
**Produces:** QueryResultView/QuerySession split from ledger, plus:

```ts
export class StoredResultView implements QueryResultView {
  constructor(schema: Schema, store: QueryPageStore,
    pages: readonly QueryPageSummary[], queryStatus: Pick<QueryStatus, 'elapsedMs' | 'sendCount'>,
    onDisposed: () => void);
  // QueryResultView methods; constructor accepts only an already-complete store.
}
// arrow-bridge.ts: move the existing function body from browser.ts unchanged.
export function convertDuckdbTable(
  schema: DuckdbSchema, batches: readonly DuckdbRecordBatch[],
): Promise<Table>;
```

- [ ] Add a real-store test; use the following factory for small page fixtures:

```ts
async function completeView(values: number[]): Promise<QueryResultView> {
  const table = tableFromArrays({ value: Int32Array.from(values) });
  const store = new QueryPageStore({ persistence: null });
  await store.put(0, 0, table);
  store.markComplete();
  return new StoredResultView(table.schema, store,
    [{ index: 0, startRow: 0, rowCount: values.length }],
    { elapsedMs: 7, sendCount: 1 }, () => {});
}
it('reads committed order without any cursor method', async () => {
  const view = await completeView([3, 1, 2]);
  expect(Array.from((await view.readPage(0)).table.getChildAt(0)!)).toEqual([3, 1, 2]);
  expect(view.status()).toMatchObject({ complete: true, loadedRows: 3, sendCount: 1 });
  await view.dispose();
  await expect(view.readPage(0)).rejects.toThrow(/closed|disposed/i);
});
```

- [ ] Run `pnpm --filter @byteql/db exec vitest run src/stored-result-view.test.ts`; observe red.
- [ ] Implement immutable summaries, cloned `pages()` output, readable-state guards, store
  delegation, complete status, and idempotent disposal. Derive stored/decoded byte counts
  from the store; preserve base query elapsedMs/sendCount. Validate contiguous summaries
  beginning at zero. Empty results have a schema and no pages.
- [ ] Test empty schemaful result, materialize budget, out-of-range page access, independent
  disposal, duplicate disposal, and disposal waiting for pending persistence reads.
- [ ] Extract only `convertDuckdbTable` to arrow-bridge.ts and import it in browser.ts.
  Preserve Arrow 17 writer -> IPC -> Arrow 21 conversion. Never cast one package's Table
  to the other package's type.
- [ ] Add `createSortedView` to ByteqlDatabase with a temporary explicit rejection in
  BrowserDatabase until Task 4, and change exportParquet/read-only writer types. Update typed
  test doubles found with `rg -n 'implements ByteqlDatabase|: ByteqlDatabase|implements QuerySession'`.
  Do not add successful stub sorting or ship this intermediate commit by itself.
- [ ] Run `pnpm --filter @byteql/db exec vitest run`, `pnpm --filter @byteql/db build`.
  **Checkpoint:** original cursor paging, EOF, retry and cancellation tests still pass.
- [ ] Commit `refactor(db): separate result views from cursor demand`.

## Task 3: Implement bounded snapshot sorting and resource cleanup

**Files:** Create `sort-result.ts`, `sort-result.test.ts`; use result-snapshot, arrow-bridge,
stored-result-view; adapt sort-probe to exercise the production writer instead of probe glue.

**Consumes:** A complete base QuerySession, ResultSortOptions, QueryPageStore and Task 1 helpers.
**Produces:**

```ts
export interface ResultSortDependencies {
  readonly database: Pick<AsyncDuckDB, 'registerOPFSFileName' | 'dropFile'>;
  connect(): Promise<AsyncDuckDBConnection>;
  createFiles(): Promise<ExportFiles>;
  createStore(): Promise<QueryPageStore>;
  onCleanupFailure(retry: () => Promise<void>, error: unknown): void;
}
export function writeSortedResult(
  dependencies: ResultSortDependencies,
  base: QuerySession,
  options: ResultSortOptions,
): Promise<QueryResultView>;
```

- [ ] Create an environment fake like `export-parquet.test.ts`, with a separate connection,
  real QueryPageStore, small base pages, and deferred send/IPC-write gates. The fake returns
  typed Arrow 17 batches with sorted values. It tests orchestration, not SQL correctness.
- [ ] Write failing tests that assert (a) base.fetchNext is never called here, (b) each base
  page is read once in summary order, (c) base.cancel/dispose is never called, and (d) return
  waits until final output EOF. Run `pnpm --filter @byteql/db exec vitest run src/sort-result.test.ts`.
- [ ] Implement this exact ownership sequence with one top-level try/catch/finally:

```text
validate complete base + supported schema + sort descriptor + signal
acquire files -> connection -> output store, recording each owned resource immediately
for each base summary in startRow order:
  signal.throwIfAborted()
  readPage -> snapshotPage(..., '__byteql_sort_ordinal') -> tableToIPC(...).slice()
  insert IPC into TEMP scratch table with generated cN + ordinal schema
  register owned shard path -> COPY scratch table to shard -> DROP scratch table
  report staging progress; release local Arrow/IPC references before next iteration
send buildResultSortSql(paths, base.schema, sort) on the separate connection
iterate Arrow 17 batches, slice into <= QUERY_PAGE_ROWS chunks
  convert chunk -> restoreResultSchema -> store.put(index, startRow, table)
  append summary -> report storing progress; never retain all chunks in an array
verify EOF, sum(rowCount) === base.status().loadedRows, signal not aborted
store.markComplete()
close reader/connection -> drop all registered paths -> dispose scratch files
return StoredResultView; ownership of its store transfers only here
```

  Use a truly connection-local **TEMP** table, named `__byteql_sort_page`. Create its typed
  schema once from a zero-row Arrow insert if necessary, then move to TEMP via
  `CREATE TEMP TABLE ... AS SELECT * FROM ... WHERE false`, drop the seed table, and append
  with `create:false`. The seed table must have a per-operation UUID-derived identifier to
  avoid touching user tables. Reuse the same TEMP table by TRUNCATE between shards; closing
  the dedicated connection removes it. Prove exact column types in Task 1. No unbounded
  accumulating table. COPY uses a fully quoted generated relation name.

  Output page sizes may be smaller than 8,192 when a reader batch is small; do not buffer
  batches merely to hit the target. Validate safe start offsets and return the original
  schema even if the iterator yields only schema/empty batches. Empty base can return an
  empty stored view without sending ORDER BY; UI does not offer sorting for <=1 row.

- [ ] Use the export writer's abort-listener pattern for **every long statement**: check
  already-aborted signal before attaching; cancelSent targets only this connection; join
  cancellation and iterator return before closing. During insertArrowFromIPCStream, which
  is not a cancellable SQL cursor, await its settlement then recheck the signal.
- [ ] Convert OPFS unavailable/security failures to SORT_UNAVAILABLE, quota to
  SORT_STORAGE_FULL, other preparation/ordering errors to SORT_FAILED. Preserve typed
  unsupported/schema errors and AbortError. Attempt independent cleanups with
  Promise.allSettled where safe; always join connection closure before dropping file handles.
  Collect every cleanup error. Transfer retry closures to onCleanupFailure; never return a
  candidate if scratch cleanup failed. Dispose candidate store on all failures.
- [ ] Test abort before setup, during each acquisition, page read, insert, COPY, ORDER BY,
  output store write and final cleanup. Inject schema/count mismatch, quota, cancellation
  failure and cleanup failure. Assert candidate disposal and unchanged base in every case.
- [ ] Add a fixture of a reader batch larger than QUERY_PAGE_ROWS; assert every put <=8,192
  and exact output row count without duplicates. Assert private ordinal absent from pages.
- [ ] Run new unit tests and both browser proof variants using the production writer.
  **Checkpoint:** do not wire a successful UI state to a partly stored view.
- [ ] Commit `feat(db): sort retained result pages into complete views`.

## Task 4: Register derived views with the database and enforce family lifetime

**Files:** Modify `browser.ts`, `browser.test.ts`, `index.ts`.

**Consumes:** writeSortedResult and a complete current QuerySessionImpl.
**Produces:** Working ByteqlDatabase.createSortedView, valid-view export checks, cancellation
and disposal covering the base and all derived/candidate resources.

- [ ] Extend the existing browser mock with **distinct** primary and sort connections. A
  mock returning the same connection for both would hide cancellation/ownership defects.
- [ ] Write failing tests for foreign/incomplete base rejection, single active sort, successful
  base survival, and startQuery superseding a pending sort. Run the browser suite.
- [ ] Add a pending-sort token `{ base, controller, promise }`, a derived-view registry keyed
  by view object with its base, and a set of cleanup retry functions. Validate before enqueue
  and again inside it; forward and remove the caller's AbortSignal listener in all outcomes.
- [ ] Allocate candidate store IDs using the same monotonically increasing database allocator
  used by startQuery; call createOpfsQueryPagePersistence and reject if it returns null.
  Construct QueryPageStore only after acquiring persistence; dispose it if construction fails.
- [ ] On writer success recheck pending token/base/disposed state, then register the view.
  Wrap its dispose with idempotent unregister-after-cleanup. If stale, dispose the view and
  reject with AbortError. Base stays `activeQuery` throughout.
- [ ] Add an abort-and-join helper like abortActiveExport. Invoke it before startQuery,
  beginIngest, cancelQuery, closeActiveQuery and dispose can retire a base. Trigger abort
  **before enqueueing behind the sort** to avoid waiting for an uninterruptible queue owner.
  Avoid circular waiting: cleanup does not enqueue itself onto the operation it is joining.
- [ ] Dispose all derived views associated with the retiring base, retry queued cleanups,
  then close base. Attempt every resource even if another cleanup fails. Keep unresolved
  retry records until successful release or final database teardown.
- [ ] Change `assertExportableResult` to accept QueryResultView, requiring either active base
  or a registered live view belonging to active base, no pending replacement/sort, and complete
  status. Do not export any arbitrary duck-typed reader supplied by app code.
- [ ] Test view dispose then export, new query then old-view export, disposal racing writer
  return, repeated cancel/dispose, two sort requests, export/sort exclusion, and failure cleanup.
  Assert original connection.send received the original SQL exactly once for that query.
- [ ] Run db unit tests and build. **Checkpoint:** no old-result family can be exported or
  adopted after a new query has taken ownership.
- [ ] Commit `feat(db): manage sorted result view lifetimes`.

## Task 5: Represent committed order and load windows from a view

**Files:** Modify `state.ts`, `state.test.ts`; create app `result-sort.ts`,
`result-sort.test.ts`, `result-view.ts`, `result-view.test.ts`; modify `result-scroll.ts`
and `result-scroll.test.ts`.

**Consumes:** QueryResultView, existing pageIndexesForWindow/assembleResultWindow.
**Produces:** These app contracts (export ResultSort from @byteql/db):

```ts
// Add to PagedResultState:
readonly orderRevision: number;
readonly sort: ResultSort | null;
// Add to SessionState, initialized/reset to null:
sorting: ResultSortingState | null;
// Also add to SessionState, initially false:
resultIsCurrent: boolean;

export interface ResultSortingState {
  readonly requestId: number;
  readonly queryGeneration: number;
  readonly fromRevision: number;
  readonly requestedSort: ResultSort | null;
  readonly phase: 'loading' | 'staging' | 'sorting' | 'storing' | 'cancelling' | 'failed';
  readonly rows: number;
  readonly totalRows: number | null;
  readonly message: string;
}
// Add reducer events:
| { type: 'resultSortUpdated'; queryGeneration: number; requestId: number;
    sorting: ResultSortingState }
| { type: 'resultSortEnded'; queryGeneration: number; requestId: number }
| { type: 'resultUnavailable'; queryGeneration: number }
| { type: 'resultOrderCommitted'; queryGeneration: number; requestId: number;
    fromRevision: number; result: PagedResultState }

// app result-sort.ts
export function nextResultSort(current: ResultSort | null, columnIndex: number): ResultSort | null;
export function sortActionLabel(schema: Schema, current: ResultSort | null, columnIndex: number): string;
export function isResultSorting(state: SessionState): boolean;
export function resultSortInteractionBlocked(state: SessionState): boolean;
export function resultSortDisabledReason(state: SessionState, opfsAvailable: boolean): string | null;

// result-view.ts: caller performs identity checks; this helper has no controller dependency.
export async function readResultWindow(view: QueryResultView, anchorRow: number): Promise<{
  schema: Schema; loadedRows: number; complete: boolean; elapsedMs: number;
  windowStart: number; window: Table;
}>;
```

- [ ] Write the cycle tests and run them red:

```ts
it('cycles one field and starts another ascending', () => {
  expect(nextResultSort(null, 2)).toEqual({ columnIndex: 2, direction: 'asc' });
  expect(nextResultSort({ columnIndex: 2, direction: 'asc' }, 2))
    .toEqual({ columnIndex: 2, direction: 'desc' });
  expect(nextResultSort({ columnIndex: 2, direction: 'desc' }, 2)).toBeNull();
  expect(nextResultSort({ columnIndex: 2, direction: 'desc' }, 5))
    .toEqual({ columnIndex: 5, direction: 'asc' });
});
```

- [ ] Implement the cycle as a pure function; reject invalid safe integer indexes. Label
  duplicate names with `column N`. `isResultSorting` is true for every phase except failed.
  Availability checks query freshness/ready phase, pageError, active sort, active download
  phases including cancelling, row count <=1 if complete, OPFS, and whole-schema eligibility.
  Clear sort bypasses OPFS/type/row-count eligibility but not busy/freshness checks.
  `resultSortInteractionBlocked` checks !resultIsCurrent, phase !== ready, active sorting,
  or an active download (including cancelling). Use it for Clear sort as well as headers.
- [ ] Write reducer tests from existing valid-result fixtures; always initialize orderRevision
  and sort in existing fixtures rather than making them optional throughout the app:

```ts
// In state.test.ts, `current` is a valid fixture with revision 2 and a selected row.
const stale = { ...current.result!, orderRevision: 1 };
expect(reduceSession(current, { type: 'queryWindowUpdated', result: stale })).toBe(current);
const committed = reduceSession(current, {
  type: 'resultOrderCommitted', queryGeneration: current.result!.generation,
  requestId: current.sorting!.requestId, fromRevision: 2,
  result: { ...current.result!, orderRevision: 3, sort: { columnIndex: 0, direction: 'asc' },
    windowStart: 0, complete: true, loadingMore: false },
});
expect(committed.selectedRow).toBeNull();
expect(committed.byteSelection).toBeNull();
expect(committed.result!.orderRevision).toBe(3);
```

- [ ] Require generation AND revision equality for queryWindowUpdated. Existing monotonic
  count/complete checks remain. Sort update admission requires state.result.generation,
  current query freshness, fromRevision matching current result, and nondecreasing requestId;
  progress/termination/commit must match the active request. A failed operation can be replaced
  by a higher requestId. Ignore lower IDs, including delayed starts/progress from old requests.
- [ ] Order commit requires a pending matching operation, fromRevision=current revision,
  next revision=current+1, valid first window, complete=true, loadedRows equal to the now
  fully drained current result, and same schema. Clear selections, sorting=null, and page
  errors only on accepted commit. Validate sort field bounds and direction at the boundary.
- [ ] Reset sorting on queryStarted/opening/cancelled/failed/querySucceeded. Initialize order
  fields in new-query results. Do not use querySucceeded to commit a sort.
  Set resultIsCurrent=false on queryStarted/opening/cancelled/failed/queryFailed, true on
  querySucceeded. Add a generation-fenced `resultUnavailable` event for explicit family
  closure while leaving old rows visible. The controller emits it before closing a current
  family; reducer accepts resultUnavailable only for the displayed result's generation,
  and cancellation/disposal of an old family must not invalidate a newer result.
  Preserve it across successful sort, sort failure and Cancel sort. Test the prior completed
  result remaining visible after failed SQL while resultIsCurrent is false.
- [ ] Extract bounded window assembly from controller.buildResultState into readResultWindow;
  use exactly the existing anchor/clamping/page pinning rules. It reads only needed pages and
  returns no completeTable. Test a middle window, the million-row tail, empty schemaful view,
  and async read failure. The caller owns stale checks after the helper resolves.
- [ ] Add a failing test for forward demand in a complete result with later stored rows:

```ts
expect(resultDemand({ firstVisible: 16_370, lastVisible: 16_383,
  windowStart: 0, windowRows: 16_384, loadedRows: 50_000, complete: true })).toBe('forward');
```

  Preserve backward-edge precedence, then replace the forward condition with:

```ts
const atWindowTail = input.windowRows > 0 &&
  input.lastVisible >= input.windowRows - RESULT_EDGE_ROWS - 1;
const hasLaterStoredRows = input.windowStart + input.windowRows < input.loadedRows;
if (atWindowTail && (hasLaterStoredRows || !input.complete)) return 'forward';
return null;
```

  Also test a complete final window (no forward demand), an incomplete loaded tail
  (forward demand), and earlier windows in an incomplete result (forward stored demand).

- [ ] Run `pnpm --filter @byteql/db build`, then
  `pnpm --filter @byteql/web exec vitest run src/lib/session/state.test.ts src/lib/session/result-sort.test.ts src/lib/session/result-view.test.ts src/lib/session/result-scroll.test.ts`.
  **Checkpoint:** a window from revision 1 cannot be accepted in revision 2, even if counts match.
- [ ] Commit `feat(web): model result order revisions`.

## Task 6: Coordinate sorting, restoration and cancellation in SessionController

**Files:** Modify `controller.ts`, `controller.test.ts`; extend typed database/view test doubles.

**Consumes:** Tasks 1–5, current export cleanup/resultDemand helpers.
**Produces:** Public methods `sortResults(sort: ResultSort | null): Promise<void>` and
`cancelResultSort(): Promise<void>`, plus original/display separation.

```ts
// New private state, alongside existing activeQuery and queryGeneration:
private activeResultView: QueryResultView | null = null;
private sortRequestId = 0;
private activeSort: {
  id: number;
  queryGeneration: number;
  sessionGeneration: number;
  fromRevision: number;
  base: QuerySession;
  previousView: QueryResultView;
  controller: AbortController;
  settlement: Promise<void>;
} | null = null;
private baseViewerTable: Table | null = null;
private baseViewerMaterialized = false;
```

- [ ] Extend FakeQuerySession in controller.test.ts with a separate complete-view fixture and
  `createSortedView` spy/deferred result. Retain real reducer updates; do not manually pretend
  the controller committed a result. Write a test with incomplete base [3,1] then [2]:

```ts
// Within the existing ready-controller fixture after runQuery, with next base page pending:
const sqlBefore = controller.getState().sql;
const generation = controller.getState().result!.generation;
await controller.sortResults({ columnIndex: 0, direction: 'asc' });
expect(database.startQuery).toHaveBeenCalledTimes(1);
expect(database.createSortedView).toHaveBeenCalledWith(base, expect.objectContaining({
  sort: { columnIndex: 0, direction: 'asc' },
}));
expect(controller.getState().result).toMatchObject({ generation, orderRevision: 1, complete: true });
expect(controller.getState().sql).toBe(sqlBefore);
expect(controller.getState().selectedRow).toBeNull();
expect(base.disposed).toBe(0);
```

- [ ] Run controller tests red. Implement new-query initialization with activeResultView=base,
  revision=0, sort=null, and reset viewer cache. `buildResultState` reads activeResultView via
  readResultWindow and fences the captured view AND revision after await. CompleteTable
  comes from a once-per-base materialization attempt after EOF, never from the sorted view.
- [ ] Implement sortResults with this state machine:

```text
check usable, ready/current result, requested descriptor, busy and capability constraints
if requested order equals committed order: return (no progress, no selection reset)
capture base/view/generations/revision; create token and publish pending synchronously
await supersedeExport() for terminal retained artifact cleanup (active export was rejected)
await pending resultDemand; recheck token and page error
if requested sort is non-null:
  while base is incomplete:
    check token/abort; await base.fetchNext(QUERY_PAGE_ROWS); recheck
    refresh base/display counts without replacing the previous visible Arrow window
    publish loading progress
  await/cache base.materialize(QUERY_RESULT_MEMORY_BYTES) once, tolerating null/failure
  candidate = await database.createSortedView(base, guarded options)
else: candidate = base
first = await readResultWindow(candidate, 0)
check token/abort/base/view/generations/revision and first-window/schema/count invariants
build next result (revision+1, sort=requested, completeTable=baseViewerTable)
synchronously assign activeResultView=candidate and dispatch resultOrderCommitted
mark ownership transferred; dispose previous view only if it is derived and different
catch: dispose any unadopted derived candidate; report current operation's failure only
finally: release suspension/active token only if this is still their owner
```

- [ ] Define a private `isCurrentSort(token)` checking all captured identities and !disposed;
  call it in progress callbacks and after every awaited boundary. Centralize the guard.
  When aborting, mark cancellation synchronously so the success continuation cannot publish.
- [ ] Suspend demand by checking activeSort in loadMoreResults, loadResultWindow and
  retryResultPage. Block selectResultRow/selectByteRange while pending. Existing reads already
  in flight may finish before preparation; later view publications require their captured
  revision/view. Do not reuse exportGeneration as a sort owner ID.
- [ ] Handle base fetch errors through existing page failure mapping before setting sort
  failed. Retryable base quota failure keeps retryPending data; after Retry loading rows,
  a fresh header action can sort. Terminal fetch errors require rerun for missing rows.
- [ ] Implement cancelResultSort: abort only the sort signal, announce cancelling, join
  settlement. During base draining await the one outstanding fetch and do not base.cancel().
  Preserve prior display/selection/scroll; refresh counts from any page that finished.
  Clear sorting for a successful cancel; failures use the inline sort error.
- [ ] Add `supersedeSort(): Promise<void>` that invalidates ID, aborts, detaches token, joins
  cleanup and disposes any candidate. Call it on runQuery, openBatch, cancel and dispose;
  combine it with export cleanup before closeActiveQuery. Invalidate synchronously before
  await. Replacement may cancel the original cursor because the whole family is being closed;
  user Cancel sort must not. Database-level guards in Task 4 remain as a second boundary.
- [ ] On sort failure after EOF refresh old result's complete/count metadata. On cleanup
  failure after commit keep the new committed view and report `Sort applied; local cleanup
  needs retry.` Retain the resource for teardown retry; do not roll the UI back to disposed
  pages. On preparation cleanup failure no candidate may commit.
- [ ] Add the following deferred-promise tests, each asserting visible revision, selected row,
  SQL send count and dispose counts: old loadWindow resolves after commit; duplicate header
  requests while pending; cancel in base drain; cancel after derived view arrives but before
  first-window read; first-window failure; rerun/file open/dispose during each phase; sort
  failure followed by successful clear; clear uses base and disposes only derived; stale
  progress from previous query; incomplete base quota retry; cleanup failure.
- [ ] Add viewer regression: materialize base once; sort twice and clear; completeTable
  reference and original row order stay stable. Values selection uses the displayed window.
- [ ] Run `pnpm --filter @byteql/web exec vitest run src/lib/session/controller.test.ts src/lib/session/state.test.ts`.
  **Checkpoint:** sort never invokes runQuery/startQuery or cancels the retained base on user cancel.
- [ ] Commit `feat(web): coordinate whole-result column sorting`.

## Task 7: Make downloads follow the committed view

**Files:** Modify app `lib/export/operation.ts`, controller export methods/tests,
`ResultsDownload.svelte`/tests, db `export-parquet.ts`/tests, browser tests.

**Consumes:** QueryResultView and current original/display/revision identity.
**Produces:** CSV and Parquet in committed display order with export isolation.

```ts
// Replace ExportOperation.result: QuerySession with:
readonly base: QuerySession;
readonly result: QueryResultView;
readonly orderRevision: number;
// Keep resultGeneration (query generation), generation (export generation), and other members.
```

- [ ] Write a controller test that sorts [3,1,2] ascending then starts CSV. Decode the exact
  exported IPC supplied to the CSV fake and expect [1,2,3]. Assert base.fetchNext is not called
  during export of a derived view. Test original incomplete view still drains exactly once.
- [ ] Add orderRevision/result-object checks to isCurrentExport and refreshExportedResult.
  Download validation rejects activeSort or !resultIsCurrent before opening a picker. The UI uses the same busy
  condition. Starting a sort rejects all active download phases, including cancelling.
  Sorting releases terminal retained downloads so an obsolete ready-to-save artifact disappears.
- [ ] Narrow the export drain loop: only `operation.result === operation.base` can fetchNext.
  Assert every other view is complete. Preserve current synchronous picker invocation; do
  not move it behind a new await. Snapshot both result view and orderRevision at invocation.
- [ ] In the Parquet writer append `__byteql_export_ordinal` to every selected page using
  snapshotPage with original **display** page.startRow. Generated user aliases remain c0…
  based on selected column position. Include ordinal in each shard, and use:

```sql
COPY (
  SELECT "c0" AS "original name", "c1" AS "another name"
  FROM parquet_scan(['owned shard paths'])
  ORDER BY "__byteql_export_ordinal" ASC
) TO 'owned output path' (FORMAT PARQUET, COMPRESSION SNAPPY)
```

  Projection must explicitly exclude ordinal and retain duplicate-name behavior. The
  existing empty-page schema path adds a zero-length ordinal too. Reuse snapshotPage
  after selecting columns by original schema index; original labels still come from
  selectedFields. Do not infer export order from shard names or scan order.

- [ ] Extend Parquet unit tests to inspect staged ordinal vectors for nonzero startRow and
  non-contiguous page indexes, final ORDER BY, user alias colliding with the private ordinal,
  empty result, quoted/duplicate names, and no private ordinal in the final projection.
- [ ] Run db export and app controller/download suites, then the existing results-download
  and results-export-probe browser suites. Confirm U+FEFF and >2^53 values survive.
  **Checkpoint:** the original SQL still has one send and saved rows match display, including tail pages.
- [ ] Commit `feat(web): export results in the committed display order`.

## Task 8: Add accessible header controls and in-place grid reset

**Files:** Modify ResultGrid, Workbench, workbench.css and tests; add `ResultGrid.sort.test.ts`.

**Consumes:** Session state and controller APIs from Tasks 5–7.
**Produces:** User-visible controls; these new ResultGrid props:

```ts
orderRevision: number;
sort: ResultSort | null;
sortBusy: boolean;
sortInteractionBlocked: boolean;
sortDisabledReason: string | null;
onsort: (sort: ResultSort | null) => void;
```

- [ ] Write a component test with table columns `[value, _src_start]`, callbacks and revision=0.
  Activate the value header by keyboard and assert callback `{columnIndex:0,direction:'asc'}`.
  Re-render with committed ascending state and test descending, then restoration. Add a
  duplicate-name schema fixture using Arrow Field/Schema (object literals cannot express it).
- [ ] Run the new suite red. Change both header and cell each-block keys to index; keep
  original index through hidden-field filtering. Render a guarded native button:

```svelte
{@const active = sort?.columnIndex === index}
{@const next = nextResultSort(sort, index)}
<div role="columnheader" aria-colindex={index + 1}
  aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
  <button type="button" class="result-sort-button"
    aria-label={sortActionLabel(table.schema, sort, index)}
    aria-describedby="result-sort-help"
    aria-disabled={sortInteractionBlocked || (next !== null && sortDisabledReason !== null)}
    onclick={() => {
      if (sortInteractionBlocked || (next !== null && sortDisabledReason !== null)) return;
      onsort(next);
    }}>
    <span>{field.name}</span>
    <small>{field.type.toString()}</small>
    <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true"
      fill="none" stroke="currentColor" stroke-width="1.5">
      {#if !active || sort.direction === 'asc'}<path d="M2 6 L6 2 L10 6" />{/if}
      {#if !active || sort.direction === 'desc'}<path d="M2 10 L6 14 L10 10" />{/if}
    </svg>
  </button>
</div>
```

  Put `result-sort-help` once per grid, describing the cycle and current unavailable reason.
  `sortInteractionBlocked` also blocks restoration for freshness/download busy reasons;
  do not let the next=null bypass that guard. Native
  Enter/Space activation suffices; no duplicate keydown toggler.

- [ ] Modify header CSS so padding/hit area belongs to the button without doubling padding
  inherited from `.grid-header > div`. Retain header height, type label, border, 9rem width,
  sticky behavior and local tokens. Add focus-visible outline and distinct disabled appearance.
  The inline SVG above needs no new icon dependency. CSS starting point:

```css
.grid-header > div { padding: 0; }
.result-sort-button {
  display: flex; align-items: baseline; gap: var(--space-2);
  width: 100%; min-width: 0; padding: var(--space-2);
  border: 0; color: inherit; background: transparent; font: inherit; text-align: left;
}
.result-sort-button svg { flex: 0 0 12px; align-self: center; }
.result-sort-button[aria-disabled='true'] { color: var(--color-text-subtle); }
.result-sort-button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
```

- [ ] Add busy checks to inspectDemand, scheduled demand callbacks, observer-driven demand,
  row clicks, and selectFromKeyboard. On pending entry cancel demand/rebase rAF work and clear
  transient guards; do not reset scroll. Set aria-busy for either paging or sorting.
- [ ] Route forward demand to the right operation:

```ts
if (direction === 'forward') {
  const nextStoredRow = windowStart + table.numRows;
  if (nextStoredRow < loadedRows) onloadwindow(nextStoredRow);
  else if (!complete) onloadmore();
} else onloadwindow(windowStart - 1);
```

  Remove the sentinel observer's unconditional `complete` exit: it exits only when complete
  AND the current window reaches loadedRows (plus existing busy/error guards). Before its
  End of result branch, display `More stored rows` if windowEnd < loadedRows. Test complete
  view forward/backward movement with real demand callbacks, not direct window assignment.

- [ ] Add an explicit orderRevision effect before ordinary window compensation. A shared
  lastSeenRevision must be checked in the compensation path too; avoid relying on effect
  declaration order. For a new revision:

```text
cancel demandFrame and rebaseFrame; null both
demandGuard=null; rebaseTop=null; demandSuppressed=true
previousWindowStart=new windowStart; hasPreviousWindowStart=true
record new revision
save scrollLeft; set virtualizer count to new window.numRows
virtualizer.scrollToOffset(0); element.scrollTop=0; restore scrollLeft
next animation frame: clear suppression, schedule fresh demand inspection
```

  Capture revision in every newly scheduled rAF/row-focus callback and ignore it if stale.
  Leave showHidden untouched. Disposal cancels all callbacks. After cancellation without
  a new revision resume demand inspection but preserve scroll and selected row.

- [ ] Workbench passes revision/sort/busy/reason and calls controller.sortResults through
  its existing async action boundary. Keep the query-generation key. Add toolbar order label,
  Clear sort, polite progress, Cancel sort, and alert on failed state. Keep editor draft/Run
  behavior unchanged. Use session.result schema for labels, never draft SQL.
- [ ] Implement focus restoration for toolbar Clear/Cancel: record initiating schema index;
  after tick focus its button via a data-column-index selector, else focus the grid with
  tabindex=-1. For header-triggered sort keep the same button node mounted. Do not focus on
  every progress update. If a hidden active field is restored, use grid fallback.
- [ ] Add tests for hidden active key, non-key unsupported field, OPFS unavailable, header
  actions disabled during sort/download/query replacement, row-selection suppression, one
  aria-sort attribute, duplicate names, horizontal-scroll/showHidden retention, and no remount
  when orderRevision changes. Update every ResultGrid fixture with required new props.
- [ ] Extend Workbench tests for unchanged editor draft and query-generation key, sorted
  status, Clear/Cancel, and base viewer input. Run ResultGrid, Workbench, ResultsDownload tests.
  **Checkpoint:** sort commit uses neither a new query generation nor a new ResultGrid instance.
- [ ] Commit `feat(web): add accessible result column sort controls`.

## Task 9: Browser acceptance, race coverage and evidence

**Files:** Add `result-column-sorting.spec.ts`; extend e2e harness, existing scrolling,
download/privacy/hex acceptance as needed; update compatibility evidence document.

**Consumes:** Complete integrated feature. **Produces:** observed acceptance and limits.

- [ ] Add the basic real-SQL acceptance test, then run it:

```ts
test('sorts all result rows and restores the original execution order', async ({ page }) => {
  await openMidiSample(page);
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  const sql = 'select 20000-i as value, i as identity from range(20000) t(i)';
  await editor.fill(sql);
  await page.getByRole('button', { name: 'Run query' }).click();
  const firstValue = page.getByRole('row', { name: 'Row 1', exact: true })
    .getByRole('gridcell').first();
  await expect(firstValue).toHaveText('20000');
  await page.getByRole('button', { name: 'Sort value ascending', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: /value/ })).toHaveAttribute('aria-sort', 'ascending');
  await expect(firstValue).toHaveText('1');
  await expect(editor).toHaveText(sql);
  await page.getByRole('button', { name: 'Sort value descending', exact: true }).click();
  await expect(firstValue).toHaveText('20000');
  await page.getByRole('button', { name: 'Clear sort', exact: true }).click();
  await expect(firstValue).toHaveText('20000');
  await expect(page.locator('[role="columnheader"][aria-sort]')).toHaveCount(0);
  expect((await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics())).sendCount).toBe(1);
});
```

- [ ] Add SQL fixtures with independently specified expected identities:

| Fixture | Expected check |
| --- | --- |
| `(id,key)=(0,2),(1,NULL),(2,2),(3,-1),(4,NULL)` | asc IDs `[3,0,2,1,4]`; desc `[0,2,3,1,4]`; clear `[0,1,2,3,4]` |
| `SELECT i, random() AS r FROM range(20000) t(i) LIMIT 1100 OFFSET 5` | exact saved `(i,r)` mapping unchanged; only those 1,100 rows sorted |
| CTE/UNION with an original ORDER BY | clear restores the captured original sequence |
| duplicate names and `SELECT 1 AS "x""; DROP TABLE events; --"` | positional field selection; source tables survive |
| `SELECT [1,2] AS details, 10 AS value` | unsupported non-key field disables sorting with reason |
| supported empty query and single-row query | schema retained; no enabled sorting |
| `SELECT * FROM events` and pcap source result | selected sorted row reveals exact original file/range |
| aggregate without source columns | remains unlinked after sort |

  Keep precision/type fixtures in the runtime probe. Browser UI tests should assert user
  behavior, not duplicate every low-level schema case.

- [ ] Add a million-row numeric test with per-test timeout 120s. Sort while only the initial
  page is loaded; check first and last display values, then loadResultWindow(999999) and
  physically scroll using existing scrolling-test patterns. Go backward again. Verify
  <=16,384 window rows, <=16,384*36 spacer height, no duplicate scrollbar and original send=1.
  Inspect decoded-cache metrics per store, not an obsolete single-store total assertion.
- [ ] Add a separate 50,000-row acceptance that starts at the first sorted window and uses
  physical mouse-wheel scrolling until Row 50000 is visible. Assert its value, scroll backward
  to Row 1, Clear sort, and repeat forward. Do not call loadResultWindow in this test: that
  would bypass the forward-demand defect this feature must fix. Use bounded polling of
  visible row indexes with wheel events, and fail if the index stops advancing.
- [ ] Extend QueryResultDiagnostics with `orderRevision`, `sort`, `sortPending`,
  `derivedViewCount`, `sortSendCount`, and `viewCaches: readonly { kind: 'base' | 'display' |
  'candidate'; decodedBytes: number }[]`. Define counters so duplicate base/display objects
  count only once. Database exposes diagnostics through a read-only method if needed; do
  not expose live QuerySession objects to production window globals. Adjust e2e harness
  storedResult to read the **display view**, with a small-fixture row cap of 20,000; use
  page/window metrics for million-row tests, never serialize all million rows to Playwright.
- [ ] Add sorted CSV and Parquet downloads with >=20,000 rows and stable ties; read exact
  file contents using existing download/readExportArtifact helpers. Assert count/order,
  provenance columns, no internal ordinal and unchanged source values. Clear and export
  original order. Test retained download artifact removed before sort.
- [ ] Test Run query and file replacement while sorting; cancellation and quota failures use
  deterministic deferred unit tests plus at least one real long-sort cancellation. Do not
  use sleeps as the primary synchronization mechanism. Assert no stale status/order appears
  and temporary registered/scratch files disappear after cleanup. Repeat ten sort/clear
  cycles and assert resource counts return to base-only after each clear.
- [ ] Test no-OPFS state before app initialization using browser context overrides; sorting
  exposes its disabled reason while a small ordinary query and CSV still work. Do not modify
  browser hardening to simulate support.
- [ ] Record light/dark and narrow/wide screenshots; use keyboard only to sort/clear/cancel;
  check stable focus, readable announcements, sort indicator without color, hidden active
  column, preserved horizontal scroll and panel heights. Manually check one touch browser
  and one screen reader if available. Record unavailable manual checks as outstanding.
- [ ] Run targeted acceptance:

```bash
pnpm --filter @byteql/db build
pnpm --filter @byteql/web test:e2e result-sort-probe.spec.ts result-column-sorting.spec.ts query-result-scrolling.spec.ts results-download.spec.ts results-export-probe.spec.ts hex-provenance.spec.ts privacy.spec.ts
```

- [ ] Run final repo gates after targeted tests pass:

```bash
pnpm check
pnpm lint
pnpm -r test -- --run
pnpm --filter @byteql/web check:bundle
pnpm --filter @byteql/web test:e2e
```

  Note: `pnpm check` includes build, package checks and format:check. The full e2e suite is
  the final integration gate, not a substitute for debugging a failing targeted test.
  Do not deploy from this plan. Stop retesting after gates pass unless code changes.

- [ ] Update compatibility document with actual device/browser/bundle, row counts, sort
  duration, peak observed decoded caches and scratch storage, cancel behavior, supported
  types, and outstanding manual checks. Distinguish OPFS staging from native sort spill;
  no claim of unbounded sorting follows from a million-row test.
- [ ] Review diff against spec coverage table below. Commit
  `test(web): verify result sorting across paging and exports`.

## Recovery rules for the executor

| Symptom | Required response |
| --- | --- |
| New @byteql/db export missing in web tests | Rebuild db/dist first; verify source exports before changing imports |
| Pinned runtime changes a value/type | Stop the proof gate; do not cast, stringify, drop a field or rerun SQL to pass |
| Out-of-memory in native sort | Preserve old view if runtime remains healthy; report failure and measured limit. Do not alter lockdown or claim external spill |
| Only visible rows sorted | Reject the implementation; verify full base drain and candidate EOF/count |
| Stale window/selection after sort | Inspect generation + revision + object guards, not just selectedRow clearing |
| Sort cancel destroys base result | Remove base.cancel from user-cancel path; base cancellation belongs to replacement/disposal only |
| Clear sort reruns SQL | Restore retained base pages; verify one original send |
| Wrong export order | Check display view capture and final Parquet ordinal ORDER BY |
| Cleanup promise deadlocks | Abort before enqueue; never enqueue cleanup behind the operation waiting for it |
| Unit tests pass but browser unavailable | Mark runtime acceptance unverified; do not claim completion |
| Existing unrelated checks fail | Record baseline and isolate failure; do not fold unrelated fixes into this feature |

If a task is interrupted, record its last passing command, uncommitted files, active failing
test, and next checkbox. Resume at that point. Do not rewrite completed tasks or restart the
implementation in a new architecture without revising the spec.

## Spec coverage and final review

| Spec requirement | Implementation / proof |
| --- | --- |
| Same query execution, LIMIT membership, original-order restore | Tasks 1, 3, 6, 9 |
| Full result and stable ties, typed/null ordering | Tasks 1, 3, 9 |
| OPFS/type restrictions and truthful errors | Tasks 1, 3, 5, 8, 9 |
| Read-only views, ownership, bounded pages | Tasks 2–4 |
| Atomic adoption, stale-result fences, cancellation | Tasks 4–6 |
| Grid reset without remount, selection/provenance | Tasks 5, 6, 8, 9 |
| Original-order trusted viewer input | Tasks 6, 8 |
| Display-order exports, no private columns | Tasks 7, 9 |
| Header accessibility and layout | Tasks 8, 9 |
| Privacy, cleanup and real bundle proof | Tasks 1, 3, 4, 9 |

Before reporting complete, confirm all required automated gates actually passed, summarize
material browser/type/storage limitations, and list any outstanding manual checks. Provide
the final diff and test evidence for review. Do not push, merge or deploy without the user's
instruction to do so.
