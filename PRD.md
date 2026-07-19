# ByteQL — Product Requirements Document

> **SQL for binary files.** Wireshark's dissector philosophy, generalized to every record-oriented format — entirely in your browser, nothing uploaded.

| | |
|---|---|
| Status | Draft v0.3 — updated 2026-07-18 |
| Owner | TBD |
| Progress | Phase 0 ✅ shipped · Phase 1a engine prep ✅ shipped 2026-07-18 · Phase 1 slice 1/3 (pcap pack) ✅ shipped 2026-07-18 · slice 2/3 (scale & intake) ✅ shipped 2026-07-19 · slice 3/3 (hex-provenance UI) ✅ shipped 2026-07-19 — Phase 1 complete |

## 1. Problem

Analysts and engineers constantly need to *query* binary files — pcaps, event logs, registry hives, MIDI, proprietary telemetry — but today's tooling forces a bad choice: format-specific GUIs (Wireshark: superb for pcap, useless for everything else), lossy convert-to-JSON pipelines that destroy byte-level context, or writing one-off parsing scripts per investigation. There is no general tool that turns *any* record-oriented binary into relational tables you can join, filter, and aggregate — while preserving the link back to the exact bytes.

## 2. Users & use cases

- **DFIR / security analysts** (beachhead): triage evtx/regf/pcap/journal artifacts on machines where installing software or uploading evidence is prohibited. "Run 800 Sigma rules against this evtx in a browser tab" is the headline capability.
- **Protocol & embedded engineers**: inspect captures and device dumps of custom formats; author a `.ksy` + projection spec once, share it as data.
- **Reverse engineers / format tinkerers**: explore unknown or semi-documented formats with hex↔SQL round-tripping.

Common constraint across all three: **data cannot leave the machine**. Local-only execution is a requirement, not an optimization.

## 3. Competitive landscape

| Tool | What it does | Why we're different |
|---|---|---|
| Wireshark | Best-in-class network dissection | Network-only; display filters ≠ SQL (no joins/aggregates); desktop install |
| `fq` (wader/fq) | jq for binary formats, CLI | Closest analog. jq expressions, not SQL; no provenance UI; terminal-only; no browser/zero-install story |
| ImHex / 010 Editor | Hex editors with pattern languages | Byte-centric, not table-centric; no relational queries across records |
| Kaitai WebIDE | Visualize one file against a .ksy | Single-record tree view; no tables, no SQL, no chaining |
| `tshark -T fields` → DuckDB | DIY pipeline | pcap-only, lossy, loses byte offsets, requires local toolchain |

Our wedge: **provenance + SQL + zero-install**, and a dissector registry that no convert-to-JSON tool has.

## 4. Differentiators

1. **Byte provenance** — every row and cell traces to exact byte offsets; SQL results light up the hex view (and hex selections filter the grid), Wireshark-style but for any format.
2. **Dissector chaining** — declarative bindings: "when this field equals 0x0800, hand the payload to the ipv4 parser," producing multiple joined tables per file.
3. **Privacy by architecture** — File System Access API + wasm; bytes never leave the browser. This is the adoption story for DFIR.
4. **Formats as data** — a format pack is `.ksy` + YAML projection spec + canned queries. Contributors ship formats without touching engine code.

## 5. Scope & non-goals

**In scope (v1):** read-only analysis of record-oriented binary files; format gallery (MIDI, pcap, lnk, regf, utmp, journal); EVTX via Rust plugin; Parquet export; Sigma rule execution.

**Non-goals (v1):** editing/writing binaries; live capture; collaboration/multi-user; server-side or CLI deployment; full TCP stream reassembly (see Risks); mobile browsers; formats that aren't record-oriented (whole-file compression, media codecs).

## 6. Success metrics

- **Phase 0:** cold load → first SQL result on a .mid in < 10 s on a mid-range laptop; the Tone.js demo ("edit the WHERE clause, the music changes") is shareable as a single URL; ≥ 1 external person reproduces it unaided.
- **Phase 1:** 1 GB pcap → queryable in < 60 s; hex↔grid round-trip works on every gallery format; query over 3 columns of a 4 GB capture reads < 10% of the file (predicate/projection pushdown verified).
- **Phase 2:** a community-authored format pack lands with zero engine changes; Sigma pack runs the public SigmaHQ ruleset against an evtx in < 30 s.

## 7. Functional requirements (summary)

1. Open local files of arbitrary size via File System Access API; never transmit bytes.
2. Auto-detect format (plugin `probe`), with manual override.
3. Produce one or more relational tables per file per its format pack; hidden `_src_start`/`_src_end` provenance columns on every row.
4. Full DuckDB SQL over all tables, including cross-table joins via synthetic keys.
5. Bidirectional hex↔grid linking.
6. Export any result set as Parquet/CSV.
7. Load user-supplied `.ksy` + projection specs at runtime (lazy-loaded compiler).
8. Graceful handling of malformed/truncated files: partial results + per-record error table, never a blank screen.

## 8. Platform constraints & browser support

- **Chromium first.** File System Access API and stable OPFS are Chromium-only today. Firefox/Safari fallback: `<input type=file>` + in-memory path with a size cap; document the degradation, don't block on it.
- wasm32 caps addressable memory ~4 GB; the spill architecture (below) exists so we never approach it.
- OPFS spill is subject to browser storage quota — request persistent storage, surface quota errors, and clean up spill files on session end.
- WebGPU (WebLLM only) remains strictly optional.

## 9. Architecture

File Intake (File Access API + OPFS) → Parse worker pool (Kaitai + wasm plugins) → Projection Engine (parse tree → rows) → Column store (Arrow + Parquet spill) → DuckDB-WASM (SQL engine in worker) → UI shell (grid, hex view, SQL console).

### The data spine: Arrow everywhere

Apache Arrow IPC is the universal interchange format between every layer: parsers emit Arrow record batches; the store holds Arrow buffers (or Parquet, Arrow-at-rest); DuckDB-WASM registers Arrow tables near-zero-copy; the grid renders directly from Arrow columns. One decision, three wins: a language-agnostic plugin boundary (anything that writes Arrow IPC bytes can be a parser), cheap worker communication (transfer ArrayBuffers, never structured-clone), and Parquet export for free.

### The two hard design problems

**Problem 1 — the projection spec.** Kaitai gives a parse tree; SQL needs tables. The mapping is the crux, and it must be declarative data, not imperative code: a sidecar YAML spec next to each `.ksy` (full DSL in Appendix A). Kaitai types map cleanly onto Arrow types (u4 → uint32, str → utf8, blobs → binary), so schema inference is mostly mechanical. Open question: how much of the mapping can be auto-generated for simple formats (see §14).

**Problem 2 — the dissector registry.** The Wireshark idea we're generalizing, and what no "binary to JSON" tool has. A pcap parser stops at "here's a payload blob." The registry is a table of bindings: (parent type, selector field, value) → child parser. `ether_type == 0x0800 → ipv4_packet`, `protocol == 6 → tcp_segment`, `dst_port == 53 → dns_packet`. The engine walks the chain and emits multiple normalized tables per file — packets, ip, tcp, dns — sharing a synthetic `packet_id`. That's when SQL stops being a gimmick and becomes the point:

```sql
select p.ts, d.query_name, count(*) over (partition by d.query_name) as freq
from dns d
join packets p using (packet_id)
where d.query_name like '%.ru'
order by freq desc;
```

**Byte provenance ties it together.** Kaitai's debug mode records start/end offsets for every parsed field. Carry `(file_id, byte_start, byte_end)` as hidden columns on every row: clicking a SQL result row highlights those bytes in the hex viewer; selecting bytes filters the grid. The bidirectional link is the product's signature interaction. (Note: debug mode has a parse-speed cost — benchmark it in Phase 0; see Risks.)

### Memory & responsiveness

Everything heavy runs off the main thread: a parse worker pool (transferred ArrayBuffer chunks) and DuckDB-WASM in its own worker. The main thread only touches Arrow batches for rendering through a virtualized grid.

Two-tier file strategy:

- **Small (< ~200 MB):** parse to in-memory Arrow batches, register directly with DuckDB.
- **Large (multi-GB):** open via File System Access API, stream-parse record-by-record (pcap, evt, utmp, journal are all naturally record-delimited — the format gallery was chosen for this), write Parquet incrementally into OPFS. DuckDB then queries lazily with projection and predicate pushdown.

Kaitai's generated parsers are eager, so **don't parse containers with Kaitai**: a thin streaming framer per container (pcap's 16-byte record header is trivial) slices out each record and hands bytes to the Kaitai parser. Containers are few; record types are many; Kaitai covers the many.

### Plugin boundary: define the WIT now, componentize later

```wit
package binsql:plugin;

interface record-source {
  probe: func(head: list<u8>) -> option<f32>;   // sniff confidence
  schemas: func() -> list<table-schema>;
  open: func(opts: open-options);
  next-batch: func() -> option<list<u8>>;       // Arrow IPC bytes
}

interface dissector {
  bindings: func() -> list<binding>;            // registry entries
}
```

Gallery formats ship as precompiled Kaitai→JS parsers driven by the projection engine (fast, small, no component overhead). The component boundary exists for what Kaitai can't express — and we hit that immediately with EVTX (see Risks). Because the contract is "Arrow IPC bytes in and out," a JS module and a Rust component are interchangeable.

*Status: the TypeScript mirror of this contract (`FormatPack`/`RecordSource` in `packages/core/src/protocol.ts`) shipped with Phase 1a — the MIDI pack implements it and the parse worker's probe registry drives it.*

Build decision: precompile all gallery `.ksy` at build time. The Kaitai compiler is Scala.js and weighs several MB — lazy-load it only for the "bring your own .ksy" path, never in the critical bundle.

## 10. Tech stack

- **App shell:** TypeScript + Vite. Every critical dependency (duckdb-wasm, kaitai-struct JS runtime, arrow-js, WebLLM, jco) has a first-class JS API.
- **UI framework:** **Svelte** — fine-grained reactivity for large virtualized grids, JSX keeps the repo `.tsx`-uniform.
- **Data:** @duckdb/duckdb-wasm, apache-arrow JS, parquet-wasm (or DuckDB itself) for the OPFS spill writer.
- **Workers:** Comlink for RPC; a small parse pool.
- **UI components:** TanStack Virtual for the grid; custom canvas hex viewer (DOM hex viewers die at scale); CodeMirror 6 + SQL extension for the console.
- **Plugins:** jco + wit-bindgen; Rust as the blessed plugin language, reserved for where it pays (EVTX parser, TLS JA3/JA4 fingerprinter).

## 11. Security & trust model

- The app parses **hostile input by definition** (malware pcaps, attacker-crafted logs). Kaitai JS parsers must be treated as crash-prone, not exploit-prone (memory-safe runtime), but every parse runs in a worker that can be killed and restarted; a poison record must not take down the session.
- Third-party wasm components run sandboxed with no I/O capabilities beyond the WIT interface — bytes in, Arrow out. No network, no OPFS access from plugins.
- Format packs from the community are data (`.ksy` + YAML) for the gallery path — reviewable, no code execution beyond the shared engine. Only components carry code; mark them visually as such in any future plugin marketplace.
- No telemetry that includes file contents, paths, or derived data. If we add analytics at all, it's opt-in and counts events only.

## 12. Roadmap

**Phase 0 — MIDI spike. ✅ Shipped.** Smallest end-to-end loop: drop a `.mid`, get an `events` table, run SQL. Killer demo: pipe query results into Tone.js — `select * from events where channel = 9` and you hear only the drums. "SQL you can listen to" is the shareable moment, and MIDI's tiny files dodge every memory problem while proving the core loop. *Status: cold sample → first result measured at 307 ms vs the <10 s target (`docs/phase-0-benchmark.md`); the projection DSL conformance suite exists. Two manual exit items remain open: the audible smoke test and the unaided external reproduction (`docs/phase-0-external-test.md`).*

**Phase 1a — engine generalization (prep). ✅ Shipped 2026-07-18.** Everything the second format needs, proven against MIDI as a continuous regression harness: projection spec v0.2 (`dissect` chaining + `parent_key`) validated at load and executed by a single-pass engine with an incremental Arrow batch-flush seam; `ProjectionSession` and a generic per-record errors table (`IssueCollector`) lifted into core; hex literals; `timestamp_us`/`binary` column types; the WIT-aligned `FormatPack`/`RecordSource` boundary; and a probe-based format registry in the parse worker. *Design record and binding runtime contracts: `docs/superpowers/specs/2026-07-18-phase1-generalization-prep-design.md` (see its "Implementation notes").*

**Phase 1 — pcap and the real engine. ⬅ Next.** Remaining scope: the pcap pack with its streaming container framer; worker-protocol streaming and DuckDB incremental registration; OPFS/Parquet spill (requires deliberately revisiting the DuckDB hardening PRAGMAs); File System Access intake with size-tiering; and the hex-provenance UI. Starts with a small pre-task batching the review-deferred cleanups from Phase 1a. *Exit: architecture proven per §6; everything after is content and plugins.*

**Phase 2 — forensics pack + plugin model.** windows_lnk_file, regf, utmp, systemd_journal via the Kaitai path; EVTX as the first Rust component (proving the boundary); a `union all` timeline view across all forensic tables as the flagship feature.

**Phase 3 — intelligence plugins.** Sigma and WebLLM, both lazy-loaded and optional.

### Plugin notes

**Sigma.** A Sigma rule is already a query — detection conditions compile naturally to SQL WHERE clauses. Skip pySigma-in-Pyodide (a Python runtime in the browser for this is absurd); the condition grammar is small enough for a TypeScript→DuckDB-SQL transpiler, or compile the public SigmaHQ ruleset to SQL at build time and ship it as data. The real work is field mapping (Sigma's EventID/Channel taxonomy → our columns), which slots into the projection spec. "800 detection rules against this evtx, entirely in your browser" is a legitimately novel DFIR capability.

**WebLLM text-to-SQL.** Works, but strictly optional: WebGPU + ~1 GB model download would wreck the "fast and light" first impression. Prompt with information_schema + 3 sample rows per table + a few-shot bank of format-specific queries (shipped with each format pack — they double as documentation). Qwen2.5-Coder-1.5B is a reasonable floor; keep the model swappable.

**MIDI extras.** One analytical step beyond playback: key/chord detection (Krumhansl-Schmuckler is a page of code and runs as SQL aggregations — very on-brand).

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| No usable EVTX `.ksy` — gallery's windows_evt_log is XP-era EVT; EVTX's chunked binary XML + template substitution exceeds Kaitai's declarative model | Sinks the forensics story if unaddressed | Flip into the architecture's proof point: omerbenamram/evtx (mature Rust crate) compiles to wasm as our first component. Same pattern later covers protobuf streams, SQLite, compression-inside-records |
| Kaitai debug mode (offset recording) slows parsing | Provenance could cost more than "free" | Benchmark in Phase 0; if material, record offsets only at anchor granularity (row-level is all the UI needs) |
| Kaitai JS runtime throughput on big captures | Phase 1 latency targets | Kaitai targets Rust (beta); component boundary lets us swap hot formats without touching anything else |
| TCP reassembly (TLS handshakes across segments) is stateful stream processing, not per-record parsing | TLS features limited | Scope v1 to "ClientHello fits in one segment"; reassembly is a Phase 2+ engine feature |
| Firefox/Safari lack File System Access API | Shrinks addressable users | Chromium-first; degraded in-memory fallback with size cap (§8) |
| OPFS quota eviction mid-session | Data loss / broken queries | Request persistent storage; surface quota; spill cleanup |
| Kaitai compiler is GPLv3 | License hygiene | Build-time use only (generated code isn't GPL); lazy-loaded user-path compiler runs client-side unmodified — verify distribution terms before shipping; audit gallery `.ksy` licenses per pack |

## 14. Open questions

1. Can projection specs be auto-generated from a `.ksy` for simple (non-union, non-stateful) formats? Even a 70% generator changes the contribution economics.

---

## Appendix A — The projection DSL

> **Implementation status (2026-07-18):** spec v0.2 is implemented and conformance-tested in
> `packages/core/src/projection/` — anchor paths, state registers, `where`/`when` guards,
> `parent_key`, `dissect` chaining with composed provenance, hex literals, and the
> `timestamp_us`/`binary` column types. The function library currently ships `enum_str`, `to_i`,
> `len`, `u24be` (`substring` and format helpers like `ip4_str` arrive with pcap). Binding runtime
> contracts (payload offset convention, session state semantics, drain-before-finish) are recorded
> in `docs/superpowers/specs/2026-07-18-phase1-generalization-prep-design.md` → "Implementation notes".

### Design principles

- **Data, not code** — fully serializable YAML/JSON; format packs can be authored, shared, and validated without executing anything.
- **Reuse Kaitai's expression syntax** — `.ksy` authors already use it in `if:` and `value:` instances; anyone who writes `.ksy` knows 90% of this DSL, including `_root`, `_parent`, `_index`.
- **Statically checkable** — with both the `.ksy` schema and the spec at load time, every path and expression type-checks before parsing a single byte. Errors at load, never per-row.

### `<format>.tables.yaml`

```yaml
version: 0.1
format: standard_midi_file          # must match the .ksy meta.id
tables:
  - name: events
    rows: $.tracks[*].events[*]     # anchor path — each match becomes a row
    where: _.event_type != 0xFF     # optional row filter (Kaitai expr, bool)
    key: event_id                   # auto-generated synthetic id
    parent_key: null                # or {table: packets, column: packet_id}
    state:                          # stateful accumulators (see below)
      tick:
        scope: $.tracks[*]          # register resets when this ancestor advances
        init: 0
        update: tick + _.delta_time
    columns:
      track:    { expr: _index(1),           type: int32 }
      tick:     { expr: tick,                type: int64 }
      channel:  { expr: _.event.channel,     type: int8,  when: _.is_channel_event }
      note:     { expr: _.event.note,        type: int8,  when: _.is_note_event }
      velocity: { expr: _.event.velocity,    type: int8,  when: _.is_note_event }
      kind:     { expr: enum_str(_.event_kind), type: utf8 }
```

**Anchor paths.** The `rows` path is the heart of the spec:

```text
path      = "$" , { step } ;
step      = "." , ident                 (* struct field *)
          | "[" , "*" , "]"             (* iterate array *)
          | "[" , integer , "]"         (* single element *)
          ;
```

Semantics: depth-first, document-order walk of the Kaitai object graph. Nested `[*]` produces the flattened product — `$.tracks[*].events[*]` yields every event of track 0, then track 1, in order. That ordering guarantee is load-bearing: it makes stateful accumulators deterministic.

**Evaluation environment.** Each anchor match evaluates columns in a scope containing `_` (the anchor node), `_parent(n)` (nth ancestor on the anchor path), `_root`, `_index(n)` (ordinal of the nth-level iteration), declared state registers, and file-level constants (`_root.header.division` for MIDI). Missing fields — a path absent on this variant — evaluate to null, not error: the relational answer to Kaitai's switch-on types.

**Column expressions.** A strict subset of Kaitai's expression language: field access, arithmetic, comparison, boolean, ternary, bit ops, plus a versioned, closed function library (`enum_str`, `to_i`, `substring`, `len`, format helpers like `ip4_str`). No user-defined functions. Anything fancier belongs in SQL after extraction. The moment someone needs a loop, the answer is "that format needs a plugin, not a bigger DSL."

**`when` clauses.** For switch-typed unions, `when:` makes a column null unless the guard holds — one `events` table absorbs note_on/note_off/control_change/pitch_bend without exploding into micro-tables. Authoring rule of thumb: variants sharing most fields → one table with when-guards; variants sharing almost nothing (DNS vs TLS inside TCP) → separate tables.

**Stateful accumulators** — what makes MIDI (and surprisingly many formats) possible. Each register declares `scope` (an ancestor prefix of the rows path; when it advances, reset to `init`), `init`, and `update` (evaluated once per anchor **before** columns read it — so `tick` includes the current event's delta; document this ordering explicitly or it becomes a silent off-by-one). Sequence numbers, cumulative offsets, running checksums, previous-record timestamps all fall out of this one mechanism. Updates are pure expressions over (old state, current node); determinism follows from traversal order.

**Keys and provenance.** Every table gets a synthetic monotonic int64 key in traversal order. Child tables from dissector chaining declare `parent_key`, filled with the parent anchor's id — the `dns.packet_id → packets.packet_id` join for free. Every row automatically carries `_src_start`/`_src_end` (hidden in the grid, always queryable) from the anchor's Kaitai debug offsets. Row-level provenance suffices for the hex link; column-level can come later.

### pcap worked example — DSL meets dissector registry

```yaml
format: pcap
tables:
  - name: packets
    rows: $.packets[*]
    key: packet_id
    columns:
      ts:     { expr: _.ts_sec * 1000000 + _.ts_usec, type: timestamp_us }
      caplen: { expr: _.incl_len, type: uint32 }
      len:    { expr: _.orig_len, type: uint32 }

dissect:
  - from: packets
    payload: _.body                       # byte field handed to children
    chain:
      - { when: _root.hdr.network == 1, parser: ethernet_frame }
  - from: ethernet_frame
    payload: _.body
    chain:
      - { when: _.ether_type == 0x0800, parser: ipv4_packet, table: ip }
      - { when: _.ether_type == 0x86DD, parser: ipv6_packet, table: ip }
  - from: ipv4_packet
    payload: _.body
    chain:
      - { when: _.protocol == 6,  parser: tcp_segment, table: tcp }
      - { when: _.protocol == 17, parser: udp_datagram, table: udp }
  - from: udp_datagram
    payload: _.body
    chain:
      - { when: _.dst_port == 53 or _.src_port == 53, parser: dns_packet, table: dns }
```

What this buys: the registry is declarative data in the same file family; each dissected layer's tables are ordinary projection tables; `parent_key` propagates `packet_id` down the whole chain so dns joins back to packets across three layers. A contributor adding a Modbus dissector touches zero engine code.

### Execution model

Compile the spec once per file-load into a small IR: anchor selectors become a state machine over the tree walk; expressions compile to JS closures (v0: a tiny tree-walking evaluator; JIT later). One pass over the parse tree feeds all tables' Arrow batch builders simultaneously, flushing every ~64K rows to the DuckDB worker. Static validation cross-references every path against the `.ksy` type graph and infers Arrow types, so `type:` is usually optional.

---

## Appendix B — Phase 0 plan

### Repo structure

```text
byteql/
├── pnpm-workspace.yaml              # pnpm: apps/*, packages/*, packages/formats/*
├── packages/
│   ├── core/                        # zero-DOM, runs in Node and workers
│   │   └── src/
│   │       ├── projection/
│   │       │   ├── spec.ts          # YAML schema types (v0.1/v0.2) + zod validation
│   │       │   ├── expression.ts    # safe expression parse/validate/evaluate (hex literals)
│   │       │   ├── anchors.ts       # anchor-path compile + single-anchor traversal
│   │       │   ├── walk.ts          # combined anchor matcher + single-pass walker
│   │       │   ├── project.ts       # compile + execution: rows, keys, state, dissect, provenance
│   │       │   ├── session.ts       # ProjectionSession: multi-root projection over batch builders
│   │       │   └── parsers.ts       # RecordParser/ParserRegistry seam for dissect child parsers
│   │       ├── arrow/build.ts       # per-table Arrow vectors + IPC serialization
│   │       ├── arrow/batch.ts       # TableBatchBuilder (flush-threshold seam)
│   │       ├── issues.ts            # IssueCollector → issues list + generic errors table
│   │       ├── protocol.ts          # worker contracts + FormatPack/RecordSource (WIT mirror)
│   │       └── index.ts
│   ├── formats/
│   │   └── midi/
│   │       ├── standard_midi_file.ksy   # vendored, patched (gotchas)
│   │       ├── midi.tables.yaml
│   │       ├── queries.yaml             # canned queries (double as LLM few-shots)
│   │       ├── src/                     # framer, running-status normalizer, kaitai wrapper, pack.ts (FormatPack)
│   │       ├── scripts/compile.mjs      # build step: .ksy → JS parsers (debug mode on)
│   │       └── gen/                     # ksc output, gitignored
│   ├── db/src/browser.ts            # duckdb-wasm wrapper: init, registerArrow, query
│   └── ...
├── apps/
│   └── web/                         # Vite + Svelte
│       └── src/
│           ├── workers/parse.worker.ts  # probe registry → FormatPack.open → drain batches → ParseResult
│           ├── components/          # explorer, grid, SQL editor, inspector, viewers
│           └── lib/viewers/tone-engine.ts  # Tone.js scheduler from result rows
```

Dependency direction is the architecture in miniature: `app → db → core ← formats`. `core` never imports DOM types — that keeps it worker-reusable and Node-testable (projection tests run against fixture `.mid` files in plain vitest, no browser).

### MIDI spike specifics

`midi.tables.yaml` produces `events` (as in Appendix A) and `tempo` — rows anchored on meta event 0x51, columns `tick` (same accumulator) and `us_per_quarter`. Tempo is required because tick→seconds conversion needs the tempo map, and doing it in SQL is a beautiful early dogfood moment:

```sql
create view events_timed as
select e.*,
       sum(coalesce(t.us_per_quarter, 500000) * e.tick_delta)
         over (order by e.tick) / (1e6 * (select division from header)) as seconds
from events e asof join tempo t on e.tick >= t.tick;
```

(DuckDB's ASOF JOIN matching each event to the latest tempo change at or before it — exactly the tool for the job, and a nice flex in the demo.)

### Milestones

1. **Node only.** The format pack's `compile.mjs` invokes kaitai-struct-compiler (debug mode), parses a fixture `.mid`, dumps object graph + `_debug` offsets to console. De-risks the two things we don't control: the compiler toolchain and the gallery spec's correctness.
2. **Projection interpreter MVP** in core: anchor paths, the expression subset (~8 operators for MIDI), one accumulator, Arrow batch emit. Vitest asserts exact row output for hand-crafted 10-event MIDI fixtures — the DSL's conformance suite being born.
3. **Browser assembly:** parse worker takes a File, streams Arrow IPC to the DuckDB worker, SqlConsole runs queries, Grid renders.
4. **Tone.js player:** any query result with (seconds, note, velocity, channel, kind) schedules on Tone.Transport with Tone.Sampler + piano soundfont. Four query chips: note histogram, drums only (`channel = 9`), first 30 seconds, bassline only (`note < 48`). The moment someone edits the WHERE clause and the music changes, the product concept has landed.

### Spike gotchas

- **Running status** (the big one): the gallery's `standard_midi_file.ksy` doesn't handle it, and real files use it constantly — a naive parser desyncs immediately. Don't fight it inside Kaitai; a ~30-line framer-layer preprocessor expands running status to explicit status bytes. Happy accident: this forces the "container framer + preprocessor in front of Kaitai" pattern that pcap needs in Phase 1.
- **VLQ delta times:** the gallery spec handles them, but fixture-test anyway — a VLQ bug corrupts every downstream tick.
- **note_on velocity 0 ≡ note_off:** normalize in the projection (`kind: _.velocity == 0 and _.event_kind == note_on ? 'note_off' : enum_str(_.event_kind)`) so SQL users never learn that MIDI trivia the hard way.
- **Naming:** expose both raw `delta_time` and accumulated `tick` as columns — 8 bytes/row of redundancy saves users from window-function gymnastics.
