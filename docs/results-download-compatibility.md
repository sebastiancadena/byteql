# Results download compatibility experiment

Date: 2026-09-05. Task 1 of the approved 2026-09-04 results-download design.

## Conclusion

The proposed Arrow-page → OPFS Parquet shards → one Snappy Parquet file route is
viable in both installed DuckDB WASM variants at the tested sizes. Exact values,
captured row sequence, empty schema, browser File access after handle release,
statement cancellation, and locked-down filesystem access passed. No writer-design
revision is required by these measurements. This is a compatibility gate, not
production export implementation or proof of a bound for arbitrary schemas/files.

The initial six scale runs covered 250,000, 1,000,000, and 2,000,000 rows per variant.
Four follow-up runs repeated the endpoints after correcting the probe's readback
mode and strengthening the denied-path check. These four tests all passed in 1.3 min.
The current million-row gates were then rerun with full empty-schema descriptor
comparison and unconditional monitoring cleanup: both passed in 36.2 s.

## Runtime and isolation

Installed versions: `@duckdb/duckdb-wasm` 1.33.1-dev57.0, its local signed Parquet
extension v1.5.4, Arrow 21.1.0 with the existing Arrow 17.0.0 IPC bridge, and
Playwright 1.61.1 (Chromium build 1228). Both `mvp` and `eh` are explicitly selected.

Each invocation owns a new database, worker, UUID export directory, and UUID denied-path
sentinel directory. It never uses the app database or calls `dropFiles()` on it.
Temporary paths and SQL identifiers are generated internally; strings use doubled
SQL apostrophes. Every OPFS Parquet filename is registered before COPY. Handles are
released before browser `getFile()` and only the generated owner directories are removed.

The local extension loads before readiness, followed by allowed directories, external
access off, extension installation/loading/community extensions off, and configuration
locking. The experiment's readiness is separate from app readiness because it starts
its own database after the MIDI sample opens. Browser network capture includes worker
requests: every completed scale report has `networkAfterReady: []`. The production-readiness
privacy test separately covers the visible export flows.

## Sequence and actual types

Input pages contain 8,192 rows at most: shuffled integer keys and distinct 128-byte text
payloads. The exact Arrow IPC pages are captured in owned OPFS files. Readback compares
every output key and payload with those captured pages, loading one expected page at a
time. No sorted-key proxy or whole-result JavaScript array is used.

IPC totals are 35,019,816; 140,078,696; and 280,156,776 bytes respectively. The million-row
case exceeds the 64 MiB result-cache limit. Both variants matched all output rows at all
three sizes, with zero reported sequence or non-key mismatches.

A separate fixture is generated as a native DuckDB result, serialized using Arrow 17,
decoded/re-encoded using Arrow 21 IPC, imported, written to Parquet, and read with the
Parquet reader. `DESCRIBE` checks actual database types; bidirectional `EXCEPT ALL`
checks exact typed values, avoiding lossy timestamp `.get()` Number conversions.

The fixture preserves `UBIGINT` max, `BIGINT` min, `DECIMAL(38,9)` value
`12345678901234567890.123456789`, microsecond and nanosecond timestamps with nonzero
sub-millisecond digits, binary `00ff`, empty binary, null text, empty text, and nullable
numeric/temporal values. Readback types are `UBIGINT`, `BIGINT`, `DECIMAL(38,9)`,
`TIMESTAMP`, `TIMESTAMP_NS`, `BLOB`, `VARCHAR`, `VARCHAR`. A zero-row imported Arrow
table produces a readable zero-row Parquet file with the same field count, names,
order, types, and nullability. Descriptor mismatches are recorded in diagnostics.

## Resource measurements

Figures below are bytes. `COPY WASM` is the observed linear-memory allocator high-water
mark at final COPY, not live DuckDB buffer use. Main JS is sampled separately in the
page; worker JS is sampled through CDP `Runtime.getHeapUsage` every 100 ms. Worker
backing storage is an additional CDP measurement, not a second name for WASM memory.
Sampling can miss short-lived JS peaks; neither heap number claims exact live retention.

| Variant |      Rows |   COPY WASM | Main JS peak | Worker JS peak | Temporary bytes |
| ------- | --------: | ----------: | -----------: | -------------: | --------------: |
| MVP     |   250,000 |  87,097,344 |   42,474,462 |     53,567,432 |      74,256,168 |
| MVP     | 1,000,000 |  87,097,344 |   68,788,339 |     64,138,188 |     295,378,659 |
| MVP     | 2,000,000 |  87,097,344 |   68,900,981 |     54,525,144 |     590,039,309 |
| EH      |   250,000 |  87,097,344 |   42,525,998 |     52,886,680 |      74,256,168 |
| EH      | 1,000,000 |  87,097,344 |   68,808,845 |     54,549,804 |     295,378,659 |
| EH      | 2,000,000 | 104,529,920 |   51,574,005 |     62,458,608 |     590,224,328 |

Endpoint figures are from the follow-up runs; million-row figures are from the current
post-review rerun. Temporary-size sampling counts IPC + shards + final output,
type/empty fixtures, and interrupted COPY residue before cleanup. These are real file
sizes, not row-count estimates. The denied-path sentinel
is outside the export directory and is not included in the table.

Page staging finishes at 20,185,088 allocated WASM bytes at every size. With an 8x input
increase, final COPY workspace remains 87 MB for MVP and grows from 87 MB to 105 MB for
EH, rather than following output bytes. Main and worker JS measurements likewise do not
grow with retained result payloads. Worker backing-storage high-water readings grow from
about 45–46 MB to 95–99 MB across the endpoint runs; they include transient array buffers
and do not establish a live-buffer limit. The probe holds one decoded input page, writes
with backpressure, and retains only shard paths across pages.

The original validation used `send(sql)` with the installed default
`allowStreamResult=false`. That made the validation SELECT materialize the readback:
overall allocated WASM reached 216,858,624 bytes at 1m rows and 374,865,920 at 2m even
though final COPY had already finished at 87–105 MB. Changing only validation to
`send(sql, true)` kept WASM unchanged through readback, typed fixtures, cancellation,
and completion at both endpoints. This was a probe defect, not writer growth.

## Cancellation and denied writes

The cancellation test starts a COPY over the saved result crossed with `range(1000)`,
waits 20 ms, then calls `cancelSent()`. Each run reports cancellation accepted and an
actual `query was canceled` failure; a subsequent count of the completed result still
matches the requested rows. Cancellation does not close the saved input or app result.

EH returns the expected filesystem permission error outside its allowlist. MVP instead
reports `ReferenceError: _setThrew is not defined`, an error-reporting limitation of this
pinned variant. Testing a permission-message regex initially failed all three MVP runs.
The stronger follow-up check first writes a sentinel successfully before locking, then
attempts to overwrite the same registered path after locking. Both variants reject the
write, leave every sentinel byte unchanged, still report external access disabled and
configuration locked, and execute an ordinary SELECT successfully. MVP is fail-closed and
usable despite the malformed diagnostic; production error presentation should handle it.

## Commands and artifacts

- Red: `pnpm --filter @byteql/web test:e2e -- results-export-probe.spec.ts`
  failed both variants with `probeResultsExport is not a function` before implementation.
- Initial functional gate: the same command passed both million-row cases in 34.1 s.
- Six-scale run: all data/type/order/cancel/network checks passed; the permission-message
  regex produced three MVP failures, while three EH cases passed.
- Follow-up: `pnpm --filter @byteql/web test:e2e -- results-export-probe.spec.ts --grep
'250000 rows|2000000 rows' --output test-results-export-validation` passed 4/4.
- Current million-row rerun: `pnpm --filter @byteql/web test:e2e --
results-export-probe.spec.ts --grep '1000000 rows' --output
test-results/export-million-current` passed 2/2 (36.2 s).
- `pnpm --filter @byteql/db build`, DB typecheck, and web typecheck passed; web typecheck
  reports zero errors and zero warnings. Existing large-chunk build warnings are baseline.
- Targeted ESLint, Prettier, and `git diff --check` passed. Markdown has only the
  repository's accepted MD013 line-length warnings (prose stays under 100 characters).
- `pnpm --filter @byteql/web test:e2e -- privacy.spec.ts --output
test-results-export-privacy` passed the unchanged production-readiness privacy test
  (1/1, 5.8 s). Its artifacts were moved under `apps/web/test-results/export-privacy/`.

The historical commands above produced intermediate ignored artifacts whose measurements this
document preserves. The final selected Playwright run replaced that output directory with fresh
artifacts under `apps/web/test-results/results-export-probe-Parquet-export-gate-<variant>-<rows>-
rows-chromium/`.

## Production browser delivery acceptance (2026-09-07)

The production controller, CSV worker, Parquet writer, fallback delivery, and direct writable path
were exercised through the visible Chromium UI. The initial, pre-round-one focused suite passed
eight tests in 33.7 seconds; this historical count predates the amended lifecycle matrix.
Downloaded bytes were saved from Playwright's actual browser download event and read by an
independent DuckDB-WASM instance with external access disabled and configuration locked.

- A CSV export started when only 1,024 of 20,000 volatile rows were visible. All 20,000 random
  values matched the original stored pages and the query cursor's send count stayed one.
- Explicit CSV readback types plus `nullstr = ''` and `allow_quoted_nulls = false` distinguished
  null from quoted empty text and preserved commas, quotes, embedded newlines, Unicode, and a
  formula-leading string.
- A 12,000-row Parquet export preserved `INTEGER`, `BIGINT`, and `VARCHAR` schema, row order, and
  values across stored pages after the grid was scrolled and the SQL editor was changed without
  executing the edit. CSV has the same scrolled/edited-result coverage through the direct path.
- Raw header-only CSV bytes contained the UTF-8 BOM followed by the exact quoted CRLF header and no
  rows. The stored zero-result Arrow schema was asserted independently before CSV readback used
  explicit corresponding types; Parquet readback preserved its schema directly and contained zero
  rows. Provenance-only CSV had its exact raw header. Both stored-result schemas and typed readbacks
  reported two unsigned 64-bit fields, and both formats preserved all three stored values in order.
  Excluding hidden/provenance columns correctly disabled the otherwise columnless export.
- CSV and Parquet each ran the direct-writer lifecycle independently. Query replacement, injected
  `QuotaExceededError`, and explicit Cancel aborted and removed their artifacts, while the result
  remained usable. Retry and repeat each succeeded; per format, five distinct picked paths produced
  exactly two closes and three aborts, with failed/cancelled paths unreadable.
- Two tabs retained distinct fallback artifacts. Dismissing one removed only its file; the second
  stayed downloadable, and its final dismissal left no temporary export files.
- The post-readiness request listener covered CSV, Parquet, fallback saving, a write error, and a
  repeated export and observed an empty request list.

That empty request list applies to the production-visible export flow. The instrumented artifact
reader is excluded from the production bundle and from this listener assertion. It creates an
independent test DuckDB/worker after readiness and can request same-origin bundled DuckDB and
Parquet-extension assets before hardening its own database and reading the locally captured file;
this is local readback, but it is not a zero-request-event operation.

The direct-save acceptance substitutes `showSaveFilePicker` with a test picker that returns a real
OPFS `FileSystemFileHandle`; production writes through and closes the actual writable-file-stream
interface. This proves the direct stream route without automating operating-system chrome. Native
save-dialog presentation, permissions, filename display, and user cancellation still require a
manual check in each supported browser/OS combination.

The initial, pre-round-one 22-test selected browser run passed in 4.2 minutes. Its scale artifacts use
34,013,144, 136,052,152, and 272,103,880 bytes of Arrow IPC at 250,000, 1,000,000, and 2,000,000
rows. Both variants again compared every row, preserved order and exact types, cleaned temporary
files, accepted statement cancellation without losing the result, rejected outside-allowlist
writes, and recorded empty post-readiness request lists.

The current `results-download.spec.ts` contains nine cases after the lifecycle matrix amendment.
Round-one verification reran the four amended CSV/Parquet zero-row and lifecycle cases: all four
passed in 18.2 seconds (`test-results/task-8-round1-amended-verified`). The expanded privacy case
also passed in 7.1 seconds (`test-results/task-8-round1-privacy`). The historical eight-test and
22-test totals above do not represent a run of all nine current download cases.

Final-review CSV repair verification passed four selected cases in 19.9 seconds
(`test-results/final-fix-csv-privacy-green`): volatile fallback CSV, direct CSV after scrolling and
editing SQL, CSV special values, and the expanded privacy case. The special-values case also checks
the complete literal downloaded bytes for leading and BOM-only U+FEFF cells, independently of the
file-level BOM. That byte oracle avoids the independent reader's Arrow `.get()` text decoding,
which strips leading U+FEFF. Parquet and scale probes were not rerun for this CSV-only repair.

| Variant |      Rows |   COPY WASM | Main JS peak | Worker JS peak | Worker backing | Temporary bytes |
| ------- | --------: | ----------: | -----------: | -------------: | -------------: | --------------: |
| MVP     |   250,000 |  87,097,344 |   65,511,545 |     53,861,328 |     43,955,727 |      73,063,271 |
| MVP     | 1,000,000 |  87,097,344 |   45,529,090 |     53,526,516 |     99,111,207 |     291,165,890 |
| MVP     | 2,000,000 |  87,097,344 |   30,668,261 |     54,018,460 |    100,225,767 |     582,170,226 |
| EH      |   250,000 | 104,529,920 |   51,112,416 |     56,883,420 |     46,719,431 |      73,248,290 |
| EH      | 1,000,000 |  87,097,344 |   46,753,835 |     55,462,916 |    114,138,661 |     291,165,890 |
| EH      | 2,000,000 | 104,529,920 |   45,018,287 |     53,530,500 |    118,590,689 |     581,985,207 |

These are observed high-water measurements, not universal limits for arbitrary schemas or devices.
`COPY WASM` is the final-copy sample; worker backing storage includes transient array buffers and is
not a live-heap bound. The production bundle audit passed nine assets, kept its largest JavaScript
chunk under 5 MiB, and found no instrumented probe/report API or test sentinel.
