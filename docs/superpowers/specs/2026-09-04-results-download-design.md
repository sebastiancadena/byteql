# Results download: CSV and Parquet

Date: 2026-09-04

Status: approved by the user on 2026-09-04. CSV and Parquet, with CSV as the default, are
the agreed scope. Implementation and browser feasibility checks have not run.

## Product contract

Download exports the current query result, including rows not yet loaded into the grid.
It preserves the sequence and values produced by that query execution. Editing the SQL
editor after running a query does not change the export. The exporter never reruns SQL.

Export is entirely local. Existing post-readiness network restrictions apply to exports,
including worker creation, encoders, extensions, and error handling.

The first release downloads one CSV or one Parquet file. Table bundles, JSON, Excel files,
selected-row exports, saved export presets, and evidence archives are outside this design.

## Interaction

Add Download beside the result count. It opens a small options popover containing:

- Format: CSV (default) or Parquet.
- Include byte provenance: enabled by default, with explanatory text that these columns
  identify the source file and byte range when present in the result.
- A Download button that starts the browser save action.

Use the actual result schema, in column order. Include all columns by default, including
hidden ones: hiding a column in the grid must not silently remove query data. Disabling
provenance removes fields using the grid's existing hidden-column predicate. Do not inject
provenance into results that do not contain it, such as aggregates. If exclusion leaves
zero columns, disable Download with an explanation. Preserve duplicate headers in CSV;
reject duplicate names for Parquet with a request to alias them in SQL, without renaming.

Use a sanitized source stem plus `-results` and the selected extension; use
`byteql-results` for multi-file results. Never derive a path from SQL or column names.

Download is enabled for successful results, including zero rows and incomplete results
with more rows available. An unresolved result-page error disables it and points to the
existing retry or rerun action. Export failures appear beside the download controls and
leave the result usable.

During export, show a live status and Cancel. Use phases such as Loading remaining rows,
Preparing file, and Saving file. Show row counts while the total is unknown; do not invent
a percentage. After EOF, use exact totals only for phases whose progress is measurable.
Success means the destination has closed successfully or the browser download was handed
off; the latter must not claim that the file has finished saving to disk.

## Result ownership and concurrency

The existing `QuerySession` provides `pages`, `readPage`, and serialized `fetchNext`.
`QueryPageStore` retains Arrow pages with a bounded decoded cache and OPFS persistence.
The grid window and `completeTable` are not export sources.

The session controller owns a single export operation tied to the result generation:

1. Capture the result generation, schema, options, and proposed filename on Download.
2. Acquire the destination from the user gesture. Recheck the generation after the picker.
3. Pause automatic grid fetches and wait for any current result demand to settle.
4. Finish the existing cursor into the page store, publishing updated result counts while
   keeping the grid's current window anchored. Check cancellation between fetches.
5. Read stored pages sequentially, encode, and write with backpressure.
6. Close the destination only after encoder finalization and a final generation check.
7. Clean up export resources and restore grid demand in all terminal states.

Finishing the cursor first lets Parquet use the existing database connection after the
reader is exhausted. It also gives both formats one immutable source and one failure
contract. The cost is that downloading still requires enough local space to retain the
complete result; exporting is not a workaround for result-store quota exhaustion.

Cancel stops export work. During row fetching, allow the current page fetch to settle,
then stop; do not call `QuerySession.cancel`, which closes the result store. Show
Cancelling while this is pending. Loaded pages remain available. During database encoding,
cancel only the encoder statement, after the original cursor is exhausted.

Running another query, replacing input, or disposing the app aborts and joins export
cleanup before disposing its result or reusing the database connection. Editing SQL,
scrolling already loaded rows, and inspecting bytes remain available. No export task may
close a destination after its result has been superseded.

## Encoding

### CSV

Encode from Arrow pages in a worker using transferred IPC copies; never detach buffers
owned by the page store. Initialize required local worker assets before app readiness.
Use a bounded request/acknowledgment protocol and await destination writes before sending
the next batch. Split encoded output into bounded chunks, including unusually large cells.

CSV is UTF-8 with a BOM, a header, comma separators, CRLF record separators, and doubled
quotes inside quoted fields. Quote text fields, including empty strings. Encode null as
an unquoted empty field. This distinguishes null and empty text at the file level, though
some spreadsheet importers collapse them.

Integers and decimals use exact base-10 text without a JavaScript Number conversion.
Booleans use `true` and `false`. Binary values use lowercase `0x` hexadecimal. Timestamp
formatting preserves the Arrow unit's precision; timezone-free timestamps get no invented
timezone, while timezone-aware timestamps normalize to UTC. Floating special values use
`NaN`, `Infinity`, and `-Infinity`.

Do not serialize arbitrary Arrow values using generic `String(value)` or `toJSON()`.
Support scalar numeric, boolean, text, binary, date, time, and timestamp types explicitly,
including dictionary-encoded supported scalars. Reject unsupported types during schema
preflight with a column-specific message; advise an explicit SQL cast.

CSV preserves text verbatim, including strings beginning with spreadsheet formula markers.
Provide brief format help: spreadsheet software may interpret these cells as formulas;
import them as text. Do not silently prefix apostrophes or claim CSV preserves spreadsheet
types. A separate spreadsheet-sanitized mode is deferred.

Zero rows produce a header-only CSV. Validate names and values with an independent CSV
parser rather than testing only against the encoder's own helpers.

### Parquet

Reuse the already loaded DuckDB Parquet extension. Pass Arrow IPC into the export writer;
avoid JavaScript row objects so int64, uint64, decimals, binary, nulls, and timestamp
precision survive. Use Snappy compression and one output file.

The preferred bounded staging route is:

1. After the original cursor reaches EOF, import one stored Arrow page into a temporary
   table on an export connection to the existing DuckDB instance.
2. Write that page to an export-owned Parquet shard and drop its temporary table.
3. Scan an explicit ordered shard list and write one final Parquet file.
4. Release DuckDB file handles before opening the final OPFS file for browser delivery.

Use generated internal column names during staging, with an explicit projection restoring
original output names. This avoids confusing user aliases with internal names. Preserve
the captured page and row sequence; validate the ordered scan and COPY behavior in the
pinned build before relying on it. A concatenation of standalone Parquet files is invalid.

Add a dedicated `opfs://byteql-exports/` directory to the initialization allowlist before
configuration locking. Keep external access and dynamic extension loading disabled. Use
per-tab, per-export ownership tokens; cleanup must not reuse the ingest spill sweeper,
which can delete directories belonging to other owners.

This staging route is a design recommendation, not yet proven against the pinned WASM
build. The implementation begins with the compatibility gate below. If it fails, revise
the writer design before building the UI around it; do not substitute SQL re-execution,
lossy conversion, a whole-result JavaScript array, or multiple output files.

## File delivery and resource bounds

When available, invoke `showSaveFilePicker` directly from the Download gesture, before
awaiting result loading. Use `createWritable` and commit only at successful completion.
Abort the writable on cancellation or failure. A newly selected path may still leave an
empty entry after cancellation; do not promise its removal.

When the picker is unavailable but OPFS works, prepare a local file and hand its File/Blob
URL to the browser download flow. Hold the file and URL for a tested delivery lifetime,
then revoke and remove only that export's temporary artifacts. A second explicit Save
button is acceptable if browser activation rules require it after preparation.

Without OPFS, support CSV through a byte-counted Blob fallback capped at 64 MiB of encoded
output. Stop before exceeding the cap and explain that a smaller query is needed. Parquet
requires OPFS in this release; disable its choice with an explanation if unavailable.
Never label an incomplete file as a successful export.

Keep the existing result cache bound. Additional decoded input is limited to one page
and a bounded encoder queue; do not retain all encoded chunks in the streaming routes.
DuckDB's staging/COPY memory and browser delivery behavior need measurement, not assumptions.
Disk use can include result IPC, temporary shards, and the final output simultaneously.
Quota failure aborts the output and cleans up export artifacts while preserving results.

## Implementation seams

- `packages/db/src/types.ts`: export operation contract, progress, cancellation, and
  session identity; retain the existing page API as the source of truth.
- New focused modules under `packages/db/src/`: Parquet staging and export file lifecycle.
  `browser.ts` supplies the database connection and initialization allowlist.
- `apps/web/src/lib/session/controller.ts`: result ownership, export lifecycle, coordinated
  demand, and abort-before-replacement semantics.
- New modules under `apps/web/src/lib/export/` and a CSV worker: schema validation, CSV
  encoding, destination adapters, and bounded transport.
- A dedicated download component mounted in `Workbench.svelte`: accessible options,
  progress, cancellation, and errors. Keep serialization out of `ResultGrid.svelte`.
- `docs/privacy.md`: describe exports and their post-readiness acceptance coverage.

## Compatibility gate and acceptance

Before implementing the production writer, test the pinned DuckDB-WASM build under the
real hardened browser configuration. Prove Arrow import, page-to-shard output, ordered
consolidation, zero-row schema output, exact supported types, release/read of OPFS output,
and statement cancellation without losing the completed result. Exercise both shipped
WASM variants or explicitly record any unsupported variant.

Use at least a million rows, a result larger than the 64 MiB cache, and a deliberately
shuffled sequence spanning many pages. Measure peak extra memory and temporary disk use.
The ordered scan must reproduce the entire sequence. If memory grows with total result
bytes or ordering is unstable, the proposed writer has failed its design gate.

Meaningful automated coverage includes:

- CSV escaping, Unicode, null versus empty, binary, exact large integers/decimals, temporal
  precision, unsupported types, duplicate names, and zero rows.
- Independent Parquet readback of schema, values, row count, and sequence across pages.
- A volatile query whose stored values match the export and whose cursor send count stays one.
- Download before scrolling, after scrolling, and after editing but not executing SQL.
- Provenance inclusion/exclusion and a result consisting only of provenance columns.
- Cancel during fetch, encoding, and saving; picker dismissal; quota and write failures;
  query/input replacement; repeated exports; and cleanup ownership across tabs.
- Browser downloads and direct save behavior, including fallback limits and zero network
  request events after readiness during both export formats.

Run the affected unit suites, workspace checks, browser export/privacy/result-scrolling
acceptance, production build, and bundle audit. No deployment is part of this feature task.

## Sources and limits of evidence

The current repository establishes the page-session API, 64 MiB result cache, local
Parquet extension load, and locked allowlist. The documents below establish relevant API
contracts; they do not prove the proposed combination works in ByteQL's pinned build.

- [DuckDB-WASM export example](https://duckdb.org/docs/current/clients/wasm/query):
  demonstrates Parquet COPY and whole-file buffer download. The buffer example alone
  does not establish bounded memory for large exports.
- [DuckDB order preservation](https://duckdb.org/docs/current/sql/dialect/order_preservation):
  informs the ordered-shard approach; pinned-build sequence verification remains required.
- [Save picker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker):
  requires a user interaction and has limited browser availability.
- [Writable file streams](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable):
  changes are reflected in the destination after the writable closes.
