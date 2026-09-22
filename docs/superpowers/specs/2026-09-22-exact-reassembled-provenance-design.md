# Exact provenance for reassembled messages

Date: 2026-09-22

Status: Design approved in conversation; written spec awaiting review. Implementation has not
started. Nothing here is evidence that the defect has been fixed.

## Purpose and accepted behavior

`ROADMAP.md` priority 2: make reassembled-message provenance explicit. A row derived from a
reassembled TCP message must never present bytes as message content when they are not.

Accepted scope (the "full truthful loop"):

- Distinguish a **bounding span** from **exact source bytes** in the data and in the UI.
- All three hex interactions honor exact bytes: grid row → byte highlight, byte click →
  covering rows (including structure shading), and filter-to-selection.
- Existing `_src_start`/`_src_end` semantics, names, types, and values are unchanged.

Out of scope: new formats, TCP identity hardening (roadmap priority 5), and `errors` rows (see
[Data contract](#data-contract)).

## Current evidence

Inspected at `84040fd`.

- `emitStreamMessage` (`packages/core/src/projection/project.ts`) already computes, per
  contributing segment, the payload range clipped to the message — then reduces those pieces to a
  min/max span and discards them. Every message-fed row shares that span.
- For any message spanning two or more segments, even back-to-back ones, the span includes the
  later packet's pcap record header and Ethernet/IP/TCP headers; with interleaving it includes
  whole unrelated packets.
- `stream_segments` cannot repair this: message rows carry `stream_id` but not their stream
  offset, so a message cannot be joined to its own segments only.
- `streams` flow rows carry the same kind of bounding span over the whole flow.
- The hex pane (`apps/web/src/lib/hex/coverage.ts`, `filter-sql.ts`) models provenance as one
  interval per row, so all three interactions return bytes or rows that are not message content.

These are read-only findings. The implementation begins by committing failing reproductions
([Testing](#testing-and-evidence)).

## Approaches considered

- **Chosen — per-row range list column.** The row carries its own exact bytes, surviving
  arbitrary SQL exactly as `_src_start` does; all three interactions resolve locally from the
  result; filter-to-selection stays pure SQL. Cost: plumbing one nested type through the builder,
  DuckDB, sorting, and export.
- **Rejected — separate range table keyed by `(_src_file, _src_start)`.** Needs a second query
  and a fragile identity invariant (a flow row can share its first message's start).
- **Rejected — stream coordinates plus a UI join to `stream_segments`.** Leaks TCP stream
  semantics into the hex pane and breaks whenever a query omits `stream_id` or the offsets.

## Data contract

New reserved column **`_src_ranges`**, Arrow `List<Struct<start: Uint64, end: Uint64>>`,
nullable.

- **Placement.** Engine-injected (like `stream_id`) into every stream-fed message table, every
  stream flow table, and every table reachable by a deeper dissect from a stream message parser.
  In the pcap pack: `tls`, `dns`, `streams`. No other table's schema changes.
- **Reserved name.** A spec that declares a column or key named `_src_ranges` fails with
  `ProjectionCompileError`.
- **Semantics.**
  - `_src_ranges IS NULL`: `[_src_start, _src_end)` is exact. Always true for tables without the
    column, and for single-segment messages.
  - `_src_ranges IS NOT NULL`: `[_src_start, _src_end)` is a bounding span; the list holds the
    exact source bytes.
- **Invariants when non-null.** At least two pieces; sorted by file offset; non-overlapping;
  merged when touching (so adjacent pieces always have a gap between them); every piece
  non-empty; first piece starts at `_src_start`; last piece ends at `_src_end`.
- **Piece order is file order**, not stream order. Stream order stays available through
  `stream_segments`.
- **Values.**
  - Message rows: each contributing segment's payload range, clipped to the part the message
    covers.
  - Flow rows: every accepted contribution's payload range (duplicates and rejected
    contributions are never recorded, so they never appear).
  - Deeper dissect rows under a message: the message's `_src_start`, `_src_end`, `_src_ranges`.
    Today such rows compute offsets from the span start, which is wrong once the span has gaps;
    pcap does not use this path yet, so the change is protective.
- **`errors` rows** raised by stream issues keep their bounding span with no `_src_ranges`: they
  mark a region where something went wrong, not message content.

## Engine (`packages/core`)

- **Internal type `src_ranges`.** Added to the `ArrowTypeName` set used by `tableOutputTypes`,
  `TableBatchBuilder`, and `arrow/build.ts`. Not accepted by the spec's zod schema. The builder
  accepts `null` or an array of `{ start: bigint; end: bigint }` and always checks the ordering,
  gap, and non-empty invariants (a linear pass per value); a violation is an engine bug and
  throws at build time.
- **Marking tables.** `CompiledProjectionTable` gains `boundedProvenance: boolean`, computed in
  the same pre-scan that sets `streamFed`, extended to flow tables and to tables reachable from a
  message parser. `tableOutputTypes` appends `_src_ranges` for marked tables as the last engine
  column, immediately after `_src_end` (the worker then appends `_src_file`). A stream fed from a
  marked table is a compile error, since its contributions would be offset from a bounding span.
- **`normalizeRanges`.** A pure exported helper: sort by start, merge overlapping or touching
  pieces, return `null` when one piece remains, `null` for empty input.
- **Messages.** `emitStreamMessage` collects the clipped pieces instead of reducing them and
  normalizes them. The span is the first piece's start and the last piece's end — identical to
  today's min/max. The `projectChildTable` provenance override carries `{ span, ranges }`, and
  every row it emits gets both.
- **Flows.** `flushStreams` builds ranges from `entry.segments`. A flow whose only contribution
  was rejected as `truncated` keeps its `fallbackSpan` with `_src_ranges = null`: that span is a
  real single payload range, so it is exact.
- **Deeper dissects.** When `fireDissect` is called from `emitStreamMessage`, it receives the
  message provenance; every row produced beneath it, directly or transitively, uses that
  provenance instead of offset arithmetic from `span.start`.
- **Timing.** Message pieces are final at emission, because the assembler's base is locked once
  any bytes are consumed (`below_base` otherwise). Flow pieces are computed at flush.
- **Unchanged.** Non-stream paths (one boolean check per row), `stream_segments`, key
  assignment, flush order, issue codes.

## Storage, transport, and results

- **Shape predicate.** `packages/db` exports `isSourceRangesType(type)`: true only for a nullable
  `List` whose item is `Struct<start: Uint64, end: Uint64>` with exactly those two fields in that
  order. It is structural, not name-based, so renamed columns still pass. General nested types
  remain unsupported everywhere.
- **Worker.** `pcapNullability` adds `_src_ranges` to `tls`, `dns`, and `streams`. Schema
  discovery and `stamp-source-file.ts` pass the field through.
- **Memory tier.** Arrow IPC insert maps it to DuckDB `STRUCT(start UBIGINT, "end" UBIGINT)[]`.
  `end` is a DuckDB reserved word: every generated SQL fragment must quote it.
- **Spill tier.** `COPY … TO parquet` and the final `parquet_scan([...])` views carry lists
  natively. The hardening PRAGMAs are unchanged.
- **Results.** DuckDB returns an Arrow `List<Struct>` that passes `isSourceRangesType`. The paged
  store and `QueryResultView` are type-agnostic.
- **Sorting.** `resultSortEligibility` also accepts `isSourceRangesType` columns as passengers.
  Their headers are disabled as sort keys (tooltip: "Byte ranges can't be sorted"). The sort
  snapshot round-trips them through Parquet shards exactly. If the probe shows the `mvp` bundle
  cannot round-trip them, sorting stays refused on `mvp`, as it already is.
- **Parquet export.** `isSupportedParquetType` also accepts the shape; the file keeps the native
  list type.
- **CSV export.** Rendered as `start-end;start-end` in decimal; empty cell for null. Exported only
  with "include provenance", per the existing `_`-prefix rule.
- **Display.** The grid (hidden-columns toggle on) and the Inspector render
  `3 ranges · 1234-1300; 1422-1500; …`, truncated after three pieces; the Inspector lists all.

## UI (`apps/web`)

- **Resolution.** `coverage.ts` looks up an optional `_src_ranges` by label and validates it with
  `isSourceRangesType`. A repeated label yields `ambiguous-provenance`; a same-named column of any
  other type is treated as absent, so user columns cannot impersonate provenance.
  `provenanceOfRow` returns `{ file, start, end, ranges }`; an exact row's `ranges` is its single
  `[start, end)`.
- **Row → bytes.** Workbench's `rowHighlight` carries `ranges` plus the bounding span. Pieces are
  painted in the highlight color. Bytes inside the span but outside every piece get a distinct
  neutral fill in a new `--color-hex-gap` token (the canvas seam exposes only rect fills, so no
  hatch pattern) — the visible bounding/exact distinction. The pane scrolls to the
  first piece and flashes it. When a row has two or more pieces, the hex toolbar shows
  `Range 1 of 3 · 1,380 of 5,212 bytes in span` with previous/next buttons and `[` / `]`
  shortcuts (added to the shortcuts overlay).
- **Byte → rows.** `buildCoverage` indexes one interval per piece, all pointing at the row; rows
  without the column still get one interval. `rowsAt` therefore matches a message only on its
  content bytes, and pieces are disjoint, so each row appears at most once. `rangeAt` returns the
  covering piece, so a click selects that piece, and "smallest interval wins" prefers message
  payload over the enclosing TCP or packet row. Shading alternates by row, not interval.
  `COVERAGE_ROW_CAP` becomes a cap on total intervals (still 2,000,000).
- **Filter to selection.** `filter-sql.ts` receives the inner result's schema. When it has a valid
  `_src_ranges`, the filter adds:

  ```sql
  and (_src_ranges is null
       or len(list_filter(_src_ranges, lambda r: r.start < E and r."end" > S)) > 0)
  ```

  The probe decides between `lambda r:` and `r ->` for the pinned DuckDB-WASM `1.33.1-dev57.0`.
  Fallback: `exists (select 1 from unnest(_src_ranges) u(r) where r.start < E and r."end" > S)`.
- **Inspector.** `Bytes 1,234–6,446 · bounding span · exact: 3 ranges`, then the pieces. Exact
  rows look unchanged.

## Testing and evidence

1. **Failing reproductions first**, built with `packages/formats/pcap/test/build-pcap.ts` and
   committed red:
   - Interleaved: a TLS ClientHello across three segments with a UDP DNS packet and an unrelated
     TCP packet between them. Assert the `tls` row's provenance covers only ClientHello payload.
   - Out-of-order plus interleaved: the same, captured shuffled. Same exact bytes, non-inverted
     span.
   - DNS-over-TCP split across two back-to-back segments: the second packet's record and
     Ethernet/IP/TCP header bytes are excluded.
2. **Probe (throwaway), on both `eh` and `mvp` bundles:** Arrow IPC insert of the shape; Parquet
   `COPY` and `parquet_scan` round-trip; sort-shard round-trip; lambda syntax. Record outcomes in
   this document's Implementation notes.
3. **Unit.**
   - core: `normalizeRanges`; builder invariant checks; reserved-name compile error; column
     placement; flow ranges equal accepted segments; rejected-first flow is null; deeper dissect
     inherits (synthetic core spec).
   - pcap: the reproductions pass; single-segment fixtures unchanged plus `_src_ranges = null`;
     existing multi-segment `_src_start`/`_src_end` unchanged.
   - db: `isSourceRangesType` accepts exactly the shape; sort and Parquet whitelists; exact sort
     round-trip including bigints.
   - web: multi-piece coverage; gap byte matches no message; `rangeAt` returns the piece;
     type-mismatched column ignored; duplicate label ambiguous; interval cap; conditional filter
     clause; CSV rendering; grid and Inspector formatting; HexPane range navigation.
4. **Browser acceptance (Chromium)**, interleaved fixture added via `generate-e2e-fixture`, new
   case in `apps/web/e2e/hex-provenance.spec.ts`: row selection paints only pieces and marks
   gaps; `]` reaches piece 2; clicking an unrelated header byte inside the span does not list the
   `tls` row; filter-to-selection excludes it on a gap byte and includes it on a piece byte;
   sorting `select * from tls` works; CSV and Parquet export with provenance succeed.
5. **Gates.** `pnpm -r check`, `pnpm -r test -- --run`, `pnpm lint`, `check:bundle`, full e2e.
   No new assets or requests; privacy gates are unaffected.

## Documentation on completion

- Amend `docs/superpowers/specs/2026-07-18-phase2-tcp-reassembly-design.md`: its "coarse span +
  link table" provenance decision is superseded by `_src_ranges`.
- `ROADMAP.md`: mark priority 2 done with evidence links. `AGENTS.md`: add a status entry.
- `PRD.md` §9 reserved-column description, if it enumerates hidden columns.

## Implementation notes

To be filled during implementation (probe outcomes, measured costs, discoveries).
