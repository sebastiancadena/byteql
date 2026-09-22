# Exact Reassembled-Message Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rows derived from reassembled TCP messages carry their exact source bytes in a new
`_src_ranges` column, and every hex interaction (row highlight, byte→rows, filter-to-selection)
honors those bytes instead of the bounding span.

**Architecture:** The projection engine stops discarding the per-segment pieces it already computes
in `emitStreamMessage`, normalizes them, and emits them as a reserved
`List<Struct<start: uint64, end: uint64>>` column on stream-fed, flow, and message-descendant
tables. `packages/db` admits exactly that one nested shape through ingest, sorting, and Parquet
export; the web app reads it in the coverage index, the filter SQL, the hex renderer, and the
formatters.

**Tech Stack:** TypeScript, apache-arrow 21 (engine/app) and 17 (DuckDB bridge), DuckDB-WASM
`1.33.1-dev57.0`, Svelte 5, vitest, Playwright (Chromium).

**Spec:** `docs/superpowers/specs/2026-09-22-exact-reassembled-provenance-design.md`

## Global Constraints

- Column name `_src_ranges`; Arrow type `List<Struct<start: Uint64, end: Uint64>>`; nullable.
- `_src_ranges IS NULL` ⇒ `[_src_start, _src_end)` exact; non-null ⇒ bounding span, list exact.
- Non-null invariants: ≥ 2 pieces, sorted by file offset, non-overlapping, merged when touching
  (strict gap between neighbors), every piece non-empty, first starts at `_src_start`, last ends
  at `_src_end`.
- Column position: last engine column, immediately after `_src_end` (the web worker appends
  `_src_file` after it). Engine-internal type name: `src_ranges`. DuckDB type:
  `STRUCT("start" UBIGINT, "end" UBIGINT)[]`.
- `end` is a DuckDB reserved word: every generated SQL fragment quotes it as `"end"`.
- `_src_start`/`_src_end` values, names, and types do not change for any existing row.
- Privacy: no new assets, URLs, or network requests; `check:bundle` and `privacy.spec.ts` stay
  green.
- Commits: conventional commits, no `Co-Authored-By` or AI attribution trailers, no text naming AI
  vendors or assistants, no absolute home-directory paths.
- Gates before the branch is done: `pnpm -r check`, `pnpm -r test -- --run`, `pnpm lint`,
  `pnpm --filter @byteql/web check:bundle`, `pnpm --filter @byteql/web test:e2e`.
- Markdown: `rumdl fmt <file>`; MD013 warnings up to ~100 chars are accepted.

## Review Focus

1. **A query keeps `_src_start`/`_src_end` but drops `_src_ranges`**
   (`select sni, _src_file, _src_start, _src_end from tls`): the pane cannot know the span is
   bounding, so it must behave exactly as today (single range, no gap marker, no crash). Pinned
   in Task 7 (`treats a result without _src_ranges as single-range`).
2. **Mixed exact and bounded rows in one table** (`dns` has UDP rows with null ranges and TCP
   rows with pieces): each row resolves independently. Pinned in Task 6 (UDP + TCP DNS capture)
   and Task 7 (mixed-row coverage).
3. **Multi-file sessions:** a row's pieces index only into its own `_src_file`; coverage for
   another file ignores them. Pinned in Task 7 (`indexes pieces only for the row's own file`).
4. **Sorted results:** after a column sort, selecting a row still highlights its pieces (the
   sorted view round-trips `_src_ranges` through Parquet). Pinned in Task 11 (e2e sort step).
5. **Range navigation bounds:** `[` on the first piece and `]` on the last piece do nothing (no
   wrap, no throw), and a new row selection resets to piece 1. Pinned in Task 10.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/core/src/projection/streams.ts` | `SourcePiece`, `normalizeRanges` (pure) |
| `packages/core/src/projection/spec.ts` | `ArrowTypeName` gains `'src_ranges'` (zod enum unchanged) |
| `packages/core/src/arrow/build.ts` | `SRC_RANGES_ARROW_TYPE`, validated `src_ranges` vector |
| `packages/core/src/projection/project.ts` | reserved name, `boundedProvenance` marking, emission |
| `packages/db/src/result-columns.ts` | `isSourceRangesType` (light subpath, no DuckDB import) |
| `packages/db/src/export-types.ts` | Parquet whitelist admits the shape |
| `packages/db/src/result-sort.ts` | sort eligibility admits it; `isSortKeyType` refuses it as key |
| `packages/db/src/browser.ts` | DDL mapping `src_ranges` → DuckDB list type |
| `packages/db/src/sort-probe.ts`, `export-probe.ts` | runtime gate fixtures |
| `packages/formats/pcap/src/pack.ts`, `project-pcap.ts` | schemas + nullability |
| `apps/web/src/lib/hex/coverage.ts` | ranges-aware provenance + interval index |
| `apps/web/src/lib/hex/filter-sql.ts` | ranges-aware overlap predicate |
| `apps/web/src/lib/hex/render.ts` | gap fill + per-piece highlight |
| `apps/web/src/lib/format/source-ranges.ts` (new) | shared display/CSV text for a ranges value |
| `apps/web/src/components/HexPane.svelte` | range readout, `[`/`]` navigation |
| `apps/web/src/components/{Workbench,Inspector,ResultGrid,ShortcutsOverlay}.svelte` | wiring |
| `apps/web/src/lib/export/{csv,options}.ts` | CSV rendering + admission |
| `apps/web/e2e/hex-provenance.spec.ts`, `e2e/fixtures/interleaved-stream.pcap` | acceptance |

---

### Task 1: Failing reproductions (pcap)

Pin the defect before touching code. Tests use `it.fails` so the suite stays green; Task 6 flips
them to `it`.

**Files:**

- Test: `packages/formats/pcap/test/project-pcap.test.ts` (append a `describe` block at the end)

**Interfaces:**

- Consumes: existing `tcpPacket`, `capture`, `findTable`, builders from `./build-pcap.js`.
- Produces: helpers `payloadRange(frames, index, payloadLength)` and `rangesOf(value)` used again
  in Task 6.
- [ ] **Step 1: Write the reproductions**

Append to `packages/formats/pcap/test/project-pcap.test.ts`:

```ts
// File offset of frame `index`'s trailing `payloadLength` bytes inside `capture(frames)`: the
// 24-byte global header, then one 16-byte record header + frame per packet. Every builder puts
// the application payload at the very end of the frame (no Ethernet padding).
const payloadRange = (frames: Uint8Array[], index: number, payloadLength: number) => {
  let offset = 24;
  for (let i = 0; i < index; i += 1) offset += 16 + frames[i]!.length;
  const end = offset + 16 + frames[index]!.length;
  return [end - payloadLength, end] as const;
};

// `_src_ranges` as plain [start, end] number pairs; null stays null.
const rangesOf = (value: unknown): Array<[number, number]> | null => {
  if (value === null || value === undefined) return null;
  return Array.from(value as Iterable<{ start: bigint; end: bigint }>, (piece) => [
    Number(piece.start),
    Number(piece.end),
  ]);
};

const udpDnsPacket = (name: string) =>
  ethFrame({
    etherType: 0x0800,
    payload: ipv4({
      protocol: 17,
      src: '10.0.0.9',
      dst: '10.0.0.8',
      payload: udp({ srcPort: 5353, dstPort: 53, payload: dnsQuery({ txId: 7, name, type: 1 }) }),
    }),
  });

describe('exact provenance for reassembled messages', () => {
  it.fails('an interleaved TLS ClientHello covers only its own payload bytes', async () => {
    const record = tlsClientHello({ sni: 'interleaved.example' });
    const third = Math.ceil(record.length / 3);
    const parts = [record.subarray(0, third), record.subarray(third, 2 * third), record.subarray(2 * third)];
    const frames = [
      tcpPacket(0, parts[0]!, 50000, 443),
      udpDnsPacket('noise.example'),
      tcpPacket(third, parts[1]!, 50000, 443),
      tcpPacket(0, new Uint8Array([1, 2, 3]), 41000, 8080), // unrelated flow, unrelated port
      tcpPacket(2 * third, parts[2]!, 50000, 443),
    ];
    const result = await parseAndProjectPcap(capture(frames), new AbortController().signal);
    expect(result.issues).toHaveLength(0);
    const row = findTable(result, 'tls').get(0)!;
    const expected = [
      payloadRange(frames, 0, parts[0]!.length),
      payloadRange(frames, 2, parts[1]!.length),
      payloadRange(frames, 4, parts[2]!.length),
    ].map(([s, e]) => [s, e]);
    expect(rangesOf(row._src_ranges)).toEqual(expected);
    expect(row._src_start).toBe(BigInt(expected[0]![0]!));
    expect(row._src_end).toBe(BigInt(expected[2]![1]!));
  });

  it.fails('an out-of-order interleaved ClientHello keeps file-ordered exact pieces', async () => {
    const record = tlsClientHello({ sni: 'shuffled.example' });
    const third = Math.ceil(record.length / 3);
    const parts = [record.subarray(0, third), record.subarray(third, 2 * third), record.subarray(2 * third)];
    const frames = [
      tcpPacket(third, parts[1]!, 50000, 443),
      udpDnsPacket('noise.example'),
      tcpPacket(2 * third, parts[2]!, 50000, 443),
      tcpPacket(0, parts[0]!, 50000, 443),
    ];
    const result = await parseAndProjectPcap(capture(frames), new AbortController().signal);
    expect(result.issues).toHaveLength(0);
    const row = findTable(result, 'tls').get(0)!;
    // File order, not stream order: part 2 is captured first, part 1 last.
    const expected = [
      payloadRange(frames, 0, parts[1]!.length),
      payloadRange(frames, 2, parts[2]!.length),
      payloadRange(frames, 3, parts[0]!.length),
    ].map(([s, e]) => [s, e]);
    expect(rangesOf(row._src_ranges)).toEqual(expected);
    expect(row._src_start).toBe(BigInt(expected[0]![0]!));
    expect(row._src_end).toBe(BigInt(expected[2]![1]!));
  });

  it.fails('back-to-back DNS-over-TCP segments exclude the second packet headers', async () => {
    const payload = dnsOverTcp({ txId: 0xbeef, name: 'stream.example', type: 1 });
    const frames = [tcpPacket(0, payload.subarray(0, 10)), tcpPacket(10, payload.subarray(10))];
    const result = await parseAndProjectPcap(capture(frames), new AbortController().signal);
    const row = findTable(result, 'dns').get(0)!;
    const first = payloadRange(frames, 0, 10);
    const second = payloadRange(frames, 1, payload.length - 10);
    // 16-byte record header + 54 bytes of Ethernet/IPv4/TCP headers separate the pieces.
    expect(second[0] - first[1]).toBe(16 + 14 + 20 + 20);
    expect(rangesOf(row._src_ranges)).toEqual([
      [first[0], first[1]],
      [second[0], second[1]],
    ]);
  });
});
```

- [ ] **Step 2: Run and confirm they are expected failures**

Run: `pnpm --filter @byteql/pcap test -- --run test/project-pcap.test.ts`
Expected: PASS overall, with the three `it.fails` cases reported as expected failures (the
assertion on `_src_ranges` fails because the column does not exist yet). If any of them passes
unexpectedly, vitest reports it as a failure: stop and re-read the code, because the defect
premise is wrong.

- [ ] **Step 3: Commit**

```bash
git add packages/formats/pcap/test/project-pcap.test.ts
git commit -m "test(pcap): reproduce bounding-span provenance for reassembled messages"
```

---

### Task 2: DuckDB support for the ranges shape, with the runtime gate

Admit exactly `List<Struct<start: Uint64, end: Uint64>>` in `packages/db`, and prove it in the
real pinned runtime before any engine work depends on it. **This task is a gate:** if Step 9's
e2e fails on `eh`, stop and report; do not cast around it.

**Files:**

- Modify: `packages/db/src/result-columns.ts` (add `isSourceRangesType`)
- Modify: `packages/db/src/index.ts` (re-export)
- Modify: `packages/db/src/export-types.ts:20-29`
- Modify: `packages/db/src/result-sort.ts:78-95`
- Modify: `packages/db/src/browser.ts:162-184` (DDL map)
- Modify: `packages/db/src/sort-probe.ts:473-541` (typed fixture)
- Modify: `packages/db/src/export-probe.ts:565-577` (typed original)
- Modify: `apps/web/e2e/results-export-probe.spec.ts:27-47` (expected types)
- Create: `apps/web/e2e/source-ranges-sql.spec.ts`
- Test: `packages/db/src/result-columns.test.ts`, `packages/db/src/result-sort.test.ts`,
  `packages/db/src/export-parquet.test.ts`

**Interfaces:**

- Produces: `isSourceRangesType(type: DataType): boolean` and
  `resultSortKeyRefusal(field: Field): string | null`, both defined in `result-columns.ts` and
  exported from `@byteql/db` and `@byteql/db/result-columns` (the light subpath the UI imports);
  DDL mapping for column type string `'src_ranges'`.

- [ ] **Step 1: Write failing unit tests for the predicate**

Append to `packages/db/src/result-columns.test.ts`:

```ts
import { Field, Int64, List, Struct, Uint32, Uint64, Utf8 } from 'apache-arrow';
import { isSourceRangesType } from './result-columns.js';

const piece = (startType = new Uint64(), endType = new Uint64(), names = ['start', 'end']) =>
  new Struct([new Field(names[0]!, startType, true), new Field(names[1]!, endType, true)]);
const listOf = (item: Struct) => new List(new Field('item', item, true));

describe('isSourceRangesType', () => {
  it('accepts List<Struct<start: Uint64, end: Uint64>>', () => {
    expect(isSourceRangesType(listOf(piece()))).toBe(true);
  });
  it('rejects wrong field names, order, widths, signedness, and non-list types', () => {
    expect(isSourceRangesType(listOf(piece(undefined, undefined, ['end', 'start'])))).toBe(false);
    expect(isSourceRangesType(listOf(piece(undefined, undefined, ['s', 'e'])))).toBe(false);
    expect(isSourceRangesType(listOf(piece(new Uint32(), new Uint64())))).toBe(false);
    expect(isSourceRangesType(listOf(piece(new Int64(), new Int64())))).toBe(false);
    expect(isSourceRangesType(new List(new Field('item', new Utf8(), true)))).toBe(false);
    expect(isSourceRangesType(piece())).toBe(false);
    expect(isSourceRangesType(new Uint64())).toBe(false);
  });
  it('rejects a struct with an extra field', () => {
    const three = new Struct([
      new Field('start', new Uint64(), true),
      new Field('end', new Uint64(), true),
      new Field('x', new Uint64(), true),
    ]);
    expect(isSourceRangesType(listOf(three))).toBe(false);
  });
});
```

If the file's existing imports already pull from `apache-arrow`/`vitest`, merge the imports
instead of duplicating them.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/db test -- --run src/result-columns.test.ts`
Expected: FAIL — `isSourceRangesType` is not exported.

- [ ] **Step 3: Implement the predicate**

In `packages/db/src/result-columns.ts` add (merge `DataType` into its existing `apache-arrow`
import):

```ts
const isUint64 = (type: DataType): boolean =>
  DataType.isInt(type) && !type.isSigned && type.bitWidth === 64;

/**
 * The one nested shape ByteQL admits: exact source byte ranges, `List<Struct<start, end>>` with
 * both fields unsigned 64-bit, in that order. Structural, not name-based, so an aliased column
 * still qualifies; general nested types stay unsupported everywhere.
 */
export const isSourceRangesType = (type: DataType): boolean => {
  if (!DataType.isList(type)) return false;
  const item = type.children[0]?.type;
  if (!item || !DataType.isStruct(item) || item.children.length !== 2) return false;
  const [start, end] = item.children;
  return start!.name === 'start' && end!.name === 'end' && isUint64(start!.type) && isUint64(end!.type);
};
```

Re-export it from `packages/db/src/index.ts` next to the existing `result-columns` exports.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @byteql/db test -- --run src/result-columns.test.ts`
Expected: PASS.

- [ ] **Step 5: Failing tests for sort and Parquet admission**

Append to `packages/db/src/result-sort.test.ts`:

```ts
import { Field, List, Schema, Struct, Uint64 } from 'apache-arrow';
import { resultSortKeyRefusal } from './result-columns.js';
import { resultSortEligibility } from './result-sort.js';

const rangesField = new Field(
  '_src_ranges',
  new List(
    new Field(
      'item',
      new Struct([new Field('start', new Uint64(), true), new Field('end', new Uint64(), true)]),
      true,
    ),
  ),
  true,
);

describe('source ranges in sorting', () => {
  it('admits a ranges column as a passenger', () => {
    expect(resultSortEligibility(new Schema([new Field('n', new Uint64()), rangesField]))).toEqual({
      supported: true,
    });
  });
  it('refuses a ranges column as the sort key', () => {
    expect(resultSortKeyRefusal(rangesField)).toBe("Byte ranges can't be sorted.");
    expect(resultSortKeyRefusal(new Field('n', new Uint64()))).toBeNull();
  });
});
```

Append to `packages/db/src/export-parquet.test.ts` (merge imports):

```ts
import { isSupportedParquetType } from './export-types.js';

it('admits the source ranges shape for Parquet export', () => {
  const type = new List(
    new Field(
      'item',
      new Struct([new Field('start', new Uint64(), true), new Field('end', new Uint64(), true)]),
      true,
    ),
  );
  expect(isSupportedParquetType(type)).toBe(true);
  expect(isSupportedParquetType(new List(new Field('item', new Uint64(), true)))).toBe(false);
});
```

Run: `pnpm --filter @byteql/db test -- --run src/result-sort.test.ts src/export-parquet.test.ts`
Expected: FAIL — `resultSortKeyRefusal` missing; list rejected by the whitelist.

- [ ] **Step 6: Implement admission**

`packages/db/src/export-types.ts` — import `isSourceRangesType` from `./result-columns.js` and
append one clause to `isSupportedParquetType`:

```ts
  (DataType.isTimestamp(type) && (type.unit === TimeUnit.MICROSECOND || type.unit === TimeUnit.NANOSECOND)) ||
  isSourceRangesType(type);
```

`packages/db/src/result-sort.ts` — the existing `isSupportedSortType` builds on
`isSupportedParquetType`, so ranges columns become passengers automatically. Add the key refusal
to `result-columns.ts` (next to `isSourceRangesType`; add `Field` to its type imports) and
re-export it from `index.ts`:

```ts
/** Why `field` cannot be the sort key even when the result as a whole is sortable, or null. */
export function resultSortKeyRefusal(field: Field): string | null {
  return isSourceRangesType(field.type) ? "Byte ranges can't be sorted." : null;
}
```

Then, in `result-sort.ts`, find where the sort request validates the chosen key column (search `result-sort.ts` and
`sort-result.ts` for the column-index check) and throw
`new ResultSortError('SORT_UNSUPPORTED_TYPE', refusal)` when `resultSortKeyRefusal` returns a
string, so a programmatic request cannot bypass the disabled header.

`packages/db/src/browser.ts` — add to `ARROW_TYPE_TO_DUCKDB_TYPE`:

```ts
  src_ranges: 'STRUCT("start" UBIGINT, "end" UBIGINT)[]',
```

- [ ] **Step 7: Run unit tests**

Run: `pnpm --filter @byteql/db test -- --run`
Expected: PASS.

- [ ] **Step 8: Add runtime-gate fixtures**

`packages/db/src/sort-probe.ts`, inside the `fixtures` array (after `boolean`):

```ts
      {
        // The one admitted nested shape: exact source byte ranges as a passenger column.
        name: 'source-ranges',
        sql:
          'SELECT * FROM (VALUES ' +
          "(2, [{'start': 10::UBIGINT, 'end': 20::UBIGINT}, {'start': 90::UBIGINT, 'end': 18446744073709551615::UBIGINT}]), " +
          '(1, NULL::STRUCT("start" UBIGINT, "end" UBIGINT)[])) t(ord, _src_ranges)',
        columnIndex: 0,
      },
```

`columnKeys` must render list values deterministically for the permutation check. Find
`columnKeys` in `sort-probe.ts`; if it stringifies with `String(value)`, a list `Vector` renders
as its `toString()`, which includes every struct value — acceptable. If it special-cases types,
add: `if (value && typeof value === 'object' && Symbol.iterator in value) return JSON.stringify(Array.from(value as Iterable<{start: bigint; end: bigint}>, (p) => [String(p.start), String(p.end)]));`.

`packages/db/src/export-probe.ts` — extend `__typed_original` with a trailing column and its null
counterpart:

```sql
        TIMESTAMPTZ '2026-09-04 01:02:03.123456+00' ts_tz,
        [{'start': 1::UBIGINT, 'end': 2::UBIGINT}, {'start': 5::UBIGINT, 'end': 18446744073709551615::UBIGINT}] src_ranges
        UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
        NULL,NULL,''::BLOB,NULL,NULL,NULL,NULL,NULL,NULL`);
```

`apps/web/e2e/results-export-probe.spec.ts` — append `'STRUCT("start" UBIGINT, "end" UBIGINT)[]'`
to the expected `parquetTypes` list after `'TIMESTAMP WITH TIME ZONE'`. (If DuckDB's `DESCRIBE`
prints the struct without quotes, e.g. `STRUCT("start" UBIGINT, "end" UBIGINT)[]` vs
`STRUCT(start UBIGINT, "end" UBIGINT)[]`, pin the exact string the runtime reports and note it in
the spec's Implementation notes.)

Create `apps/web/e2e/source-ranges-sql.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

import { openMidiSample, runSql } from './support/app.js';

// Pins the DuckDB SQL the hex filter relies on: the lambda syntax and the quoted "end" field.
test('list_filter with lambda syntax over source ranges', async ({ page }) => {
  await openMidiSample(page);
  await runSql(
    page,
    'select len(list_filter(r, lambda p: p.start < 15 and p."end" > 12)) as hits from ' +
      "(select [{'start': 10::UBIGINT, 'end': 20::UBIGINT}, {'start': 30::UBIGINT, 'end': 40::UBIGINT}] as r)",
  );
  await expect(page.getByRole('gridcell', { name: '1', exact: true })).toBeVisible();
});
```

Check `apps/web/e2e/support/app.ts` for `runSql`'s exact signature and how other specs assert a
single result cell (e.g. `duplicate-result-columns.spec.ts`); match that idiom if `gridcell` by
name is not how cells are exposed.

- [ ] **Step 9: Run the gate**

Run:

```bash
pnpm --filter @byteql/web test:e2e -- result-sort-probe.spec.ts results-export-probe.spec.ts source-ranges-sql.spec.ts
```

Expected: PASS. `eh` must admit `source-ranges` in `typedFixtures`; `mvp` sorting is already
refused wholesale, so its typed fixtures are not asserted. The export gate runs both bundles: if
`mvp` fails only the new Parquet column, **stop and report** — the spec has no mvp-specific
export refusal, and adding one is a design change. If the lambda test fails with a parser error,
replace `lambda p: …` with `p -> …`, rerun, and record which syntax passed; Task 8 uses the same.

- [ ] **Step 10: Record results and commit**

Replace the spec's `## Implementation notes` placeholder line with a dated bullet list: the
`parquetTypes` string, the lambda syntax that passed, and the two bundles' outcomes.

```bash
git add packages/db apps/web/e2e/results-export-probe.spec.ts apps/web/e2e/source-ranges-sql.spec.ts \
  docs/superpowers/specs/2026-09-22-exact-reassembled-provenance-design.md
git commit -m "feat(db): admit source byte ranges through ingest, sorting, and Parquet export"
```

---

### Task 3: Engine type and normalization

**Files:**

- Modify: `packages/core/src/projection/streams.ts` (append)
- Modify: `packages/core/src/projection/spec.ts:5-17` (union only; not the zod enum at 89-102)
- Modify: `packages/core/src/arrow/build.ts`
- Test: `packages/core/src/projection/streams.test.ts`, `packages/core/src/arrow/build.test.ts`

**Interfaces:**

- Produces: `interface SourcePiece { start: number; end: number }`;
  `normalizeRanges(pieces: readonly SourcePiece[]): SourcePiece[] | null`;
  `ArrowTypeName` includes `'src_ranges'`; `SRC_RANGES_ARROW_TYPE: List<Struct>` exported from
  `build.ts`; `columnVector(values, 'src_ranges', table, column)` accepts
  `null | ReadonlyArray<{ start: bigint | number; end: bigint | number }>`.

- [ ] **Step 1: Failing tests**

Append to `packages/core/src/projection/streams.test.ts`:

```ts
import { normalizeRanges } from './streams.js';

describe('normalizeRanges', () => {
  it('sorts by start and keeps gapped pieces', () => {
    expect(normalizeRanges([{ start: 50, end: 60 }, { start: 10, end: 20 }])).toEqual([
      { start: 10, end: 20 },
      { start: 50, end: 60 },
    ]);
  });
  it('merges touching and overlapping pieces', () => {
    expect(
      normalizeRanges([
        { start: 10, end: 20 },
        { start: 20, end: 25 },
        { start: 22, end: 30 },
        { start: 40, end: 41 },
      ]),
    ).toEqual([
      { start: 10, end: 30 },
      { start: 40, end: 41 },
    ]);
  });
  it('returns null for a single piece, after merging, and for empty input', () => {
    expect(normalizeRanges([{ start: 1, end: 5 }])).toBeNull();
    expect(normalizeRanges([{ start: 1, end: 5 }, { start: 5, end: 9 }])).toBeNull();
    expect(normalizeRanges([])).toBeNull();
  });
  it('drops empty pieces', () => {
    expect(normalizeRanges([{ start: 3, end: 3 }, { start: 1, end: 2 }, { start: 5, end: 6 }])).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ]);
  });
  it('does not mutate its input', () => {
    const input = [{ start: 20, end: 30 }, { start: 10, end: 20 }];
    normalizeRanges(input);
    expect(input).toEqual([{ start: 20, end: 30 }, { start: 10, end: 20 }]);
  });
});
```

Append to `packages/core/src/arrow/build.test.ts` (merge imports):

```ts
import { columnVector } from './build.js';

describe('src_ranges vectors', () => {
  it('builds List<Struct<start, end>> with nulls', () => {
    const vector = columnVector(
      [[{ start: 1n, end: 4n }, { start: 9n, end: 12n }], null],
      'src_ranges',
      't',
      '_src_ranges',
    );
    expect(String(vector.type)).toContain('List');
    const first = Array.from(vector.get(0) as Iterable<{ start: bigint; end: bigint }>, (p) => [p.start, p.end]);
    expect(first).toEqual([[1n, 4n], [9n, 12n]]);
    expect(vector.get(1)).toBeNull();
  });
  it.each([
    ['one piece', [{ start: 1n, end: 4n }]],
    ['empty piece', [{ start: 1n, end: 1n }, { start: 5n, end: 6n }]],
    ['touching', [{ start: 1n, end: 4n }, { start: 4n, end: 6n }]],
    ['unsorted', [{ start: 9n, end: 12n }, { start: 1n, end: 4n }]],
  ])('rejects an invariant violation: %s', (_label, value) => {
    expect(() => columnVector([value], 'src_ranges', 't', '_src_ranges')).toThrow(/SRC_RANGES_INVALID/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core test -- --run src/projection/streams.test.ts src/arrow/build.test.ts`
Expected: FAIL — `normalizeRanges` not exported; `'src_ranges'` not a type.

- [ ] **Step 3: Implement**

Append to `packages/core/src/projection/streams.ts`:

```ts
/** A half-open absolute file byte range `[start, end)`. */
export interface SourcePiece {
  start: number;
  end: number;
}

/**
 * Canonical exact-provenance form: empty pieces dropped, sorted by start, overlapping or
 * touching pieces merged. Null when at most one piece remains — a single range is already exact
 * and is expressed by `_src_start`/`_src_end` alone.
 */
export const normalizeRanges = (pieces: readonly SourcePiece[]): SourcePiece[] | null => {
  const sorted = pieces
    .filter((piece) => piece.end > piece.start)
    .map((piece) => ({ start: piece.start, end: piece.end }))
    .sort((a, b) => a.start - b.start);
  const merged: SourcePiece[] = [];
  for (const piece of sorted) {
    const last = merged[merged.length - 1];
    if (last && piece.start <= last.end) last.end = Math.max(last.end, piece.end);
    else merged.push(piece);
  }
  return merged.length >= 2 ? merged : null;
};
```

`packages/core/src/projection/spec.ts` — add `| 'src_ranges'` to the `ArrowTypeName` union with a
comment `// engine-internal (_src_ranges); never accepted by the spec schema below`. Leave the zod
`arrowType` enum unchanged, so specs still cannot declare it.

`packages/core/src/arrow/build.ts` — add `Field`, `List`, `Struct` to the `apache-arrow` import,
then:

```ts
const SRC_RANGE_PIECE_TYPE = new Struct([
  new Field('start', new Uint64(), false),
  new Field('end', new Uint64(), false),
]);
export const SRC_RANGES_ARROW_TYPE = new List(new Field('item', SRC_RANGE_PIECE_TYPE, false));

// Enforces the `_src_ranges` contract (≥2 pieces, sorted, strictly gapped, non-empty) on every
// value. A violation is an engine bug, never input data, so it throws instead of nulling.
const srcRangesValues = (values: readonly unknown[], table: string, column: string): readonly unknown[] =>
  values.map((value) => {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value) || value.length < 2) {
      throw new Error(`SRC_RANGES_INVALID: ${table}.${column} needs at least two pieces or null`);
    }
    let previousEnd = -1n;
    return value.map((piece: { start: number | bigint; end: number | bigint }) => {
      const start = requireUint64(piece.start, table, column);
      const end = requireUint64(piece.end, table, column);
      if (end <= start || start <= previousEnd) {
        throw new Error(
          `SRC_RANGES_INVALID: ${table}.${column} piece [${start}, ${end}) is empty, unsorted, or not separated from the previous piece`,
        );
      }
      previousEnd = end;
      return { start, end };
    });
  });
```

Add `case 'src_ranges': return SRC_RANGES_ARROW_TYPE;` to `arrowType`, and route it in
`columnVector`:

```ts
export const columnVector = (values, type, table, column): Vector =>
  type === 'timestamp_us'
    ? timestampMicrosecondVector(values, table, column)
    : type === 'src_ranges'
      ? vectorFromArray(srcRangesValues(values, table, column), SRC_RANGES_ARROW_TYPE)
      : vectorFromArray(valuesForType(values, type, table, column), arrowType(type));
```

(keep the existing parameter types on the real signature). Note: `previousEnd` starts at `-1n`,
so a first piece starting at `0` is accepted.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @byteql/core test -- --run && pnpm --filter @byteql/core check`
Expected: PASS. If `check` reports a non-exhaustive `switch` over `ArrowTypeName` elsewhere, add a
`'src_ranges'` arm that throws `new Error('src_ranges is engine-internal')` — declared columns can
never reach it.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): add the src_ranges column type and range normalization"
```

---

### Task 4: Compile-time marking and reserved name

**Files:**

- Modify: `packages/core/src/projection/project.ts` (`reservedOutputNames` :110,
  `CompiledProjectionTable` ~:50-58, pre-scan ~:208-216, table compile ~:296-298, stream rule 3
  ~:503-516, `tableOutputTypes` :1037-1048)
- Test: `packages/core/src/projection/stream-compile.test.ts`

**Interfaces:**

- Consumes: `ArrowTypeName` `'src_ranges'` (Task 3).
- Produces: `CompiledProjectionTable.boundedProvenance: boolean`; `tableOutputTypes` appends
  `_src_ranges: 'src_ranges'` last for marked tables.
- [ ] **Step 1: Failing tests**

`stream-compile.test.ts` has a `validYaml` stream spec (tables `records`, `chunks`, `flows`,
`msgs`; stream `byte_stream` with `messages: [{ parser: msg_parser, table: msgs }]`) and a
registry/stream-registries pair. Append, reusing those names:

```ts
import { tableOutputTypes } from './project.js';

describe('bounded provenance marking', () => {
  const compileYaml = (source: string) => compileProjection(parseProjectionSpec(source), registry, streamRegistries);
  const table = (compiled: ReturnType<typeof compileYaml>, name: string) =>
    compiled.tables.find((candidate) => candidate.name === name)!;

  it('marks message-fed and flow tables only, and appends _src_ranges last', () => {
    const compiled = compileYaml(validYaml);
    expect(table(compiled, 'msgs').boundedProvenance).toBe(true);
    expect(table(compiled, 'flows').boundedProvenance).toBe(true);
    expect(table(compiled, 'records').boundedProvenance).toBe(false);
    expect(table(compiled, 'chunks').boundedProvenance).toBe(false);
    const keys = Object.keys(tableOutputTypes(table(compiled, 'msgs')));
    expect(keys.slice(-3)).toEqual(['_src_start', '_src_end', '_src_ranges']);
    expect(tableOutputTypes(table(compiled, 'msgs'))._src_ranges).toBe('src_ranges');
    expect('_src_ranges' in tableOutputTypes(table(compiled, 'records'))).toBe(false);
  });

  it('marks tables reachable by a deeper dissect from a message parser or message table', () => {
    const deeper = validYaml
      .replace(
        'dissect:',
        `  - name: words
    rows: $.word
    key: word_id
    parent_key: { table: records, column: record_id }
    columns:
      w: { expr: '_.w', type: utf8 }
dissect:
  - from: msg_parser
    payload: _.message.body
    chain:
      - { when: 'true', parser: word_parser, table: words }`,
      );
    const compiled = compileProjection(
      parseProjectionSpec(deeper),
      new Map([...registry, ['word_parser', () => ({ root: { word: { w: 'x' } } })]]),
      streamRegistries,
    );
    expect(table(compiled, 'words').boundedProvenance).toBe(true);
  });

  it('rejects a declared _src_ranges column', () => {
    const bad = validYaml.replace("text: { expr: '_.text', type: utf8 }", "_src_ranges: { expr: '_.text', type: utf8 }");
    expect(() => compileYaml(bad)).toThrow(ProjectionCompileError);
  });

  it('rejects a stream fed from a bounded-provenance table', () => {
    const bad = validYaml.replace(
      'streams:',
      `  - from: msgs
    payload: _.body
    chain:
      - { when: 'true', stream: byte_stream }
streams:`,
    );
    expect(() => compileYaml(bad)).toThrow(/bounded provenance/);
  });
});
```

Adapt the two `replace` anchors to the exact text in `validYaml` (read it first); the intent is:
a `words` table under a `from: msg_parser` dissect, and a second stream feed rooted at `msgs`. If
the "stream fed from two tables" rule (rule 3) fires first for the last case, give that feed its
own second stream entry instead, so the new rule is the one under test.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core test -- --run src/projection/stream-compile.test.ts`
Expected: FAIL — `boundedProvenance` undefined.

- [ ] **Step 3: Implement**

1. `reservedOutputNames` → `new Set(['_src_start', '_src_end', '_src_ranges', '_src_file'])`.
2. Add to `CompiledProjectionTable`, beside `streamFed`:

```ts
  // Rows may carry a bounding span: stream-fed message tables, stream flow tables, and every
  // table a dissect chain reaches from a message parser or message table. tableOutputTypes
  // appends the engine-owned `_src_ranges` column for these.
  readonly boundedProvenance: boolean;
```

3. Next to the `streamFedNames` pre-scan, compute the marked set from the raw spec:

```ts
  const boundedProvenanceNames = (() => {
    const streams = spec.streams ?? [];
    const reached = new Set<string>();
    const queue: string[] = [];
    const visit = (name: string | undefined) => {
      if (name === undefined || reached.has(name)) return;
      reached.add(name);
      queue.push(name);
    };
    for (const stream of streams) {
      for (const message of stream.messages) {
        visit(message.parser);
        visit(message.table);
      }
    }
    while (queue.length > 0) {
      const from = queue.shift()!;
      for (const entry of spec.dissect ?? []) {
        if (entry.from !== from) continue;
        for (const link of entry.chain) {
          visit(link.parser);
          visit(link.table);
        }
      }
    }
    for (const stream of streams) reached.add(stream.table);
    return reached;
  })();
```

Use the real spec field names (`message.parser`, `link.parser`, `link.table`, `stream.table`) as
typed in `spec.ts`; adjust if they differ.

4. In the table compile loop set `boundedProvenance: boundedProvenanceNames.has(table.name)`.
5. In the stream-link branch, immediately after the rule 1/rule 2 checks and **before** the
   rule 3 feed-table comparison (so this rule, not rule 3 or the rule 5 cycle check, reports a
   message-rooted feed):

```ts
        if (boundedProvenanceNames.has(entry.from)) {
          throw new ProjectionCompileError(
            `${linkPath}.stream`,
            `stream ${JSON.stringify(link.stream)} cannot be fed from ${JSON.stringify(entry.from)}: its rows have bounded provenance`,
          );
        }
```

(match `ProjectionCompileError`'s real constructor argument order as used elsewhere in the file).

6. `tableOutputTypes`: after `types._src_end = 'uint64';` add
   `if (table.boundedProvenance) types._src_ranges = 'src_ranges';`.

- [ ] **Step 4: Run core tests and typecheck**

Run: `pnpm --filter @byteql/core test -- --run && pnpm --filter @byteql/core check`
Expected: PASS. Existing stream-runtime tests still pass: the new column is null-filled by
`TableBatchBuilder.appendRow` for rows that do not set it.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): mark bounded-provenance tables and reserve _src_ranges"
```

---

### Task 5: Emit exact ranges for messages, flows, and message descendants

**Files:**

- Modify: `packages/core/src/projection/project.ts` (`EmitContext` :951, `emitStreamMessage`
  :1400-1473, `projectChildTable` :1475-1538, `flushStreams` :1582-1673, and every place an
  `EmitContext` literal is built — search `const emitContext: EmitContext` and
  `session.ts`)
- Test: `packages/core/src/projection/stream-runtime.test.ts`

**Interfaces:**

- Consumes: `normalizeRanges`, `SourcePiece` (Task 3); `boundedProvenance` (Task 4).
- Produces: `_src_ranges` values on engine output (`Array<{ start: bigint; end: bigint }> | null`).
- [ ] **Step 1: Failing tests**

Append to `stream-runtime.test.ts` (its geometry: record *n*'s chunk sits at file offset
`n*100`, and the chunk payload starts 2 bytes in):

```ts
const ranges = (value: unknown) =>
  value === null ? null : Array.from(value as Iterable<{ start: bigint; end: bigint }>, (p) => [p.start, p.end]);

describe('exact source ranges', () => {
  it('gives a multi-chunk message its exact pieces and keeps the span', () => {
    // Message [4, a, b, c, d]: chunk 0 payload file [2, 5), chunk 1 payload file [102, 104).
    const { finished } = project([chunk(7, 0, [4, 97, 98]), chunk(7, 3, [99, 100])]);
    const msgs = table(finished, 'msgs');
    expect(ranges(msgs.arrow.getChild('_src_ranges')!.get(0))).toEqual([[2n, 5n], [102n, 104n]]);
    expect(msgs.arrow.getChild('_src_start')!.get(0)).toBe(2n);
    expect(msgs.arrow.getChild('_src_end')!.get(0)).toBe(104n);
  });

  it('leaves a single-chunk message null', () => {
    const { finished } = project([chunk(7, 0, [2, 65, 66])]);
    expect(table(finished, 'msgs').arrow.getChild('_src_ranges')!.get(0)).toBeNull();
  });

  it('clips pieces to the message, as the existing span test does', () => {
    // Same geometry as 'computes exact provenance spans per message': message 1 is file [2, 4)
    // (single piece → null); message 2 is file [4, 5) + [102, 104).
    const { finished } = project([chunk(7, 0, [1, 65, 2]), chunk(7, 3, [66, 67])]);
    const column = table(finished, 'msgs').arrow.getChild('_src_ranges')!;
    expect(column.get(0)).toBeNull();
    expect(ranges(column.get(1))).toEqual([[4n, 5n], [102n, 104n]]);
  });

  it('orders pieces by file offset for an out-of-order capture', () => {
    // Stream bytes 3.. arrive first (record 0, file [2, 4)); bytes 0..2 arrive second (record 1,
    // file [102, 105)). File order puts the stream-later piece first.
    const { finished } = project([chunk(7, 3, [99, 100]), chunk(7, 0, [4, 97, 98])]);
    expect(ranges(table(finished, 'msgs').arrow.getChild('_src_ranges')!.get(0))).toEqual([
      [2n, 4n],
      [102n, 105n],
    ]);
  });

  it('gives a flow row every accepted contribution, excluding duplicates', () => {
    const { finished } = project([
      chunk(7, 0, [4, 97, 98]),
      chunk(7, 0, [4, 97, 98]), // exact duplicate: dropped, never recorded
      chunk(7, 3, [99, 100]),
    ]);
    expect(ranges(table(finished, 'flows').arrow.getChild('_src_ranges')!.get(0))).toEqual([
      [2n, 5n],
      [202n, 204n],
    ]);
  });

  it('leaves a rejected-first-contribution flow null with its fallback span', () => {
    const big70 = Array.from({ length: 70 }, (_, i) => i % 251);
    const { finished } = project([chunk(7, 0, big70)]);
    const flows = table(finished, 'flows');
    expect(flows.arrow.getChild('_src_ranges')!.get(0)).toBeNull();
    expect(flows.arrow.getChild('_src_start')!.get(0)).toBe(2n);
  });
});
```

Also add one deeper-dissect test with a local YAML variant (copy `yaml`, add a `words` table fed
by `from: msg_parser` with a `word_parser` whose `resolve` would report a sub-range) and assert
that each `words` row carries the parent message's `_src_start`, `_src_end`, and `_src_ranges`
exactly — not `span.start + offset`:

```ts
  it('gives deeper dissect rows their message provenance', () => {
    const deeperYaml = yaml
      .replace(
        '  - name: msgs',
        `  - name: words
    rows: $.word
    key: word_id
    parent_key: { table: records, column: record_id }
    columns:
      w: { expr: '_.w', type: utf8 }
  - name: msgs`,
      )
      .replace(
        'streams:',
        `  - from: msg_parser
    payload: _.message.body
    chain:
      - { when: 'true', parser: word_parser, table: words }
streams:`,
      );
    const deeperRegistry: ParserRegistry = new Map([
      ...registry,
      [
        'msg_parser',
        (bytes: Uint8Array) => ({
          root: {
            message: { text: new TextDecoder().decode(bytes.subarray(1)), body: { bytes: bytes.subarray(1), start: 1 } },
          },
        }),
      ],
      [
        'word_parser',
        () => ({ root: { word: { w: 'x' } }, resolve: () => ({ start: 1, end: 2 }) }),
      ],
    ]);
    const compiled = compileProjection(parseProjectionSpec(deeperYaml), deeperRegistry, streamRegistries);
    const session = createProjectionSession(compiled, { issues: new IssueCollector() });
    session.project(
      { records: [chunk(7, 0, [4, 97, 98]), chunk(7, 3, [99, 100])].map((bytes, index) => ({ n: index, body: { bytes, start: index * 100 } })) },
      { resolve: () => ({ start: 0, end: 4 }) },
    );
    const words = table(session.finish(), 'words');
    expect(words.rowCount).toBe(1);
    expect(words.arrow.getChild('_src_start')!.get(0)).toBe(2n);
    expect(words.arrow.getChild('_src_end')!.get(0)).toBe(104n);
    expect(ranges(words.arrow.getChild('_src_ranges')!.get(0))).toEqual([[2n, 5n], [102n, 104n]]);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core test -- --run src/projection/stream-runtime.test.ts`
Expected: FAIL — `_src_ranges` is null everywhere.

- [ ] **Step 3: Implement**

1. `EmitContext` gains a mutable field:

```ts
  // Set only while emitStreamMessage is emitting a message's rows: every row projected beneath it
  // (message tables and deeper dissect tables alike) inherits the message's provenance instead
  // of composing offsets against the span start, which is meaningless once the span has gaps.
  inherited?: InheritedProvenance | null;
```

with, near `StreamSegmentRecord`:

```ts
export interface InheritedProvenance {
  readonly span: SourceRange;
  readonly ranges: readonly { start: bigint; end: bigint }[] | null;
}

const toColumnRanges = (pieces: readonly SourcePiece[] | null) =>
  pieces?.map((piece) => ({ start: BigInt(piece.start), end: BigInt(piece.end) })) ?? null;
```

(import `normalizeRanges`, `type SourcePiece` from `./streams.js`).

2. `emitStreamMessage`: replace the min/max loop with piece collection:

```ts
  const pieces: SourcePiece[] = boundary.map((s) => ({
    start: s.srcStart + Math.max(0, messageStart - s.start),
    end: s.srcStart + Math.min(s.end - s.start, messageEnd - s.start),
  }));
  const exact = normalizeRanges(pieces);
  let spanStart = Infinity;
  let spanEnd = -Infinity;
  for (const piece of pieces) {
    if (piece.start < spanStart) spanStart = piece.start;
    if (piece.end > spanEnd) spanEnd = piece.end;
  }
  const span: SourceRange = { start: spanStart, end: spanEnd };
  const inherited: InheritedProvenance = { span, ranges: toColumnRanges(exact) };
```

Keep the existing explanatory comment, updated to say the pieces are kept. Wrap the
`for (const link of stream.messages)` loop in:

```ts
  const previous = emitContext.inherited ?? null;
  emitContext.inherited = inherited;
  try {
    // …existing loop, unchanged except: projectChildTable's last argument becomes
    //   { streamId: entry.streamId, span, ranges: inherited.ranges }
  } finally {
    emitContext.inherited = previous;
  }
```

3. `projectChildTable`: widen `streamMeta` to
   `{ streamId: bigint; span: SourceRange; ranges: InheritedProvenance['ranges'] }` and resolve
   provenance in this order:

```ts
  const inherited = streamMeta ?? emitContext.inherited ?? null;
  const resolver: ProvenanceResolver = inherited
    ? { resolve: () => inherited.span } // (keep the existing comment, extended to deeper tables)
    : { /* existing payload-relative resolver, unchanged */ };
  const extraColumns: Record<string, unknown> | undefined = streamMeta
    ? { stream_id: streamMeta.streamId, _src_ranges: streamMeta.ranges }
    : inherited && table.boundedProvenance
      ? { _src_ranges: inherited.ranges }
      : undefined;
```

and pass `extraColumns` as `emitRow`'s `extraColumns` argument.

4. `flushStreams`: before the flow `emitRow`, compute

```ts
      const flowRanges = toColumnRanges(
        normalizeRanges(entry.segments.map((record) => ({ start: record.srcStart, end: record.srcEnd }))),
      );
```

and pass `{ _src_ranges: flowRanges }` as `extraColumns` (the argument currently `undefined`
right before `entry.streamId`). `entry.segments` holds accepted contributions only, so
duplicates cannot appear.

5. Every place that constructs an `EmitContext` object literal keeps compiling without change
   (the field is optional).

- [ ] **Step 4: Run all core tests**

Run: `pnpm --filter @byteql/core test -- --run && pnpm --filter @byteql/core check`
Expected: PASS, including the unchanged `computes exact provenance spans per message` test
(spans are identical).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): emit exact source ranges for reassembled messages and flows"
```

---

### Task 6: pcap pack wiring and green reproductions

**Files:**

- Modify: `packages/formats/pcap/src/project-pcap.ts:65-77` (`pcapNullability`)
- Modify: `packages/formats/pcap/src/pack.ts` (`PCAP_TABLE_SCHEMAS` for `dns`, `tls`, `streams`)
- Modify: `packages/formats/pcap/test/project-pcap.test.ts` (flip `it.fails` → `it`; add tests)
- Test: `packages/formats/pcap/test/pack.test.ts` (run; update only if it hard-codes schemas)

**Interfaces:**

- Consumes: engine `_src_ranges` (Task 5); DDL mapping `'src_ranges'` (Task 2).
- Produces: pcap tables `dns`, `tls`, `streams` with `_src_ranges` after `_src_end`.
- [ ] **Step 1: Flip reproductions and add regression tests**

Change the three `it.fails(` in the Task 1 block to `it(`. Add inside the same `describe`:

```ts
  it('keeps UDP DNS rows exact (null) beside a reassembled TCP DNS row', async () => {
    const payload = dnsOverTcp({ txId: 1, name: 'tcp.example', type: 1 });
    const frames = [udpDnsPacket('udp.example'), tcpPacket(0, payload.subarray(0, 9)), tcpPacket(9, payload.subarray(9))];
    const result = await parseAndProjectPcap(capture(frames), new AbortController().signal);
    const dnsT = findTable(result, 'dns');
    const byName = new Map(Array.from({ length: dnsT.numRows }, (_, i) => [dnsT.get(i)!.query_name, dnsT.get(i)!]));
    expect(byName.get('udp.example')!._src_ranges).toBeNull();
    expect(rangesOf(byName.get('tcp.example')!._src_ranges)).toHaveLength(2);
  });

  it('gives a flow row its accepted segment payloads', async () => {
    const payload = dnsOverTcp({ txId: 2, name: 'flow.example', type: 1 });
    const frames = [tcpPacket(0, payload.subarray(0, 9)), udpDnsPacket('x.example'), tcpPacket(9, payload.subarray(9))];
    const result = await parseAndProjectPcap(capture(frames), new AbortController().signal);
    const flow = findTable(result, 'streams').get(0)!;
    expect(rangesOf(flow._src_ranges)).toEqual([
      [...payloadRange(frames, 0, 9)],
      [...payloadRange(frames, 2, payload.length - 9)],
    ]);
  });

  it('leaves the single-segment path exact and unchanged', async () => {
    const payload = dnsOverTcp({ txId: 3, name: 'one.example', type: 1 });
    const frames = [tcpPacket(0, payload)];
    const result = await parseAndProjectPcap(capture(frames), new AbortController().signal);
    const row = findTable(result, 'dns').get(0)!;
    expect(row._src_ranges).toBeNull();
    const [start, end] = payloadRange(frames, 0, payload.length);
    expect([row._src_start, row._src_end]).toEqual([BigInt(start), BigInt(end)]);
  });
```

- [ ] **Step 2: Run to see the pack-level failures**

Run: `pnpm --filter @byteql/pcap test -- --run`
Expected: the reproductions now PASS (engine work is done). Any failure left should be a schema
mismatch in `pack.test.ts` (declared schemas vs emitted tables) — that is Step 3.

- [ ] **Step 3: Update pack schemas and nullability**

`project-pcap.ts` — add `'_src_ranges'` to the `dns`, `tls`, and `streams` sets.
`pack.ts` — in the `dns`, `tls`, and `streams` entries of `PCAP_TABLE_SCHEMAS`, append
`['_src_ranges', 'src_ranges'],` after `['_src_end', 'uint64'],`.

- [ ] **Step 4: Run pack tests, typecheck, regenerate if needed**

Run: `pnpm --filter @byteql/pcap test -- --run && pnpm --filter @byteql/pcap check`
Expected: PASS. (`pcap-tables.generated.ts` embeds only the YAML, which is unchanged.)

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap
git commit -m "feat(pcap): expose exact source ranges on dns, tls, and streams"
```

---

### Task 7: Ranges-aware coverage and row provenance

**Files:**

- Modify: `apps/web/src/lib/hex/coverage.ts`
- Test: `apps/web/src/lib/hex/coverage.test.ts`

**Interfaces:**

- Consumes: `isSourceRangesType` from `@byteql/db/result-columns` (Task 2).
- Produces:
  `export interface RowProvenance { file: string; start: number; end: number; ranges: readonly { start: number; end: number }[] }`;
  `provenanceOfRow(table, row): RowProvenance | null` (exact rows: `ranges = [{start, end}]`);
  `COVERAGE_INTERVAL_CAP = 2_000_000` (replaces `COVERAGE_ROW_CAP`; keep `COVERAGE_ROW_CAP` as a
  deprecated alias only if other modules import it — check with a search and update them instead).
  `CoverageIndex.rowCount` stays the number of indexed rows; add
  `intervalCount: number`.
- [ ] **Step 1: Failing tests**

Add to `coverage.test.ts`:

```ts
import { Field, List, Struct, Uint64, vectorFromArray } from 'apache-arrow';

const RANGES_TYPE = new List(
  new Field('item', new Struct([new Field('start', new Uint64(), true), new Field('end', new Uint64(), true)]), true),
);

function rangesTable(
  rows: Array<{ start: number; end: number; ranges: Array<[number, number]> | null; file?: string }>,
) {
  const base = tableFromArrays({
    id: Int32Array.from(rows.map((_, i) => i)),
    _src_file: rows.map((row) => row.file ?? FILE),
    _src_start: BigUint64Array.from(rows.map((row) => BigInt(row.start))),
    _src_end: BigUint64Array.from(rows.map((row) => BigInt(row.end))),
  });
  const ranges = vectorFromArray(
    rows.map((row) => row.ranges?.map(([s, e]) => ({ start: BigInt(s), end: BigInt(e) })) ?? null),
    RANGES_TYPE,
  );
  return base.assign(new Table({ _src_ranges: ranges }));
}

describe('source ranges', () => {
  // Row 0: message with pieces [10,20) and [50,60), bounding [10,60).
  // Row 1: an unrelated packet [30,45) sitting inside the gap.
  const table = rangesTable([
    { start: 10, end: 60, ranges: [[10, 20], [50, 60]] },
    { start: 30, end: 45, ranges: null },
  ]);

  it('returns every piece from provenanceOfRow, and a single piece for exact rows', () => {
    expect(provenanceOfRow(table, 0)).toEqual({
      file: FILE, start: 10, end: 60, ranges: [{ start: 10, end: 20 }, { start: 50, end: 60 }],
    });
    expect(provenanceOfRow(table, 1)!.ranges).toEqual([{ start: 30, end: 45 }]);
  });

  it('does not match the message on a gap byte', () => {
    const { index } = buildCoverage(table, FILE);
    expect(index!.rowsAt(35)).toEqual([1]);
    expect(index!.rowsAt(25)).toEqual([]);
    expect(index!.rowsAt(55)).toEqual([0]);
  });

  it('returns the covering piece from rangeAt', () => {
    const { index } = buildCoverage(table, FILE);
    expect(index!.rangeAt(52)).toEqual({ start: 50, end: 60 });
  });

  it('shades a message\'s pieces with the same alternation', () => {
    const { index } = buildCoverage(table, FILE);
    const spans = index!.spansIn(0, 100);
    const messageSpans = spans.filter((span) => span.start === 10 || span.start === 50);
    expect(new Set(messageSpans.map((span) => span.alt)).size).toBe(1);
    expect(index!.intervalCount).toBe(3);
  });

  it('indexes pieces only for the row\'s own file', () => {
    const multi = rangesTable([
      { start: 10, end: 60, ranges: [[10, 20], [50, 60]], file: 'a.pcap' },
      { start: 10, end: 60, ranges: null, file: 'b.pcap' },
    ]);
    expect(buildCoverage(multi, 'b.pcap').index!.rowsAt(30)).toEqual([1]);
    expect(buildCoverage(multi, 'a.pcap').index!.rowsAt(30)).toEqual([]);
  });

  it('treats a result without _src_ranges as single-range', () => {
    const plain = provenanceTable([[10, 60]]);
    expect(provenanceOfRow(plain, 0)!.ranges).toEqual([{ start: 10, end: 60 }]);
    expect(buildCoverage(plain, FILE).index!.rowsAt(30)).toEqual([0]);
  });

  it('ignores a same-named column of another type', () => {
    const impostor = provenanceTable([[10, 60]]).assign(
      tableFromArrays({ _src_ranges: ['10-20;50-60'] }),
    );
    expect(provenanceOfRow(impostor, 0)!.ranges).toEqual([{ start: 10, end: 60 }]);
  });

  it('reports ambiguity when _src_ranges is repeated', () => {
    const doubled = withResultLabels(
      table.assign(new Table({ dup: table.getChild('_src_ranges')! })),
      ['id', '_src_file', '_src_start', '_src_end', '_src_ranges', '_src_ranges'],
    );
    expect(buildCoverage(doubled, FILE).reason).toBe('ambiguous-provenance');
  });
});
```

Check `withResultLabels`'s real signature in `apps/web/src/test-support/result-columns.ts` and
adapt the last test to it. Add `Table` to the `apache-arrow` import.

Also update the existing cap test: it now asserts `too-large` when the **interval** count exceeds
`COVERAGE_INTERVAL_CAP` (build a table whose rows are under the cap but whose pieces are over it
is expensive — instead keep the existing row-count test against `COVERAGE_INTERVAL_CAP`, since
exact rows contribute one interval each).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/web test -- --run src/lib/hex/coverage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `coverage.ts`:

1. `import { isSourceRangesType, resultColumnIndex, resultColumnLabel } from '@byteql/db/result-columns';`
2. Extend `provenanceColumns`: include `'_src_ranges'` in the repeated-label ambiguity check, and
   return a fourth element `ranges: Vector | null` — the child at `resultColumnIndex(schema,
   '_src_ranges')` only when `isSourceRangesType(field.type)`, else `null`.
3. Add:

```ts
type Piece = { start: number; end: number };

/** A row's exact pieces: the `_src_ranges` list when present, else its single range. */
function piecesOf(ranges: Vector | null, row: number, fallback: Piece): Piece[] {
  const value = ranges?.get(row) as Iterable<{ start: bigint; end: bigint }> | null | undefined;
  if (!value) return [fallback];
  return Array.from(value, (piece) => ({ start: Number(piece.start), end: Number(piece.end) }));
}
```

4. `provenanceOfRow` returns `{ file, ...range, ranges: piecesOf(rangesColumn, row, range) }`.
5. `buildCoverage`: iterate rows, and for each matching-file row push one interval per piece
   (skip empty pieces), recording `rawRows[count] = row + rowOffset` and a parallel
   `rawOrdinal[count] = ordinal of the row among indexed rows`. Grow the typed arrays
   dynamically (start at `table.numRows`, double on overflow) and return `too-large` once
   `count > COVERAGE_INTERVAL_CAP`. Keep the sort and `maxEndPrefix` logic as-is over intervals.
   Change `spansIn`'s `alt` to `(ordinals[i] & 1) === 1` so pieces of one row share a shade.
   `rowCount` = number of distinct indexed rows; `intervalCount` = `count`.
6. Pieces of one row are disjoint, so `rowsAt` never lists a row twice; do not add dedup.

- [ ] **Step 4: Run web unit tests and typecheck**

Run: `pnpm --filter @byteql/web test -- --run src/lib/hex && pnpm --filter @byteql/web check`
Expected: PASS. `check` will flag consumers of `provenanceOfRow`'s widened type only if they
destructure strictly — fix them in place (they only read `file/start/end`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/hex
git commit -m "feat(web): index exact source ranges in hex coverage"
```

---

### Task 8: Ranges-aware filter-to-selection

**Files:**

- Modify: `apps/web/src/lib/hex/filter-sql.ts`
- Modify: `apps/web/src/components/Workbench.svelte` (the `wrapFilterSql` call site)
- Test: `apps/web/src/lib/hex/filter-sql.test.ts`

**Interfaces:**

- Consumes: `isSourceRangesType`, `resultColumnIndex` (Task 2).
- Produces: `wrapFilterSql(sql, selection, schema: Schema | null): string`.
- [ ] **Step 1: Failing tests**

Add to `filter-sql.test.ts` (merge imports; reuse `RANGES_TYPE` construction from Task 7):

```ts
import { Field, List, Schema, Struct, Uint64, Utf8 } from 'apache-arrow';

const rangesField = new Field(
  '_src_ranges',
  new List(new Field('item', new Struct([new Field('start', new Uint64(), true), new Field('end', new Uint64(), true)]), true)),
  true,
);
const selection = { file: 'a.pcap', start: 100, end: 110 };

it('adds the piece-overlap clause when the result has valid source ranges', () => {
  const sql = wrapFilterSql('select * from tls;', selection, new Schema([rangesField]));
  expect(sql).toContain(
    'and (_src_ranges is null or len(list_filter(_src_ranges, lambda r: r.start < 110 and r."end" > 100)) > 0)',
  );
});

it('omits the clause without a ranges column or with an impostor type', () => {
  expect(wrapFilterSql('select * from packets', selection, null)).not.toContain('_src_ranges');
  expect(
    wrapFilterSql('select * from x', selection, new Schema([new Field('_src_ranges', new Utf8(), true)])),
  ).not.toContain('list_filter');
});
```

Use the lambda syntax Task 2 recorded (`lambda r:` or `r ->`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/web test -- --run src/lib/hex/filter-sql.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { Schema } from 'apache-arrow';
import { isSourceRangesType, resultColumnIndex } from '@byteql/db/result-columns';

import { sqlStringLiteral } from '../sql-literal.js';

/**
 * Wraps the current query with the file-scoped byte-overlap predicate for selection
 * [start, end) in `file`. `_src_end` is exclusive engine-side, hence strict/strict comparisons.
 * When the result carries exact `_src_ranges`, a bounded row matches only if one of its pieces
 * overlaps the selection — bytes inside its span but outside every piece are not its content.
 */
export function wrapFilterSql(
  sql: string,
  selection: { file: string; start: number; end: number },
  schema: Schema | null,
): string {
  const inner = sql.trim().replace(/;\s*$/u, '');
  const rangesIndex = schema ? resultColumnIndex(schema, '_src_ranges') : null;
  const exact =
    schema && rangesIndex !== null && isSourceRangesType(schema.fields[rangesIndex]!.type)
      ? ` and (_src_ranges is null or len(list_filter(_src_ranges, lambda r: r.start < ${selection.end} and r."end" > ${selection.start})) > 0)`
      : '';
  return `select * from (\n${inner}\n) where _src_file = ${sqlStringLiteral(selection.file)} and _src_start < ${selection.end} and _src_end > ${selection.start}${exact};`;
}
```

In `Workbench.svelte`, pass the current result schema at the call site:
`wrapFilterSql(sql, range, session.result?.window.schema ?? null)` (use whichever expression the
file already uses for the current result table).

- [ ] **Step 4: Run and typecheck**

Run: `pnpm --filter @byteql/web test -- --run src/lib/hex && pnpm --filter @byteql/web check`
Expected: PASS. Update any existing `wrapFilterSql` test calls to pass `null` as the third arg.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): filter to selection by exact source ranges"
```

---

### Task 9: Text rendering — CSV, grid, Inspector, trace summary

**Files:**

- Create: `apps/web/src/lib/format/source-ranges.ts`, `apps/web/src/lib/format/source-ranges.test.ts`
- Modify: `apps/web/src/lib/export/csv.ts` (`scalarParts`), `apps/web/src/lib/export/options.ts`
  (`isSupportedCsvScalar`)
- Modify: `apps/web/src/components/ResultGrid.svelte` (`formatValue` :291, `headerBlocked`) and
  `Inspector.svelte:83` (`formatValue`)
- Modify: `apps/web/src/lib/ui/trace.ts` (label)
- Test: `apps/web/src/lib/export/csv.test.ts`, `apps/web/src/lib/ui/trace.test.ts`,
  `apps/web/src/components/Inspector.test.ts`, `apps/web/src/components/ResultGrid.sort.test.ts`

**Interfaces:**

- Produces: `sourceRangesCsv(value: Iterable<{start: bigint; end: bigint}>): string` →
  `"10-20;50-60"`; `sourceRangesSummary(value, maxPieces = 3): string` →
  `"3 ranges · 10-20; 50-60; 90-95"` / `"… +2 more"` suffix when truncated;
  `isSourceRangesValue(value: unknown): value is Iterable<{start: bigint; end: bigint}>`.

- [ ] **Step 1: Failing tests**

`source-ranges.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { sourceRangesCsv, sourceRangesSummary } from './source-ranges.js';

const pieces = (...pairs: Array<[number, number]>) => pairs.map(([s, e]) => ({ start: BigInt(s), end: BigInt(e) }));

describe('source range text', () => {
  it('renders CSV as start-end pairs joined by semicolons', () => {
    expect(sourceRangesCsv(pieces([10, 20], [50, 60]))).toBe('10-20;50-60');
  });
  it('summarizes up to three pieces and counts the rest', () => {
    expect(sourceRangesSummary(pieces([1, 2], [3, 4]))).toBe('2 ranges · 1-2; 3-4');
    expect(sourceRangesSummary(pieces([1, 2], [3, 4], [5, 6], [7, 8], [9, 10]))).toBe(
      '5 ranges · 1-2; 3-4; 5-6; … +2 more',
    );
  });
});
```

`csv.test.ts` — add a case building a one-column table from the Task 7 `RANGES_TYPE` with values
`[[10,20],[50,60]]` and `null`, asserting the body lines are `10-20;50-60` and an empty field.

`trace.test.ts` — add: with `provenance.ranges` of length 2, `label` ends with `· 2 ranges`;
with length 1 it is unchanged.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/web test -- --run src/lib/format src/lib/export src/lib/ui`
Expected: FAIL.

- [ ] **Step 3: Implement**

`source-ranges.ts`:

```ts
export type SourceRangePieceValue = { start: bigint | number; end: bigint | number };

export const isSourceRangesValue = (value: unknown): value is Iterable<SourceRangePieceValue> =>
  value !== null &&
  typeof value === 'object' &&
  Symbol.iterator in value &&
  typeof (value as { toArray?: unknown }).toArray === 'function';

const pairs = (value: Iterable<SourceRangePieceValue>) =>
  Array.from(value, (piece) => `${String(piece.start)}-${String(piece.end)}`);

export const sourceRangesCsv = (value: Iterable<SourceRangePieceValue>): string => pairs(value).join(';');

export const sourceRangesSummary = (value: Iterable<SourceRangePieceValue>, maxPieces = 3): string => {
  const all = pairs(value);
  const shown = all.slice(0, maxPieces).join('; ');
  const rest = all.length > maxPieces ? `; … +${all.length - maxPieces} more` : '';
  return `${all.length} ranges · ${shown}${rest}`;
};
```

`options.ts` `isSupportedCsvScalar`: return `true` for `isSourceRangesType(type)` (import from
`@byteql/db/result-columns`). `csv.ts` `scalarParts`, before the final `throw`:

```ts
  if (isSourceRangesType(data.type)) {
    const value = vector.get(index) as Iterable<{ start: bigint; end: bigint }> | null;
    if (value) yield* quotedText(sourceRangesCsv(value));
    return;
  }
```

`csvChunks` hands `scalarParts` the batch's own child vector and the batch-local row, so
`vector.get(index)` is that row's list value. Keep the text through `quotedText` so CSV escaping
stays uniform.

`ResultGrid.svelte`: the header already routes clicks through `headerBlocked(index)`. Make it also
return `true` when `resultSortKeyRefusal(table.schema.fields[index]!)` is non-null (import from
`@byteql/db/result-columns`), and set the header button's `title` to that refusal text for such
columns. Add a `ResultGrid.sort.test.ts` case: a table with a `_src_ranges` column (hidden columns
shown) renders its header button with `aria-disabled="true"` and the title
`Byte ranges can't be sorted.`, and clicking it does not call `onsort`.

`ResultGrid.svelte` and `Inspector.svelte` `formatValue`: add a first branch
`if (isSourceRangesValue(value)) return sourceRangesSummary(value);`. In the Inspector's
provenance block (the section using `requiredProvenanceNames`), when the selected row's
`_src_ranges` is non-null, render
`Bytes {start}–{end} · bounding span · exact: {n} ranges` followed by one `<li>` per piece; keep
exact rows unchanged. Add an `Inspector.test.ts` case asserting that text.

`trace.ts`: `TraceInput.provenance` is now `RowProvenance | null`; for the `linked` summary,
append `· ${ranges.length} ranges` to `label` when `ranges.length > 1`.

- [ ] **Step 4: Run and typecheck**

Run: `pnpm --filter @byteql/web test -- --run && pnpm --filter @byteql/web check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): render source ranges in CSV, grid, inspector, and trace"
```

---

### Task 10: Hex pane — gap marker, per-piece highlight, range navigation

**Files:**

- Modify: `apps/web/src/lib/hex/render.ts` (`HexColors`, `HexFrame.highlight`, draw order)
- Modify: `apps/web/src/components/HexPane.svelte` (prop type, colors, effect, keys, toolbar,
  data attributes)
- Modify: `apps/web/src/components/Workbench.svelte` (`highlightMemo` type)
- Modify: `apps/web/src/components/ShortcutsOverlay.svelte:18-30`
- Modify: `apps/web/src/styles/tokens.css` (light :31 and dark :149 blocks)
- Test: `apps/web/src/lib/hex/render.test.ts`, `apps/web/src/components/HexPane.test.ts`

**Interfaces:**

- Consumes: `RowProvenance` (Task 7).
- Produces: `HexFrame.highlight: { start; end; ranges: readonly {start; end}[] } | null`;
  `HexColors.gap: string`; HexPane attributes `data-hex-highlight-ranges="s-e,s-e"` and
  `data-hex-range-index` (0-based); toolbar text `Range i of n · x of y bytes in span`; buttons
  `Previous source range` / `Next source range`.
- [ ] **Step 1: Failing tests**

`render.test.ts` — using the file's existing recording `CanvasTextContext` fake, draw a frame with
`highlight: { start: 0, end: 32, ranges: [{ start: 0, end: 4 }, { start: 28, end: 32 }] }` and
colors `{ …, gap: 'GAP', highlight: 'HI' }`; assert bytes 4–27 were filled with `'GAP'` after the
shading pass and bytes 0–3 and 28–31 with `'HI'`, and no byte in 4–27 with `'HI'`.

`HexPane.test.ts` — render with a multi-piece `highlight`
(`ranges: [{0,4},{2000,2004},{9000,9004}]`, `start: 0`, `end: 9004`, `fileSize: 10_000`) and
assert:

```ts
expect(pane.getAttribute('data-hex-range-index')).toBe('0');
expect(screen.getByText('Range 1 of 3 · 12 of 9,004 bytes in span')).toBeTruthy();
await fireEvent.keyDown(canvas, { key: ']' });
expect(pane.getAttribute('data-hex-range-index')).toBe('1');
await fireEvent.keyDown(canvas, { key: ']' });
await fireEvent.keyDown(canvas, { key: ']' }); // stays on the last piece
expect(pane.getAttribute('data-hex-range-index')).toBe('2');
await fireEvent.keyDown(canvas, { key: '[' });
expect(pane.getAttribute('data-hex-range-index')).toBe('1');
// a new highlight resets navigation
await rerender({ highlight: { start: 5, end: 30, ranges: [{ start: 5, end: 8 }, { start: 20, end: 30 }] } });
expect(pane.getAttribute('data-hex-range-index')).toBe('0');
```

and that a single-range highlight renders no range readout and ignores `[`/`]`. Follow the file's
existing render/rerender helpers and canvas lookup.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/web test -- --run src/lib/hex/render.test.ts src/components/HexPane.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement render**

`render.ts`: add `gap: string` to `HexColors`; change `HexFrame.highlight` to
`{ start: number; end: number; ranges: readonly { start: number; end: number }[] } | null`; replace
line 73 with:

```ts
  if (frame.highlight) {
    // Bounding-span bytes that are not message content get the gap marker; only exact pieces get
    // the highlight. An exact row has one piece equal to its span, so no gap is drawn.
    if (frame.highlight.ranges.length > 1) {
      fillRange(ctx, frame, frame.highlight.start, frame.highlight.end, colors.gap);
    }
    for (const piece of frame.highlight.ranges) fillRange(ctx, frame, piece.start, piece.end, colors.highlight);
  }
```

`tokens.css`: add `--color-hex-gap` next to `--color-hex-highlight` in both blocks — light
`#e4e1da`, dark `#2f2c28` (neutral, distinct from both shade tokens and the highlight; check
contrast against the text token by eye in both themes and adjust if the byte text becomes
unreadable).

`CanvasTextContext` exposes only rect fills, so the gap marker is a distinct neutral fill (the
spec records this).

- [ ] **Step 4: Implement HexPane**

1. Prop type: `highlight: { start: number; end: number; ranges: readonly { start: number; end: number }[] } | null`.
2. Colors: `gap: readColor(style, '--color-hex-gap')` beside `highlight`.
3. State + reset: `let rangeIndex = $state(0);`. In the existing highlight `$effect`, compare
   by value including `ranges` (length and every piece), and on a real change set
   `rangeIndex = 0` before `revealTo(next.start, false)`.
4. Navigation:

```ts
  function stepRange(delta: -1 | 1): void {
    const ranges = highlight?.ranges ?? [];
    if (ranges.length < 2) return;
    const next = Math.min(ranges.length - 1, Math.max(0, rangeIndex + delta));
    if (next === rangeIndex) return;
    rangeIndex = next;
    revealTo(ranges[next]!.start, false);
  }
```

   In the canvas keydown `switch`, add `case '[': event.preventDefault(); stepRange(-1); break;`
   and `case ']': …stepRange(1)…`.
5. Toolbar (inside `.hex-toolbar`, before the filter button), rendered only when
   `highlight && highlight.ranges.length > 1`:

```svelte
  <span class="hex-range-readout" aria-live="polite">
    Range {rangeIndex + 1} of {highlight.ranges.length} ·
    {contentBytes.toLocaleString()} of {(highlight.end - highlight.start).toLocaleString()} bytes in span
  </span>
  <button type="button" aria-label="Previous source range" disabled={rangeIndex === 0} onclick={() => stepRange(-1)}>‹</button>
  <button type="button" aria-label="Next source range" disabled={rangeIndex === highlight.ranges.length - 1} onclick={() => stepRange(1)}>›</button>
```

   with `const contentBytes = $derived(highlight ? highlight.ranges.reduce((sum, r) => sum + r.end - r.start, 0) : 0);`.
   Reuse the toolbar's existing button class for styling.
6. Attributes on the root `<section>`:
   `data-hex-highlight-ranges={highlight ? highlight.ranges.map((r) => `${r.start}-${r.end}`).join(',') : ''}`
   and `data-hex-range-index={highlight && highlight.ranges.length > 1 ? rangeIndex : ''}`.
   Keep `data-hex-highlight` as the bounding span.

`Workbench.svelte`: `highlightMemo.value` becomes `RowProvenance | null` (import the type from
`coverage.js`); `rowHighlight` passes it through unchanged — it already has `start`, `end`,
`ranges`.

`ShortcutsOverlay.svelte`: after `Bytes: select record`, add
`{ action: 'Bytes: previous / next source range', keys: '[ / ]' },`.

- [ ] **Step 5: Run and typecheck**

Run: `pnpm --filter @byteql/web test -- --run && pnpm --filter @byteql/web check && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): mark gap bytes and navigate exact source ranges in the hex pane"
```

---

### Task 11: Browser acceptance

**Files:**

- Modify: `packages/formats/pcap/test/generate-e2e-fixture.test.ts` (second fixture)
- Create: `apps/web/e2e/fixtures/interleaved-stream.pcap` (generated)
- Modify: `apps/web/e2e/hex-provenance.spec.ts`
- Modify: `apps/web/e2e/pcap.spec.ts` (only if it asserts hidden-column counts for `dns`/`tls`)

**Interfaces:**

- Consumes: everything above.

- [ ] **Step 1: Generate the fixture**

In `generate-e2e-fixture.test.ts`, add a second `it.runIf(process.env.GENERATE_E2E_FIXTURES === '1')`
that writes `apps/web/e2e/fixtures/interleaved-stream.pcap`: a DNS-over-TCP query for
`interleaved.example` split into two segments (first 10 bytes, rest) on port 53, with one UDP DNS
query for `noise.example` between them — the same frame construction as the existing fixture
plus `udp`/`dnsQuery` imports. Then run:

```bash
GENERATE_E2E_FIXTURES=1 pnpm --filter @byteql/pcap exec vitest run test/generate-e2e-fixture.test.ts
```

Expected: both fixtures written; `git status` shows the new `.pcap` and an unchanged
`dns-stream.pcap`.

- [ ] **Step 2: Write the acceptance test**

Append to `hex-provenance.spec.ts`, reusing its helpers (`highlightedHexRange`, `gotoOffset`,
`hexCanvas`) and `runSql` from `support/app.js`:

```ts
const highlightedRanges = async (page: Page) => {
  const value = await page.locator('[data-hex-pane]').getAttribute('data-hex-highlight-ranges');
  return (value ?? '').split(',').filter(Boolean).map((pair) => pair.split('-').map(Number) as [number, number]);
};

for (const tier of ['memory', 'spill'] as const) {
  test(`pcap: reassembled DNS highlights only its payload bytes (${tier} tier)`, async ({ page }) => {
    if (tier === 'spill') await setSessionOverrides(page, { tiering: { tierThresholdBytes: 1, rotationBytes: 256 * 1024 } });
    await page.goto('/');
    await page
      .getByLabel('Open file input')
      .setInputFiles(fileURLToPath(new URL('./fixtures/interleaved-stream.pcap', import.meta.url)));
    await runSql(page, "select * from dns where query_name = 'interleaved.example'");
    await page.getByRole('row', { name: 'Row 1', exact: true }).click();

    // 1. Only pieces are highlighted; the span is wider than their sum.
    const ranges = await highlightedRanges(page);
    expect(ranges).toHaveLength(2);
    const span = await highlightedHexRange(page);
    expect(span.start).toBe(ranges[0]![0]);
    expect(span.end).toBe(ranges[1]![1]);
    await expect(page.getByText(/Range 1 of 2 ·/u)).toBeVisible();

    // 2. `]` moves to the second piece.
    await hexCanvas(page).press(']');
    await expect(page.locator('[data-hex-pane]')).toHaveAttribute('data-hex-range-index', '1');

    // 3. A gap byte (inside the span, outside both pieces) does not filter to the DNS row.
    const gapByte = ranges[0]![1] + 20; // inside the UDP packet between the two segments
    await gotoOffset(page, gapByte);
    await page.getByRole('button', { name: 'Filter results to selection' }).click();
    await expect(page.getByText(/^0 rows/u)).toBeVisible();

    // 4. A piece byte does.
    await runSql(page, "select * from dns where query_name = 'interleaved.example'");
    await gotoOffset(page, ranges[1]![0] + 1);
    await page.getByRole('button', { name: 'Filter results to selection' }).click();
    await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  });
}

test('pcap: sorting and exporting a result with source ranges', async ({ page }) => {
  await page.goto('/');
  await page
    .getByLabel('Open file input')
    .setInputFiles(fileURLToPath(new URL('./fixtures/interleaved-stream.pcap', import.meta.url)));
  await runSql(page, 'select * from dns');
  await page.getByRole('columnheader', { name: /query_name/u }).click(); // sort ascending
  await page.getByRole('row', { name: /Row \d+/u }).filter({ hasText: 'interleaved.example' }).click();
  expect(await highlightedRanges(page)).toHaveLength(2);
});
```

Match assertion idioms to the existing specs: how "0 rows" is displayed (see the `rows` meta
locator in the existing pcap test), how a column header sort is triggered in
`result-column-sorting.spec.ts`, and `setSessionOverrides`'s signature in `support/app.ts`. For
exports, add CSV and Parquet downloads with "include provenance" following
`results-download.spec.ts`, asserting the CSV body contains `-` pairs joined by `;` for the
`_src_ranges` field and the Parquet download completes.

If `pcap.spec.ts` asserts `+3 hidden` for `dns` or `tls` results, update to `+4 hidden`.

- [ ] **Step 3: Run acceptance**

Run: `pnpm --filter @byteql/web test:e2e -- hex-provenance.spec.ts pcap.spec.ts`
Expected: PASS for both tiers.

- [ ] **Step 4: Run the full gates**

Run:

```bash
pnpm -r check && pnpm -r test -- --run && pnpm lint && pnpm --filter @byteql/web check:bundle && pnpm --filter @byteql/web test:e2e
```

Expected: all PASS. A known pre-existing e2e flake may appear (see project memory notes); rerun
that spec alone and report it if it recurs, never mark it skipped.

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap/test/generate-e2e-fixture.test.ts apps/web/e2e
git commit -m "test(web): accept exact source-range provenance in the browser"
```

---

### Task 12: Documentation

**Files:**

- Modify: `docs/superpowers/specs/2026-07-18-phase2-tcp-reassembly-design.md` (amendment note)
- Modify: `docs/superpowers/specs/2026-09-22-exact-reassembled-provenance-design.md` (status +
  Implementation notes)
- Modify: `ROADMAP.md` (priority 2 → done), `AGENTS.md` (status entry)
- Modify: `PRD.md` §9 only if it enumerates the hidden provenance columns
- [ ] **Step 1: Write the notes**
- Phase 2 design, under its "Provenance: coarse span + link table" bullet, add:
  `> Amended 2026-09-22: message and flow rows now carry exact pieces in _src_ranges; see
  > 2026-09-22-exact-reassembled-provenance-design.md.`
- This spec: `Status:` → `Implemented <date>`; Implementation notes gain the gap-fill decision,
  the column position (last, after `_src_end`), and any measurements.
- `ROADMAP.md` §2: add `— done (<date>)` to the heading and an Evidence line pointing to the
  e2e spec and this design; in "Next development cycle" mark item 2 done.
- `AGENTS.md` Status: one bullet in the house style (what shipped, design path, documented
  limitations: `errors` rows keep bounding spans; queries that drop `_src_ranges` fall back to
  the bounding span).
- [ ] **Step 2: Format and commit**

```bash
for f in ROADMAP.md AGENTS.md docs/superpowers/specs/2026-07-18-phase2-tcp-reassembly-design.md \
  docs/superpowers/specs/2026-09-22-exact-reassembled-provenance-design.md; do rumdl fmt "$f"; done
pnpm format:check
git add ROADMAP.md AGENTS.md PRD.md docs/superpowers/specs
git commit -m "docs: record exact reassembled-message provenance"
```
