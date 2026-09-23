# Pack kit: simpler, data-first format packs

Date: 2026-09-23

Status: Implemented.

## Purpose and accepted behavior

Make format-pack creation easier, more ergonomic, and cheaper to maintain, using pcapng
(`ROADMAP.md` priority 3) as the guiding case. Adding a format today means hand-copying
schemas, drivers, build scripts, and test helpers from an existing pack; this design moves all
of that into shared infrastructure so a pack is a manifest, a projection spec, queries, `.ksy`
files, and a small set of named code hooks.

Accepted scope decisions:

- **Audience: staged.** Optimize now for the maintainers and agents adding the next packs
  (pcapng, then lnk/regf/utmp/journal), but shape every piece so the PRD's "community pack as
  data" goal (PRD §4 differentiator 4) stays reachable: identity, probing, and wiring are data;
  code is limited to named hooks.
- **One pack, many containers.** pcapng becomes a second container of the existing packet
  capture pack, not a separate pack. Both containers share one spec, dissect graph, streams, and
  queries, and a multi-file session can mix `.pcap` and `.pcapng` because they share a pack id.
- **Kit first.** This spec delivers the kit and migrates MIDI, ZIP, and pcap onto it with
  byte-identical output. pcapng is a separate follow-up spec and is the kit's first from-scratch
  consumer.
- **Approach: manifest plus code hooks.** Chosen over a code-first `definePack({...})` (moves
  identity into code, away from the data goal) and a pure-data design with built-in declarative
  framers (too large a DSL effort today; pcapng's per-section endianness and per-interface state
  would strain it). Declarative framers and a generic Kaitai adapter remain additive later steps.

Out of scope: pcapng itself, declarative framers, a generic Kaitai-to-projection adapter, and
WASM components.

## Current evidence

Inspected at `41778d0`.

- `packages/formats/{midi,pcap,zip}/src/pack.ts` each hand-write `*_TABLE_SCHEMAS` that mirror
  the column names and types already declared in `*.tables.yaml`, plus a hand-kept
  `*Nullability` map. Nothing checks either against the engine's real output.
- The `RecordSource` state machine (drained guard, sticky failure, `RECORD_SOURCE_NOT_DRAINED`)
  is written three times. MIDI and ZIP build a whole `ParseResult` and hand out one table per
  `nextBatch()`; pcap's `openPcapSource` (`project-pcap.ts`) is ~250 lines of pump, drain
  threshold, unclamped yield, progress, abort, and issue-reordering logic that is generic in
  substance.
- `scripts/compile.mjs` (Kaitai) exists twice and `scripts/generate-pack.mjs` three times,
  differing only in names and the accepted query `kind`s.
- `project-pcap.ts` remaps the framer's camelCase fields to the snake_case names the spec reads
  (`packetRoot`) and warns that `compileProjection` does not validate field names, so a
  mismatch silently yields NULL columns.
- Kaitai glue (`parse()`, `bodyRange()`, and the `_debug.<field>.start` payload-offset
  convention) is re-implemented and re-explained per pack.
- Each pack has its own batch-merging test helper (`parseAndProjectPcap` and equivalents) and
  its own copies of `throwIfAborted`.
- `packages/core/src/projection/project.ts` already exports `tableOutputTypes` and
  `streamSegmentsOutputTypes`, so column order and types can be derived from the compiled spec;
  only nullability is missing from the spec language.
- `apps/web/src/lib/packs.ts` holds `REGISTERED_PACKS` and `selectPack`, which returns a pack
  only.

## Architecture

Two new homes; dependency direction stays `app → db → core ← formats`.

- `packages/core/src/pack/` — runtime (zero-DOM): manifest types, `definePack`,
  `projectionSchemas`, the framer contract, the generic driver `openFramedSource`, and the
  moved unclamped yield helper.
- `packages/core` subpath exports:
  - `@byteql/core/kaitai` — Kaitai helpers (depends on the pure-JS `kaitai-struct` runtime;
    core stays zero-DOM).
  - `@byteql/core/testing` — the conformance kit and shared test helpers. Production code
    never imports it.
- `packages/pack-tools` — new, Node-only dev dependency exposing the `byteql-pack` CLI
  (`build`, `new`). Never bundled into the app; `check:bundle` is unaffected.

A pack package after migration:

```text
packages/formats/<name>/
  pack.yaml                 # identity, containers, probes, capabilities, file pointers
  <name>.tables.yaml        # projection spec (v0.4)
  queries.yaml
  ksy/                      # optional
  src/
    index.ts                # export default definePack(manifest, { framers, parsers, streams })
    pack.generated.ts       # emitted by `byteql-pack build`
    <container>.ts          # framer hook(s)
    wrappers.ts, streams.ts # parser / stream hooks, when needed
  test/
    conformance.test.ts     # describePackConformance(...)
    fixtures/, goldens/
```

## Manifest and build tool

### `pack.yaml`

```yaml
version: '0.1'
id: pcap
title: Packet capture
spec: pcap.tables.yaml
queries: queries.yaml
capabilities: []            # names this pack may enable at runtime, e.g. [audio]
errors: { ordinal: record } # errors-table ordinal column name (MIDI: track)
ksy:                        # optional
  dir: ksy
  roots: [ethernet_frame, ipv4_packet]   # optional; default every *.ksy in dir
containers:                 # >= 1; probed in declaration order
  - id: pcap
    probe:
      magic:
        - { at: 0, hex: a1b2c3d4, confidence: 1 }
        - { at: 0, hex: d4c3b2a1, confidence: 1 }
        - { at: 0, hex: a1b23c4d, confidence: 1 }
        - { at: 0, hex: 4d3cb2a1, confidence: 1 }
    framer: pcap
```

- `probe.magic` entries each carry their own confidence (ZIP needs 0.9 and 0.5). The pack's
  probe result is the highest-confidence match across all containers; ties go to the earlier
  container. `probe: { hook: <name> }` names a code probe when bytes-at-offset is insufficient.
- `framer`, `probe.hook`, and spec-referenced parser, key-extractor, and stream-framer ids are
  **hook names** resolved against the TS registrations.
- `capabilities` lists capability names the pack can report. A query of `kind: playback` is
  valid only when `audio` is declared (generalizing today's per-script `kind` allow-list).
- `queries.yaml` drops its `format:` field; the manifest owns identity.

### `byteql-pack build`

Replaces every `compile.mjs` and `generate-pack.mjs`. Each pack's `build`, `check`, and `test`
scripts call it once. In order:

1. Validate `pack.yaml` with a zod schema; errors name the file and field path.
2. Compile `.ksy` roots into `gen/`, keeping today's import-path and output-path containment
   guards and the `gen/package.json` CommonJS marker. Skipped when `ksy` is absent.
3. Load the spec with core's `parseProjectionSpec` and `compileProjection` using placeholder
   registries built from the names the spec references, so spec errors fail the build instead
   of surfacing at worker load. Hook implementations are checked later by `tsc`.
4. Lint queries: unique ids; valid `kind` per declared capabilities; every identifier after
   `from`/`join` must be a spec table, an engine table (`streams`, `stream_segments`, `errors`),
   or a CTE name defined in the same query. This is a lint, not SQL parsing; real execution is
   covered by the browser spec in [Testing](#testing).
5. Emit one file, `src/pack.generated.ts`, containing the embedded spec YAML, the parsed
   manifest, the typed query list, and string-literal union types of every hook name
   (`FramerName`, `ParserName`, `KeyExtractorName`, `StreamFramerName`, `ProbeHookName`).

`definePack` is generic over those unions, so a missing, extra, or misspelled hook is a `tsc`
error.

### `byteql-pack new <id>`

Generates a skeleton that builds and passes `check`: `pack.yaml` with one container, a one-table
spec, `queries.yaml` with a table-overview query, a stub framer yielding nothing, `index.ts`,
and a conformance test with an empty fixture slot for the author to fill.

## Derived schemas and field safety

### Spec v0.4: `nullable`

- Column specs gain optional `nullable: true`. In v0.4, spec columns are **non-null by
  default**.
- Specs declaring `version` `0.1`–`0.3` still load and treat every spec column as nullable, so
  behavior changes only when a pack migrates to v0.4.
- Engine-owned columns follow fixed rules, chosen to match what the engine actually writes:
  key and `parent_key` non-null; `_src_start` and `_src_end` non-null on projected and stream
  tables (every emitted row resolves a range) but nullable on `errors`; `stream_id` (injected on
  message-fed tables) nullable; `_src_ranges` nullable; a segments table's feed-key column
  nullable; `errors.<ordinal>` nullable; other `errors` columns non-null.

### `projectionSchemas(compiled, issueOptions)`

Returns `TableSchema[]` for every compiled table, the stream tables, and `errors` (its ordinal
column name comes from `issueOptions.ordinalColumn`, which `definePack` fills from the
manifest's `errors.ordinal`), in the engine's column order. `definePack`
exposes it as `pack.schemas()`. Before deletion, the hand-written schemas of all three packs are
captured as test fixtures and the derived schemas must equal them in names, order, and types
exactly. Nullability must equal them except for one documented delta: the hand-written maps
disagree about `_src_start`/`_src_end` (MIDI marks them non-null, pcap and ZIP nullable), so
pcap's and ZIP's non-`errors` tables change to non-null, following the engine rule above. The
conformance nullability check proves the new flags true. `nullable` is informational (Explorer
`?` marker, worker column overview) and does not affect Arrow output or goldens.

### Strict fields

- New session option `strictFields: boolean` (default `false`).
- When true, the evaluator distinguishes a **missing** member (`undefined`: the property is
  absent) from a **present null**. The first missing read for a given table/column throws
  `ProjectionFieldError` naming the table, column, field path, and the node's actual keys.
- Production keeps `strictFields: false`; row-time evaluation still returns null and never
  throws, preserving the engine invariant.
- Convention (documented in the authoring guide): framer and parser roots are **total**. An
  optional field is present with value `null`, never omitted. Exception: an anchor path whose
  absence is meaningful (ZIP's omitted `end_of_central_dir`, which must produce zero rows) is
  an anchor, not a column read, and is unaffected.
- Existing wrappers that omit optional fields are fixed during migration; strict mode finds
  them.

Rejected: static field declarations per framer and parser. `_.x` resolves against nested
anchors, making static checking complex and costly to author, while strict mode catches the
same mistakes on the first fixture row.

## Framer contract and driver

### Contract

```ts
type Framer = (
  source: ByteSource,
  ctx: FramerContext,
) => AsyncGenerator<FramedRecord, FramerSummary | void>;

interface FramedRecord {
  root: object;
  provenance: SourceRange | ((table: string, match: AnchorMatch) => SourceRange);
  tables?: readonly string[]; // restrict to these root tables
  ordinal?: number;           // errors-table ordinal if projecting this record throws
}

interface FramerContext {
  signal: AbortSignal;
  report(issue: FramerIssue): void;   // stage defaults to 'framing'
  progress(progress: ParseProgress): void;
  bytes(consumed: number): void;      // standard "x of y MB" 'projecting' progress
}

interface FramerSummary {
  capabilities?: Readonly<Record<string, FormatCapability>>;
}
```

`FramerIssue` is `IssueReport` with `stage` optional. A framer that cannot recognize its input
at all (bad magic after a successful probe) throws; that is the one fatal path, unchanged from
today.

Mapping of existing containers:

- **pcap** — the incremental framer yields one record per packet with root fields already in
  snake_case (the `packetRoot` remap is deleted) and provenance
  `{ start: recordStart, end: bodyEnd }`. Framing issues discovered at EOF (truncation) are
  reported through `ctx.report`.
- **ZIP** — reads the central-directory structure, reports container issues, yields one record
  whose provenance is a resolver returning the matched node's `_range`.
- **MIDI** — `readAll`, then normalization and parsing passes that report `normalizing` and
  `parsing` issues, then one header record (`tables: ['header']`) and one record per parsed
  track (`tables: ['events', 'tempo']`, `ordinal: track.index`) with the existing per-event
  resolver. Returns `{ capabilities: { audio } }` computed from the header's division mode.
- **pcapng (follow-up spec)** — yields packet records and interface records; tables anchor at
  `$.packet` and `$.interface`, so classic pcap leaves an `interfaces` table empty. The
  contract needs no change for it.

### `openFramedSource(compiled, framer, source, opts, tuning?)`

Owns everything pcap's `openPcapSource` does today, generically:

- Creates one `ProjectionSession` and `IssueCollector` (ordinal column from the manifest's
  `errors.ordinal`).
- Pulls records; calls `session.project(record.root, resolver, { tables })`. A throw from
  `project` becomes a recoverable `projecting` errors row carrying `record.ordinal`, with the
  record's bounding provenance when it is a plain range. Previously pcap would fail the whole
  session; this strictly strengthens the hostile-input invariant.
- Drains when `pendingRowCount() >= tuning.flushRowThreshold` (default 65 536).
- Every `tuning.yieldInterval` records (default 256): unclamped yield (`scheduler.yield()`,
  else the lazily created, unref'd `MessageChannel` round trip, moved from pcap unchanged),
  abort check, and progress flush. Progress from `ctx.progress`/`ctx.bytes` is coalesced to
  this cadence; the final progress update is always delivered.
- At generator completion: `session.finish()`, emit non-empty residual tables, then always emit
  `errors` (even with zero rows). Tables that stayed empty emit no batch; consumers read their
  schemas from `schemas()`, as today.
- `finish()` returns issues and the framer summary's capabilities (default `{}`), with the
  drained guard and sticky failure behavior of today's adapters.
- **Errors ordering, one rule for all packs:** framer-reported issues in report order, then
  engine and driver issues in report order. This formalizes pcap's current replay and matches
  ZIP's and MIDI's current output.
- `tuning` (`chunkBytes`, forwarded to the framer via `ctx`; `flushRowThreshold`;
  `yieldInterval`) is for tests only; `pack.open` uses defaults.

Accepted behavior change: MIDI yields and reports progress at the driver cadence instead of
once per track per stage; progress becomes coarser, output is identical.

### `definePack(manifest, hooks)`

Produces a `FormatPack`:

- `id`, `title`, `queries` from the manifest.
- `probe(head)` from the declarative magics or probe hooks. Returns the confidence as today; a
  new `probeContainer(head)` returns `{ container, confidence } | null`.
- `schemas()` from `projectionSchemas`.
- `open(source, opts)` gains an optional `container` in `OpenOptions`; when absent the pack
  re-probes the head. It dispatches to that container's framer via `openFramedSource`.
- The compiled projection is built once, at module load, as today.

## Kaitai helpers

`@byteql/core/kaitai`:

- `kaitaiParse(GenClass, bytes)` — builds a `KaitaiStream` over a `DataView` that preserves
  `bytes.byteOffset`, constructs, and runs `_read()` (may throw; the engine turns a parser throw
  into `DISSECT_PARSE_FAILED`).
- `payload(parsed, field)` — returns the `{ bytes, start }` payload range using
  `_debug[field].start`, i.e. relative to the view the wrapper was handed, never
  `ioOffset + start`.

The offset convention is documented and unit-tested once in core; pack wrappers shrink to field
maps and drop their local helpers and explanatory comments.

## App integration

- `apps/web/src/lib/packs.ts` keeps an explicit `REGISTERED_PACKS` array (adding a pack is one
  import and one entry). `selectPack` returns `{ pack, container } | null`, keeping
  first-registered tie-breaking and never selecting confidence 0.
- The parse worker passes `container` into `pack.open`. Multi-file sessions keep the
  same-pack-id rule; mixing containers of one pack is allowed.
- The pcap pack keeps id `pcap` (Wireshark users call both formats "pcap"; renaming would churn
  e2e, session checks, and query examples) and changes its title to "Packet capture". The
  package stays `@byteql/pcap`.

## Testing

### Conformance kit (`@byteql/core/testing`)

```ts
describePackConformance(pack, {
  fixtures: [{ file: 'test/fixtures/v6.pcap', container: 'pcap' }],
  goldens: 'test/goldens',
  fuzz: { seed: 1, truncations: 6, flips: 6 },
});
```

For each fixture:

1. **Probe** selects this pack and the expected container.
2. **Schema** — every emitted batch's Arrow schema equals `schemas()` (names, order, types);
   no nulls in columns not declared nullable.
3. **Strict fields** — all runs use `strictFields: true`.
4. **Provenance bounds** — `0 <= _src_start <= _src_end <= size` where present; every
   `_src_ranges` piece lies within its row's span, ordered by start.
5. **Chunk invariance** — a run with `chunkBytes` 1 and 7, `flushRowThreshold` 1, and
   `yieldInterval` 1 merges to the same tables as the default run.
6. **Determinism** — two default runs produce identical merged output.
7. **Abort** — aborting after the first batch rejects with `AbortError` without hanging.
8. **Hostile input (seeded)** — the fixture truncated at `truncations` evenly spread offsets
   and with `flips` single-byte flips at seeded positions each must either complete
   (`nextBatch()` to null, then `finish()`) or throw exactly the fatal unrecognized-input error;
   any other throw or a timeout fails. Invariants 2 and 4 are also checked on every mutant
   that completes.
9. **Golden** — merged tables serialized as stable text (Arrow → JSON rows, bigint-safe) match
   `goldens/<fixture>.json`. A documented env flag regenerates goldens for review.

Shared helpers replace per-pack copies: `collectSource(pack, bytes, opts?)` (merges batches,
backfills empty tables from `schemas()`), `memoryByteSource`, and `loadFixture`.

Packs keep their own framer, wrapper, and semantic unit tests; generic properties move to the
kit.

### Browser

- New `apps/web/e2e/pack-queries.spec.ts`: for every registered pack and its e2e fixture, run
  every canned query and assert none errors.
- Existing `pcap.spec.ts`, `zip.spec.ts`, `audio.spec.ts`, `hex-provenance.spec.ts`,
  `multi-file.spec.ts`, and privacy specs stay and must pass unchanged.

### Migration proof

Goldens for every existing fixture of MIDI, ZIP, and pcap are captured on the pre-refactor code
in the first commit. Each migrated pack must reproduce them exactly, and its derived schemas must
equal the captured hand-written ones.

## Migration sequence

Each step is its own commit (or small commit series) with `pnpm -r check`, unit tests,
`check:bundle`, and e2e green:

1. Golden and schema capture on current code (kit's golden serializer lands here first).
2. Core: spec v0.4 `nullable`; `projectionSchemas`; `strictFields`; framer contract,
   `openFramedSource`, moved yield helper; `definePack`; `@byteql/core/kaitai`;
   `@byteql/core/testing` including fuzz.
3. `packages/pack-tools`: manifest schema, `build`, `new`.
4. Migrate ZIP, then MIDI, then pcap. Each deletes its hand-written schemas, nullability map,
   driver, local helpers, and scripts, and adds `conformance.test.ts`.
5. App: `selectPack` returns `{ pack, container }`; worker passes `container`;
   `pack-queries.spec.ts`.
6. Docs: `docs/pack-authoring.md` (manifest reference, framer contract, total roots,
   nullability rules, conformance kit, adding a container to an existing pack); pointers from
   `AGENTS.md` and `PRD.md` §9; `AGENTS.md` repo map updated for `packages/pack-tools` and
   `packages/core/src/pack/`.

## Success criteria

- MIDI, ZIP, and pcap run on the kit with golden-identical output and schema-identical
  `schemas()`.
- All existing gates pass: `pnpm check`, `pnpm lint`, unit tests (including the MIDI regression
  suite), `check:bundle`, e2e including privacy.
- Every pack passes `describePackConformance`, including fuzz.
- A pack generated by `byteql-pack new` builds and passes `check`.
- The non-generated, non-test line count of `packages/formats/*/src` is reported before and
  after (no fixed target).

## Risks

- **Golden fidelity.** Serialization must be exact for bigint, timestamps, binary, and
  `List<Struct>` columns, or the migration proof is weaker than it looks. Mitigation: goldens
  compare Arrow type strings alongside values, and binary is hex-encoded.
- **Async-generator overhead per packet.** pcap already awaits per packet; the generator adds
  a comparable cost. Mitigation: re-run the 1 GB scale benchmark after the pcap migration and
  record the result; a regression beyond 10 % blocks the pcap step until addressed.
- **Strict mode surfacing latent wrapper gaps.** Expected and desired; fixes are part of each
  migration step and must not change goldens (present-null and missing both project NULL).

## Implementation notes (recorded post-execution)

Recorded 2026-09-23 after all 14 implementation tasks landed on `feature/pack-kit`. The Task 1
base commit (pre-refactor goldens captured, migration not yet started) is `ba9f4f0`; the
pre-kit `main` commit this branch forked from is `0b8d52f`.

### Progress reporting

`ctx.progress` (a framer-owned progress phase, e.g. MIDI's `normalizing`/`parsing`/`projecting`
stage labels) is forwarded to the app immediately — it is never coalesced. Only `ctx.bytes`
(the generic "x of y MB" byte-progress readout) is coalesced to the driver's yield cadence
(every `yieldInterval` records, default 256); a tail byte-progress event always fires once more
at EOF regardless of the cadence, so the last number a framer reports is always accurate even
when the record count lands exactly on a yield boundary. Framers call `ctx.bytes` before each
point where the driver may yield, so the coalesced event reflects the record just produced.

The unclamped-yield helper (`scheduler.yield()`, falling back to a `MessageChannel` round trip)
is created once per `openFramedSource` call, not as a module-level singleton — the
`MessageChannel` fallback has a single pending-resolver slot that is only safe under one
strictly sequential pump loop, and two `openFramedSource` calls pumping concurrently in the
same worker must not share one yield instance.

### Conformance kit behavior

The shared conformance suite (`describePackConformance`) compares column names, order, and
Arrow types against `pack.schemas()` on every emitted Arrow batch, not just the merged result,
and again on every table in the merged output. Every run — including the abort test — uses
`strictFields: true`. Every fuzz mutant that completes (rather than throwing the classified
`PackFatalError`) is re-checked against the schema/nullability/provenance-bounds invariants, not
just left to complete silently. Determinism and chunk/drain-invariance runs compare tables,
issues, *and* capabilities, not tables alone.

Fuzzing and the `chunkBytes` 1/7 invariance runs apply only to fixtures at or under
`fuzz.maxBytes` (default 64 KiB); larger fixtures — pcap's `SkypeIRC.cap` is 411 KiB — use a
single `chunkBytes` 4093 invariance run instead and skip fuzzing entirely, since seeded
truncate/flip fuzzing scales with fixture size and a multi-hundred-KB capture would make the
suite too slow to run on every change.

Two limits are accepted, not fixed: a framer that spins synchronously between yields cannot be
interrupted mid-record by the abort check (the abort check runs between driver pump iterations,
not inside a synchronous framer loop), and vitest's timeout is per test, not per fuzz mutant, so
a hang inside one mutant only surfaces as the whole `it` timing out. The abort conformance test
does not depend on fixture size: `nextBatch()` checks the abort signal unconditionally before it
looks at any already-queued batch, so a call made after `abort()` rejects with `AbortError` even
when the whole parse already completed in a single batch and every table is sitting in `pending`
(`driver.test.ts`, "rejects with AbortError even when every batch is already queued").

Goldens regenerate with `vitest -u` (or `pnpm --filter <pkg> test -- -u`), reviewed like any
other file diff.

### Fuzz findings

Seeded truncation/flip fuzzing found one real gap, in ZIP: a declared record length pointing
past the available bytes previously parsed past the end of the buffer instead of failing
loudly. Fixed by clamping and reporting: an over-length record now produces a `RECORD_TRUNCATED`
issue with provenance clamped to the available bytes, and a truncated or inconsistent central
directory produces `CENTRAL_DIRECTORY_TRUNCATED` (entries clamp to the central-directory region)
or `CENTRAL_DIRECTORY_ENTRY_COUNT_MISMATCH` (the loop exits early because it ran out of bytes
before reading the declared entry count). MIDI and pcap's fuzz runs found no findings requiring
a code fix.

### MIDI behavior deltas

MIDI's abort cadence is coarser than pcap's or ZIP's: normalization and Kaitai parsing for every
track run synchronously before the first record is yielded, and the driver only yields (and
therefore only checks abort) every 256 *records* thereafter — a MIDI file with fewer than 256
tracks can complete its whole normalize/parse pass before an abort has any chance to land. The
Type 2 fatal keeps its pre-kit user-visible message wording verbatim
(`UNSUPPORTED_MIDI_TYPE at offset 8: Type 2 files contain independent sequences and are not
supported in Phase 0`), built via the same `MidiParseError` formatting the pre-kit driver used,
not a plain string, so the "CODE at offset N: message" shape is unchanged for anything that
matches on it. The header record's projection failure is now a recoverable `errors` row
(via the framer's per-record `onError`) instead of failing the whole session — a strict
improvement, not a behavior the migration needed to preserve.

### `_src_start`/`_src_end` nullability delta

As already documented under "Derived schemas and field safety" above: pcap's and ZIP's
non-`errors` tables change from nullable to non-null for `_src_start`/`_src_end`, following the
engine rule (every emitted row resolves a range) rather than the pre-kit hand-written
nullability maps, which disagreed with MIDI's (already non-null) on this point. The conformance
suite's nullability check (zero nulls in a column not declared nullable) proves the new flags
true against real output, not just against the schema declaration.

### Benchmark

Re-run of the 1 GB scale benchmark (`apps/web/bench/run-scale-bench.mjs`) after the pcap
migration, same machine and session as the rest of this work (arm64, 20 logical cores, Chromium
149): pre-migration **56.71 s / 56.28 s**, post-migration **56.20 s / 56.54 s** — no regression.
Read fraction on the 3-column query stayed **1.72 %**. The drift from the July 2026-07-19
baseline (44.25 s) predates this branch and is unexplained by anything in this migration; it
leaves roughly 6 % headroom to the 60 s Phase-1 target, worth flagging for follow-up but not a
pack-kit regression.

### Line count

Non-generated, non-test line count of `packages/formats/*/src/*.ts` (generated files, `*.test.ts`,
and `*.d.ts` excluded):

```bash
BASE=ba9f4f0
count() {
  git ls-tree -r --name-only "$1" packages/formats \
    | grep -E '^packages/formats/[^/]+/src/[^/]+\.ts$' \
    | grep -v -e generated -e '\.test\.ts$' -e '\.d\.ts$' \
    | while read -r f; do git show "$1:$f"; done | wc -l
}
echo "before: $(count "$BASE")  after: $(count HEAD)"
# before: 2675  after: 1753
```

The kit cuts hand-written pack code by roughly a third (2675 → 1753 lines) across MIDI, ZIP, and
pcap combined, by deleting the hand-written table schemas, nullability maps, three
reimplementations of the `RecordSource` state machine, and the per-pack Kaitai parse/offset
glue that this design's "Current evidence" section identified as duplicated.
