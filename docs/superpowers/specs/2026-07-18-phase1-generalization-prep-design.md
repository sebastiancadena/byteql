# Phase 1 generalization prep — design

Date: 2026-07-18
Status: approved design, pre-implementation

## Context

Phase 0 (MIDI spike) is functionally complete. Before building Phase 1 proper (pcap, streaming
framer, OPFS/Parquet spill, hex-provenance UI), this milestone generalizes the engine so that the
second format arrives to working mechanisms instead of driving refactors under pressure. The MIDI
pack acts as a continuous regression harness for every change.

## Goals

1. Projection spec v0.2: `dissect:` chaining and `parent_key`, validated at load and executed by
   the engine, proven by a synthetic multi-layer fixture.
2. Engine restructure: one traversal feeds all tables' batch builders, with an incremental
   Arrow record-batch flush seam (core-internal).
3. Format pack boundary aligned with the PRD's WIT `record-source` contract, plus a probe-based
   format registry in the parse worker.
4. Expression and type primitives pcap needs: hex literals, `timestamp_us`, `binary`.
5. MIDI-specific glue lifted into core: multi-root projection sessions and a generic per-record
   errors table.

## Non-goals (deferred to Phase 1 proper)

- Worker-protocol streaming and DuckDB incremental append; the worker still delivers one
  `ParseResult`, and `packages/db` keeps `replaceTables`.
- OPFS, Parquet spill, and any change to the DuckDB hardening PRAGMAs.
- File System Access API intake, file-size gating, byte retention for the hex viewer, and any UI
  change beyond two renamed error codes.
- The pcap pack itself.

The milestone is behavior-preserving: the web app and MIDI pack produce identical results before
and after, except for the two error-code renames noted below.

## Design

### 1. Projection spec v0.2 (`packages/core/src/projection/spec.ts`)

`version` accepts `'0.1' | '0.2'`. Two additions, both rejected under 0.1:

- `tables[].parent_key: { table, column }` — declares a foreign-key column filled by the engine
  during dissect chaining, never by a column expression.
- Top-level `dissect:` list, exactly the PRD Appendix A shape:
  `{ from, payload, chain: [{ when, parser, table? }] }`, where `from` names a declared table or a
  parser id used earlier in the dissect graph.

Load-time validation (errors at load, never per-row):

- `parent_key.table` must exist and `parent_key.column` must equal that table's `key`.
- The dissect graph must be acyclic; every `chain[].parser` must exist in the `ParserRegistry`
  supplied at compile time.
- `payload` and `when` compile against the same expression subset as columns.

`ParserRegistry` is a core-defined map from parser id to
`RecordParser: (bytes: Uint8Array) => { root: unknown }`. Packs supply implementations; MIDI's map
is empty; the synthetic test fixture supplies hand-written parsers.

Execution semantics: when the engine emits a row for a table named in a `from:`, it evaluates the
chain guards in order against that anchor's scope; on first match it evaluates `payload` — which
must resolve to a byte range within the parent record, not a detached copy — invokes the child
parser on those bytes, and projects the child's tables from the resulting subtree inline
(depth-first). Two things propagate down the chain:

- Keys: the child's `parent_key` column receives the just-emitted parent row's synthetic key;
  deeper descendants keep inheriting so the root key (e.g. `packet_id`) reaches every layer.
- Provenance: child parsers see payload-relative offsets; the engine carries an absolute base
  offset into each child projection and adds it, so `_src_start`/`_src_end` always point into the
  original file.

A chain with no matching guard is not an error: the parent row simply has no children, mirroring
the `when:`-null philosophy. A child parser that throws produces an `IssueCollector` row and a
childless parent, never a failed parse.

### 2. Engine restructure (`anchors.ts`, `project.ts`, `arrow/build.ts`)

Single pass: all tables' anchor paths compile into one matcher (a trie over path steps tracking
wildcard indices). One depth-first, document-order walk of the parse tree fires each matching
table in place — state registers update, `where` filters, columns evaluate, the row pushes into
that table's builder, and any dissect chain fires immediately. Traversal order, state determinism,
and key order are preserved exactly; the current
one-full-traversal-per-table model is deleted.

Batch builders: `arrow/build.ts` gains a per-table `BatchBuilder`. Rows append column-wise; at a
row threshold (default 64 Ki, injectable for tests) the builder seals an Arrow `RecordBatch` and
hands it to a sink callback. Final per-table output is a multi-batch IPC stream. In this milestone
the only sink is the internal accumulator; Phase 1's framer-driven incremental registration
attaches at this seam.

`ProjectionSession` (new, core): `createProjectionSession(compiled, registry, options)` returns a
session whose `project(root, resolver)` may be called N times (MIDI: once per track) with builders
and key counters persisting across calls; `finish()` returns the tables. This replaces
`appendProjected` and the key-renumbering shim in `project-midi.ts`. pcap's record-by-record
framer will call it far more often than MIDI does.

`IssueCollector` (new, core): packs report structured issues (`stage`, `code`, `message`,
optional record ordinal and byte range); core renders the standard `errors` table (with
provenance columns when known) and the `ParseIssue[]` list from one source of truth. MIDI's
hand-built `errorsTable` is deleted. `ParseIssue.stage` widens from the fixed MIDI-shaped union
to `string` with documented well-known values (`framing`, `normalizing`, `parsing`,
`projecting`, `dissecting`).

### 3. Format pack boundary and registry (`protocol.ts`, `parse.worker.ts`)

The pack interface mirrors the PRD's WIT `record-source` so componentization later is mechanical.
Everything crossing the boundary is Arrow IPC bytes:

```ts
interface FormatPack {
  id: string;
  title: string;
  probe(head: Uint8Array): number | null;       // WIT: probe — sniff confidence 0..1
  schemas(): TableSchema[];                     // WIT: schemas — derived from the compiled spec
  open(bytes: Uint8Array, opts: OpenOptions): RecordSource;  // WIT: open
  queries: PackQuery[];                         // pack metadata outside the WIT core
}

interface RecordSource {
  nextBatch(): Promise<BatchTransfer | null>;   // WIT: next-batch — IPC record batch + table name
  finish(): SourceFinish;                       // after the last batch: issues + capabilities
}

interface SourceFinish {
  issues: ParseIssue[];                         // errors is also emitted as an ordinary table
  capabilities: Record<string, FormatCapability>;
}
```

Capabilities are returned by `finish()` rather than declared statically on the pack because they
can depend on the parsed file (MIDI disables the audio capability for SMPTE-division files).

`OpenOptions` carries the abort signal and progress callback. The parse worker becomes the
driving loop: read a bounded head slice (4 KiB), probe every registered pack, dispatch to the
highest confidence, `open`, pull `nextBatch()` until null, assemble the same single `ParseResult`
the app already consumes. The registry is an ordered array; today it contains only the MIDI pack.

For eager packs like MIDI, `nextBatch()` is a façade over a completed parse — accepted trade so
the boundary is streaming-shaped before any pack streams.

Error codes: `INVALID_MIDI_HEADER` becomes `UNRECOGNIZED_FORMAT` (carrying probed pack ids);
`MIDI_PARSE_FAILED` becomes `PARSE_FAILED` (carrying the format id). These are the only
user-visible changes. The worker parse message gains an optional `formatId` override; no UI for
it this milestone.

### 4. Expression and type primitives

- Hex literals: extend jsep (plugin hook or registered literal handler) to parse `0x...` into
  number or bigint by magnitude, matching the existing safe-integer→BigInt convention. The PRD's
  `_.ether_type == 0x0800` must evaluate.
- Arrow types: spec `type` enum and `arrow/build.ts` add `timestamp_us`
  (Arrow `Timestamp(MICROSECOND)`, int64 microseconds from expressions) and `binary`
  (Arrow `Binary`, byte ranges/`Uint8Array` values — also what dissect payload columns store when
  a pack wants raw blobs queryable).

## Testing

1. MIDI conformance (regression): existing projection, pack, and e2e suites pass unmodified
   except the two renamed error codes. During the engine transition a temporary old-vs-new test
   asserts byte-identical projected rows, keys, and provenance on all MIDI fixtures; it is
   deleted with the old path.
2. Synthetic dissect fixture (the new capability's conformance suite): a hand-crafted "envelope"
   format in core tests — outer records with a type selector and payload, two child parsers, one
   nesting a grandchild — exercising guard order, first-match-wins, unmatched chains,
   `parent_key` across two hops, absolute provenance composition, and load-time errors
   (cyclic graph, unregistered parser, bad `parent_key`).
3. Flush seam: builder tests with the threshold forced tiny (e.g. 2 rows) asserting multi-batch
   IPC round-trips through DuckDB registration identically to single-batch.
4. Registry: probe dispatch unit tests (confidence ordering, no-match, head-slice bounds) plus
   the existing worker-recovery e2e proving the registry path survives worker recreation.

## Sequencing (approach A — evolve in place, MIDI green at every step)

1. Independent primitives: hex literals, `timestamp_us`/`binary`, `ParseIssue.stage` widening.
2. Lift MIDI glue into core: `IssueCollector` + generic errors table, `ProjectionSession`;
   MIDI consumes both.
3. Engine restructure: single-pass matcher + `BatchBuilder` flush seam; old-vs-new comparison
   test guards the swap.
4. Spec v0.2 + dissect execution on the new engine; synthetic fixture suite.
5. Format pack boundary + probe registry in the worker; error-code renames.

## Risks and notes

- The dissect engine ships without a real consumer; the synthetic fixture is its only exercise
  until pcap. Some rework when real pcap stresses it is accepted and expected.
- `payload` as a byte range (not a copy) is load-bearing for provenance composition; the
  expression evaluator must expose range-typed values for byte fields. If a Kaitai-generated
  field only offers a copied `Uint8Array`, the pack's resolver must supply the range.
- The streaming seam deliberately stops at the core boundary; worker streaming, DuckDB append,
  and intake changes are Phase 1 proper.

## Implementation notes (recorded at milestone completion)

The milestone landed per this design with the following clarifications discovered during
implementation and review:

- `RecordSource.finish()` enforces its "only after `nextBatch()` returned null" contract with an
  explicit drained flag; a partial drain throws `RECORD_SOURCE_NOT_DRAINED`.
- Rule 7 (parent-key reachability): tables fed by a chain link are NOT ancestors of that link's
  parser. Parenting onto an intermediate table's per-row key is expressed by chaining
  `from: <table>` instead of `from: <parser>`; a `parent_key` onto a parser-fed sibling table
  fails at load with `PROJECTION_PARENT_KEY_INVALID`.
- Child-table state registers reset at the start of every dissected payload (each payload is a
  fresh document, so every scope ancestor has advanced); synthetic keys stay globally monotonic
  per table across payloads.
- The `ParseIssue` ordinal field keeps its historical name `track` at the protocol level;
  `IssueCollector`'s `ordinalColumn` option names the errors-table column (`record` by default,
  `track` for MIDI).
- `projectTree` and `ProjectionSession` share the single-pass engine, so both execute dissect
  chains and populate dissect-only tables.
