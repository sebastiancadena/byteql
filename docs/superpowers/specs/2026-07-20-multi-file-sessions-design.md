# Multi-File Sessions — Design

Date: 2026-07-20
Status: Approved

## Problem

ByteQL sessions are strictly single-file: the UI reads `files?.[0]`, `SessionController.open`
replaces the whole session, and byte provenance is a bare absolute offset into *the* file.
Real analysis often needs several files of the same format queried as one dataset — e.g. five
pcaps captured from different vantage points during one incident, or a capture-rotation
window. Multi-file sessions were an explicit non-goal of the Phase 1 scale/intake slice; this
design lifts that restriction.

## Requirements (from brainstorm)

- **Same-format batch**: N files of one format ingested as one dataset. Mixed formats are out
  of scope (a mismatched file is skipped, not supported side by side).
- **Batch open only**: files are picked/dropped in one gesture and ingested as one atomic
  open, replacing any prior session. No incremental "add file to live session".
- **Scale target**: 2–10 files. No directory ingestion, no parallel parse workers.
- **Per-file provenance**: provenance becomes (file, byte range). The hex pane shows one file
  at a time and auto-switches to the selected row's source file.
- **Skip and report**: a file that fails (wrong format, truncated, parse error) is skipped and
  reported; the session opens with the files that parsed. If every file fails, the open fails.

## Approach

**App-level composition.** `@byteql/core` stays strictly single-file — its provenance and
stream-rebase invariants are untouched. The web app's session controller loops the batch
sequentially through the existing single parse worker, and the ingestion path stamps file
identity at the DB append boundary.

Alternatives considered:

- *Core-aware multi-file* (engine stamps a file column, parser fed N sources): the only
  approach that could ever reassemble a TCP stream spanning rotated captures, but the
  deepest change — file identity would have to thread through the stream assembler and the
  absolute-offset rebase machinery. Deferred; this design does not preclude it (the column,
  catalog, and UI contracts would be identical).
- *Per-file tables + `UNION ALL` views* (`packets__2` etc.): rejected — explorer/table
  explosion, per-table spill bookkeeping multiplied by N, provenance resolution through
  views. Only wins if files need independent lifecycles, which batch-only excludes.

Known trade-off of the chosen approach: **streams reassemble per file only.** A TCP stream
crossing a rotation boundary appears as two streams — the same result as opening each capture
separately in Wireshark. Users who need cross-rotation reassembly can `mergecap` first.

## Data model & SQL surface

### `_src_file` reserved column

Every projected table gains a third reserved provenance column, `_src_file VARCHAR`,
alongside `_src_start`/`_src_end`. Its value is the file's **display name**: the basename,
deduplicated within the batch by suffixing (`capture.pcap`, `capture (2).pcap`). A name
rather than an integer id because analysts filter/group by it directly
(`GROUP BY _src_file`) without a join; at 2–10 files DuckDB dictionary-encodes it.

`_src_file` is added to the reserved-output-names validation in
`packages/core/src/projection/project.ts` (`reservedOutputNames`) so packs cannot collide
with it. That validation change is the only core change in this design.

### `_files` catalog table

A session-scoped table listing batch composition:

| column          | type     | notes                                   |
| --------------- | -------- | --------------------------------------- |
| `file`          | VARCHAR  | deduped display name (unique)           |
| `original_name` | VARCHAR  | basename as given                       |
| `size`          | UBIGINT  | bytes                                   |
| `ingest_order`  | INTEGER  | 0-based order the user supplied         |
| `status`        | VARCHAR  | `ok` \| `skipped`                       |
| `error`         | VARCHAR  | NULL when `ok`; reason when `skipped`   |

It appears in the explorer like any other table and records skipped files queryably (in
addition to the issues panel).

### N=1 uniformity

A single-file session is simply the N=1 case: `_src_file` is present, `_files` has one row.
No "multi-file mode" branches anywhere in the query or provenance path; saved queries are
portable between single- and multi-file sessions. Existing single-file goldens/tests change
once to include the new column and table — values otherwise identical (that *is* the
regression bar).

### Stamping point

The projection engine never sees `_src_file`. The web app's ingestion path (parse-worker
client → `database.append`) extends each table's schema with `_src_file` and stamps the
current file's display name on every appended batch. One choke point; the engine's only
involvement is the reserved-name validation noted above.

## Ingest flow & session lifecycle

### Entry points

- `<input type="file">` in `EmptyState`/`Workbench` gains `multiple`; drop handlers take all
  of `dataTransfer.files` instead of `files[0]`.
- Controller API: `openFiles(files: File[])`. `openFile(file)` remains as the N=1 wrapper.
  `openSample()` is unchanged (N=1).

### Atomicity & generations

The whole batch is one atomic open: one `sessionGeneration` bump, one replacement of any
prior session. Cancel/replace semantics are unchanged — `cancel()` or a new open abandons the
entire batch.

### Batch format election

The first file whose head bytes sniff to a known pack elects the batch's format. Each later
file is sniffed and checked against it; a file that sniffs to a different pack (or none) is
skipped with a "format mismatch — batch is <format>" issue. Files are processed in the order
supplied.

### Sequential per-file pipeline

The controller loops files through the existing single parse worker: normalize → parse →
project per file. Staging tables are created once from the elected pack's schema (plus
`_src_file`) on the first successful file, appended to across all files, and finalized once
after the last file. OPFS spill tiering is untouched (session-scoped, swept on
replace/dispose/startup).

### Progress

`SessionState.source` becomes `{ files: {name, size}[], totalSize }`. Progress events carry
`fileIndex`/`fileCount`; `bytesIngested` accumulates over `totalSize` so the progress bar is
monotonic across the batch. Status bar example: `parsing capture3.pcap (3/5) — 62%`.

### Failure handling

- **Sniff mismatch** → skip file, record issue + `_files` row (`skipped`, reason).
- **Mid-parse hard failure** (truncated mid-stream, worker error) → remove that file's
  partial rows with `DELETE FROM <staging> WHERE _src_file = <name>` (works on both memory
  and spill tiers), record `skipped` + error, continue with the next file. The surviving
  dataset always contains whole files only.
- **Every file fails** → the open fails as a whole with the collected errors.
- File names flow into SQL literals (cleanup DELETE, hex filter). Every such literal goes
  through one escaping helper (or a bound parameter) — never ad-hoc concatenation.

### Blob retention

`retainedBlob` becomes a map keyed by display name. `getSourceBlob()` becomes
`getSourceBlob(file: string): Blob | null`.

## Provenance, hex pane & viewers

### File-qualified byte selection

`byteSelection` changes from `{start, end}` to `{file, start, end}`; `selectByteRange`
likewise. A selection belongs to exactly one file; there is no cross-file byte range.

### Hex pane

The pane shows one file at a time. New UI state holds the pane's current file (default: first
successfully ingested file). The pane header gains a compact file switcher (dropdown —
sufficient at 2–10 files). Manually switching files clears any byte selection.

### Grid row → hex (auto-switch)

`provenanceOfRow` (`apps/web/src/lib/hex/coverage.ts`) additionally reads `_src_file`.
Selecting a result row switches the hex pane to that file (blob via `getSourceBlob(file)`),
then scrolls/highlights `_src_start.._src_end` under the existing slice-3 highlight contract.
A result set lacking the `_src_file` column (e.g. an aggregate that dropped it) is the
existing `no-provenance` case — uniformly, including at N=1.

### Hex → grid (byte filter)

The filter SQL (`apps/web/src/lib/hex/filter-sql.ts`) gains a file predicate:

```sql
where _src_file = '<escaped>' and _src_start < <end> and _src_end > <start>
```

so "which rows touch these bytes" is scoped to the file being viewed.

### Viewers

The viewer path (`ViewerMenu` → e.g. `AudioViewer`) keys off the selected row's provenance
file, same as the hex pane: whatever file the provenance points at is what the viewer
plays/renders.

### Explorer & status bar

`_files` lists in the explorer like any table. The status bar shows the batch summary
(`5 files · 2.3 GB`, plus skipped count when nonzero).

## Testing

- **Unit**: display-name dedup; format election (first known pack wins; mismatch skips);
  filter-SQL file predicate + escaping (filename containing `'`); `provenanceOfRow` with and
  without `_src_file`; reducer events for batch progress.
- **Controller** (existing `controller.test.ts` harness): batch happy path (3 files →
  unioned tables + `_files` rows); mid-file failure → staged rows removed, ingest continues;
  all-fail → open rejects; cancel mid-batch; a second `openFiles` replacing an in-flight
  batch.
- **DB**: schema extension with `_src_file`; appends from multiple files into one staging
  table across memory/spill tiers; DELETE-by-file cleanup on both tiers.
- **Components**: multi-select intake in `EmptyState`/`Workbench`; hex pane file switcher;
  auto-switch on row selection; selection cleared on manual switch.
- **Regression bar**: single-file goldens gain `_src_file` + `_files`; all other values
  identical to today's output.
- **Edge cases**: duplicate basenames; the same file picked twice (legal, deduped); 0-byte
  file in a batch.

## Non-goals

- Incremental add/remove of files in a live session (data model doesn't preclude it).
- Mixed-format sessions.
- Directory ingestion; parallel parse workers; >10-file ergonomics.
- Cross-file stream reassembly (see trade-off above; would require core-aware multi-file).
- Persistent/re-openable sessions (unchanged from scale/intake non-goals).
