# Result column sorting — observed compatibility

Evidence for the support restrictions in
[the design record](superpowers/specs/2026-09-14-result-column-sorting-design.md). Everything here
was measured, not inferred. Re-measure with:

```bash
pnpm --filter @byteql/web test:e2e result-sort-probe.spec.ts
```

The probe (`packages/db/src/sort-probe.ts`) runs the whole snapshot path against the real pinned
runtime under production hardening — Arrow pages → private Parquet shards → typed `ORDER BY` →
paged Arrow output — and attaches its full report as a test artifact.

## Environment measured

|                   |                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------- |
| Date              | 2026-09-14                                                                          |
| Runtime           | `@duckdb/duckdb-wasm` 1.33.1-dev57.0, local `mvp` and `eh` bundles                  |
| Parquet extension | local `v1.5.4/wasm_{mvp,eh}`                                                        |
| Arrow             | `apache-arrow` 21.1.0, `apache-arrow-duckdb` (Arrow 17.0.0) bridge                  |
| Browser           | Chromium (Playwright-managed), Linux x86_64                                         |
| Hardening         | `allowed_directories` → external access off → extensions off → `lock_configuration` |

## What passes

On the `eh` bundle, with 20,000 rows carrying ties and nulls across page boundaries:

- Values, field names, field types and schema metadata all survive the round trip.
- Ties keep original query order in both directions (the private `__byteql_sort_ordinal`
  tie-breaker works); nulls sort last.
- The original SQL is sent **exactly once**. Every staging and ordering statement runs on a
  separate connection; none reaches the connection that owns the original cursor.
- Cancelling mid-statement settles, and the sorting connection is reusable afterwards.
- A denied OPFS path outside the allowlist is refused and the denied file's bytes are unchanged,
  `enable_external_access` reads back as false, `lock_configuration` as true, and the connection is
  still usable. External access is proved from the locked settings rather than by attempting a
  remote URL: the bundle audit forbids an external URL literal in runtime source, and a probe that
  worked around that check would undermine the guarantee it claims to verify. That no network
  request happens after readiness is asserted separately, here and in `privacy.spec.ts`.
- Scratch shards and DuckDB file registrations are released; the scratch directory is left empty.

Typed fixtures that round-trip exactly (`eh`): signed and unsigned integer widths including
`TINYINT`/`SMALLINT`/`INTEGER`/`BIGINT` extremes and `UBIGINT` values beyond 2^53;
`DECIMAL(38,9)`; `DOUBLE`/`FLOAT` including NaN, ±infinity and negative zero; empty, BOM-prefixed
and non-ASCII `VARCHAR`; `BLOB` including empty and high-byte values; `DATE`, `TIME`, `TIMESTAMP`
and `TIMESTAMP_NS`; `BOOLEAN` with nulls; and quote-bearing, SQL-looking column aliases.

## Limitation: the `mvp` bundle cannot sort

**Sorting is refused outright on the `mvp` bundle** (`resultSortRuntimeSupported`), with the reason
_"Column sorting is unavailable in this browser's WebAssembly runtime. Update your browser and run
the query again."_

`mvp` fails `ORDER BY` over `parquet_scan` when the key column spans the full range of a signed
16- or 32-bit type. Measured with the snapshot machinery removed entirely — a plain
`COPY (SELECT …) TO … (FORMAT PARQUET)` followed by `SELECT … FROM parquet_scan(…) ORDER BY v`:

| Bundle | in-memory `ORDER BY` | `ORDER BY` over `parquet_scan` |
| ------ | -------------------- | ------------------------------ |
| `mvp`  | works                | **fails**                      |
| `eh`   | works                | works                          |

So the defect is in the pinned runtime, not in the snapshot path. Narrowed by a type/value matrix:
`TINYINT` extremes, `SMALLINT` small values, `BIGINT` values beyond 2^53 and every unsigned width
all sort correctly on `mvp`; only full-range signed 16- and 32-bit keys fail. Refusing the whole
bundle is deliberate — the alternative is a sort that works until a user's data happens to contain
both extremes of a column's type.

`mvp` is selected only for browsers without WebAssembly exception handling (roughly pre-Chrome 95,
pre-Firefox 100, pre-Safari 15.2). Every current browser gets `eh`.

`result-sort-probe.spec.ts` pins this: the `mvp` case asserts `runtimeOrderBy.parquet === false`.
A runtime upgrade that fixes it will fail that test, which is the signal to re-enable sorting there.

On `mvp`, DuckDB errors surface as `ReferenceError: _setThrew is not defined` rather than the real
message. That masking is pre-existing and unrelated — the passing Parquet export probe records the
identical string today.

## Limitation: duplicate output column names (pre-existing, not sort-specific)

A query whose result has two columns of the same name — `select 10 as dup, 'ten' as dup` — **already
fails on `main`**, before this feature, with:

```text
Cannot destructure property 'length' of '(intermediate value)(intermediate value)(intermediate value)' as it is undefined.
```

Cause: Arrow's `Schema.assign` matches fields **by name**, and every `RecordBatch` construction —
including the IPC reader and writer — routes through it. A duplicate-named schema therefore has its
declared types collapsed onto the last duplicate's type, and the Arrow 17 → 21 bridge in
`convertDuckdbTable` then rejects the mismatched batch. Child vectors keep their true types
throughout; only the declared field type is wrong.

Consequences for sorting:

- No duplicate-named result can reach the sort path, because no such result exists to sort. The
  probe's fixtures therefore cover hostile and quote-bearing aliases but not duplicate ones.
- `snapshotPage` takes each staged column's type from its **child vector**, never from the declared
  field, so it is correct by construction if the bridge is ever fixed.
- Sorting addresses columns by original schema index, and the grid keys columns by index rather
  than name, so duplicate names remain valid at the UI layer.

Fixing the bridge is out of scope for this feature and would need its own design record.

## Observed performance

Measured by `result-column-sorting.spec.ts` on the environment above, and attached to that test as
`million-row-sort.json`. These are observations from one machine, not a throughput commitment.

| Result                            | Sort duration | Window rows | Decoded cache (base / display) | Scratch page files |
| --------------------------------- | ------------- | ----------- | ------------------------------ | ------------------ |
| 1,000,000 numeric rows, ascending | 8.1 s         | 16,384      | 8.1 MB / 8.1 MB                | 612                |
| 50,000 numeric rows, ascending    | under 1 s     | 16,384      | —                              | —                  |

The million-row case sorts a result whose cursor had not finished, so the drain, the snapshot, the
ordering and the paged read are all inside that duration. Both ends stay reachable afterwards by
physical scrolling, the spacer never exceeds `16,384 x 36` px, there is one grid scroller, and the
original SQL is sent exactly once.

Ten consecutive sort/clear cycles return to base-only resources each time — one live view, no
derived view, no leftover scratch files.

## Outstanding manual checks

These are not automated and have not been performed:

- Screen-reader acceptance (announcements, `aria-sort`, button naming) with a real screen reader.
- Touch acceptance on a real touch browser.
- Light/dark and narrow/wide visual review by eye. The automated suite covers keyboard-only
  operation, focus placement, one `aria-sort` at a time, hidden active columns and preserved
  horizontal scroll, but not appearance.
