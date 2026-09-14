# Result column sorting design

Date: 2026-09-14

Status: Proposed design; current-result semantics confirmed by the user. Implementation is not authorized by this document.

## 1. Outcome

Click a result column header to reorder **every row from the current query execution**.
The cycle is ascending, descending, then original query order. Clicking a different
column starts ascending. SQL text, query membership, values, and source-byte provenance
remain unchanged. CSV and Parquet downloads follow the committed display order.

This is a result-view operation. For example, sorting `SELECT ... LIMIT 100` sorts those
100 rows. It does not choose a different 100 rows. A `random()` value is evaluated once,
by the original query. An existing SQL `ORDER BY` defines the original order that Clear
sort restores; the UI does not attempt to infer or display that SQL as an active header sort.

## 2. Approaches considered

| Approach | Benefit | Cost / decision |
| --- | --- | --- |
| DuckDB sorts a retained result snapshot | Correct across pages; uses typed SQL ordering; preserves the original execution | Recommended. Needs a separate ordered view, scratch storage, and lifecycle guards. |
| Rewrite or wrap SQL and execute again | Much less result-storage machinery | Changes volatile values, may repeat statements with side effects, and introduces SQL/editor ambiguity. User chose current-result sorting. |
| Sort decoded JavaScript rows | Small initial patch | A window has at most 16,384 rows. Local sorting misrepresents the whole result; collecting everything defeats paging and adds a second comparison implementation. Rejected. |

Do not optimize by switching between these semantics at a size threshold.

## 3. Current implementation facts

Inspected at commit `8f192c4` on 2026-09-14; working tree initially clean.

- `packages/db/src/browser.ts`: `QuerySessionImpl` owns one original cursor, page store,
  serialized fetches, and cancellation. `BrowserDatabase.startQuery()` closes the old
  session. Therefore **do not call startQuery to implement a sort**.
- `packages/db/src/types.ts`: `QuerySession` currently combines read access and cursor demand.
- `packages/db/src/query-pages.ts`: Arrow IPC pages, OPFS persistence, 64 MiB decoded cache
  target and in-memory fallback. A failed page write can retain an exact page for retry.
- `apps/web/src/lib/session/controller.ts`: generation guards, paging, selection, exports;
  `buildResultState()` currently assumes its reader is `activeQuery`.
- `apps/web/src/lib/session/state.ts`: same-generation updates require monotonic row counts.
  There is no order identity yet.
- `ResultGrid.svelte`: header divs, field-name keyed columns, one `.grid-scroll` element,
  demand guards and scroll compensation. Workbench keys it on query generation.
- `result-scroll.ts`: forward demand currently depends on an incomplete cursor. A fully
  stored sorted view needs forward window navigation even though no cursor fetch is needed.
- `packages/db/src/export-parquet.ts`: sequential Arrow pages become privately named Parquet
  shards, then a final file. The final scan currently has no explicit ordering key.
- `BrowserDatabase` already permits `opfs://byteql-exports/` before locking configuration;
  `createExportFiles()` provides UUID ownership, cleanup, and Web Lock aware orphan sweeping.

## 4. Scope and browser support

Ship one-column sorting. No multi-sort, menu of comparison modes, locale chooser, automatic
SQL edits, persistent sort preferences, column resizing, or column reordering in this feature.
New queries, file opens, and table browsing start in original query order.

V1 uses OPFS for temporary snapshot shards and sorted pages. When OPFS is unavailable,
show the reason `Column sorting requires local browser storage (OPFS).` before starting.
Do not add a separate memory sorter. Checking API presence is an availability hint; actual
storage access errors still need a recoverable failure. Normal queries keep their current
in-memory fallback. This browser limitation is an explicit tradeoff to keep one sorting path.

V1 supports a result only when **every field**, including hidden fields, can round-trip
through the snapshot path without loss. Begin with `isSupportedParquetType`, additionally
reject timestamps with a nonempty timezone. This includes signed/unsigned integers,
Float32/Float64, Decimal128, Boolean, Utf8, Binary, DateDay, TimeMicrosecond, and timezone-free
TimestampMicrosecond/TimestampNanosecond, subject to the pinned-build proof gate below.
Reject nested, dictionary, null-only, interval, large/fixed binary, other temporal types,
and other unproven types. Do not cast unsupported values or drop unsupported non-key columns.
Show the first offending field and its 1-based position: `Column sorting is unavailable:
column 3 “details” has unsupported type List. Cast it in SQL and run again.`

This whole-schema restriction is deliberate: full rows travel through DuckDB. A future
key-plus-row-index sorter could widen support without transporting payload columns, but
its random page gathering and Arrow reconstruction are outside this implementation.

Zero- and one-row complete results retain schema headers but have no enabled sort actions.
Original-order restoration remains available for an existing sorted result even when new
sort preparation is unavailable.

## 5. Interaction and accessibility

| Input / state | Behavior |
| --- | --- |
| Click, Enter, or Space on an inactive header | Ascending on that schema field index |
| Activate the ascending header | Descending on that field |
| Activate the descending header | Restore original query order |
| Activate another header | Ascending on the new field |
| Clear sort in Results toolbar | Restore original query order |
| Sorting in progress | Keep old rows and committed indicator; disable sorting, downloads, selection, and grid demand; allow Cancel sort, Run query, and file open |
| Success | Publish new view atomically, clear row and byte selections, reset vertical scroll to zero, retain horizontal scroll and hidden-column visibility |
| Failure / cancellation | Keep prior order, selection, and scroll; show an inline status/error; permit retry when the base result is usable |

The Results toolbar displays `Query order` or `Sorted by velocity ↑`, plus Clear sort when
sorted. Include the schema position for duplicate names. If the active field is hidden,
the toolbar still names it and offers Clear sort. Hiding a field never clears its sort.

Each sortable `role="columnheader"` contains a native button filling the existing header
hit area, with name, type, and a reserved icon slot. Keep the current header geometry and
9rem column floor. Inactive headers show a subtle neutral sort icon; committed order shows
an up/down arrow, independent of color. Use local inline SVG and existing theme tokens.

Only the committed active header has `aria-sort="ascending"` or `"descending"`; other
headers omit it. Button names describe the next action, for example `Sort velocity ascending`
or `Restore query order`. Use a shared description for cycle instructions and unavailable
reasons. Use `aria-disabled` with guarded activation for temporary busy state so keyboard
focus stays on the initiating header. Do not use `aria-pressed` for sorting.

A polite status region announces progress, completion, and cancellation. Real errors use
an alert. While the total is unknown say `Loading remaining rows… 12,000 loaded`; once
complete use `Preparing sort… 12,000 of 50,000 rows`, `Sorting all 50,000 rows…`, then
`Saving sorted rows… 8,192 of 50,000`. Do not invent a percentage for DuckDB's blocking sort.
Keep phase text in a fixed/wrapping toolbar slot measured by the existing panel coordinator.
No new top-level session phase is necessary.

On success focus stays on the initiating header. Clear sort restores focus to the formerly
active header if visible, otherwise the grid. Cancel sort restores focus to its initiating
header. Row keyboard navigation must ignore input while sorting.

## 6. Ordering semantics

- Address fields by original **schema index**, never display index or field name.
- Rename snapshot fields to `c0`, `c1`, etc. Append private `__byteql_sort_ordinal` as Uint64:
  `BigInt(page.startRow) + BigInt(localRow)`. Validate safe integer page offsets before conversion.
- Use `ORDER BY cN ASC|DESC NULLS LAST, __byteql_sort_ordinal ASC`. Direction comes from a
  closed union, N from validated bounds, paths from the owned scratch allocator.
- Equal values, including nulls, keep original query order in both directions. Repeated
  sorts always derive from the original result, never a previously sorted view.
- Use DuckDB's default binary text ordering, numeric comparison for numeric types, and
  DuckDB's ordering for Boolean, binary, temporal, floating special values, and decimals.
  No JavaScript stringification, `Number(bigint)`, `localeCompare`, or hidden type casts.
- Preserve every value, field position/name/type, field/schema metadata, and provenance.
  Restore original Arrow schema metadata only after validating physical type compatibility.
  A type mismatch fails the candidate; relabeling incompatible buffers is prohibited.
- The internal ordinal never appears in the public schema, grid, inspector, or downloads.

DuckDB documents that `ORDER BY` need not be stable, so the ordinal tie-breaker is required.
The explicit null placement also avoids depending on configuration defaults.
Sources: [DuckDB order preservation](https://duckdb.org/docs/lts/sql/dialect/order_preservation),
[ORDER BY](https://duckdb.org/docs/current/sql/query_syntax/orderby).

## 7. Architecture and ownership

```text
Original SQL --one send--> QuerySession (base Arrow pages, retained until query replacement)
                               |
                         drain to EOF once
                               |
                  page-by-page private Parquet shards + original ordinal
                               |
                  separate DuckDB connection: ORDER BY key, ordinal
                               |
                  bounded Arrow conversion -> candidate QueryPageStore
                               |
                   EOF + count/schema checks + first window ready
                               |
                 atomic display-view swap; dispose previous derived view
```

Introduce `QueryResultView`: read-only schema, status, page summaries, readPage, pinPages,
materialize, dispose. `QuerySession extends QueryResultView` adds fetchNext, retryPending,
cancel. The original session is the default display view. A derived view is complete,
immutable, and backed by its own `QueryPageStore`; it owns no live cursor after preparation.

`BrowserDatabase.createSortedView(base, options)` accepts only its current complete base.
It never replaces or disposes that base. It returns an owned complete view and registers
its association with the base. `exportParquet(view, ...)` accepts the active base or an
undisposed derived view registered to that base. A foreign or superseded view is rejected.

The controller retains `activeQuery` as base and adds `activeResultView` for display. It
also owns the pending sort operation and a monotonically increasing request token. Each
published result has `orderRevision`, initially 0 and incremented only on committed order
changes, and `sort: ResultSort | null`. Query generation is unchanged by sorting.
Session state also records `resultIsCurrent`: false when a new query starts or the result
family is closed, true only when a new query result is successfully published. A previous
result left visible after query failure must not expose enabled sorting or download actions.

At most the base, previous display view, and one candidate coexist. Read/encode pages
sequentially. No whole-result JS row arrays or whole-result IPC buffers. Each store retains
the existing 64 MiB decoded-cache target with its existing pinned-page exceptions; temporary
Arrow/IPC batches and the bounded display window add overhead. This is not a promise of
64 MiB total process memory. Native DuckDB sorting may need substantial WASM memory and can
fail. OPFS staging alone does not prove DuckDB external-sort spill works in this build.

Allocate fresh scratch via `createExportFiles()` for each sort, using its already-permitted
private root; do not change its ownership rules or the hardening allowlist. Sorted output
page stores use fresh database-allocated persistence IDs, distinct from all query stores.
Do not retain snapshot shards between sorts in v1. Delete shards and release DuckDB handles
before returning the complete view. Retain the original and committed sorted pages only.

## 8. Transactions, cancellation, and errors

1. Validate eligibility synchronously; mark sort pending before awaiting anything. Capture
   session generation, query generation, order revision, request ID, base and display views.
2. Suspend all demand, including load-window and retry paths. Wait for the existing demand
   promise. In-flight demand is allowed to finish before sort work begins.
3. Exclude active downloads, including `cancelling`. A direct controller call fails with
   `Finish or cancel the download before sorting.` Header actions expose the same reason.
   A new sort releases a terminal retained download artifact before preparation.
4. Drain the original cursor to EOF using existing fetchNext and page-error handling.
   Refresh counts without moving the old display window. Never pretend a partial result is
   globally sorted. Only the first sort can need this drain.
5. Build the candidate using a dedicated connection. Every awaited result is fenced. On
   abort during a DuckDB statement call that connection's cancelSent, join the iterator,
   close the connection, drop registered handles, remove scratch and candidate pages.
6. Validate complete row count equals base count and schema/value representation is supported.
   Read the first display window before committing. Check all captured identities again.
7. In one synchronous turn adopt the candidate, publish the order-change event and clear
   selections. Dispose the old derived view after the swap. Never dispose base on Clear sort.

Cancellation during base draining stops **between page fetches**; do not call base.cancel(),
which would destroy the result. Show `Cancelling sort…` while one pending fetch finishes.
New query/file/disposal instead invalidates the request, aborts work, joins cleanup and
closes the entire prior result family. UI updates from that family are then forbidden.

Sort failures after a successful drain preserve the old order, but its known row count can
increase or become complete. A failure while draining also preserves the existing page
failure rules: quota errors offer Retry loading rows; terminal cursor errors require rerun
to obtain missing rows. Do not advertise the old incomplete result as fully recoverable.

Use explicit sort error codes: `SORT_UNAVAILABLE`, `SORT_UNSUPPORTED_TYPE`,
`SORT_STORAGE_FULL`, `SORT_FAILED`, `SORT_CLEANUP_FAILED`. Abort is not an error alert.
Report cleanup failures separately from comparison/storage failures. Attempt every independent
cleanup even when one fails; preserve the primary error as the cause. Retain failed cleanup
handles for retry on query replacement/disposal; never silently declare resources released.

Clear sort uses the same request fencing, first-window preparation and atomic commit, but
reads the retained base and never starts DuckDB work. If that page read fails, retain the
previous display and report the storage error.

## 9. Grid, inspector, viewer, and export integration

Keep Workbench's existing key on **query generation**, not order revision. Add an explicit
order-revision reset inside ResultGrid: cancel scheduled demand/rebase callbacks, clear
demand guards, reset virtualizer offset/scrollTop, reset previous-window bookkeeping, and
schedule one fresh demand check. Prevent ordinary scroll compensation for the revision change.
Retain scrollLeft, hidden-column state, and mounted components.

Separate **reading another stored window** from **fetching more cursor rows**. At the lower
window edge, if windowStart + window.numRows < loadedRows, demand the next stored window
regardless of complete status. Only request fetchNext when at the loaded tail and incomplete.
At the upper edge retain backward window demand. The tail sentinel must not claim End of
result while later stored rows exist, and its observer must remain active for that case.
Test physical forward scrolling after sorting and after restoring original order, without
using an e2e loadResultWindow shortcut to bypass this boundary.

Key column loops by original field index, including grid cells; duplicate names are valid.
`queryWindowUpdated` must match both generation and order revision. Add a distinct reducer
event for an order commit; it requires the next revision, a complete valid first window,
unchanged schema and row count, and clears selectedRow/byteSelection. Late window reads can
never publish rows from an older order.

A selected row index means a position in the committed display. Clearing it on reorder
prevents wrong-record highlights without adding a row-identity mapping. Coverage indexes,
Values and Bytes continue to use the displayed Arrow window, including `_src_file` and
end-exclusive ranges. Aggregate/non-provenance results remain explicitly unlinked.

Trusted viewers continue to receive the **original complete query table**, in original order,
within the existing materialization budget. Keep this cached per original query; do not
feed a newly sorted grid table to MIDI playback. This leaves user SQL ordering authoritative
for viewers. Inspector's selected values still use the display window.

Exports capture both query generation and order revision plus the display-view object.
Drain only when that view is the incomplete base. CSV reads its pages sequentially. Parquet
must append its own private display ordinal per input page and explicitly ORDER BY that
ordinal in the final COPY, excluding the ordinal from exported columns. Do not assume a
parallel shard scan preserves display order. Keep existing picker activation, cancellation,
column selection, duplicate names, U+FEFF, CSV fallback, and private-file cleanup contracts.

## 10. Proof gates and acceptance

The plan starts with a real pinned DuckDB-WASM browser proof, before controller/UI work:
Arrow pages -> private Parquet shards -> typed ORDER BY -> paged Arrow output under current
hardening, tested for both local mvp and eh bundles. Test precision and schema preservation,
duplicate names, ordinal ties, cancellation, cleanup, denied network/path access, and no
original SQL resend. If this fails, stop at the failing gate; do not replace the design with
query reruns, casts, or whole-result JavaScript sorting.

Required acceptance cases:

- Ascending/descending/original cycle and switching columns; nulls last; stable ties.
- Negative numbers, 2 versus 10, Int64/Uint64 beyond 2^53, Decimal128, temporal values,
  empty/non-ASCII strings, binary, NaN/infinities and signed zero round-trip checks.
- Duplicate names, quotes, SQL-looking aliases, hidden sort key, unsupported non-key field.
- Existing ORDER BY, LIMIT/OFFSET, CTE, UNION, aggregate and volatile results preserve rows.
- Sort while only 1,024 of 20,000 rows are loaded; first value must reflect the entire result.
- One-million-row numeric result sorts and both ends remain reachable with window rows
  <=16,384 and one grid scroller. Record duration, scratch bytes and cache metrics; do not
  invent an unmeasured throughput target or claim arbitrary-size support.
- Cancel/fail during each phase; delayed old reads; rerun/file replacement/disposal; cleanup
  failures; quota/unsupported storage. No stale publish, mixed pages or original cursor resend.
- Sorted CSV and Parquet match displayed order, count, types and provenance across pages.
- Keyboard focus, aria-sort and announcements; light/dark, narrow layout, hidden columns;
  sort while scrolled horizontally; source reveal after selecting a newly sorted row.

Accessibility reference: [WAI sortable header example](https://www.w3.org/WAI/ARIA/apg/patterns/table/examples/sortable-table/).
Use its header-button/aria-sort pattern within the existing interactive grid; do not change
the entire widget to a static table.

No feature code, runtime proof, browser screenshots, performance measurement, touch review,
or screen-reader acceptance was performed during this planning task. Those are execution gates.

## 11. Implementation handoff

Read the companion [implementation plan](../plans/2026-09-14-result-column-sorting.md).
It defines interfaces, ordered tasks, concrete tests and recovery rules. Implement only
after the user approves proceeding with implementation; this spec and plan are review artifacts.
