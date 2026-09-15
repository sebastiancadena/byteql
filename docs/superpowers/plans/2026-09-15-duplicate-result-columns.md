# Duplicate Result Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve repeated SQL result labels and all positional values through querying,
inspection, sorting, and CSV/Parquet download.

**Architecture:** Normalize top-level query fields to unique Arrow names before batch slicing.
Store original SQL labels in field metadata and centralize display, unambiguous lookup, and
Parquet name allocation in a pure module. Keep the existing paged-result and export lifecycles.

**Tech Stack:** TypeScript, Svelte 5, Arrow 17/21 IPC bridge, pinned DuckDB-WASM,
Vitest, Playwright, OPFS.

**Spec:** [Duplicate result-column correctness](../specs/2026-09-15-duplicate-result-columns-design.md).

**Status:** Handoff for review. All execution steps below remain pending. This planning session
changed documentation only and did not reproduce the failure or execute application tests.

## Global Constraints

- No SQL rewrite or rerun; one original cursor send per query execution.
- Arrow IPC remains the interchange format; no whole-result JavaScript row arrays.
- `RESULT_WINDOW_ROWS = 16_384`; `.grid-scroll` remains the sole result-grid scroll owner.
- Preserve exact values, positional types, nulls, row counts, and committed display order.
- Sorting remains unavailable on the pinned `mvp` bundle; duplicate-result reading is required there.
- Keep the current OPFS requirements, storage budgets, hardening, cancellation, and cleanup contracts.
- No dependency upgrades, new network requests, runtime-loaded code, or deployment changes.
- No format-pack, parser-engine, connection-lifecycle, or multi-range-provenance expansion.

## Execution discipline and file map

Read `AGENTS.md`, `ROADMAP.md`, the spec, and the sorting compatibility report first. Confirm the
checkout state with `git status --short` and `git log -5 --oneline`. Follow the worktree skill at
implementation time. Preserve unrelated changes. Baseline for this plan: `6228b19`.

Each checkbox is one action, generally a 2–5 minute step; repeat a test/implementation cycle for
each named fixture rather than treating an entire task as one edit. Commit only the task's files
after its targeted checks pass. Do not advance past Task 2 if the real-runtime gate fails.

| Module or path | Responsibility |
| --- | --- |
| `packages/db/src/result-columns.ts` (new) | Pure labels, unique lookup, Parquet names |
| `packages/db/src/result-arrow.ts` (new) | Arrow 17 result normalization |
| `packages/db/src/browser.ts` | Normalize cursor batches before slicing and publish unique schemas |
| `packages/db/src/arrow-bridge.ts` | Existing generic IPC version crossing |
| `query-pages.ts`, `result-snapshot.ts`, `stored-result-view.ts` in db | Retain metadata through storage and sorting |
| `apps/web/src/lib/session/result-sort.ts` | Display labels, accessible actions, schema comparison |
| `ResultGrid.svelte`, `Inspector.svelte` | Positional rendering and original labels |
| `apps/web/src/lib/hex/coverage.ts` | Unambiguous logical-label provenance lookup |
| `apps/web/src/lib/viewers/registry.ts`, `AudioViewer.svelte`, `Workbench.svelte` | Logical-label audio matching and reading |
| `apps/web/src/lib/export/csv.ts`, `options.ts` | Original headers and label-based selection |
| `packages/db/src/export-parquet.ts`, `export-types.ts` | Validate and write captured export names |
| `ResultsDownload.svelte`, session controller, export operation | Preview and capture export name mapping |
| Runtime probe, e2e harness, acceptance specs | Real-reader, paging, export, and lifecycle evidence |

Paths abbreviated in this table are expanded in each task. Do not change a listed production
file merely to touch it: storage/window modules may need only regression tests if metadata
already survives their operations.

## Task 1: Define the label and export-name interface

**Create:** `packages/db/src/result-columns.ts`, `packages/db/src/result-columns.test.ts`.
**Modify:** `packages/db/src/index.ts`, `packages/db/package.json`.

**Consumes:** Arrow 21 `Field`/`Schema`, with fallback to ordinary field names.
**Produces:** `RESULT_LABEL_METADATA_KEY`, `resultColumnLabel`, `resultColumnIndex`,
`ParquetColumnName`, and `parquetColumnNames`, with the signatures in the spec.

- [ ] Add tests with uniquely named physical fields and metadata, not duplicate physical fields:

  ```ts
  import { Field, Int32, Schema } from 'apache-arrow';
  import { expect, it } from 'vitest';
  import {
    RESULT_LABEL_METADATA_KEY, parquetColumnNames, resultColumnIndex, resultColumnLabel,
  } from './result-columns.js';

  const schemaOf = (labels: string[]) => new Schema(labels.map((label, i) =>
    new Field(`c${i}`, new Int32(), true,
      new Map([[RESULT_LABEL_METADATA_KEY, label]]))));

  it('preserves labels and refuses an ambiguous lookup', () => {
    const schema = schemaOf(['dup', 'dup', '']);
    expect(schema.fields.map(resultColumnLabel)).toEqual(['dup', 'dup', '']);
    expect(resultColumnIndex(schema, 'dup')).toBeNull();
    expect(resultColumnIndex(schema, '')).toBe(2);
    expect(resultColumnIndex(schema, 'missing')).toBeNull();
  });

  it('reserves existing suffixed names', () => {
    const schema = schemaOf(['dup', 'dup', 'dup_2']);
    expect(parquetColumnNames(schema, [0, 1, 2]).map(x => x.name))
      .toEqual(['dup', 'dup_3', 'dup_2']);
  });
  ```

- [ ] Run `pnpm --filter @byteql/db exec vitest run src/result-columns.test.ts`; establish failure.
- [ ] Implement the helpers with these kernels; use type-only Arrow imports:

  ```ts
  export const RESULT_LABEL_METADATA_KEY = 'byteql:result-label:v1';
  export const resultColumnLabel = (field: Field): string =>
    field.metadata.get(RESULT_LABEL_METADATA_KEY) ?? field.name;

  export function resultColumnIndex(schema: Schema, label: string): number | null {
    let found: number | null = null;
    for (const [index, field] of schema.fields.entries()) {
      if (resultColumnLabel(field) !== label) continue;
      if (found !== null) return null;
      found = index;
    }
    return found;
  }

  const key = (name: string): string =>
    name.replace(/[A-Z]/g, character => character.toLowerCase());

  export function parquetColumnNames(
    schema: Schema, columns: readonly number[],
  ): readonly ParquetColumnName[] {
    const seen = new Set<number>();
    const selected = columns.map(columnIndex => {
      if (!Number.isSafeInteger(columnIndex) || columnIndex < 0 ||
          columnIndex >= schema.fields.length || seen.has(columnIndex)) {
        throw new RangeError('Invalid or repeated export column index.');
      }
      seen.add(columnIndex);
      return { columnIndex, label: resultColumnLabel(schema.fields[columnIndex]!) };
    });
    if (selected.length === 0) throw new Error('Select at least one export column.');
    const reserved = new Set(selected.filter(x => x.label !== '').map(x => key(x.label)));
    const used = new Set<string>();
    return selected.map(({ columnIndex, label }) => {
      const base = label || `column_${columnIndex + 1}`;
      let name = base;
      if (used.has(key(name)) || (label === '' && reserved.has(key(name)))) {
        let suffix = 2;
        do { name = `${base}_${suffix++}`; }
        while (reserved.has(key(name)) || used.has(key(name)));
      }
      used.add(key(name));
      return { columnIndex, label, name };
    });
  }
  ```

- [ ] Add table-driven tests for `dup/DUP`, three repeats, empty labels, original `column_1`,
  names containing quotes/Unicode/U+FEFF, reordered/filtered selection, invalid/repeated indices,
  and metadata-free fields. Check labels and input metadata were not mutated.
- [ ] Export through the main barrel and add the package export below without changing `.`:

  ```json
  "./result-columns": {
    "types": "./dist/result-columns.d.ts",
    "default": "./dist/result-columns.js"
  }
  ```

- [ ] Run the targeted test, `pnpm --filter @byteql/db build`, and package type checks.
- [ ] Commit only these files: `feat(db): define positional result column labels`.

## Task 2: Prove and implement normalization at the live cursor

**Create:** `packages/db/src/result-arrow.ts`, `packages/db/src/result-arrow.test.ts`,
`packages/db/src/result-columns-probe.ts`, `apps/web/e2e/result-columns-probe.spec.ts`.
**Modify:** `packages/db/src/browser.ts`, `packages/db/src/browser.test.ts`,
`packages/db/src/index.ts`, `apps/web/src/lib/e2e-harness.ts`.
**Inspect:** `packages/db/src/arrow-bridge.ts`, `sort-probe.ts`, `export-probe.ts`.

**Consumes:** Task 1 metadata key, the original Arrow 17 cursor schema and each raw batch.
**Produces:** `normalizeDuckdbResultSchema` and `normalizeDuckdbResultBatch` from the spec;
normalized batches must exist before any slice. The generic converter's signature is unchanged.

- [ ] Add a real-reader probe following `sort-probe.ts`'s local bundle setup and production
  hardening sequence. Reuse the existing setup pattern; do not change hardening to get a pass.
  Export and expose this exact probe interface in the existing e2e-only harness:

  ```ts
  export interface ResultColumnsProbeReport {
    variant: 'mvp' | 'eh';
    checks: Record<'mixed' | 'sameType' | 'empty' | 'sliced' | 'ipc' | 'exactValues', boolean>;
    errors: string[];
  }
  export function probeResultColumns(
    variant: 'mvp' | 'eh',
  ): Promise<ResultColumnsProbeReport>;
  ```

  The probe uses `conn.send` to exercise the raw reader and the production normalization plus
  conversion functions. For each fixture compare positional vectors, physical names, logical
  labels, and true types. Catch fixture errors into `errors`, set their check false, and clean up
  reader, connection, database, and worker in `finally`. Never emit a true check without comparing
  its values. Add these queries individually:

  ```sql
  select 10::integer as dup, 'ten'::varchar as dup;
  select 10::integer as dup, 20::integer as dup, 30::integer as dup;
  select 10::integer as dup, 'ten'::varchar as dup where false;
  select i::integer as dup, ('v' || i)::varchar as dup from range(20001) t(i);
  select 9007199254740993::bigint as dup, 123.45::decimal(9,2) as dup;
  ```

- [ ] Run the mixed-type query against the existing conversion before changing production code;
  record the failure. Add a probe test for each bundle, using `openMidiSample` only to load the
  existing instrumented app and access the harness:

  ```ts
  expect(report.errors).toEqual([]);
  expect(report.checks).toEqual({
    mixed: true, sameType: true, empty: true,
    sliced: true, ipc: true, exactValues: true,
  });
  ```

  Attach the report JSON via Playwright's `testInfo.attach`; require a failing pre-fix report.
  Run `pnpm --filter @byteql/web test:e2e -- e2e/result-columns-probe.spec.ts`.
- [ ] Add Arrow 17 unit fixtures that create a raw mixed-type duplicate batch. Assert its child
  vectors retain their values even if the declared fields do not. Normalize before slicing, then
  cross the existing IPC converter and assert `c0/c1`, `dup/dup`, `Int32/Utf8`, and `10/'ten'`.
- [ ] Implement schema normalization with fresh cloned fields and metadata:

  ```ts
  const fields = sourceSchema.fields.map((field, index) => field.clone({
    name: `c${index}`,
    metadata: new Map(field.metadata).set(RESULT_LABEL_METADATA_KEY, field.name),
  }));
  return new DuckdbSchema(fields, new Map(sourceSchema.metadata));
  ```

  For a batch, use its child data's actual type for each cloned field and rebuild the parent
  Struct data with those fields. The buffer-preserving construction is:

  ```ts
  const data = duckdbMakeData({
    type: new DuckdbStruct(fields),
    length: batch.numRows,
    children: batch.data.children,
  });
  return new DuckdbRecordBatch(new DuckdbSchema(fields, new Map(sourceSchema.metadata)), data);
  ```

  Alias `makeData`, `Struct`, `Schema`, and `RecordBatch` from `apache-arrow-duckdb`; never from
  Arrow 21 in this module. Validate field/child counts and true types first. Preserve dictionary
  IDs through the field types. Test offsets, nulls, field metadata, nested ordinary fields, and
  input immutability. These are top-level record batches, so preserve each child's offset/null
  mask rather than materializing its values.
- [ ] Update `QuerySessionImpl` to normalize raw `iterator.next().value` immediately in both the
  normal fetch and lookahead branches. Do this before setting the remainder or calling `slice`.
  Prefer the original nonempty cursor schema for labels; when it is provisional, use the raw
  batch's original field labels. True types come from child data. Keep remainders normalized.
- [ ] Convert with the normalized schema for ordinary pages and initial/final schema-only paths.
  For the zero-row-batch branch, retain the normalized batch schema; do not overwrite it at EOF
  with an empty provisional schema. Validate reader/child positional types before publication.
- [ ] Extend `browser.test.ts` for a batch split across the initial 1,024-row page, lookahead,
  empty results, cancellation, and a mismatching schema. Assert one original `send`, exact values,
  and terminal error/cleanup for mismatches. Update result-name expectations to use logical labels;
  retain separate assertions on physical names.
- [ ] Run `pnpm --filter @byteql/db exec vitest run src/result-arrow.test.ts src/browser.test.ts`,
  rebuild `@byteql/db`, and rerun the two-bundle probe. Inspect both JSON reports.
- [ ] **Gate:** mixed and empty duplicate types must be correct on both bundles, including slices
  and IPC reload. If unavailable schema information makes this impossible, stop here with the
  failing evidence and revise the design. Do not add casts, reruns, or an Arrow monkey patch.
- [ ] Commit: `fix(db): normalize result columns before Arrow reconstruction`.

## Task 3: Preserve identity through retained pages and sorted views

**Modify/tests:** `packages/db/src/query-pages.test.ts`, `result-snapshot.test.ts`,
`stored-result-view.test.ts`, `sort-result.test.ts`, `sort-probe.ts`, and
`apps/web/src/lib/session/result-window.test.ts`.
**Implementation if a test exposes loss:** `packages/db/src/query-pages.ts`,
`result-snapshot.ts`, `stored-result-view.ts`, `sort-result.ts`,
`apps/web/src/lib/session/result-window.ts`.

**Consumes:** Unique physical schemas with label metadata from Task 2.
**Produces:** The same schema/labels/types through every retained-result operation.

- [ ] Build one shared pattern of fixture with physical `c0/c1`, logical `dup/dup`, and integer/text
  vectors. Use a `QueryPageStore` with a small memory limit and in-memory persistence adapter to
  force eviction. Retrieve an evicted page and compare metadata, types, and positional values.
- [ ] Assert slice/concat and materialization retain both labels. The essential invariant is:

  ```ts
  expect(restored.schema.fields.map(field => field.name)).toEqual(['c0', 'c1']);
  expect(restored.schema.fields.map(resultColumnLabel)).toEqual(['dup', 'dup']);
  expect(restored.getChildAt(0)!.get(0)).toBe(10);
  expect(restored.getChildAt(1)!.get(0)).toBe('ten');
  ```

- [ ] Run the affected tests red if a production change is needed. Fix only the operation dropping
  metadata. Keep Arrow batches; do not rebuild rows as JavaScript objects.
- [ ] Test `snapshotPage` followed by `restoreResultSchema`: the latter receives the base physical
  schema, not a schema reconstructed from display labels. Preserve metadata and reject positional
  type mismatches. Retain the existing raw-duplicate regression as a low-level staging test, but
  add the new canonical representation as the production-path test.
- [ ] Add differently typed duplicate labels to the real `eh` sorting probe. Verify each index
  sorts independently and metadata survives; retain the existing `mvp` refusal assertions.
- [ ] Test a result window spanning two pages and a later window beyond row 16,384. Keep the
  bounded-window size and original page coordinates intact.
- [ ] Run db unit tests and the web result-window test; run `result-sort-probe.spec.ts` after
  rebuilding the db package. Commit: `fix(db): retain result labels across paging and sorting`.

## Task 4: Render labels and sort actions by position

**Modify:** `apps/web/src/components/ResultGrid.svelte`, `Inspector.svelte`,
`apps/web/src/lib/session/result-sort.ts`, `packages/db/src/result-sort.ts`.
**Tests:** `apps/web/src/components/ResultGrid.sort.test.ts`,
`apps/web/src/lib/session/result-sort.test.ts`; create
`apps/web/src/components/Inspector.test.ts`.

**Consumes:** `resultColumnLabel(field)`; physical indices remain unchanged.
**Produces:** Exact visible labels, positional Inspector keys, distinct accessible sort actions.

- [ ] Add a mixed-type duplicate fixture to the grid and Inspector tests. Assert two visible `dup`
  labels, values `10` and `ten`, and two distinct sort buttons by accessible column position.
- [ ] Add a schema-only Inspector test and an empty-label test. All three Inspector loops must
  work without duplicate-key errors.
- [ ] Run the tests to expose physical-name leakage; replace presentation uses with:

  ```svelte
  {#each table.schema.fields as field, columnIndex (columnIndex)}
    <dt>{resultColumnLabel(field)}</dt>
    <dd>{formatValue(valueAt(columnIndex))}</dd>
  {/each}
  ```

  Apply this pattern inside the existing Inspector sections, preserving their structure. Grid
  headers use the helper; hidden filtering tests `resultColumnLabel(field).startsWith('_')`.
- [ ] Update `fieldLabel` in the web sort module to compare logical labels and append one-based
  positions for duplicates. An empty label returns `column N` for accessibility. The visible
  header stays empty. Use these helpers for header accessible names and announcements.
- [ ] Update `sameResultSchema` with the additional positional label comparison:

  ```ts
  return field.name === other.name &&
    resultColumnLabel(field) === resultColumnLabel(other) &&
    field.type.toString() === other.type.toString();
  ```

  Test two generated schemas with identical `c0/c1` names/types but different SQL labels as unequal.
  Use logical labels in db sort eligibility messages too.
- [ ] Run the three targeted web tests, relevant db sort tests, and web type checks after db build.
- [ ] Commit: `fix(web): render and sort duplicate labels by position`.

## Task 5: Make provenance and audio label lookup unambiguous

**Modify:** `apps/web/src/lib/hex/coverage.ts`, `apps/web/src/lib/viewers/registry.ts`,
`apps/web/src/components/AudioViewer.svelte`, `Workbench.svelte`, `Inspector.svelte`.
**Tests:** `coverage.test.ts`, `registry.test.ts`, `AudioViewer.test.ts`, `Workbench.test.ts`,
`Inspector.test.ts` beside those modules.

**Consumes:** `resultColumnIndex(schema, label)` and `resultColumnLabel`.
**Produces:** Existing provenance/audio for unique logical labels; no automatic binding when a
consumed label is repeated.

- [ ] Test provenance with unique source labels plus unrelated duplicate `dup` columns. It must
  reveal the same file/range and coverage as before.
- [ ] Add separate duplicate `_src_file`, `_src_start`, and `_src_end` cases. Assert null row
  provenance, no coverage index, and the specified Inspector ambiguity explanation.
- [ ] Replace source vector lookup in both `provenanceOfRow` and `buildCoverage`:

  ```ts
  const index = resultColumnIndex(table.schema, '_src_start');
  const startColumn = index === null ? null : table.getChildAt(index);
  ```

  Resolve all three required columns before reading values; keep existing row/range validation.
  Add `ambiguous-provenance` to `CoverageReason` and return it when any required label occurs more
  than once. Check all consumers of `CoverageReason` with `rg -n 'CoverageReason|no-provenance'`
  and update exhaustive handling. The Inspector counts matching logical labels to select the
  explanation, while preserving all field values in its fallback provenance section.
- [ ] Add registry tests for repeated `note`, repeated optional `channel/program`, and unrelated
  repeated labels. The first two disable audio; the latter remains compatible.
- [ ] Count consumed labels before constructing the registry's type map. Change Workbench and
  `compatibleTableViewers` descriptions to logical labels. Replace all six AudioViewer lookups
  with positional lookup; preserve optional defaults and existing required-value validation.
  Directly passing an ambiguous table to the viewer must not schedule audio.
- [ ] Run those six test files, then `open-query-inspect.spec.ts` and `hex-provenance.spec.ts`.
- [ ] Commit: `fix(web): reject ambiguous provenance and viewer columns`.

## Task 6: Preserve CSV headers and write explicit Parquet names

**Modify:** `apps/web/src/lib/export/csv.ts`, `options.ts`,
`packages/db/src/export-types.ts`, `export-parquet.ts`, `export-probe.ts`,
`apps/web/src/lib/export/operation.ts`, `apps/web/src/lib/session/controller.ts`.
**Tests/update callers:** `csv.test.ts`, `options.test.ts`, `controller.test.ts` in their web
directories; `packages/db/src/export-parquet.test.ts`, `browser.test.ts`.

**Consumes:** `parquetColumnNames` and logical label helpers.
**Produces:** Original-label CSV, validated export-name Parquet, captured immutable export names.

- [ ] Test CSV from a metadata-bearing table after IPC round-trip. Assert exact bytes for duplicate
  headers, embedded quotes, empty labels, and literal U+FEFF, preserving the file's separate BOM.
  Test zero rows and two columns with different types/values.
- [ ] Run the test red. Import `resultColumnLabel` from `@byteql/db/result-columns` in `csv.ts`
  and use it only for headers. Retain positional scalar reads and the existing worker protocol.
- [ ] Update `selectExportColumns` to filter hidden columns and construct error messages using
  logical labels. Remove only the duplicate-name rejection; retain type checks. Test repeated
  labels becoming selectable for Parquet and unsupported types remaining unavailable.
- [ ] Add `readonly columnNames: readonly string[]` to `ParquetExportOptions`. Add
  `readonly parquetColumnNames: readonly string[] | null` to `ExportOperation`.
  Capture names synchronously in `downloadResults`, before destination acquisition:

  ```ts
  const capturedNames = options.format === 'parquet'
    ? parquetColumnNames(resultState.schema, columns).map(column => column.name)
    : null;
  ```

  Store a copied array on the operation and pass it to `database.exportParquet` after loading
  completes. Do not recompute from a later `this.state.result`. Existing generation/view/order
  guards must remain in force. The normal CSV operation carries null.
- [ ] At `writeParquet` entry validate the captured names against a fresh deterministic mapping
  before connection/file allocation. Add tests for length mismatch, reordered names, duplicates,
  and stale names, asserting no scratch files or COPY are attempted.

  ```ts
  const expected = parquetColumnNames(result.schema, options.columns).map(x => x.name);
  if (options.columnNames.length !== expected.length ||
      expected.some((name, i) => name !== options.columnNames[i])) {
    throw new Error('Parquet column names no longer match the selected result.');
  }
  ```

- [ ] Build final projection aliases from `options.columnNames`, using existing quoting. Keep
  generated `cN` staging aliases and the qualified ordinal ORDER BY. Test names containing
  quotes, `__byteql_export_ordinal`, existing suffixes, and case-only collisions.
- [ ] Migrate every `exportParquet`/`writeParquet` test and probe caller to provide names from the
  same mapping; locate them with `rg -n 'exportParquet\(|writeParquet\(' packages/db/src apps/web/src`.
  Update typed/empty export probes too. A required argument must not become optional to silence
  compiler failures.
- [ ] Add controller coverage proving names are captured before awaits and stale exports cannot
  publish after query replacement or sorting. Keep picker acquisition synchronous and verify
  cancellation/cleanup assertions still pass.
- [ ] Run affected db/web tests and `pnpm --filter @byteql/web test:worker-privacy` after db build.
- [ ] Commit: `feat: preserve duplicate columns in CSV and Parquet exports`.

## Task 7: Preview Parquet field renaming before download

**Modify:** `apps/web/src/components/ResultsDownload.svelte`.
**Create:** `apps/web/src/components/ResultsDownload.test.ts`.
**Consumes:** Current result schema, `selectExportColumns`, and `parquetColumnNames`.
**Produces:** An accurate, accessible mapping in the existing popover, before Download.

- [ ] Add component tests with the existing controller/session fixture conventions for duplicate,
  suffixed, empty, case-colliding, and hidden labels. Assert a mapping appears only for Parquet
  when at least one selected label changes; unique labels and CSV show no mapping.
- [ ] Derive the mapping from the same schema/selection used by validation. Return an empty preview
  while validation fails. Use the equivalent of:

  ```ts
  const selected = selectExportColumns(result.schema, options);
  const renamed = parquetColumnNames(result.schema, selected)
    .filter(column => column.label !== column.name);
  ```

- [ ] Render a heading `Parquet column names` and a table of `Column`, `SQL label`, `File name`.
  Use `columnIndex + 1`, exact escaped label text (or `(empty)`), and `name`. Key by columnIndex.
  Add its ID to the Download button's `aria-describedby` alongside any validation reason.
  Keep the existing popover scrolling and the current Download click handler.
- [ ] Test that toggling hidden columns changes the preview consistently and clicking Download
  calls the controller once. Test long/untrusted labels as text and keyboard access to Download.
- [ ] Run component tests and web type checks. Commit: `feat(web): preview Parquet column renaming`.

## Task 8: Verify the complete workflow and record limits

**Create:** `apps/web/e2e/duplicate-result-columns.spec.ts`.
**Modify:** `apps/web/src/lib/e2e-harness.ts`, `apps/web/e2e/results-download.spec.ts`,
`apps/web/e2e/result-column-sorting.spec.ts`,
`docs/result-column-sorting-compatibility.md`, `ROADMAP.md`.

**Consumes:** Production result, sort, Inspector, and download interfaces from Tasks 1–7.
**Produces:** Downloaded-file and browser evidence; factual compatibility documentation.

- [ ] Update the e2e harness's stored-result serialization to return logical `columns`, with a
  separate `physicalColumns` array where a test needs internal-name assertions. Read values by
  position. Preserve all existing metrics and the production/e2e build separation.
- [ ] Add this browser fixture and verify the first and later windows by column position:

  ```sql
  select i::integer as dup,
         ('row-' || (20000 - i))::varchar as dup,
         random() as token
  from range(20001) t(i);
  ```

  Assert duplicate headers, correct types/Inspector values, 20,001 complete rows, a window beyond
  16,384, and one original send. Capture the original rows/tokens once for test comparison; do
  not execute the SQL again to create expected random values.
- [ ] Sort each duplicate via its accessible position, both directions, and restore query order.
  Compare the entire exported result against the captured original values in the expected order.
  Add null/stable-tie fixtures separately. Assert tokens remain associated with their original rows.
- [ ] Download CSV and inspect actual header bytes with `TextDecoder('utf-8', { ignoreBOM: true })`.
  Do not use the existing name-keyed CSV readback schema to validate duplicate headers: read the
  header bytes directly and decode data positionally with distinct test-only reader names after
  skipping the header. Preserve BOM/quote/U+FEFF assertions.
- [ ] Select Parquet, assert the displayed mapping, download the artifact, and read it back using
  the existing isolated export-artifact reader. Compare names, types, all values, and row order.
  Include `dup/dup/dup_2`, case collisions, empty results, and hidden-column selection.
- [ ] Force page eviction in the page-store integration test and retain the real browser large
  result/storage coverage. Verify cancellation, quota failure, query replacement, and sorting
  clear owned resources and do not change the labels of a subsequent result.
- [ ] Run targeted browser tests first:

  ```bash
  pnpm --filter @byteql/web test:e2e -- e2e/duplicate-result-columns.spec.ts e2e/result-columns-probe.spec.ts e2e/result-column-sorting.spec.ts e2e/results-download.spec.ts
  ```

- [ ] Run the final repository gates once targeted failures are resolved:

  ```bash
  pnpm check
  pnpm lint
  pnpm -r test -- --run
  pnpm --filter @byteql/web check:bundle
  pnpm --filter @byteql/web test:e2e
  ```

  `pnpm check` builds before type/format checks; do not diagnose stale `packages/db/dist` exports
  as a source defect. Do not publish `dist-e2e` or deploy as part of this plan.
- [ ] Replace the compatibility report's active duplicate-name limitation with the measured
  behavior and link this design. Retain the historical failure explanation and the `mvp` sorting
  limitation. Mark roadmap item 1 complete only after the full workflow passes. Keep real
  screen-reader/touch acceptance pending until performed; automated ARIA assertions are not a
  substitute. Record probe versions, exact commands, artifacts, and any failures honestly.
- [ ] Commit: `test: verify duplicate result columns across the full workflow`.

## Recovery and handoff rules

- Gate failure in the pinned reader: keep evidence and revise Task 2/design before any UI work.
- A display of `c0` or an export header `c0` means a consumer bypassed the logical-label helper.
  Audit result consumers; do not restore duplicate physical Arrow names as a shortcut.
- Metadata lost through an Arrow operation: isolate that operation with an IPC/storage test.
  Fix the producer or reconstruction step rather than adding a parallel labels array.
- Wrong Parquet preview: compare selected indices, reserved names, captured mapping, and COPY
  aliases. Never rely on implicit writer deduplication or silently discard a duplicate column.
- Ambiguous source/audio labels: keep automatic linking/viewing unavailable and retain the data.
- Regression outside this scope: reproduce and report it; do not expand into pcapng or other
  roadmap tasks to finish this one.

## Design coverage check

| Design requirement | Execution tasks |
| --- | --- |
| Positional identity and pure shared interface | 1, 2 |
| Raw-reader/zero-row gate on both bundles | 2 |
| IPC, retained pages, sorted schema, later windows | 2, 3, 8 |
| Exact UI labels and accessible distinctions | 4 |
| Ambiguous provenance and audio behavior | 5 |
| Exact CSV headers and typed unique-name Parquet | 1, 6, 8 |
| Preview, captured mapping, user gesture, stale-operation guards | 6, 7, 8 |
| Privacy, budgets, current-execution identity, cleanup | 2, 3, 6, 8 |
| Evidence and outstanding manual acceptance | 8 |
