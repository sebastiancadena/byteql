# ByteQL Phase 0 Design

**Status:** Approved design

**Date:** 2026-07-17

**Source:** `PRD.md` draft v0.2

## 1. Purpose

Phase 0 proves ByteQL's smallest complete product loop: open a local binary file, project its records into relational tables, query those tables with SQL, and send compatible results to a specialized viewer. MIDI is the first format because it makes that loop easy to demonstrate, but it must not define the permanent application shell.

The repository is currently a scaffold containing the PRD and an untracked Standard MIDI File Kaitai schema. This design covers the first implementation slice only. It does not attempt to implement the full multi-phase platform described by the PRD.

## 2. Goals

Phase 0 will:

- Ship a static Svelte/Vite browser application with no application backend.
- Open local Type 0 and Type 1 `.mid` files without uploading their bytes.
- Handle MIDI running status and common timing/event variants.
- Use a bundled Kaitai schema plus a declarative projection spec to produce Arrow tables.
- Register those tables with DuckDB-WASM and expose editable SQL.
- Render query results in a virtualized grid.
- Preserve and test original-file `_src_start` and `_src_end` offsets for every projected row.
- Offer Tone.js playback only when a query result has a compatible schema.
- Recover useful partial results from malformed tracks where safe.
- Provide a repository-authored demo MIDI behind a `Try sample` action so the open-query-play loop is reproducible from a single shareable URL.
- Keep the product shell format-agnostic even while the sample demonstrates MIDI.

## 3. Non-goals

Phase 0 does not include:

- A visible hex viewer or bidirectional hex-to-grid selection.
- User-supplied `.ksy` or projection specs.
- The complete projection language from PRD Appendix A.
- PCAP, EVTX, registry, journal, or other gallery formats.
- Format-pack-provided executable UI code.
- OPFS, Parquet spill, multi-gigabyte streaming, or worker pools.
- CSV or Parquet export.
- Plugin components, dissector chaining, Sigma, or WebLLM.
- Mobile support or full non-Chromium optimization.

## 4. Decisions

The following decisions resolve ambiguities in the PRD:

- **UI framework:** Svelte is canonical. The Appendix B reference to Solid and the `.tsx` rationale are superseded.
- **Implementation shape:** build a reusable vertical slice, not a hard-coded MIDI demo and not the complete projection platform.
- **Provenance:** Phase 0 stores and verifies exact row-level offsets but defers the visual hex workflow to Phase 1.
- **Application shell:** files, tables, SQL, results, schema, and provenance are permanent concepts. Audio is an optional viewer capability.
- **Browser target:** Chromium is the acceptance target. Phase 0 uses ordinary file input and drag-and-drop because MIDI files are small; File System Access API integration is deferred until it provides a material benefit.
- **Generated code:** Kaitai-generated JavaScript is build output and is not committed.

## 5. Repository structure

The implementation uses a pnpm workspace:

```text
byteql/
├── apps/
│   └── web/                         # Svelte/Vite application
├── packages/
│   ├── core/                        # DOM-free projection and Arrow pipeline
│   ├── db/                          # DuckDB-WASM worker API
│   └── formats/
│       └── midi/                    # MIDI format pack and fixtures
│           └── scripts/compile.mjs  # Build-time Kaitai compilation
└── docs/superpowers/specs/
```

`packages/core` runs in Node and browser workers and does not import DOM APIs. `packages/db` owns DuckDB initialization and query transport. The MIDI package contains the `.ksy`, its vendored `vlq_base128_be` import, projection YAML, canned queries, binary fixtures, generated-code output directory, and its own build-time Kaitai compilation script — format packs own their compile steps rather than sharing a repository-level script. `apps/web` composes these packages and owns user interface state and trusted viewer capabilities.

The dependency direction stays acyclic: the web app depends on core, database, and bundled format packs; the database package accepts Arrow and shared transport types; format packs conform to core-owned data contracts.

## 6. Runtime architecture

Phase 0 uses one parse worker and one DuckDB worker:

```text
Local File
  -> parse worker
  -> MIDI framing and running-status normalization
  -> generated Kaitai parser with debug offsets
  -> compiled projection specification
  -> Arrow record batches
  -> DuckDB worker
  -> SQL result batches
  -> Svelte result grid or compatible viewer
```

The application coordinator routes transferable buffers between workers without decoding table contents on the main thread. The main thread owns interaction state, rendering, and audio scheduling. Phase 0 may emit one record batch per small MIDI table; the interfaces use batches so later formats can flush incrementally without redesign.

### 6.1 Worker contracts

Worker requests have a task identifier and return typed messages:

- `progress`: stage, completed units, optional total, and human-readable label.
- `result`: metadata or transferable Arrow IPC buffers.
- `error`: stable code, stage, message, source range when known, and recoverability.
- `cancelled`: confirmation that the task stopped and temporary state was discarded.

The parse worker exposes `loadFile`, `cancel`, and format metadata operations. The database worker exposes `initialize`, `registerTables`, `query`, `cancelQuery`, `listTables`, and `reset`. Exact RPC syntax is an implementation-plan decision; the semantic boundary is fixed here.

## 7. MIDI parsing and provenance

The bundled Kaitai schema does not support running status. A framing layer therefore processes each track before Kaitai projection:

1. Validate the MIDI header and chunk boundaries.
2. Frame track events while maintaining the current channel status byte.
3. Expand omitted running-status bytes in normalized track data.
4. Record an event-level map from normalized byte ranges to original-file byte ranges.
5. Parse normalized tracks through a generated or adapted Kaitai track entry point with debug offsets enabled.

Inserted status bytes do not acquire fictional source width. The event-level map is authoritative for event-row provenance: `_src_start` begins at the original delta-time byte and `_src_end` is the exclusive end of the original event payload. Header rows use identity offsets. Tempo rows reuse their containing event range.

Tracks are framed and parsed independently after the file header is accepted. If a malformed event prevents safe resynchronization, the remainder of that track becomes an error while completed tracks remain available. The next track can still be processed because its chunk boundary is known.

The normalizer is not a second projection engine. Its responsibilities stop at MIDI event framing, status expansion, source mapping, and safe recovery boundaries; field-to-column mapping remains declarative.

## 8. Minimal projection engine

Phase 0 implements only the reusable language features required by the MIDI pack:

- Table `name`, `rows`, optional `where`, optional state registers, and explicit columns.
- Anchor paths containing field access, fixed indexes, and array iteration.
- Literals and field, ancestor, index, root, and state references.
- Arithmetic, comparison, boolean, bitwise, and ternary expressions.
- A closed function library containing only functions required by the bundled pack, including `enum_str` and `u24be`.
- Per-column `when` guards that produce `null` when false.
- Deterministic state scopes and updates.
- Synthetic monotonic `int64` keys.
- Automatic `_src_start` and `_src_end` columns.

Expressions are tokenized and parsed into an AST. They are never evaluated with `eval` or `new Function`. Compilation rejects malformed YAML, duplicate names, invalid declared Arrow types, unsupported syntax, unknown functions, invalid state references, and syntactically invalid anchor paths before processing a file.

Full path/type cross-validation against the `.ksy` graph and Arrow type inference are deferred. Phase 0 requires explicit column types. Missing union-variant fields resolve to `null`; bundled-pack conformance tests protect against misspelled unconditional paths.

State updates occur once per anchor before columns are evaluated. MIDI's `tick` accumulator therefore includes the current event's delta time. A track-scoped accumulator resets when traversal enters the next track.

## 9. Relational model

The MIDI format pack registers these tables.

### 9.1 `header`

One row containing:

- `header_id int64`
- `format uint16`
- `num_tracks uint16`
- `division int16`
- `_src_start uint64`
- `_src_end uint64`

### 9.2 `events`

One row per MIDI event containing:

- `event_id int64`
- `track int32`
- `event_index int32`
- `delta_time int64`
- `tick int64`
- `kind utf8`
- Nullable variant columns: `channel`, `note`, `velocity`, `controller`, `value`, `program`, `pressure`, and `bend`
- `_src_start uint64`
- `_src_end uint64`

A `note_on` with velocity zero is normalized to `kind = 'note_off'`. The raw delta and accumulated tick are both retained because they answer different queries.

### 9.3 `tempo`

One row per tempo meta-event containing:

- `tempo_id int64`
- `track int32`
- `tick int64`
- `us_per_quarter uint32`
- `_src_start uint64`
- `_src_end uint64`

Pack-provided SQL derives event seconds using the applicable tempo map. Type 0 and Type 1 files are supported. Files using SMPTE division remain queryable, but the Phase 0 audio viewer is disabled with an explanation. Type 2 files are reported as unsupported rather than corrupt.

### 9.4 `errors`

The table is registered with a stable schema even when empty:

- `error_id int64`
- `stage utf8`
- `track int32?`
- `code utf8`
- `message utf8`
- `recoverable bool`
- `_src_start uint64?`
- `_src_end uint64?`

## 10. Format-agnostic user experience

The application uses an Inspector Workbench with three persistent regions.

### 10.1 Explorer

The explorer shows local sources, detected formats, generated tables, schemas, pack-provided canned queries, and parse-error counts. All labels and entries derive from runtime metadata; the permanent navigation contains no MIDI-specific concepts.

### 10.2 Workbench

The workbench places an editable SQL editor above a virtualized Arrow-backed result grid. Queries support keyboard execution and cancellation. A successful parse runs a bounded, pack-provided overview query so the first screen is useful without requiring SQL knowledge. A failed query leaves the previous successful result visible.

### 10.3 Inspector

Selection changes the inspector without rewriting the SQL. Depending on context, it shows:

- Table schema and column types.
- All values for a selected row or cell.
- Original source start/end offsets.
- Parse or query diagnostics.
- Compatible actions under `Open in...`.

The Phase 0 inspector displays provenance numerically. A future generic hex viewer will use the same source-range contract.

### 10.4 Experience states

The normal flow is:

1. The empty state explains local-only processing and offers drop, file selection, or `Try sample` using the bundled public demo.
2. Intake shows detected format, parsing stage, progress, and cancellation.
3. Tables appear after successful registration.
4. A bounded overview query produces the initial grid.
5. The user edits SQL, selects results, and inspects details.
6. Compatible results may open in a trusted specialized viewer.

Desktop Chromium is the layout target. Panes may be resized or collapsed, but mobile navigation is outside Phase 0.

## 11. Viewer capability model

Format packs contribute metadata, projections, schemas, and canned queries as declarative data. They do not inject JavaScript into the application.

Trusted built-in viewers declare a predicate over result schemas and optional format metadata. The `Open in...` menu contains only viewers whose predicate matches the current result. The MIDI audio viewer requires at least `seconds`, `note`, `velocity`, and `kind`; `channel` is optional. It appears as a contextual tool, not a permanent transport bar.

The same contract can later host a generic hex viewer, timeline, chart, or trusted packet tree. Executable third-party viewer plugins require a separate security and lifecycle design and are not implied by the data-only format-pack contract.

## 12. Audio behavior

The audio viewer converts compatible query rows into scheduled Tone.js events through an adapter with an injectable clock. It supports play, pause, stop, current position, and clear error states for invalid timing data. Closing the viewer or loading another source stops playback and releases audio resources. Phase 0 uses a bundled synthesizer configuration and does not fetch remote soundfonts or samples.

Browser audio begins only after an explicit user gesture. Pack queries demonstrate all notes, percussion-channel filtering, a low-note bassline, and a note histogram. Query wording may be MIDI-specific because queries belong to the active format pack; the surrounding shell remains generic.

## 13. Failure and recovery model

A file session has explicit `opening`, `normalizing`, `parsing`, `projecting`, `registering`, `ready`, `querying`, and `failed` states.

- Projection compilation errors reject the bundled pack before parsing begins.
- Invalid MIDI headers reject the file with a concise diagnostic.
- Unsafe malformed events stop only their track and add a row to `errors`.
- Completed tracks remain registered and queryable.
- Query failures appear beside the editor and preserve tables and the last successful result.
- Cancellation discards incomplete output for the cancelled stage.
- A crashed worker is terminated and recreated. The retained local `File` permits an explicit retry.
- Loading a new file stops active queries and audio before replacing session state.

Errors shown to users include actionable stage and byte information where known. Internal stack traces may be available in development diagnostics but are not the primary message.

## 14. Privacy and security

- File contents, paths, names, queries, and derived rows are never sent to an application server or analytics endpoint.
- All JavaScript, WebAssembly, fonts, demo data, and audio resources are bundled as same-origin static assets; the application uses no CDN or runtime third-party fetch.
- Once the application reports ready, parsing, querying, inspection, and playback require no network requests.
- All parsing occurs in a killable worker because files are hostile input.
- Projection expressions use a closed interpreter rather than JavaScript evaluation.
- Format packs are declarative and bundled during Phase 0.
- Worker and UI errors must not accidentally include file contents.
- The static deployment must document that normal hosting request logs can see page requests but never local file operations.

## 15. Verification strategy

### 15.1 Core tests

Unit tests cover path traversal, expression tokenization/parsing/evaluation, null semantics, explicit Arrow types, state update/reset order, synthetic keys, and normalized-to-original source mapping.

### 15.2 MIDI conformance tests

Small committed fixtures cover:

- Type 0 and Type 1 files.
- Running status.
- One-byte and multi-byte VLQ delta times.
- Multiple tracks and tempo changes.
- Velocity-zero note-off normalization.
- SMPTE division with playback disabled.
- Invalid headers, truncated events, and a malformed track followed by a valid track.

Golden expectations assert logical rows and exact original-file offsets. Each fixture has a readable manifest explaining the behavior it proves.

### 15.3 Integration tests

- Compile the real MIDI projection spec and evaluate it with generated Kaitai code.
- Compare Arrow table schemas and values against golden expectations.
- Register Arrow tables in DuckDB-WASM and run every canned query.
- Exercise worker progress, cancellation, reset, and crash recovery.

### 15.4 Interface and browser tests

Svelte component tests cover explorer states, diagnostics, result selection, inspector updates, and capability matching. Chromium Playwright tests open a fixture, await registration, edit and run SQL, inspect provenance, and confirm that compatible results enable the audio viewer.

Audio scheduling is tested through the injected clock/adapter. Audible output receives a short manual smoke test. A browser privacy test waits for application readiness, then fails if processing, querying, inspection, or playback creates a network request.

### 15.5 Performance test

A documented benchmark measures elapsed time from accepting the standard MIDI fixture in a cold browser session to painting the first SQL result. The target is under ten seconds on the recorded mid-range reference machine. The benchmark reports measurements without making ordinary CI depend on noisy wall-clock thresholds.

## 16. Delivery sequence

1. Scaffold the pnpm workspace, strict TypeScript configuration, Svelte/Vite app, and shared quality commands.
2. Prove Kaitai compilation, MIDI framing, running-status normalization, and provenance in Node.
3. Implement the minimal projection compiler/evaluator and Arrow conformance fixtures.
4. Add the DuckDB-WASM worker and canned-query integration.
5. Build the generic explorer, workbench, result grid, inspector, progress, cancellation, and errors.
6. Add schema-matched Tone.js playback as a contextual viewer.
7. Add browser tests, recovery, privacy assertions, performance measurement, bundle checks, and static deployment verification.

Every increment ends with a runnable, tested state. The Node data path is proven before browser assembly, and the generic workbench is useful before the audio capability is added.

## 17. Acceptance criteria

Phase 0 is complete when:

- A fresh Chromium session can open the benchmark MIDI and paint its first SQL result in under ten seconds on the documented reference machine.
- Type 0 and Type 1 fixtures, including running status, produce the expected tables.
- Every projected row in conformance fixtures has exact original-file provenance.
- The user can edit SQL, run and cancel it, browse results, and inspect a row without MIDI-specific permanent navigation.
- A compatible query result can be played, and changing its SQL predicate changes scheduled notes.
- SMPTE timing and Type 2 limitations are explained without crashing or silently producing incorrect audio.
- A malformed track yields partial tables plus a queryable error row when the following track is recoverable.
- Local processing produces no post-load network requests.
- The application builds to static assets at a shareable URL.
- The bundled `Try sample` path reproduces the open-query-play loop without locating a separate input file.
- An external tester can reproduce the open-query-play loop without developer assistance.

## 18. Deferred design work

The implementation must preserve extension points but must not pre-build Phase 1. Later specifications will cover the full projection DSL, static `.ksy` cross-validation, user format packs, large-file framing and spill, the visible hex/provenance interaction, dissector chaining, multiple simultaneous sources, export, trusted component plugins, and the remaining format gallery.
