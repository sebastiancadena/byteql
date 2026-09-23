# Writing a ByteQL format pack

A format pack turns one binary container (or a family of related containers, like classic pcap
and pcapng) into Arrow tables the app can query. This guide covers the pack kit that MIDI, ZIP,
and pcap all run on: `packages/core/src/pack/` (manifest, framer contract, driver, `definePack`),
`@byteql/core/kaitai` (Kaitai helpers), `@byteql/core/testing` (the conformance kit), and
`packages/pack-tools` (the `byteql-pack` CLI).

## What a pack is

A pack package is a manifest, a projection spec, canned queries, optional `.ksy` schemas, and a
small set of named code hooks:

```text
packages/formats/<name>/
  pack.yaml                 # identity, containers, probes, capabilities, file pointers
  <name>.tables.yaml        # projection spec (v0.4)
  queries.yaml
  ksy/                      # optional
  src/
    index.ts                # export const <name>FormatPack = definePack(definition, hooks)
    pack.generated.ts        # emitted by `byteql-pack build`
    <container>.ts           # framer hook(s)
    wrappers.ts, streams.ts  # parser / stream hooks, when needed
  test/
    conformance.test.ts      # describePackConformance(...)
    fixtures/, goldens/
```

Identity, probing, and wiring are data (`pack.yaml`, the projection spec, `queries.yaml`); code
is limited to the named hooks a manifest references by name (a framer per container, plus
optional parsers, key extractors, stream framers, and probe hooks). `byteql-pack build` checks
that every hook the manifest and spec reference is implemented, and that every hook a pack
implements is referenced, by generating string-literal union types (`FramerName`, `ParserName`,
…) that `definePack` is generic over — a missing, extra, or misspelled hook is a `tsc` error, not
a runtime one.

## `pack.yaml` reference

```yaml
version: '0.1'
id: pcap
title: Packet capture
spec: pcap.tables.yaml
queries: queries.yaml
capabilities: [] # names this pack may enable at runtime, e.g. [audio]
errors: { ordinal: record } # errors-table ordinal column name (MIDI: track)
ksy: # optional
  dir: ksy
  roots: [ethernet_frame, ipv4_packet] # optional; default every *.ksy in dir
containers: # >= 1; probed in declaration order
  - id: pcap
    probe:
      magic:
        - { at: 0, hex: a1b2c3d4, confidence: 1 }
        - { at: 0, hex: d4c3b2a1, confidence: 1 }
        - { at: 0, hex: a1b23c4d, confidence: 1 }
        - { at: 0, hex: 4d3cb2a1, confidence: 1 }
    framer: pcap
```

Fields:

- `version` — manifest schema version; currently only `'0.1'`.
- `id` — the pack's identity. Query text, multi-file session grouping, and the worker's
  `formatId` override all key off it. Renaming an id churns e2e fixtures, session checks, and
  query examples, so treat it as load-bearing once shipped (pcap kept `id: pcap` through the
  pcapng-container migration even though the title changed to "Packet capture").
- `title` — display title (pcap's is "Packet capture" so it reads naturally for both
  containers; the package still stays `@byteql/pcap`).
- `spec` — path to the projection spec YAML (relative to the pack directory).
- `queries` — path to `queries.yaml`. Its own `version: '0.1'` and per-query `id`/`title`/
  `kind`/`sql` are validated by `byteql-pack build`'s query lint (unique ids; `kind` is `grid`
  or `playback`, and `playback` requires `audio` in `capabilities`; every identifier after
  `from`/`join` must be a spec table, an engine table (`errors`, `_files`), or a CTE defined in
  the same query). The lint is textual, not a SQL parser — real execution is covered by
  `apps/web/e2e/pack-queries.spec.ts`.
- `capabilities` — names this pack may report at runtime (e.g. `audio` for MIDI playback);
  defaults to `[]`.
- `errors` — `{ ordinal: <column name> }` for the generic per-record `errors` table (pcap and
  ZIP use `record`; MIDI uses `track`, since MIDI issues are per-track). Defaults to
  `{ ordinal: record }`.
- `ksy` — optional. `dir` is the directory (relative to the pack) holding `.ksy` schemas;
  `roots` optionally restricts compilation to named roots (MIDI compiles only
  `standard_midi_file` out of `dir: .`; pcap compiles every `.ksy` under `ksy/`). Omit the whole
  key when a pack has no Kaitai schemas (ZIP hand-writes its reader instead).
- `containers` — at least one. Each has an `id` (not a hook name — just an identifier used for
  probing, session `container` selection, and fixture tagging; a container's tables live in the
  shared spec, not per-container), a `framer` (a hook name resolved against `hooks.framers`),
  and a `probe`, which is either:
  - `{ magic: [...] }` — each entry is `{ at, hex, confidence }`; `confidence` is `(0, 1]`.
    Multiple containers of one pack can have overlapping magics at different confidences (ZIP
    needs 0.9 for the local-file and EOCD signatures and 0.5 for a data-descriptor-only
    signature). The pack's overall `probe(head)` is the highest-confidence match across every
    container; ties go to the earlier-declared container.
  - `{ hook: <name> }` — a code probe (`(head: Uint8Array) => number | null`) resolved against
    `hooks.probes`, for containers bytes-at-offset can't distinguish.

ZIP's manifest (`packages/formats/zip/pack.yaml`) is the minimal shape — one container, no
`ksy`, default `errors.ordinal`:

```yaml
version: '0.1'
id: zip
title: ZIP archive
spec: zip.tables.yaml
queries: queries.yaml
errors: { ordinal: record }
containers:
  - id: zip
    framer: zip
    probe:
      magic:
        - { at: 0, hex: 504b0304, confidence: 0.9 }
        - { at: 0, hex: 504b0506, confidence: 0.9 }
        - { at: 0, hex: 504b0708, confidence: 0.5 }
```

## Writing a framer

A framer turns bytes into projection records. Its contract (`packages/core/src/pack/framer.ts`):

```ts
type Framer = (
  source: ByteSource,
  ctx: FramerContext,
) => AsyncGenerator<FramedRecord, FramerSummary | void, undefined>;

interface FramedRecord {
  root: object;
  provenance: SourceRange | ((table: string, match: AnchorMatch) => SourceRange);
  tables?: readonly string[]; // restrict this record to these spec tables
  ordinal?: number; // errors-table ordinal if projecting this record throws
  onError?: (error: unknown) => FramerIssue; // default: PROJECTION_FAILED at this record's range
}

interface FramerContext {
  readonly signal: AbortSignal;
  readonly chunkBytes: number | undefined; // tuning passthrough, used by chunked framers (pcap)
  report(issue: FramerIssue): void;
  progress(progress: ParseProgress): void; // forwarded to the caller immediately
  bytes(consumed: number): void; // byte progress, coalesced to the yield cadence
}
```

A framer is an async generator: `yield` one `FramedRecord` per logical unit (one packet, one
track, one whole-container structure), and optionally `return { capabilities }` at the end. The
generic driver, `openFramedSource`, owns the `ProjectionSession`, batching, yielding, abort
checks, and issue table — a framer never touches any of that.

**Total roots.** A record's `root` object must be _total_: every field the projection spec might
read is present, with an explicit `null` when the value is absent — never omitted. Conformance
tests run with `strictFields: true`, which distinguishes a present `null` from a missing
property and throws `ProjectionFieldError` on the first missing read; production keeps
`strictFields: false` (row-time evaluation still returns null and never throws there), so a gap
only surfaces during testing, not for a real user. The one exception is an _anchor_ whose absence
is itself meaningful — ZIP's `end_of_central_dir` is omitted entirely (not set `null`) when the
archive has no end-of-central-directory record, so the table's `$.end_of_central_dir` anchor
misses the property lookup and the table comes back with zero rows instead of one null row.

**`ctx.report`/`progress`/`bytes`.** `report` files a `FramerIssue` (an `IssueReport` with
`stage` optional, defaulting to `'framing'`) into the errors table — use it for container-level
problems discovered while framing (pcap's truncation-at-EOF, ZIP's central-directory issues,
MIDI's per-track normalizing/parsing failures). `progress` is forwarded to the app immediately,
for framer-owned progress phases (MIDI reports `normalizing`/`parsing`/`projecting` stages this
way). `bytes(consumed)` reports byte-level "x of y MB" progress; call it before each driver yield
point so the coalesced progress event reflects the record just produced, and expect it to be
reported at the driver's yield cadence (every `yieldInterval` records, default 256) rather than
every call — the driver always flushes one final byte-progress event at EOF regardless of the
cadence, so the last reported number is always accurate.

**`tables`/`ordinal`/`onError`.** `tables` restricts which spec tables a record can populate
(MIDI's header record sets `tables: ['header']`; its per-track record sets
`tables: ['events', 'tempo']`) — omit it when a record can reach every table its root has
anchors for. `ordinal` names the errors-table ordinal value to use if projecting _this_ record
throws (MIDI: the track index) — the driver turns that throw into a recoverable `projecting`
errors row rather than failing the whole session. `onError` overrides the default issue shape
for that row (MIDI distinguishes `KAITAI_PARSE_FAILED` from `PROJECTION_FAILED` by stage).

**`PackFatalError`.** The one fatal path is input a framer cannot recognize at all even after a
successful probe (MIDI's Type 2 files, or genuinely corrupt magic bytes) — throw
`new PackFatalError(code, message)` and the driver lets it propagate as the pack's fatal error.
Every other problem — truncation, a malformed record, a parser that throws on one packet — should
become a recoverable `errors` row via `ctx.report` or `onError` instead, so one bad record never
takes down a whole session.

**Provenance.** `provenance` is either a fixed `{ start, end }` range for the whole record, or a
resolver `(table, match) => SourceRange` when different tables (or different rows within a
`[*]`-anchored table) need different ranges — MIDI's per-track record resolves each event's own
`sourceStart`/`sourceEnd`; ZIP's whole-container record resolves each anchor match's own
`_range`.

## Projection spec v0.4 nullability rules

Spec v0.4 (`version: '0.4'` in the `.tables.yaml`) adds optional `nullable: true` on a column
spec. In v0.4, spec columns are **non-null by default** — the opposite of v0.1–v0.3, where
every spec column was implicitly nullable (specs declaring `0.1`–`0.3` still load unchanged and
keep treating every spec column as nullable; behavior changes only when a pack's spec migrates
to `0.4`).

Engine-owned columns follow fixed rules, independent of what the spec declares, matching what the
engine actually writes:

- Key and `parent_key` columns: **non-null**.
- `_src_start` and `_src_end`: **non-null** on projected and stream tables (every emitted row
  resolves a range), **nullable** on `errors`.
- `stream_id` (injected on message-fed tables): **nullable**.
- `_src_ranges`: **nullable**.
- A stream segments table's feed-key column: **nullable**.
- `errors.<ordinal>`: **nullable**; every other `errors` column: **non-null**.

`pack.schemas()` (built by `projectionSchemas(compiled, { ordinalColumn })`) derives every
table's `TableSchema` — names, Arrow types, and nullability — directly from the compiled spec, in
engine column order, following the rules above. Nothing hand-writes a schema anymore: the
conformance kit's schema check compares every emitted Arrow batch against `pack.schemas()`
column-for-column, so a spec/hook mismatch fails a test instead of silently yielding NULL
columns at runtime. `nullable` is informational only (Explorer's `?` marker, the worker's column
overview) — it never affects Arrow output or goldens.

## Parsers and Kaitai helpers

A parser is a `RecordParser`: it takes a byte range and returns the projection root (or root
fragment) for a nested structure — pcap's `dissect:` chain calls one per protocol layer
(ethernet → ipv4/ipv6 → tcp/udp → dns/tls/icmp/icmpv6).

`@byteql/core/kaitai` provides the two helpers every Kaitai-backed parser needs, so pack
wrappers shrink to field maps instead of re-implementing parse/offset glue:

```ts
import { kaitaiParse, payload } from '@byteql/core/kaitai';

export const ethernetFrame: RecordParser = (bytes) => {
  const parsed = kaitaiParse(EthernetFrame, bytes);
  return { root: { ether_type: parsed.etherType, body: payload(parsed, 'body') } };
};
```

- `kaitaiParse(GenClass, bytes)` — builds a `KaitaiStream` over a `DataView` that preserves
  `bytes.byteOffset`, constructs `GenClass`, and runs `_read()`. A parse failure throws; the
  engine turns that into a `DISSECT_PARSE_FAILED` issue.
- `payload(parsed, field)` — returns `{ bytes, start }` for a field's payload range, where
  `start` comes from `_debug.<field>.start`. **`start` is relative to the view the wrapper was
  handed, never `ioOffset + start`.** The engine composes absolute provenance as
  `baseOffset + payload.start`; adding `ioOffset` on top would double-count the enclosing
  layers. This convention is documented and unit-tested once in core so every pack's wrappers can
  drop the local re-explanation.

ZIP shows the non-Kaitai path: its reader is hand-written (a hand-written binary reader is
sometimes simpler than a `.ksy` schema for a central-directory-anchored format), and its framer
yields the whole parsed structure as one record instead of using per-layer parsers.

## Testing a pack

Every pack's `test/conformance.test.ts` is one call:

```ts
import { describePackConformance } from '@byteql/core/testing';

import { pcapFormatPack } from '../src/index.js';
import { PCAP_FIXTURES } from './fixtures.list.js';

describePackConformance(pcapFormatPack, {
  fixtures: PCAP_FIXTURES,
  fuzz: { seed: 1, truncations: 6, flips: 6 },
});
```

`fixtures` is a list of `FixtureCase` (`{ name, container, load() }`); `goldens` defaults to
`./goldens` relative to the test file. For each fixture, the kit runs:

1. **Probe** — the fixture's bytes probe to this pack and the declared `container`.
2. **Golden, schema, strict fields, provenance bounds** — one full parse (with
   `strictFields: true`) is checked against `pack.schemas()` (names, order, Arrow types on every
   emitted batch), against the nullability rules above (no nulls in a column not declared
   nullable), against provenance bounds (`0 <= _src_start <= _src_end <= size`, every
   `_src_ranges` piece inside its row's span and in order), and its merged tables are serialized
   to a stable golden (`goldens/<fixture>.json` — Arrow types plus row count plus a SHA-256 over
   every row plus the first 10 rows verbatim, bigint- and binary-safe) via
   `toMatchFileSnapshot`. Regenerate goldens for review with `vitest -u` (or
   `pnpm --filter <pkg> test -- -u`), then diff the change like any other file.
3. **Determinism and chunk/drain invariance** — two default runs must produce identical merged
   output; a run with `chunkBytes` 1 and 7 (or, for a fixture bigger than the fuzz `maxBytes`,
   `chunkBytes` 4093), `flushRowThreshold` 1, and `yieldInterval` 1 must merge to the same
   tables, issues, and capabilities as the default run. This is what catches a framer that
   assumes it always sees a whole record in one chunk.
4. **Clean abort** — aborting after the first batch rejects the next `nextBatch()` with
   `AbortError`, without hanging.
5. **Seeded fuzz** (fixtures at or under `fuzz.maxBytes`, default 64 KiB) — the fixture
   truncated at `truncations` evenly spread offsets, and with `flips` single-byte flips at seeded
   positions (a mulberry32 PRNG keyed by `fuzz.seed`, for reproducibility), must each either
   complete cleanly or throw exactly `PackFatalError`; any other throw, or a hang, fails the
   test. Every mutant that completes is re-checked against the schema/provenance invariants from
   step 2. Fixtures larger than `maxBytes` skip fuzzing entirely (and use the single `4093`
   chunk size above instead of `1`/`7`) — fuzzing scales with fixture size and a multi-hundred-KB
   capture would make the suite too slow.

Known limits, not bugs: a framer that spins synchronously without an `await` between records
cannot be interrupted mid-record by the abort check (the abort check runs between driver pump
iterations, not inside a synchronous framer loop) — this only matters for a pathological framer,
and every shipped framer already awaits per record or per byte-source read. The abort test itself
fails loudly (not falsely-passes) on a fixture small enough that its whole parse completes in one
batch before the second `nextBatch()` call can observe the abort.

Packs keep their own framer-, wrapper-, and semantic-level unit tests (wire-format edge cases,
specific field decoding) alongside `conformance.test.ts` — the kit only covers the properties
that are the same shape for every pack.

## Adding a container to an existing pack

One pack can have more than one container — pcapng, when it ships, becomes a second container of
the existing `pcap` pack rather than a new pack, sharing one spec, dissect graph, streams, and
queries so a multi-file session can mix `.pcap` and `.pcapng`. The recipe for adding a container
to an existing pack:

1. Add a `containers` entry to `pack.yaml`, with its own `id`, `probe` (its own magic bytes or a
   probe hook), and `framer` (a new hook name).
2. Write the new framer, following the same contract as every other framer in this guide. It can
   yield records with `tables` restricted to the record kinds only this container produces
   (pcapng's `interface` records, say) — the classic-pcap framer simply never yields those
   records, so its `interfaces` table (if the spec adds one) comes back empty for pcap files, no
   `if (container === 'pcapng')` branching required anywhere else.
3. If the new container introduces new record kinds the shared spec needs to read, add tables
   (or extend existing tables) whose `rows:` anchor at `$.<kind>` on the new framer's root shape
   — the same anchor-path convention every existing table already uses (`$.hdr`,
   `$.tracks[*].events.event[*]`, `$.local_files[*]`). The spec, dissect graph, and queries stay
   otherwise unchanged; only the new framer needs new code.
4. Add fixtures for the new container to `test/fixtures.list.ts` (tagged with the new
   `container` id) — `describePackConformance` then covers it with the same probe, golden,
   schema, chunk-invariance, abort, and fuzz checks as every other container.

## Commands

- `byteql-pack new <id> --dir packages/formats` — scaffolds `packages/formats/<id>/` from
  `packages/pack-tools/templates/`: a one-container `pack.yaml`, a one-table spec, a
  table-overview query, a stub framer that yields the whole file as one record, `index.ts`, and a
  `conformance.test.ts` with an empty fixture slot to fill in. The scaffold builds and passes
  `check` as generated.
- `byteql-pack build` — validates `pack.yaml`, compiles `.ksy` schemas (if `ksy` is set) to
  `gen/`, loads and validates the projection spec, lints `queries.yaml`, and emits
  `src/pack.generated.ts` (the parsed manifest, the typed query list, and the hook-name union
  types `definePack` is generic over). Every pack's `build`/`check`/`test` script calls it once,
  before `tsc`/`vitest` — see `packages/formats/pcap/package.json` for the pattern.
- Register the new pack in `apps/web/src/lib/packs.ts`: import the pack and add it to
  `REGISTERED_PACKS`. Registration order breaks probing ties (the earlier-registered pack wins);
  a confidence of 0 is never selected. That one import-and-array-entry is the only app-side
  wiring a new pack needs — probing, table schemas, and queries all flow from the pack itself.
