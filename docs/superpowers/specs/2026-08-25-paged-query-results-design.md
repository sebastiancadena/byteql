# Paged query results and seamless infinite scrolling

Date: 2026-08-25
Status: approved design, pre-implementation

## Context

ByteQL currently consumes every DuckDB result batch, rewrites the full stream into one Arrow
IPC buffer, decodes that buffer into one `Table`, and retains the complete table on the main
thread. `ResultGrid` then creates a TanStack virtualizer before its scroll element is mounted.
`initialRect` makes the first rows appear, but the virtualizer never attaches to the real element,
so scrolling changes `scrollTop` without changing the rendered row range.

The two faults have different scales:

- A 300-row query is complete and correctly reported as 300 rows, but only the initial virtual
  range is reachable.
- A one-million-row query is fully materialized in JavaScript. At 36 px per row its logical
  height is 36,000,000 px, beyond Chromium's approximately 33,554,428 px element-height ceiling.
  Even with the mount bug repaired, the last approximately 68,000 rows are unreachable.

This design repairs the immediate mount defect and replaces whole-result materialization with a
pull-based query result session, OPFS-backed page retention, and a bounded sliding render window.

## User-visible contract

- Results scroll continuously. There are no Next/Previous page controls.
- The first pull targets 1,024 rows. If it also reaches end-of-stream, the heading immediately
  shows the exact result count; a 300-row result therefore says `300 rows` and every row is
  reachable.
- If more data exists, the heading says `<N> loaded · more available`. Approaching the bottom
  fetches and appends the next page without a button click.
- Subsequent pages target 8,192 rows. Approaching the top of an evicted render window restores
  prior pages without rerunning SQL.
- Once DuckDB reaches end-of-stream, the heading changes to the exact count, such as
  `1,000,000 rows`.
- A loading row and `aria-busy` communicate background fetches. Storage failures offer retry;
  terminal cursor failures explain that the query must be rerun. The existing query cancel action
  cancels initial execution or a later page fetch.
- Starting a new query or opening new source files closes the prior result session and removes
  its scratch pages.
- Explorer **Browse** runs `select * from <quoted table>` through the same result session; it no
  longer injects `limit 10000`.

## Scope decisions

- **One DuckDB cursor per result (recommended approach).** `connection.send(sql)` executes once;
  ByteQL pulls Arrow record batches incrementally. This preserves the query's one-execution
  snapshot and row order. (Rejected: wrap and rerun the query with `LIMIT/OFFSET` for each page —
  deep offsets repeat work and unordered SQL is not stable across executions.)
- **OPFS page spool plus bounded decoded cache.** Every fetched page is serialized once under
  `byteql-results/<query-generation>/<page>.arrow`. Recently viewed pages stay decoded in an LRU
  capped by bytes. (Rejected: keep every fetched page decoded — wide million-row results can
  exhaust the tab; discard old pages and rerun SQL — breaks the one-execution snapshot.)
- **Sliding render window.** The DOM virtualizer covers at most 16,384 logical rows around the
  viewport. Moving across a window boundary swaps pages and compensates `scrollTop`, so no DOM
  element approaches the browser height ceiling. (Rejected: one spacer for all loaded rows — it
  fails again as the loaded count grows.)
- **Loaded count until EOF.** ByteQL does not issue a second `COUNT(*)` query. This minimizes
  time-to-first-row and supports arbitrary DuckDB result-producing SQL without parsing or
  rewriting it. The UI never labels a partial result as the total.
- **Small-result compatibility.** A completed result whose serialized size remains below the
  decoded-cache limit may expose a materialized `Table` to trusted viewers. Large/incomplete
  results remain grid/inspector results; viewers that require a complete table stay disabled
  with a literal reason.

## Non-goals

- Random jump-to-row or proportional scrollbar positioning before the total is known.
- Editing result cells, server-side sorting/filtering controls, or saved result sets.
- Running queries while intake is still in progress.
- Changing SQL semantics, projection behavior, table schemas, or source provenance.
- Persisting query results across an application reload.

## Architecture

### Database query session (`@byteql/db`)

`ByteqlDatabase.query(sql)` is replaced by `startQuery(sql)`. The database owns at most one
active query session because the existing app permits only one current query and uses one DuckDB
connection.

```ts
export interface QueryPage {
  readonly index: number;
  readonly startRow: number;
  readonly rowCount: number;
  readonly table: Table;
}

export interface QueryStatus {
  readonly loadedRows: number;
  readonly complete: boolean;
  readonly elapsedMs: number;
  readonly storedBytes: number;
}

export type QueryPageSummary = Omit<QueryPage, 'table'>;

export interface QuerySession {
  readonly schema: Schema;
  status(): QueryStatus;
  pages(): readonly QueryPageSummary[];
  fetchNext(targetRows?: number): Promise<QueryPage | null>;
  retryPending(): Promise<QueryPage>;
  readPage(index: number): Promise<QueryPage>;
  pinPages(indexes: readonly number[]): void;
  materialize(maxBytes?: number): Promise<Table | null>;
  cancel(): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface ByteqlDatabase {
  // existing ingest/list/statistics methods stay unchanged
  startQuery(sql: string): Promise<QuerySession>;
  cancelQuery(): Promise<boolean>;
}
```

`startQuery` calls `connection.send(sql)` and returns after the stream/schema are available; it
does not call `RecordBatchStreamWriter.writeAll`. `fetchNext` is serialized per session and pulls
until it has at least the requested number of rows or observes EOF. A DuckDB batch that crosses a
page boundary is sliced without converting rows into objects. Page tables retain Arrow vectors
and record batches.

The initial call requests `QUERY_INITIAL_ROWS = 1_024`; later calls default to
`QUERY_PAGE_ROWS = 8_192`. A page may be smaller only at EOF. `status.loadedRows` is the sum of
published pages. `status.complete` becomes true only after the reader reports EOF. `elapsedMs` is
wall time from `startQuery` through the latest published state; the UI labels an incomplete value
as first/streaming time and a completed value as total time.

The active query exclusively owns the existing connection until `dispose`. Database operations
that replace data first cancel and dispose it. Starting a new query does the same to the previous
session before calling `send`; stale session methods reject with `Query result session is closed.`
`cancelQuery()` remains the controller's race-safe cancellation entrypoint and delegates to
DuckDB's `cancelSent()` when a cursor is active.

### Query page storage

`packages/db/src/query-pages.ts` owns serialized page persistence and lifecycle. It uses direct
Origin Private File System APIs, not DuckDB external access, so the existing DuckDB hardening
statements and `allowed_directories` remain unchanged.

Layout:

```text
byteql-results/
  <query-generation>/
    0.arrow
    1.arrow
    ...
```

Each completed page is Arrow IPC-serialized and persisted before it becomes eligible for decoded
cache eviction. `readPage` first consults the decoded LRU, then reads and decodes the corresponding
OPFS file. The cache has a 64 MiB byte budget and always retains the pages intersecting the render
window, even when those pages temporarily exceed the budget.

If OPFS is unavailable, pages remain in memory while their serialized total is at most 64 MiB.
Before a fetch would exceed that limit, it fails without discarding already loaded rows using the
code `RESULT_SPILL_UNSUPPORTED`. The UI explains that the browser cannot retain more local result
pages and suggests narrowing the SQL. A one-million-row narrow result remains supported when it
fits this fallback; OPFS-capable browsers support large wide results.

`dispose` removes the query generation recursively. Initialization sweeps every directory under
`byteql-results/` because results never survive a reload. Cleanup is best-effort after preserving
the primary query error; quota errors use `RESULT_SPILL_QUOTA_EXCEEDED` and retain already loaded
rows.

### Application state and controller

`SessionState.result: Table | null` becomes a plain `PagedResultState | null`:

```ts
export interface PagedResultState {
  readonly generation: number;
  readonly schema: Schema;
  readonly loadedRows: number;
  readonly complete: boolean;
  readonly loadingMore: boolean;
  readonly windowStart: number;
  readonly window: Table;
  /** Complete result for trusted viewers, or null while incomplete/above the 64 MiB budget. */
  readonly completeTable: Table | null;
  readonly elapsedMs: number;
  readonly pageError: string | null;
  readonly pageErrorRetryable: boolean;
}
```

The standalone `SessionState.queryElapsedMs` field is removed; `result.elapsedMs` is the single
source for result timing. `queryError` continues to describe initial execution failure, while
`result.pageError` describes a failure after at least one page was published.

The live `QuerySession` stays private to `SessionController`; reducer state remains serializable
apart from the existing Arrow `window`. Initial execution starts the session, fetches the first
page, builds the first window, and dispatches `querySucceeded`. `loadMoreResults()` coalesces
concurrent requests into one promise, fetches the next page, refreshes the window, and ignores
events from superseded query generations. `loadPreviousResults(globalRow)` reloads spooled pages
needed to center the window around that row.

Initial execution failure keeps the previous successful result, matching current behavior. A
later page failure keeps already loaded rows and sets `pageError`. A page that DuckDB produced but
OPFS could not persist remains buffered inside the session, so an explicit retry persists that
same page rather than advancing or rereading the cursor. A DuckDB/Arrow cursor error is terminal
for that result and requires rerunning the query. Cancellation does not relabel loaded rows as
complete. New query/open/cancel/dispose paths close the live result session exactly once.

Because the database has one query cursor, starting replacement SQL closes the old cursor before
executing the new statement. If initial replacement execution fails, the prior result window stays
visible. A prior incomplete result is then explicitly stopped (`Run the prior query again to load
more rows`) rather than pretending its disposed cursor can continue.

The controller exposes provenance by global result row. It resolves the owning page through the
query session before reading `_src_file`, `_src_start`, and `_src_end`; grid row numbers and
selection are never window-local outside `ResultGrid` internals.

### Sliding infinite grid

`ResultGrid` receives `window`, `windowStart`, `loadedRows`, `complete`, `loadingMore`, and
callbacks for forward/backward demand. The virtualizer count is `window.numRows`, never the total
or loaded row count. `aria-rowcount` is `-1` while incomplete and the exact total plus header after
EOF.

The virtualizer is attached after `bind:this` resolves by pushing options from an effect keyed on
the scroll element and current window row count. This removes reliance on `initialRect` for mount
timing. A browser regression must demonstrate that physical wheel scrolling changes the rendered
range.

Demand rules:

- Within eight visible rows of the loaded tail, call `onloadmore`; the controller coalesces calls.
- Within eight rows of `windowStart` when prior pages exist, call `onloadprevious`.
- Keep at most `RESULT_WINDOW_ROWS = 16_384` rows in the virtualizer window.
- When rows are removed from the front, subtract their measured/estimated height from
  `scrollTop`; when rows are prepended, add that height. Apply compensation in the same animation
  frame as the window replacement so the first still-visible global row does not move.
- Render global labels (`Row ${windowStart + localIndex + 1}`) and send global indexes to the
  controller.

A terminal sentinel says `End of result · N rows`. An in-progress sentinel uses a spinner and
`Loading more rows`. A stopped sentinel exposes `Retry loading rows`. IntersectionObserver drives
normal prefetch; a scroll-range check is the fallback and the deterministic test seam.

### Workbench, inspector, provenance, and viewers

The heading renders:

- incomplete: `<loadedRows> loaded · more available`;
- complete: `<loadedRows> rows`;
- page failure: the loaded count plus a result-loading diagnostic.

Explorer Browse removes its hard-coded `limit 10000` and quotes table identifiers with the
existing SQL identifier helper pattern.

Inspector receives the selected page/table and local row resolved by the controller. Hex
highlighting continues to use the selected row's absolute provenance. The coverage index is built
over the decoded render window and is invalidated when that window changes; while incomplete, its
empty-byte-click copy says `No loaded result row covers this byte` rather than claiming no result
row exists.

Trusted viewers continue to receive a complete `Table` through `result.completeTable`. At EOF the
controller calls `QuerySession.materialize(64 MiB)`, which returns `null` without decoding all
pages when their recorded IPC sizes exceed that budget. Viewers are enabled only when this table
exists; otherwise the viewer menu explains `Finish and narrow the result to use this viewer.` This
prevents audio playback from silently using a partial result.

## Error handling and lifecycle

- `QUERY_CANCELLED`: close the reader, preserve no new partial result for an initial query, and
  preserve already published rows for cancellation during later demand.
- `RESULT_SPILL_UNSUPPORTED`: preserve loaded rows, stop automatic demand, and offer narrower SQL.
- `RESULT_SPILL_QUOTA_EXCEEDED`: preserve loaded rows, stop automatic demand, and explain how to
  free local storage.
- DuckDB/Arrow cursor error: preserve loaded rows and keep the result stopped until a new query.
  OPFS persistence failures retain the uncommitted page and expose retry without advancing the
  cursor.
- Superseded generations may finish cleanup but may never publish pages or errors.
- `dispose` is idempotent. Reader cancellation precedes OPFS deletion; deletion failure never
  hides the query/cancellation error.

## Privacy and security

- Result pages remain origin-private and session-scoped. No new URLs, requests, runtime-loaded
  code, analytics, fonts, or CDN assets are introduced.
- Arrow decoding keeps the same hostile-result assumptions: values are formatted lazily and never
  converted wholesale into JavaScript objects.
- OPFS filenames are generated integers, not SQL or source-file text. SQL never becomes a path.
- `check:bundle` and the zero-network Playwright test remain release gates. A new lifecycle test
  verifies query-result OPFS directories disappear on replacement, cancellation, disposal, and
  reload sweep.

## Testing and acceptance

### Unit and component tests

- Database query session proves the initial fetch does not exhaust a multi-batch reader, page
  boundaries preserve every value exactly once, EOF produces the exact count, concurrent fetches
  serialize, and cancel/dispose are idempotent.
- Page-store tests cover IPC round-trip, byte-budget LRU eviction, OPFS reload, quota failure,
  unsupported fallback, generation cleanup, and orphan sweep.
- Reducer/controller tests cover loaded-versus-total copy, demand coalescing, stale generations,
  page retry, cleanup on every terminal path, global/local index translation, and retaining the
  previous successful result when initial execution fails.
- Grid component tests cover global row labels, forward/backward demand thresholds, scroll
  compensation, incomplete `aria-rowcount`, exact completed `aria-rowcount`, and mount-time
  virtualizer attachment.
- Viewer and hex tests prove incomplete results are never presented as complete tables and that
  provenance resolves through global indexes.

### Browser acceptance

1. Run `select i from range(300) t(i)`, physically scroll, and assert `Row 300` is reachable while
   the heading says `300 rows`.
2. Run `select i from range(1000000) t(i)`, assert the first heading says
   `1,024 loaded · more available`, continuously demand pages, and assert rows above 932,076 and
   `Row 1000000` are reachable.
3. During the million-row run, assert `.grid-virtual-space` never exceeds
   `RESULT_WINDOW_ROWS * 36` px and decoded result memory remains within the configured budget.
4. Scroll backward across an evicted boundary and verify the exact earlier values return from
   OPFS without a second `connection.send`.
5. Start a replacement query mid-fetch and verify only the replacement publishes; the prior
   result directory is removed.
6. Run the privacy test and assert zero post-readiness network requests.

The full gate is `pnpm -r check`, `pnpm -r test -- --run`,
`pnpm --filter @byteql/web check:bundle`, and `pnpm --filter @byteql/web test:e2e`.

## Rollout

The change lands as one feature slice behind no user-facing flag. The database session and page
store ship first with unit coverage, then controller state, then the sliding grid and browser
acceptance. The old whole-result `query()` path is removed only after viewers, inspector, hex
provenance, saved overview queries, and Explorer Browse consume the paged result contract. No
instrumented `dist-e2e` output is deployable.
