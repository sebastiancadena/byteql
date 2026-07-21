# ByteQL

> **SQL for binary files.** Wireshark's dissector philosophy, generalized to every
> record-oriented format — entirely in your browser, nothing uploaded.

ByteQL turns record-oriented binary files (MIDI, pcap, and ZIP today; evtx, regf, and more next)
into relational tables you query with DuckDB SQL, with every row tracing back to the exact source
bytes it was parsed from. It runs 100% client-side: drop one file or a same-format batch into a
browser tab, get tables, join and aggregate them, and click any result row to light up its bytes
in the hex view.

## Why

Analysts and engineers constantly need to _query_ binary files — packet captures, event logs,
registry hives, MIDI, proprietary telemetry — but existing tooling forces a bad choice:

- **Format-specific GUIs** (Wireshark is superb for pcap, useless for everything else), with
  display filters that aren't SQL — no joins, no aggregates, no window functions.
- **Convert-to-JSON pipelines** that destroy byte-level context, so you can never get from a
  suspicious record back to the bytes that produced it.
- **One-off parsing scripts** written per investigation and thrown away.

There is no general tool that turns _any_ record-oriented binary into relational tables you can
join, filter, and aggregate — while preserving the link back to the exact bytes. ByteQL is that
tool. Its differentiators:

1. **Byte provenance.** Every row carries hidden `_src_start`/`_src_end` columns. SQL results
   light up the hex view; selecting bytes filters the grid. The bidirectional hex↔grid link is
   the product's signature interaction.
2. **Dissector chaining.** Declarative bindings — "when `ether_type == 0x0800`, hand the payload
   to the ipv4 parser" — produce multiple normalized tables per file (`packets`, `ip`, `tcp`,
   `dns`, …) that join on synthetic keys, Wireshark-style but for any format.
3. **Privacy by architecture.** File System Access API + WebAssembly; bytes never leave the
   browser. Zero network requests after the app loads — no CDNs, fonts, analytics, or
   runtime-loaded code. This is the adoption story for DFIR work where evidence must not leave
   the machine. Enforced by automated bundle audits and e2e tests (`docs/privacy.md`).
4. **Formats as data.** A format pack is a Kaitai Struct schema plus a YAML projection spec plus
   canned queries. Contributors ship new formats without touching engine code.

Who it's for: DFIR and security analysts triaging artifacts on locked-down machines, protocol
and embedded engineers inspecting captures of custom formats, and reverse engineers exploring
semi-documented formats with hex↔SQL round-tripping.

Full product requirements, roadmap, and risk analysis live in [PRD.md](PRD.md).

## How I built ByteQL with Codex and GPT-5.6

ByteQL started with my product thesis: analysts should be able to query binary evidence with SQL,
trace every result back to its exact bytes, and do it without uploading the evidence or installing
an untrusted binary. I made the defining product and engineering choices: the DFIR audience, the
browser-only privacy boundary, SQL plus byte provenance, Arrow as the data spine, declarative
format packs, and MIDI as the first end-to-end proof. Codex helped turn that thesis into a working
product and repeatedly pushed the initial ideas into stronger, testable contracts.

The collaboration was deliberate rather than a single generate-and-accept pass:

| My decisions and review                                                                        | How Codex and GPT-5.6 accelerated the work                                                                                                                                                                                                                                | Evidence in the repository                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Defined the problem, audience, differentiators, architecture, and acceptance metrics.          | GPT-5.6 Sol challenged the initial PRD through adversarial critique and failure-mode inversion, then helped translate it into bounded designs and executable plans.                                                                                                       | [PRD.md](PRD.md), [`docs/superpowers/specs/`](docs/superpowers/specs/), [`docs/superpowers/plans/`](docs/superpowers/plans/)                                                                                                                                                     |
| Chose MIDI as the validating slice and retained final judgment over architecture and scope.    | Sol at high reasoning implemented the critical Phase 0 path across Kaitai parsing, provenance-aware projection, Arrow IPC, DuckDB-WASM, the Svelte workbench, and MIDI playback. I used medium reasoning for narrower, non-critical tasks once the contracts were stable. | [Phase 0 design](docs/superpowers/specs/2026-07-17-byteql-phase-0-design.md), [Phase 0 plan](docs/superpowers/plans/2026-07-17-byteql-phase-0.md), [`packages/formats/midi/`](packages/formats/midi/)                                                                            |
| Made local-only operation a non-negotiable product constraint.                                 | Codex kept that constraint active across later work and turned it into enforcement: bundle audits, browser tests that assert zero off-origin requests, same-origin DuckDB extensions, and release checks that fail closed.                                                | [Privacy model](docs/privacy.md), [`check-bundle.mjs`](apps/web/scripts/check-bundle.mjs), [`privacy.spec.ts`](apps/web/e2e/privacy.spec.ts), [`verify-pages-artifact.test.ts`](apps/web/scripts/verify-pages-artifact.test.ts)                                                  |
| Set the performance targets and decided which implementation trade-offs were acceptable.       | Codex built the benchmark harnesses, traced browser-only failures such as detached buffers and timer clamping, and recorded discoveries back into the design documents instead of letting the specification drift away from reality.                                      | [Scale design notes](docs/superpowers/specs/2026-07-19-phase1-scale-intake-design.md#implementation-notes-recorded-post-execution), [`scale-metrics.spec.ts`](apps/web/e2e/scale-metrics.spec.ts)                                                                                |
| Directed the signature hex-to-grid interaction and approved the final Command Deck experience. | I returned to GPT-5.6 Sol for the UI/UX pass, demo use cases, and guarded `pnpm release:pages` path. It refined the rendered product and automated verification-before-publish while preserving accessibility, responsive behavior, and privacy gates.                    | [UI design](docs/superpowers/specs/2026-07-20-command-deck-ui-redesign-design.md), [`hex-provenance.spec.ts`](apps/web/e2e/hex-provenance.spec.ts), [`package.json`](package.json), [deployment design](docs/superpowers/specs/2026-07-20-cloudflare-pages-deployment-design.md) |

The working loop was **brainstorm → approved design → implementation plan → test-first build →
review → full verification**. Repository guidance in [AGENTS.md](AGENTS.md) kept architecture,
privacy, and completion criteria in context between tasks. Codex did not choose what ByteQL should
be; it made the product I chose feasible on a build-week timescale, carried decisions across a
large codebase, and converted promises into tests. I reviewed the designs, resolved trade-offs,
and treated every “done” claim as something the build, browser tests, or benchmarks had to prove.

After the base architecture and first use case were operational, I also used other models and
tools for supporting plugin work. GPT-5.6 Sol remained the primary collaborator for the core
architecture and Phase 0 implementation, and returned for the final UI/UX, release automation,
and example workflows.

## Architecture

The pipeline, end to end:

```text
File intake                Parse worker               Projection engine        Storage & query
(File System Access   →    (streaming container  →    (parse tree → Arrow  →   (Arrow in-memory, or
 API, drag-drop,           framer + generated         row batches via the      Parquet spill to OPFS)
 <input type=file>)        Kaitai parsers)            YAML projection spec)    → DuckDB-WASM worker
                                                                               → UI shell (grid, SQL
                                                                                 console, hex pane)
```

### The data spine: Arrow everywhere

Apache Arrow IPC is the interchange format between every layer: parsers emit Arrow record
batches, the store holds Arrow buffers (or Parquet — Arrow at rest), DuckDB-WASM registers
Arrow tables near-zero-copy, and the grid renders directly from Arrow columns. One decision,
three wins: a language-agnostic plugin boundary (anything that writes Arrow IPC bytes can be a
parser), cheap worker communication, and Parquet export for free.

### Two-tier file strategy

- **Small files:** parsed to in-memory Arrow batches and registered directly with DuckDB.
- **Large files (multi-GB):** streamed chunk-by-chunk through an incremental container framer,
  with rows spilled incrementally as Parquet into OPFS (the browser's origin-private file
  system). DuckDB then queries lazily with projection and predicate pushdown — a 3-column query
  over a 4 GB capture reads under 2% of the file. Everything heavy runs off the main thread:
  parsing in a killable worker, DuckDB in its own worker.

### Repo layout

pnpm workspace (`apps/*`, `packages/*`, `packages/formats/*`). The dependency direction **is**
the architecture: `app → db → core ← formats`.

| Path                    | Package        | Role                                                                                                                                                                                                                                                                        |
| ----------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`         | `@byteql/core` | The engine: projection spec schema + validation, sandboxed expression evaluator, anchor-path walker, `ProjectionSession`, TCP stream reassembly, Arrow batch builders, the `FormatPack`/`RecordSource` plugin contract. Zero-DOM — runs in Node, workers, and plain vitest. |
| `packages/formats/midi` | `@byteql/midi` | First format pack: Standard MIDI File.                                                                                                                                                                                                                                      |
| `packages/formats/pcap` | `@byteql/pcap` | Network capture pack: 10-parser dissect chain (ethernet → ipv4/ipv6 → tcp/udp → dns/icmp/icmpv6/tls) with TCP stream reassembly.                                                                                                                                            |
| `packages/formats/zip`  | `@byteql/zip`  | Structural ZIP archive pack: archive and local-file metadata with exact byte provenance; file contents are deliberately not extracted.                                                                                                                                      |
| `packages/db`           | `@byteql/db`   | DuckDB-WASM wrapper: local-asset init, hardening PRAGMAs, Arrow registration, OPFS Parquet spill tier, serialized query path.                                                                                                                                               |
| `apps/web`              | `@byteql/web`  | Svelte UI: parse worker with probe registry, session state machine, virtualized grid, CodeMirror SQL console, canvas hex pane, capability-gated viewers (MIDI audio playback via Tone.js).                                                                                  |
| `crates/byteql`         | —              | Name-reservation placeholder for the future Rust/wasm component work (e.g. an EVTX parser). No functionality yet.                                                                                                                                                           |

### Engine invariants

A few rules are load-bearing and worth knowing before reading the code:

- **Document-order traversal** of the parse tree is guaranteed — it makes stateful accumulators
  and synthetic key order deterministic.
- **Errors at load, never per-row.** Spec and compile problems throw at load time; row-time
  expression evaluation returns null, never throws.
- **Input is hostile by definition** (malware pcaps, attacker-crafted logs). Every parse runs in
  a worker that can be killed and restarted; a poison record becomes a row in the per-file
  `errors` table, never a crashed session.
- **DuckDB is deliberately locked down** — external access off, configuration locked — as part
  of the privacy guarantee.

## The plugin methodology: formats as data

The core bet is that adding a format should mean **authoring data, not writing engine code**. A
format pack is three files plus a thin façade:

```text
packages/formats/<name>/
├── <format>.ksy           # Kaitai Struct schema — the binary grammar (vendored or authored)
├── <format>.tables.yaml   # projection spec — how the parse tree becomes relational tables
├── queries.yaml           # canned queries (double as documentation and LLM few-shots)
└── src/pack.ts            # FormatPack façade: probe + container framer + wiring
```

### 1. Kaitai Struct describes the bytes

Each record type is described by a declarative `.ksy` schema. Schemas are precompiled to
JavaScript parsers at build time (with debug mode on, which records the byte offsets of every
parsed field — that's where provenance comes from). Kaitai's generated parsers are eager, so
containers are _not_ parsed with Kaitai: a thin streaming framer per container (pcap's 16-byte
record header, MIDI's chunk structure) slices out each record and hands its bytes to the
generated parser. Containers are few; record types are many; Kaitai covers the many.

### 2. The projection spec turns trees into tables

Kaitai yields a parse tree; SQL needs tables. The mapping is a sidecar YAML spec — fully
serializable, statically validated against the schema at load time, no code execution. The DSL
(full reference in [PRD.md](PRD.md) Appendix A) provides:

- **Anchor paths** (`rows: $.tracks[*].events[*]`) — each match of a depth-first, document-order
  walk becomes a row.
- **Column expressions** — a strict, sandboxed subset of Kaitai's own expression language with a
  closed builtin function library. No user-defined functions; the moment a format needs a loop,
  the answer is a plugin, not a bigger DSL.
- **`when` guards** — for switch-typed unions, a column is null unless its guard holds, so one
  table absorbs many record variants.
- **Stateful accumulators** — scoped registers (`tick: update: tick + _.delta_time`) that make
  running offsets, sequence numbers, and cumulative timestamps declarative and deterministic.
- **Dissector chains** — the registry of `(parent type, selector value) → child parser`
  bindings, in the same YAML file. Each dissected layer's tables are ordinary projection tables,
  and `parent_key` propagates the parent's synthetic key down the chain so `dns` joins back to
  `packets` across three layers.
- **Stream reassembly** (spec v0.3) — a declarative `streams:` section with key-extractor and
  framer registries, so protocols spanning multiple TCP segments (TLS ClientHello,
  DNS-over-TCP) reassemble without format packs owning any stateful code.

### 3. The `FormatPack` boundary

Every pack implements one contract (`packages/core/src/protocol.ts`), a TypeScript mirror of a
WIT interface: `probe(head) → confidence`, `schemas()`, `open(source)`, and batch draining that
yields Arrow IPC bytes. The parse worker's probe registry auto-detects formats by asking every
registered pack to sniff the file head.

Because the contract is "Arrow IPC bytes in and out," a JS module and a sandboxed Rust/wasm
component are interchangeable. Gallery formats ship as precompiled Kaitai→JS parsers (fast,
small, no component overhead); the component boundary exists for what Kaitai can't express —
EVTX's chunked binary XML is the first planned case (`crates/byteql`). Components will run
sandboxed with no I/O beyond the interface: bytes in, Arrow out, no network, no file system.

The trust model follows from this split: community format packs on the gallery path are _data_
(`.ksy` + YAML) — reviewable, with no code execution beyond the shared engine. Only components
carry code.

## Build and publish

### Prerequisites

- **Node.js ≥ 22.12** (see `engines` in `package.json`)
- **pnpm** (the repo is a pnpm workspace; `corepack enable` or `npm i -g pnpm`)
- **A Chromium-based browser** for the app itself. The File System Access API and stable OPFS
  are Chromium-only today; Firefox/Safari fall back to `<input type=file>` with an in-memory
  size cap.
- **Wrangler 4.x** for Cloudflare Pages releases. The release scripts use the already installed
  `wrangler` command rather than a workspace dependency.

No JVM or other toolchain is needed — the Kaitai Struct compiler runs as an npm package during
the build, generating parsers into each format pack's `gen/` directory.

### Install and run locally

```bash
pnpm install
pnpm --filter @byteql/web dev       # Vite dev server — open the printed URL in Chromium
```

Then drop a `.mid`, `.pcap`, or `.zip` file onto the page (or use the built-in demo sample), and
query the resulting tables from the SQL console. Select several files of the same format to query
them as one dataset; the `_src_file`, `_src_start`, and `_src_end` columns preserve file-qualified
byte provenance.

### Create a production build

From the repository root:

```bash
pnpm install
pnpm build
```

This builds every workspace package in dependency order and writes the production web app to
`apps/web/dist`. A normal build still contains DuckDB modules larger than Cloudflare Pages' file
limit, so do not upload that directory until `pnpm prepare:pages` has prepared it.

### Tests and checks

```bash
pnpm test                           # build + unit tests across the workspace (vitest)
pnpm check                          # build + typecheck + lint + prettier check
pnpm --filter @byteql/core test -- --run    # single package (same for @byteql/midi, etc.)
pnpm test:e2e                       # Playwright browser acceptance tests (apps/web/e2e)
pnpm check:bundle                   # privacy/bundle audit: no external URLs in the build
```

Notes:

- Unit tests are co-located as `*.test.ts`; `packages/core` runs entirely without a browser.
- The e2e run builds an instrumented `dist-e2e` — never publish that directory; the deployable
  output is `dist`.
- The project is developed test-first, and the privacy guarantee is itself under test
  (`apps/web/e2e/privacy.spec.ts` asserts zero network requests after app readiness).

### Publish to Cloudflare Pages

The production site at [byteql.dev](https://byteql.dev) uses a Cloudflare Pages Direct Upload
project named `byteql`; [byteql.pages.dev](https://byteql.pages.dev) remains its Pages hostname.
Authenticate Wrangler before the first release from a new machine:

```bash
wrangler login
wrangler whoami
```

The `byteql` project already exists. Only create it when bootstrapping an independent Cloudflare
account or replacing a deleted project:

```bash
wrangler pages project create byteql --production-branch=main
```

For a routine production release, run this from the repository root:

```bash
pnpm release:pages
```

That command performs the complete release pipeline:

1. `pnpm check` builds, type-checks, lints, and checks formatting.
2. `pnpm check:bundle` enforces the bundle-size and zero-external-URL privacy contract.
3. `pnpm prepare:pages` gzip-compresses the oversized, content-hashed DuckDB modules and rewrites
   their generated references in `apps/web/dist`.
4. `pnpm verify:pages` checks the `_headers` contract, the 25 MiB per-file limit, the absence of
   threaded assets, and the presence of both same-origin signed Parquet extensions.
5. `pnpm deploy:pages` uploads only `apps/web/dist` to project `byteql`, production branch `main`.

To inspect or retry individual release stages, run them in this order:

```bash
pnpm check
pnpm check:bundle
pnpm prepare:pages
pnpm verify:pages
pnpm deploy:pages
```

`prepare:pages` modifies `apps/web/dist` in place and expects a fresh ordinary build. Run
`pnpm build` before repeating the preparation step manually. Never publish `apps/web/dist-e2e`;
Playwright creates that instrumented directory only for browser acceptance tests.

The source-controlled `apps/web/public/_headers` file is copied beside `index.html`. It serves
WASM with the correct MIME type, caches immutable generated modules for one year, and keeps
`index.html` uncached. Cross-origin isolation headers are intentionally absent because this is not
a threaded build. The `byteql.dev` custom domain is attached to the same production Pages project.

## Status and roadmap

Phase 0 (MIDI spike) and Phase 1 (pcap, streaming scale intake, hex-provenance UI) have shipped,
including the Phase 2 TCP stream reassembly engine work. ZIP structural analysis and same-format
multi-file sessions have also shipped. Measured against the PRD's exit metrics: a 1 GB pcap is
queryable in ~44 s, and a 3-column query over a 4 GB capture reads 1.7% of the file. Next up:
pcapng, the forensics pack (lnk, regf, utmp, systemd journal), EVTX as the first Rust component,
and intelligence plugins (Sigma rule execution, optional local text-to-SQL). See [PRD.md](PRD.md)
§12 for the full roadmap.

## Key documents

- [PRD.md](PRD.md) — requirements, architecture rationale, roadmap, risks, and the projection
  DSL reference (Appendix A)
- [AGENTS.md](AGENTS.md) — orientation for contributors and coding agents: repo map, commands,
  binding constraints
- [docs/privacy.md](docs/privacy.md) — the privacy threat model
- `docs/superpowers/specs/` — approved design records for each shipped phase

## License

[MIT](LICENSE) © 2026 Juan Sebastián Cadena.
