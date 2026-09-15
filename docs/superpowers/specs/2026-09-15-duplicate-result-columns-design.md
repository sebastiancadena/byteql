# Duplicate result-column correctness

Date: 2026-09-15

Status: Design and implementation handoff for review; implementation has not started.

## Purpose and accepted behavior

Make valid SQL with repeated output labels usable throughout the current-result workflow:

```sql
select 10 as dup, 'ten' as dup;
```

The user selected this task from `ROADMAP.md` and accepted:

- Preserve the SQL labels exactly in the grid and Inspector: `dup`, `dup`.
- Identify result columns by position, preserving each column's type and values.
- Preserve repeated headers in CSV.
- Give Parquet fields unique export-only names and show the mapping before download.
  For example, `dup`, `dup` exports as `dup`, `dup_2`.

This document specifies the supporting architecture. It is not evidence that the failure has
been fixed or that browser acceptance has passed.

## Current evidence

The inspected checkout starts at `6228b19`. The compatibility report records an Arrow 17 to
Arrow 21 conversion failure for differently typed duplicate labels. Local source inspection
confirms that both batch reconstruction and subsequent IPC storage need attention:

- `packages/db/src/arrow-bridge.ts` writes an Arrow 17 table to IPC and reads it as Arrow 21.
- Arrow's `RecordBatch` construction calls `Schema.assign`, which matches fields by name.
- `browser.ts` slices incoming DuckDB batches before converting them.
- `query-pages.ts` serializes pages to IPC, decodes evicted pages, and concatenates tables.
- `result-snapshot.ts` already stages by position, but restores the result schema afterward.
- `Inspector.svelte` keys three field loops by name; grid cells already read by position.
- `options.ts` explicitly rejects case-insensitive duplicate names for Parquet export.
- Provenance and audio consumers use name-based lookup and need ambiguity handling.

No runtime probe or test suite was run while writing this design. The first execution task
must reproduce the defect and establish the proposed representation in both pinned bundles.

## Approach

Three approaches were considered:

1. **Unique Arrow names plus original-label metadata — selected.** One representation survives
   normal Arrow operations; callers use a small shared module for display and label lookup.
2. Patch or override Arrow's duplicate-name handling. This couples ByteQL to two versions'
   internal reconstruction behavior and requires maintaining that patch across every IPC path.
3. Change the user's SQL aliases. This changes result labels and can require another execution;
   it does not meet the accepted behavior.

Use unique physical names for **every top-level query result column**, not only duplicates.
This gives empty, paged, and sorted results the same contract. Catalog tables and parser output
keep their existing schemas. The generic Arrow version converter remains generic; result
normalization is a separate step at the query cursor seam.

## Result-column contract

For a result with N columns, physical Arrow fields are `c0` through `c{N-1}`. Each field carries
its exact original SQL label in the string metadata entry `byteql:result-label:v1`.
An empty SQL label is a valid label. Field position is identity within a query generation;
the name `c0` is not an identity across executions.

`QueryResultView.schema`, stored pages, materialized results, and visible windows all use this
physical schema. Original labels are never restored as physical field names. Sorting restores
the base result's unique schema and metadata. Scratch ordinals remain outside the public result.

Add the browser-independent module `packages/db/src/result-columns.ts` with this interface:

```ts
export const RESULT_LABEL_METADATA_KEY = 'byteql:result-label:v1';

export function resultColumnLabel(field: Field): string;

export function resultColumnIndex(schema: Schema, label: string): number | null;

export interface ParquetColumnName {
  readonly columnIndex: number;
  readonly label: string;
  readonly name: string;
}

export function parquetColumnNames(
  schema: Schema,
  columns: readonly number[],
): readonly ParquetColumnName[];
```

`Field` and `Schema` above are Arrow 21 types. Label lookup uses metadata when present, otherwise
the physical field name, supporting existing fixtures and non-result tables. Use nullish fallback,
not truthiness, so empty labels survive. A label match is exact and case-sensitive.
`resultColumnIndex` returns an index only for exactly one matching label; absent and ambiguous
labels return null. Data reads use `getChildAt(index)`, never a row object keyed by label.

Export this module through `@byteql/db/result-columns` as well as the package's main interface.
The subpath lets the CSV worker import pure helpers without importing the database browser module.
Add no dependency and no separate label array to the worker protocol.

## Query normalization and Arrow conversion

Add `packages/db/src/result-arrow.ts`, using Arrow 17 types, with:

```ts
export function normalizeDuckdbResultSchema(schema: DuckdbSchema): DuckdbSchema;

export function normalizeDuckdbResultBatch(
  batch: DuckdbRecordBatch,
  sourceSchema: DuckdbSchema,
): DuckdbRecordBatch;
```

The source schema is the cursor's original schema, before ByteQL renaming. Normalize each newly
received batch immediately, including lookahead and zero-row batches, before `slice`, remainder
storage, table construction, or Arrow-version conversion. Do not normalize an already normalized
remainder again. Keep the existing iterator, page sizes, cancellation, and lookahead behavior.

Build unique fields positionally. Recover batch types from the actual child vectors/data, not
from a duplicate-corrupted `batch.schema`. Preserve raw value buffers, offsets, null masks,
dictionary data, nested types, field metadata, and schema metadata. Overwrite the reserved label
metadata key using the original cursor label; never trust an incoming value of that key as the
label of a new query. Do not mutate the source schema or batch and do not cast between Arrow versions.

Use a matching unique schema when calling the existing `convertDuckdbTable`. For schema-only
results, derive types from the original cursor schema, or the original child data of its zero-row
batch when supplied. The initial pre-open empty schema is provisional. Once available, the actual
schema must preserve all declared columns even when there are no rows.

Validate column counts and positional physical types before publishing a page. A shape/type
mismatch fails the query through the existing error and cancellation path; it must not drop a
column, replace it with nulls, coerce it to text, or resend SQL. The execution gate must establish
that true empty-result types are recoverable in the pinned reader. If not, revise this design
before advancing to UI work.

This task addresses duplicate top-level result labels. It does not add support for previously
unsupported nested values in sorting or export, or attempt to repair duplicate nested struct keys.
Previously supported complex query values must still cross the bridge unchanged.

## Consumers and presentation

### Grid, Inspector, sorting, and windows

- Display labels using `resultColumnLabel`; use original labels for hidden-column filtering.
- Key all Inspector loops by column index. Read values by column index.
- Keep visible headers unchanged. Accessible names for duplicates include their one-based
  result-column positions, for example `Sort dup, column 2, ascending`.
- Use a column-position accessible label for an empty header without inventing a visible SQL label.
- Update sort eligibility/error messages to display SQL labels.
- Update `sameResultSchema` to compare physical names, logical labels, and types by position.
- Preserve original labels and types through page eviction/reload, slice/concat, bounded windows,
  materialization, and `restoreResultSchema`. Schema equality must detect changed labels even when
  the generated names and types are identical.

### Provenance and trusted viewers

Provenance requires exactly one each of `_src_file`, `_src_start`, and `_src_end` by logical label,
plus the existing value/range validation. If any required label is duplicated, disable automatic
byte linking and coverage for that result. The Inspector shows the fields and their values with
the explanation `Byte provenance is ambiguous because source columns are repeated.`
Do not guess which joined source range the user intended. Explicit unique SQL aliases remain a
way to select a range. Duplicate unrelated labels do not disable otherwise unambiguous provenance.

Update the audio capability check and reader together. Require unique required labels `seconds`,
`note`, `velocity`, and `kind`; a present `channel` or `program` must also be unique. Preserve the
existing type checks and optional-column defaults. Ambiguous consumed labels make the viewer
unavailable; unrelated repeated labels are allowed. Audio still receives the original complete
result, in original query order, under its existing materialization budget.

Update both `Workbench.svelte` and `compatibleTableViewers`, since both construct viewer column
descriptions. Catalog/Explorer columns and parse-worker provenance stamping are not query results
and retain their current name semantics.

## Downloads

### CSV

Read header labels from field metadata after the existing worker IPC decode. Preserve exact
header strings, their order, duplicate labels, quotes, Unicode, and literal U+FEFF. Preserve the
existing UTF-8 BOM, scalar formatting, bounded chunks, backpressure, cancellation, and full-result
iteration. Metadata travels in Arrow IPC; no parallel label payload is needed.

### Deterministic Parquet names

Run `parquetColumnNames` on the selected columns in export order. Validate indices and reject
repeated indices. All comparisons for name allocation use the existing DuckDB convention of
folding ASCII A–Z to a–z, not locale folding.

1. Reserve all nonempty original labels of selected columns, using the comparison key above.
2. Preserve the first occurrence of each nonempty label, including its original spelling.
3. For a repeated label, try `<label>_2`, `<label>_3`, and upward, skipping names reserved by
   any original label or already allocated output name.
4. For an empty label, try `column_<one-based original column position>`; if reserved or used,
   append `_2`, `_3`, and upward by the same rule.
5. Return an entry for every selected column. A rename is `label !== name`.

Examples:

| Selected SQL labels | Parquet names |
| --- | --- |
| `dup`, `dup` | `dup`, `dup_2` |
| `dup`, `dup`, `dup_2` | `dup`, `dup_3`, `dup_2` |
| `dup`, `DUP` | `dup`, `DUP_2` |
| empty first label, `column_1` | `column_1_2`, `column_1` |

Allocation considers only selected columns. Turning hidden-column export on or off can change
the mapping, so the preview must recompute with the selection.

In the existing download popover, selecting Parquet shows changed columns before the Download
button, with the copy `Parquet column names` and a table of `Column`, `SQL label`, and `File name`.
Use one-based original result positions and show an empty label as `(empty)` in this explanation.
For `dup`, `dup`, the table contains `2 | dup | dup_2`. Render aliases as text, never HTML.
Associate the explanation with the Download button using `aria-describedby`. Use the popover's
existing scroll container for long mappings. Do not add a second confirmation dialog.

Capture the mapping synchronously when Download is clicked, alongside the selected indices,
result view, generation, and order revision. Continue opening the destination picker in that same
user gesture. Add required `columnNames: readonly string[]` to `ParquetExportOptions`; the writer
recomputes the expected mapping and rejects a mismatch before staging files. This makes the
preview, requested export, and final COPY agree, including non-UI callers.

Final COPY projects generated staging columns to the validated export names using the existing
identifier quoting. Preserve the qualified display ordinal ordering and omit the ordinal from
the output. Keep type admission unchanged. The downloaded Parquet schema uses the previewed names;
the current result schema and labels are unchanged. Do not rely on DuckDB's implicit name repair.

## Binding constraints

- No SQL rewrite or rerun; one original cursor send per query execution.
- Arrow IPC remains the interchange format; no whole-result JavaScript row arrays.
- `RESULT_WINDOW_ROWS = 16_384`; `.grid-scroll` remains the sole result-grid scroll owner.
- Preserve exact values, positional types, nulls, row counts, and committed display order.
- Sorting remains unavailable on the pinned `mvp` bundle; duplicate-result reading is required there.
- Keep the current OPFS requirements, storage budgets, hardening, cancellation, and cleanup contracts.
- No dependency upgrades, new network requests, runtime-loaded code, or deployment changes.
- No format-pack, parser-engine, connection-lifecycle, or multi-range-provenance expansion.

## Verification and execution gates

The plan begins with a recorded failing reproduction and real-runtime evidence, then proceeds
through storage, consumers, exports, and full regression. Required cases include:

1. Same-name/different-type and same-name/same-type results; three or more repeated labels.
2. Empty results, nulls, exact large integers, decimals, timestamps, Unicode and quoted labels,
   empty labels, case-only collisions, and labels that look like generated internal names.
3. More than 20,000 rows, multiple pages, forced page eviction and reload, and a window beyond
   row 16,384. Assert every positional value, label, and type at each relevant seam.
4. Sorting either duplicate independently on `eh`, stable ties/nulls-last, restoring original
   order, both exports in committed order, and no second query execution with volatile values.
5. CSV bytes with duplicate headers; Parquet readback matching the preview, types, values, and
   row order. Include empty exports and collision avoidance against existing suffixed labels.
6. Duplicate provenance and audio labels, unaffected unambiguous pcap/MIDI workflows, stale
   generation/order callbacks, cancellation, quota failure, and cleanup.
7. Existing build/type/format/lint, workspace unit, bundle/privacy, and browser acceptance gates.

Do not treat design artifacts or synthetic Arrow fixtures as proof that the pinned DuckDB reader
works. Record actual runtime versions and results in the compatibility document during execution.
Screen-reader and touch checks remain manual until performed and recorded.
