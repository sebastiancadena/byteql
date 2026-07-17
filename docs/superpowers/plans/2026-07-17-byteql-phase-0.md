# ByteQL Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first complete ByteQL vertical slice: open or sample a MIDI file locally, project it into provenance-carrying Arrow tables, query it with DuckDB-WASM, inspect results in a format-neutral Svelte workbench, and play compatible results.

**Architecture:** A DOM-free core parses safe projection expressions and emits Arrow IPC. A MIDI format package frames tracks, normalizes running status with an original-byte source map, invokes generated Kaitai code, and supplies declarative tables and queries. A Svelte/Vite application coordinates a parse worker and DuckDB-WASM's own worker-backed async client, while trusted viewers attach to query results through schema predicates.

**Tech Stack:** Node.js 22.12+, pnpm workspace, strict TypeScript, Svelte 5, Vite, Vitest, Playwright Chromium, Kaitai Struct 0.11, Apache Arrow JS, DuckDB-WASM, CodeMirror 6, TanStack Virtual, Tone.js, Zod, YAML, and jsep.

## Global Constraints

- Svelte is the only UI framework; do not introduce Solid or React.
- Target desktop Chromium for Phase 0 and produce only static deployment assets.
- Never upload a local file, its name or path, SQL text, or derived rows.
- When the app reports ready, file processing, SQL, inspection, and playback perform no network requests.
- Disable DuckDB external access and extension auto-install/auto-load before running user SQL.
- Parse every user file in a killable worker and check cancellation between MIDI tracks.
- Never use `eval`, `new Function`, or executable code from a format pack.
- Preserve exact, original-file, end-exclusive `_src_start` and `_src_end` row offsets.
- Implement only the projection features used by the bundled MIDI pack.
- Keep permanent UI labels format-neutral; MIDI terms may appear only in pack data and the optional audio viewer.
- Use TDD for every behavioral change and commit after every task.
- Stage only files named by the current task; preserve unrelated user files and changes.

## Reference documentation

- Vite Svelte TypeScript scaffolding and Node floor: <https://vite.dev/guide/>
- DuckDB-WASM Vite bundles: <https://duckdb.org/docs/current/clients/wasm/instantiation>
- DuckDB-WASM Arrow ingestion: <https://duckdb.org/docs/clients/wasm/data_ingestion>
- DuckDB extension hardening: <https://duckdb.org/docs/current/operations_manual/securing_duckdb/securing_extensions>
- Kaitai JavaScript compiler API and debug mode: <https://www.npmjs.com/package/kaitai-struct-compiler>
- CodeMirror 6 lifecycle: <https://codemirror.net/docs/ref/>
- Svelte Testing Library API: <https://testing-library.com/docs/svelte-testing-library/api/>
- Playwright network monitoring: <https://playwright.dev/docs/network>
- Tone.js local synthesizer API: <https://tonejs.github.io/docs/>

## Planned file map

### Workspace and quality configuration

- `.gitignore`: ignore dependencies, generated Kaitai output, builds, reports, and visual-companion state.
- `package.json`: root scripts and Node engine.
- `pnpm-workspace.yaml`: workspace package discovery.
- `tsconfig.base.json`: shared strict compiler rules.
- `eslint.config.js`: TypeScript and Svelte lint configuration.
- `prettier.config.js`: shared formatting configuration.

### `packages/core`

- `src/projection/spec.ts`: YAML-facing schema and compiled types.
- `src/projection/expression.ts`: safe expression parse, validation, and evaluation.
- `src/projection/anchors.ts`: deterministic anchor traversal and index metadata.
- `src/projection/project.ts`: state registers, row filters, columns, keys, and provenance.
- `src/arrow/build.ts`: explicit Arrow vectors, tables, and IPC serialization.
- `src/protocol.ts`: worker and table-transfer contracts shared with the app.
- `src/index.ts`: public exports only.

### `packages/formats/midi`

- `standard_midi_file.ksy` and `common/vlq_base128_be.ksy`: vendored CC0 Kaitai sources.
- `scripts/compile.mjs`: programmatic debug-mode Kaitai compilation.
- `src/container.ts`: MIDI header and track chunk framing.
- `src/vlq.ts`: bounded MIDI VLQ decoding.
- `src/normalize-track.ts`: running-status expansion and source maps.
- `src/kaitai.ts`: generated-parser adapter and debug-offset access.
- `src/project-midi.ts`: per-track parse recovery and projection orchestration.
- `midi.tables.yaml`: bundled declarative relational mapping.
- `queries.yaml`: bounded overview and playback queries.
- `test/fixtures.ts`: deterministic binary fixture builder.
- `test/fixtures/*.mid`: committed acceptance fixtures and demo MIDI.

### `packages/db`

- `src/browser.ts`: Vite-local DuckDB bundles, secure initialization, Arrow registration, query, cancellation, and reset.
- `src/types.ts`: database client interface for UI tests.
- `src/index.ts`: public exports.

### `apps/web`

- `src/lib/session/state.ts`: pure session reducer and state types.
- `src/lib/session/controller.ts`: parse/database orchestration and viewer selection.
- `src/lib/parse-worker-client.ts`: typed parse worker lifecycle.
- `src/workers/parse.worker.ts`: local file parse and Arrow transfer.
- `src/lib/viewers/registry.ts`: trusted capability matching.
- `src/lib/viewers/tone-engine.ts`: injectable audio scheduler.
- `src/components/*`: format-neutral shell, explorer, SQL editor, grid, inspector, status, and audio viewer.
- `src/App.svelte`: composition root only.
- `e2e/*.spec.ts`: open-query-inspect-play, recovery, privacy, and performance flows.

---

### Task 1: Establish the workspace and executable quality baseline

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`
- Create: `prettier.config.js`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/index.test.ts`
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/src/index.ts`
- Create: `packages/formats/midi/package.json`
- Create: `packages/formats/midi/tsconfig.json`
- Create: `packages/formats/midi/src/index.ts`
- Create: `apps/web/package.json`
- Create: `apps/web/index.html`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/src/main.ts`
- Create: `apps/web/src/App.svelte`

**Interfaces:**
- Produces: workspace commands `pnpm build`, `pnpm check`, `pnpm test`, and `pnpm test:e2e`.
- Produces: package names `@byteql/core`, `@byteql/db`, `@byteql/midi`, and `@byteql/web`.

- [ ] **Step 1: Create the workspace configuration**

Use these root scripts and compiler constraints:

```json
{
  "name": "byteql",
  "private": true,
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "build": "pnpm -r build",
    "check": "pnpm -r check && pnpm format:check",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "eslint .",
    "test": "pnpm -r test",
    "test:e2e": "pnpm --filter @byteql/web test:e2e"
  }
}
```

```yaml
packages:
  - apps/*
  - packages/*
  - packages/formats/*
```

Set `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, and `skipLibCheck: true` in `tsconfig.base.json`. Ignore `.superpowers/`, `node_modules/`, `dist/`, `coverage/`, `playwright-report/`, `test-results/`, and `packages/formats/*/gen/`.

Core, database, and MIDI package manifests initially use `build: "tsc -p tsconfig.json"`, `check: "tsc -p tsconfig.json --noEmit"`, and `test: "vitest --passWithNoTests"`. The web package uses `build: "vite build"`, `check: "svelte-check --tsconfig ./tsconfig.json"`, `test: "vitest --passWithNoTests"`, `test:e2e: "playwright test"`, and `dev: "vite"`. `--passWithNoTests` keeps the workspace gate green before later tasks add package-specific tests; Task 1 still proves the core package through its required smoke test. Each library `src/index.ts` is an explicit public entrypoint and each package sets `type: "module"`.

Configure ESLint with `@eslint/js` recommended rules, `typescript-eslint` recommended rules, and `eslint-plugin-svelte` flat recommended rules. Configure Prettier with `plugins: ['prettier-plugin-svelte']`, `singleQuote: true`, `trailingComma: 'all'`, and `printWidth: 110`.

- [ ] **Step 2: Add dependencies through pnpm so the lockfile records exact versions**

Run:

```bash
pnpm add -Dw typescript vitest @vitest/coverage-v8 eslint @eslint/js typescript-eslint eslint-plugin-svelte prettier prettier-plugin-svelte
pnpm --filter @byteql/core add apache-arrow jsep yaml zod
pnpm --filter @byteql/midi add "@byteql/core@workspace:*" kaitai-struct yaml
pnpm --filter @byteql/midi add -D kaitai-struct-compiler
pnpm --filter @byteql/db add @duckdb/duckdb-wasm apache-arrow
pnpm --filter @byteql/web add "@byteql/core@workspace:*" "@byteql/db@workspace:*" "@byteql/midi@workspace:*" apache-arrow svelte tone @tanstack/svelte-virtual codemirror @codemirror/lang-sql
pnpm --filter @byteql/web add -D vite @sveltejs/vite-plugin-svelte svelte-check vitest jsdom @testing-library/svelte @testing-library/user-event @playwright/test
```

Expected: `pnpm-lock.yaml` is created and every workspace package resolves.

- [ ] **Step 3: Write the failing core smoke test**

```ts
// packages/core/src/index.test.ts
import { describe, expect, it } from 'vitest';
import { BYTEQL_CORE_VERSION } from './index.js';

describe('core public surface', () => {
  it('exports the projection contract version', () => {
    expect(BYTEQL_CORE_VERSION).toBe('0.1');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails, then add the minimal export**

Run: `pnpm --filter @byteql/core test -- --run`

Expected before implementation: FAIL because `BYTEQL_CORE_VERSION` is missing.

```ts
// packages/core/src/index.ts
export const BYTEQL_CORE_VERSION = '0.1' as const;
```

Run: `pnpm --filter @byteql/core test -- --run`

Expected after implementation: PASS, 1 test.

- [ ] **Step 5: Verify the workspace and commit**

Run: `pnpm check && pnpm test && pnpm build`

Expected: all commands exit 0 and Vite emits `apps/web/dist`.

```bash
git add .gitignore package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json eslint.config.js prettier.config.js packages/core packages/db/package.json packages/formats/midi/package.json apps/web
git commit -m "build: scaffold ByteQL workspace"
```

### Task 2: Frame MIDI containers and decode bounded VLQs

**Files:**
- Create: `packages/formats/midi/src/types.ts`
- Create: `packages/formats/midi/src/errors.ts`
- Create: `packages/formats/midi/src/vlq.ts`
- Create: `packages/formats/midi/src/container.ts`
- Create: `packages/formats/midi/test/fixtures.ts`
- Create: `packages/formats/midi/src/container.test.ts`
- Modify: `packages/formats/midi/src/index.ts`

**Interfaces:**
- Produces: `decodeVlq(bytes, offset): { value: number; next: number }`.
- Produces: `parseMidiContainer(bytes): MidiContainer`.
- Produces: `MidiHeader`, `TrackChunk`, `SourceRange`, and `MidiParseError`.

- [ ] **Step 1: Define the binary-domain types and fixture builder**

```ts
export interface SourceRange { start: number; end: number }
export interface MidiHeader {
  format: 0 | 1 | 2;
  numTracks: number;
  division: number;
  divisionMode: 'ppqn' | 'smpte';
  range: SourceRange;
}
export interface TrackChunk {
  index: number;
  chunkStart: number;
  bodyStart: number;
  bodyEnd: number;
  body: Uint8Array;
}
export interface MidiContainer { header: MidiHeader; tracks: TrackChunk[] }
```

`test/fixtures.ts` must expose `chunk(id, body)`, `midiFile({ format, division, tracks })`, and `vlq(value)`. Use `DataView.setUint16`/`setUint32` with big-endian `false`; do not depend on a MIDI library in tests.

- [ ] **Step 2: Write failing tests for header, chunks, VLQ, and truncation**

```ts
it('frames two tracks with absolute source offsets', () => {
  const bytes = midiFile({ format: 1, division: 480, tracks: [u8(0, 0xff, 0x2f, 0), u8(0, 0xff, 0x2f, 0)] });
  const parsed = parseMidiContainer(bytes);
  expect(parsed.header).toMatchObject({ format: 1, numTracks: 2, division: 480, divisionMode: 'ppqn' });
  expect(parsed.tracks.map((track) => [track.bodyStart, track.bodyEnd])).toEqual([[22, 26], [34, 38]]);
});

it('rejects a five-byte MIDI VLQ at its first byte', () => {
  expect(() => decodeVlq(u8(0x81, 0x80, 0x80, 0x80, 0), 0)).toThrowError(/VLQ_TOO_LONG.*offset 0/);
});
```

- [ ] **Step 3: Run the tests to verify red**

Run: `pnpm --filter @byteql/midi test -- --run src/container.test.ts`

Expected: FAIL because `parseMidiContainer` and `decodeVlq` do not exist.

- [ ] **Step 4: Implement strict framing**

`decodeVlq` must accept at most four bytes and reject EOF. `parseMidiContainer` must verify `MThd`, header length at least six, declared track count, every `MTrk` tag, and every body length before slicing. Convert a negative signed division to `divisionMode: 'smpte'`; retain the signed `division` value. Throw `MidiParseError` with stable codes including `INVALID_MAGIC`, `TRUNCATED_HEADER`, `UNSUPPORTED_HEADER_LENGTH`, `MISSING_TRACK`, `TRUNCATED_TRACK`, `VLQ_TRUNCATED`, and `VLQ_TOO_LONG`.

```ts
export class MidiParseError extends Error {
  constructor(
    readonly code: string,
    readonly offset: number,
    message: string,
  ) {
    super(`${code} at offset ${offset}: ${message}`);
    this.name = 'MidiParseError';
  }
}
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @byteql/midi test -- --run`

Expected: all MIDI framing tests pass.

```bash
git add packages/formats/midi/src packages/formats/midi/test
git commit -m "feat(midi): frame containers and decode VLQs"
```

### Task 3: Normalize running status while retaining original event ranges

**Files:**
- Create: `packages/formats/midi/src/normalize-track.ts`
- Create: `packages/formats/midi/src/normalize-track.test.ts`
- Modify: `packages/formats/midi/src/types.ts`
- Modify: `packages/formats/midi/src/index.ts`

**Interfaces:**
- Consumes: `decodeVlq`, `TrackChunk`, `SourceRange`, and `MidiParseError` from Task 2.
- Produces: `normalizeTrack(track): NormalizedTrack`.
- Produces: `NormalizedEventMap { index, normalizedStart, normalizedEnd, sourceStart, sourceEnd, deltaTime }`.

- [ ] **Step 1: Write failing tests for explicit status, running status, and recovery failure**

```ts
it('expands running status and maps both events to original bytes', () => {
  const track = trackChunk(22, u8(0x00, 0x90, 60, 100, 0x81, 0x00, 62, 90));
  const result = normalizeTrack(track);
  expect([...result.bytes]).toEqual([0x00, 0x90, 60, 100, 0x81, 0x00, 0x90, 62, 90]);
  expect(result.events).toEqual([
    { index: 0, deltaTime: 0, normalizedStart: 0, normalizedEnd: 4, sourceStart: 22, sourceEnd: 26 },
    { index: 1, deltaTime: 128, normalizedStart: 4, normalizedEnd: 9, sourceStart: 26, sourceEnd: 30 },
  ]);
});

it('clears running status after a meta event', () => {
  const track = trackChunk(0, u8(0, 0x90, 60, 1, 0, 0xff, 0x01, 0, 0, 61, 1));
  const result = normalizeTrack(track);
  expect(result.error).toMatchObject({ code: 'RUNNING_STATUS_MISSING', offset: 9 });
  expect(result.events).toHaveLength(2);
});
```

- [ ] **Step 2: Run the tests to verify red**

Run: `pnpm --filter @byteql/midi test -- --run src/normalize-track.test.ts`

Expected: FAIL because `normalizeTrack` is missing.

- [ ] **Step 3: Implement event-length rules and source mapping**

Channel messages `0x80`–`0xbf` and `0xe0` consume two data bytes; `0xc0` and `0xd0` consume one. Meta `0xff` consumes type, VLQ length, and body. SysEx `0xf0`/`0xf7` consumes VLQ length and body. Reject other system statuses with `UNSUPPORTED_STATUS`. A data byte without current channel status raises `RUNNING_STATUS_MISSING`. Meta and SysEx clear running status.

Append the original delta bytes, an explicit status byte, and original payload bytes to `bytes`. For inserted status, extend only the normalized range; `sourceStart` and `sourceEnd` remain the actual original event span. Stop the track at the first unsafe error and return it as `error` with the successfully normalized prefix rather than throwing away prefix events.

- [ ] **Step 4: Add boundary tests**

Cover program change, pitch bend, meta length using a multi-byte VLQ, SysEx, truncated payload, data byte `>= 0x80`, and a valid event prefix followed by corruption. Assert every end offset is exclusive.

Run: `pnpm --filter @byteql/midi test -- --run src/normalize-track.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/formats/midi/src/normalize-track.ts packages/formats/midi/src/normalize-track.test.ts packages/formats/midi/src/types.ts packages/formats/midi/src/index.ts
git commit -m "feat(midi): normalize running status with provenance"
```

### Task 4: Compile Kaitai in debug mode and parse normalized tracks

**Files:**
- Add existing scaffold file: `packages/formats/midi/standard_midi_file.ksy`
- Create: `packages/formats/midi/common/vlq_base128_be.ksy`
- Create: `packages/formats/midi/scripts/compile.mjs`
- Create: `packages/formats/midi/src/generated.d.ts`
- Create: `packages/formats/midi/src/kaitai.ts`
- Create: `packages/formats/midi/src/kaitai.test.ts`
- Modify: `packages/formats/midi/package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `MidiHeader` and `NormalizedTrack` from Tasks 2–3.
- Produces: `buildSyntheticTrackFile(header, track): SyntheticTrackFile`.
- Produces: `parseSyntheticTrack(file): ParsedTrackTree`.
- Produces: generated `gen/StandardMidiFile.js` with `_debug` maps.

- [ ] **Step 1: Vendor the CC0 VLQ schema and declare the build command**

Copy the official `common/vlq_base128_be.ksy` with its license metadata intact. Add:

```json
{
  "scripts": {
    "compile:ksy": "node scripts/compile.mjs",
    "build": "pnpm compile:ksy && tsc -p tsconfig.json",
    "check": "pnpm compile:ksy && tsc -p tsconfig.json --noEmit",
    "test": "pnpm compile:ksy && vitest"
  }
}
```

- [ ] **Step 2: Write a failing generated-parser test**

The test builds a one-track synthetic file from a normalized running-status track, calls `parseSyntheticTrack`, and asserts the two parsed events plus `_debug.event.start/end` offsets. Because debug compilation disables constructor auto-read, the adapter test must fail if `_read()` is omitted.

Run: `pnpm --filter @byteql/midi test -- --run src/kaitai.test.ts`

Expected: FAIL because the compiler script and adapter do not exist.

- [ ] **Step 3: Implement programmatic compilation**

Use `createRequire(import.meta.url)` to load the compiler's UMD module, `YAML.parse` for schemas, and:

```js
const files = await compiler.compile('javascript', rootSchema, importer, true);
```

The importer's `importYaml(name)` strips one leading slash, resolves only beneath the MIDI package directory, rejects `..`, and loads `${name}.ksy`. Write every compiler output under `gen/` and fail the process on compiler errors. Do not load the compiler in browser code.

- [ ] **Step 4: Implement the synthetic-file and parser adapter**

Create a canonical 14-byte `MThd` with copied format/division and `num_tracks = 1`, then one `MTrk` containing normalized bytes. Shift normalized event offsets by 22 when correlating generated debug positions. Instantiate `StandardMidiFile`, call `_read()`, and return the single parsed track plus its debug object.

```ts
const parsed = new StandardMidiFile(new KaitaiStream(file.bytes));
parsed._read();
if (parsed.tracks.length !== 1) throw new Error('KAITAI_TRACK_COUNT: expected one synthetic track');
```

- [ ] **Step 5: Verify generated output is reproducible and commit sources only**

Run twice: `pnpm --filter @byteql/midi compile:ksy`

Expected: the second run changes no tracked file; `gen/` remains ignored.

Run: `pnpm --filter @byteql/midi test -- --run`

Expected: PASS.

```bash
git add .gitignore packages/formats/midi/standard_midi_file.ksy packages/formats/midi/common packages/formats/midi/scripts packages/formats/midi/src/generated.d.ts packages/formats/midi/src/kaitai.ts packages/formats/midi/src/kaitai.test.ts packages/formats/midi/package.json
git commit -m "build(midi): compile Kaitai parser with debug offsets"
```

### Task 5: Validate projection YAML and compile safe expressions

**Files:**
- Create: `packages/core/src/projection/spec.ts`
- Create: `packages/core/src/projection/expression.ts`
- Create: `packages/core/src/projection/expression.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `parseProjectionSpec(yamlText): ProjectionSpec`.
- Produces: `compileExpression(source): CompiledExpression`.
- Produces: `evaluateExpression(expression, context): unknown`.
- Produces: `ProjectionCompileError { code, path, message }`.

- [ ] **Step 1: Define the Zod-backed data contract**

```ts
export interface ProjectionSpec {
  version: '0.1';
  format: string;
  tables: TableSpec[];
}
export interface TableSpec {
  name: string;
  rows: string;
  where?: string;
  key: string;
  state?: Record<string, { scope: string; init: number; update: string }>;
  columns: Record<string, { expr: string; type: ArrowTypeName; when?: string }>;
}
export type ArrowTypeName = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'int64' | 'uint64' | 'bool' | 'utf8';
```

Require version `0.1`, identifier-safe table/key/column/state names, unique table names, a non-empty table list, and explicit column types.

- [ ] **Step 2: Write failing validation and expression tests**

Test valid arithmetic and paths, `and`/`or`/`not`, ternary, bitwise operators, `_index(1)`, `enum_str`, `u24be`, null propagation, and rejection of assignment, arrays, object literals, constructors, computed properties, and unknown calls.

```ts
it('rejects executable member calls', () => {
  expect(() => compileExpression('_.body.constructor("return 1")()')).toThrowError(/EXPRESSION_NODE_FORBIDDEN/);
});
```

- [ ] **Step 3: Run the tests to verify red**

Run: `pnpm --filter @byteql/core test -- --run src/projection/expression.test.ts`

Expected: FAIL because projection modules are absent.

- [ ] **Step 4: Implement AST validation and a closed evaluator**

Configure jsep with word operators, parse once, and recursively reject every node type except literal, identifier, non-computed member, unary, binary, conditional, and direct calls to the closed function map. Resolve identifiers only from `_`, `_root`, `_parent`, declared state, and literals. `readMember` tries the exact key then its snake-case-to-camel-case form so YAML uses `.ksy` names while generated JavaScript remains internal.

The only Phase 0 functions are:

```ts
const builtins = {
  enum_str: (value: unknown) => value == null ? null : String(value),
  to_i: (value: unknown) => value == null ? null : Number(value),
  len: (value: { length?: number } | null) => value?.length ?? null,
  u24be: (value: Uint8Array | null) => value?.length === 3 ? (value[0]! << 16) | (value[1]! << 8) | value[2]! : null,
};
```

Any arithmetic or member operation with a missing operand returns `null`, except boolean short-circuiting. `_index(n)` is handled as a special direct call over context indexes.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @byteql/core test -- --run`

Expected: all validation and expression tests pass.

```bash
git add packages/core/src/projection packages/core/src/index.ts packages/core/package.json
git commit -m "feat(core): compile safe projection expressions"
```

### Task 6: Traverse anchors, apply state, and emit logical rows

**Files:**
- Create: `packages/core/src/projection/anchors.ts`
- Create: `packages/core/src/projection/project.ts`
- Create: `packages/core/src/projection/project.test.ts`
- Modify: `packages/core/src/projection/spec.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: compiled expressions and validated specs from Task 5.
- Produces: `compileProjection(spec): CompiledProjection`.
- Produces: `projectTree(compiled, root, provenance): ProjectedTable[]`.
- Consumes: `ProvenanceResolver.resolve(table, anchor): SourceRange`.

- [ ] **Step 1: Write failing traversal and state tests**

Use an in-memory tree with two tracks. Assert depth-first document order, `_index(0)`/`_index(1)`, missing variants as null, `where`, `when`, a tick state that updates before columns, reset at `$.tracks[*]`, monotonic keys, and provenance columns.

```ts
expect(rows.map((row) => [row.track, row.tick])).toEqual([[0, 10], [0, 15], [1, 7]]);
```

- [ ] **Step 2: Run the tests to verify red**

Run: `pnpm --filter @byteql/core test -- --run src/projection/project.test.ts`

Expected: FAIL because anchor compilation and projection are absent.

- [ ] **Step 3: Compile the anchor grammar**

Accept only `$`, `.identifier`, `[*]`, and `[non-negative integer]`. Return steps plus wildcard count. Require every state scope to be an exact prefix of its table's rows path. At runtime each anchor match carries `node`, `parents`, `indexes`, and a stable traversal ordinal.

- [ ] **Step 4: Implement deterministic projection**

For each table, reset a state register when the wildcard-index prefix represented by its scope changes. Evaluate `update`, assign the new state value, evaluate `where`, then columns and their `when` guards. Generate a `bigint` key starting at `1n`; append `BigInt(range.start)` and `BigInt(range.end)`.

```ts
export interface ProjectedTable {
  name: string;
  columns: Record<string, readonly unknown[]>;
  types: Record<string, ArrowTypeName>;
  rowCount: number;
}
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @byteql/core test -- --run`

Expected: PASS.

```bash
git add packages/core/src/projection packages/core/src/index.ts
git commit -m "feat(core): project trees into provenance rows"
```

### Task 7: Build Arrow IPC and the MIDI format pack

**Files:**
- Create: `packages/core/src/arrow/build.ts`
- Create: `packages/core/src/arrow/build.test.ts`
- Create: `packages/core/src/protocol.ts`
- Create: `packages/formats/midi/midi.tables.yaml`
- Create: `packages/formats/midi/queries.yaml`
- Create: `packages/formats/midi/src/project-midi.ts`
- Create: `packages/formats/midi/src/project-midi.test.ts`
- Create: `packages/formats/midi/test/fixtures/basic-type0.mid`
- Create: `packages/formats/midi/test/fixtures/running-status-type1.mid`
- Create: `packages/formats/midi/test/fixtures/malformed-then-valid.mid`
- Create: `packages/formats/midi/test/fixtures/demo.mid`
- Create: `packages/formats/midi/test/fixtures/manifest.md`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/formats/midi/src/index.ts`

**Interfaces:**
- Produces: `projectedTableToArrow(table): Table`.
- Produces: `tableToIpc(table): Uint8Array` and `ipcToTable(bytes): Table`.
- Produces: `parseAndProjectMidi(bytes, signal): Promise<ParseResult>`.
- Produces: `TableTransfer { name, ipc, rowCount, columns }` and stable `ParseIssue`.

Use these shared transfer types:

```ts
export interface TableTransfer {
  name: string;
  ipc: Uint8Array;
  rowCount: number;
  columns: readonly { name: string; type: string; nullable: boolean }[];
}
export interface ParseIssue {
  stage: 'framing' | 'normalizing' | 'parsing' | 'projecting';
  track: number | null;
  code: string;
  message: string;
  recoverable: boolean;
  sourceStart: number | null;
  sourceEnd: number | null;
}
export interface ParseResult {
  format: { id: 'standard_midi_file'; title: 'Standard MIDI file' };
  tables: readonly TableTransfer[];
  issues: readonly ParseIssue[];
  capabilities: { audio: { enabled: boolean; reason: string | null } };
}
```

- [ ] **Step 1: Write failing Arrow type and round-trip tests**

Assert every declared logical type maps to the expected Arrow type, nulls survive IPC, `int64`/`uint64` values remain bigint, and column lengths must match `rowCount`.

Run: `pnpm --filter @byteql/core test -- --run src/arrow/build.test.ts`

Expected: FAIL because Arrow builders are absent.

- [ ] **Step 2: Implement explicit Arrow vectors and IPC**

Map type names to `Int8`, `Uint8`, `Int16`, `Uint16`, `Int32`, `Uint32`, `Int64`, `Uint64`, `Bool`, and `Utf8`. Use `vectorFromArray(values, type)`, create a `Table` from named vectors, and `tableToIPC(table, 'stream')`. Reject unequal column lengths before allocation.

- [ ] **Step 3: Add the real MIDI projection pack and failing conformance tests**

The YAML registers `header`, `events`, and `tempo`; the orchestrator always appends a schema-stable `errors` table. `events` includes all MIDI events and nullable variant columns. Its `kind` ternary maps channel types, meta, and SysEx and rewrites velocity-zero note-on to `note_off`. Both event tables declare a track-scoped `tick` state.

`queries.yaml` contains `overview`, `play_all`, `drums`, `bassline`, and `note_histogram`. Every grid query has an explicit `limit`. Playback SQL creates a default tempo point at tick zero when absent, computes cumulative seconds at tempo boundaries, uses an ASOF join, and returns `seconds`, `note`, `velocity`, `kind`, and `channel` ordered by seconds.

Use this tempo-map shape for `play_all` and add the pack-specific predicate for `drums` or `bassline` before the final order/limit:

```sql
with tempo_points as (
  select tick, us_per_quarter, tempo_id
  from tempo
  where track = 0
  union all
  select 0, 500000, 0
  where not exists (select 1 from tempo where track = 0 and tick = 0)
), deduped as (
  select tick, us_per_quarter
  from tempo_points
  qualify row_number() over (partition by tick order by tempo_id desc) = 1
), boundaries as (
  select tick,
         us_per_quarter,
         lag(tick, 1, 0) over (order by tick) as previous_tick,
         lag(us_per_quarter, 1, 500000) over (order by tick) as previous_tempo
  from deduped
), tempo_map as (
  select tick,
         us_per_quarter,
         sum((tick - previous_tick) * previous_tempo / h.division / 1000000.0)
           over (order by tick rows unbounded preceding) as seconds_at_tick
  from boundaries
  cross join header h
)
select tm.seconds_at_tick
         + (e.tick - tm.tick) * tm.us_per_quarter / h.division / 1000000.0 as seconds,
       e.note, e.velocity, e.kind, e.channel
from events e
asof join tempo_map tm on e.tick >= tm.tick
cross join header h
where e.note is not null
order by seconds, e.event_id
limit 100000;
```

Conformance tests assert exact rows and original source offsets for all four fixtures, plus partial tables and one error row for `malformed-then-valid.mid`.

- [ ] **Step 4: Implement per-track orchestration**

`parseAndProjectMidi` performs container framing, rejects Type 2 as `UNSUPPORTED_MIDI_TYPE`, normalizes each track, checks `signal.aborted` between tracks, parses each successful normalized prefix through Kaitai, resolves anchor provenance through event index maps, merges projected rows in original track order, and emits Arrow IPC. After every track, await a zero-delay task so the worker can receive a cancellation message before starting the next track. Keep exactly one `header` row from the original container; discard synthetic per-track header rows. Register `errors` with its full schema even when it has zero rows. SMPTE files project normally and set `capabilities.audio = { enabled: false, reason: 'SMPTE time division is not supported by the Phase 0 player.' }`.

- [ ] **Step 5: Verify fixtures and commit**

Run: `pnpm --filter @byteql/core test -- --run && pnpm --filter @byteql/midi test -- --run`

Expected: all Arrow and MIDI conformance tests pass.

```bash
git add packages/core/src/arrow packages/core/src/protocol.ts packages/core/src/index.ts packages/formats/midi/midi.tables.yaml packages/formats/midi/queries.yaml packages/formats/midi/src packages/formats/midi/test/fixtures
git commit -m "feat: emit MIDI format pack as Arrow IPC"
```

### Task 8: Securely initialize DuckDB-WASM and query Arrow tables

**Files:**
- Create: `packages/db/src/types.ts`
- Create: `packages/db/src/browser.ts`
- Create: `packages/db/src/browser.test.ts`
- Create: `packages/db/src/index.ts`
- Modify: `packages/db/package.json`

**Interfaces:**
- Consumes: `TableTransfer[]` from Task 7.
- Produces: `createBrowserDatabase(): Promise<ByteqlDatabase>`.
- Produces: `ByteqlDatabase.initialize`, `replaceTables`, `query`, `cancelQuery`, `listTables`, and `dispose`.
- Produces: `QueryResult { table: Table; elapsedMs: number }`.

- [ ] **Step 1: Define the mockable database interface and failing security tests**

```ts
export interface ByteqlDatabase {
  initialize(): Promise<void>;
  replaceTables(tables: readonly TableTransfer[]): Promise<void>;
  query(sql: string): Promise<QueryResult>;
  cancelQuery(): Promise<boolean>;
  listTables(): Promise<readonly string[]>;
  dispose(): Promise<void>;
}
```

Mock `AsyncDuckDBConnection.query` and assert initialization sends the five hardening statements before any user query. Assert table names reject anything outside `/^[A-Za-z_][A-Za-z0-9_]*$/`.

- [ ] **Step 2: Run the tests to verify red**

Run: `pnpm --filter @byteql/db test -- --run`

Expected: FAIL because the database client is absent.

- [ ] **Step 3: Implement Vite-local bundle selection and hardening**

Import MVP/EH Wasm and worker assets with `?url`, build manual bundles, call `selectBundle`, create `AsyncDuckDB`, instantiate it, connect, then execute in this order:

```sql
SET enable_external_access = false;
SET autoinstall_known_extensions = false;
SET autoload_known_extensions = false;
SET allow_community_extensions = false;
SET lock_configuration = true;
```

Never use `getJsDelivrBundles`. Use `VoidLogger` in production and an injected logger in tests.

- [ ] **Step 4: Implement replace, query, cancel, and dispose**

Within a transaction, drop only previously registered ByteQL tables, then call `connection.insertArrowFromIPCStream(table.ipc, { name: table.name, create: true })`. On failure, roll back and preserve the previous table set. `query` records `performance.now()`, calls `connection.query(sql)`, and returns the Arrow `Table`. `cancelQuery` calls `connection.cancelSent()`. `dispose` closes the connection and terminates the database worker.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @byteql/db test -- --run && pnpm --filter @byteql/db build`

Expected: PASS and no CDN URL appears in `packages/db/dist`.

```bash
git add packages/db
git commit -m "feat(db): add secure DuckDB-WASM client"
```

### Task 9: Add the parse worker and pure session controller

**Files:**
- Create: `apps/web/src/lib/session/state.ts`
- Create: `apps/web/src/lib/session/state.test.ts`
- Create: `apps/web/src/lib/session/controller.ts`
- Create: `apps/web/src/lib/session/controller.test.ts`
- Create: `apps/web/src/lib/parse-worker-client.ts`
- Create: `apps/web/src/workers/parse.worker.ts`
- Create: `apps/web/src/assets/demo.mid`
- Create: `apps/web/src/vite-env.d.ts`

**Interfaces:**
- Consumes: `parseAndProjectMidi`, `ByteqlDatabase`, and core worker protocol.
- Produces: `SessionState` and pure `reduceSession(state, event)`.
- Produces: `SessionController.initialize`, `openFile`, `openSample`, `runQuery`, `cancel`, `selectResultRow`, and `dispose`.

The reducer owns this stable state shape:

```ts
export type SessionPhase = 'idle' | 'opening' | 'normalizing' | 'parsing' | 'projecting' | 'registering' | 'ready' | 'querying' | 'failed';
export interface SessionState {
  phase: SessionPhase;
  source: { name: string; size: number } | null;
  format: { id: string; title: string } | null;
  progress: { completed: number; total: number | null; label: string } | null;
  tables: readonly TableTransfer[];
  issues: readonly ParseIssue[];
  sql: string;
  result: Table | null;
  queryElapsedMs: number | null;
  queryError: string | null;
  selectedRow: number | null;
  fatalError: string | null;
}
```

- [ ] **Step 1: Write failing reducer tests for every state transition**

Cover `idle -> opening -> normalizing -> parsing -> projecting -> registering -> ready`, query start/success/failure, cancellation, partial parse issues, worker crash, selected row, loading a replacement file, and retaining the prior query result after SQL failure.

```ts
expect(reduceSession(ready, { type: 'queryFailed', message: 'syntax error' })).toMatchObject({
  phase: 'ready',
  result: ready.result,
  queryError: 'syntax error',
});
```

- [ ] **Step 2: Run reducer tests to verify red, then implement the pure reducer**

Run: `pnpm --filter @byteql/web test -- --run src/lib/session/state.test.ts`

Expected before implementation: FAIL.

Keep `File`, `Worker`, database handles, and audio objects out of `SessionState`; it contains plain UI data plus one explicitly local current Arrow result `Table`.

- [ ] **Step 3: Write failing controller tests with fake worker/database ports**

Assert that opening a new file cancels parse/query, stops the active viewer callback, resets DuckDB only after new tables are ready, and transfers every IPC `ArrayBuffer`. Copy the repository-authored `demo.mid` fixture byte-for-byte into `apps/web/src/assets/demo.mid`; assert its Vite asset URL is fetched during `initialize` and retained as bytes before `ready` is emitted.

- [ ] **Step 4: Implement worker/client/controller boundaries**

The parse worker accepts `{ type: 'parse'; taskId; name; bytes }`, verifies the first four bytes are `MThd`, calls `parseAndProjectMidi`, and posts progress plus a final result with IPC buffers in the transfer list. Cancellation records a task id and aborts between tracks. `ParseWorkerClient` terminates and recreates the worker after `error` or `messageerror`.

`SessionController` owns a subscriber set rather than Svelte stores, making it independently testable:

```ts
subscribe(listener: (state: SessionState) => void): () => void
getState(): SessionState
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @byteql/web test -- --run src/lib/session`

Expected: all reducer and orchestration tests pass.

```bash
git add apps/web/src/lib/session apps/web/src/lib/parse-worker-client.ts apps/web/src/workers apps/web/src/assets/demo.mid apps/web/src/vite-env.d.ts
git commit -m "feat(web): orchestrate local parse and query sessions"
```

### Task 10: Build the format-neutral Inspector Workbench

**Files:**
- Create: `apps/web/src/app.css`
- Create: `apps/web/src/components/AppHeader.svelte`
- Create: `apps/web/src/components/EmptyState.svelte`
- Create: `apps/web/src/components/Explorer.svelte`
- Create: `apps/web/src/components/SqlEditor.svelte`
- Create: `apps/web/src/components/ResultGrid.svelte`
- Create: `apps/web/src/components/Inspector.svelte`
- Create: `apps/web/src/components/StatusBar.svelte`
- Create: `apps/web/src/components/Workbench.svelte`
- Create: `apps/web/src/components/Workbench.test.ts`
- Modify: `apps/web/src/App.svelte`
- Modify: `apps/web/src/main.ts`

**Interfaces:**
- Consumes: `SessionController` and `SessionState` from Task 9.
- Produces: accessible file/sample actions, pack query selection, SQL execution/cancellation, virtualized results, and contextual row/schema/provenance inspection.

- [ ] **Step 1: Write failing user-facing component tests**

Using Svelte Testing Library and a fake controller, assert:

- Empty state says files stay local and exposes `Open file` and `Try sample`.
- Ready state shows source, format badge, tables, canned queries, editor, result count, and inspector.
- Permanent landmarks contain no `MIDI`, `note`, `track`, or `play` labels.
- Selecting a row shows `_src_start` and `_src_end` without changing SQL.
- A failed query leaves the prior grid visible and shows the diagnostic beside the editor.

Run: `pnpm --filter @byteql/web test -- --run src/components/Workbench.test.ts`

Expected: FAIL because components do not exist.

- [ ] **Step 2: Implement the responsive three-region shell**

Use semantic landmarks and CSS grid columns `minmax(12rem, 18rem) minmax(28rem, 1fr) minmax(16rem, 22rem)`. Explorer and inspector can collapse; below 1100px the inspector becomes a workbench tab. Keep all colors as CSS custom properties and meet visible focus and 4.5:1 text contrast.

- [ ] **Step 3: Integrate CodeMirror 6 with explicit teardown**

`SqlEditor.svelte` creates one `EditorView` on mount with `basicSetup`, `sql()`, an update listener, and a `Mod-Enter` key binding that invokes `onrun(view.state.doc.toString())`. Update external SQL through a transaction only when it differs. Call `view.destroy()` on component teardown.

- [ ] **Step 4: Implement an Arrow-backed virtual grid and inspector**

Use `@tanstack/svelte-virtual` for rows and render only visible indexes. Read values column-wise from the Arrow `Table`; do not first materialize the whole result into objects. Add keyboard row selection, sticky headers, bigint formatting, null rendering as `NULL`, and a 100-character preview for binary/string cells. The inspector reads the selected row on demand and lists every column plus numeric provenance.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @byteql/web test -- --run && pnpm --filter @byteql/web check && pnpm --filter @byteql/web build`

Expected: tests, Svelte checks, and production build pass.

```bash
git add apps/web/src apps/web/index.html apps/web/vite.config.ts apps/web/tsconfig.json
git commit -m "feat(web): build format-neutral query workbench"
```

### Task 11: Add schema-matched viewers and Tone.js playback

**Files:**
- Create: `apps/web/src/lib/viewers/registry.ts`
- Create: `apps/web/src/lib/viewers/registry.test.ts`
- Create: `apps/web/src/lib/viewers/tone-engine.ts`
- Create: `apps/web/src/lib/viewers/tone-engine.test.ts`
- Create: `apps/web/src/components/ViewerMenu.svelte`
- Create: `apps/web/src/components/AudioViewer.svelte`
- Create: `apps/web/src/components/AudioViewer.test.ts`
- Modify: `apps/web/src/components/Inspector.svelte`
- Modify: `apps/web/src/components/Workbench.svelte`

**Interfaces:**
- Produces: `ViewerCapability { id, label, accepts, component }`.
- Produces: `compatibleViewers(schema, formatMetadata): ViewerCapability[]`.
- Produces: `AudioEngine.load`, `play`, `pause`, `stop`, `seek`, and `dispose`.

```ts
import type { Component } from 'svelte';

export interface ViewerCapability {
  id: string;
  label: string;
  accepts(columns: readonly { name: string; type: string }[], audioEnabled: boolean): boolean;
  component: Component;
}
export interface AudioEngine {
  load(rows: readonly AudioRow[]): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  dispose(): void;
}
export interface AudioRow {
  seconds: number;
  note: number;
  velocity: number;
  kind: 'note_on' | 'note_off';
  channel: number | null;
}
```

- [ ] **Step 1: Write failing capability tests**

Assert audio matches only results containing numeric `seconds`, `note`, and `velocity` plus UTF-8 `kind`; `channel` is optional. Assert the capability is absent for SMPTE metadata and generic aggregate results.

- [ ] **Step 2: Write failing deterministic scheduler tests**

Inject a fake clock and synth. Given note-on at `0.5` and note-off at `1.25`, assert attack and release are scheduled at those exact seconds with velocity normalized from `0..127` to `0..1`. Assert stop releases all notes and clears scheduled callbacks; loading a new result performs stop first.

- [ ] **Step 3: Implement the trusted registry and Tone adapter**

The registry is an application-owned array; format packs provide no constructors. `tone-engine.ts` statically imports the locally bundled `tone` module so its chunk is loaded before the application reports ready. `ToneAudioEngine` waits for user action before calling `Tone.start()`, creates `new Tone.PolySynth(Tone.Synth).toDestination()`, and uses `Tone.getTransport()` for scheduling. It never creates a `Tone.Sampler` or remote URL.

- [ ] **Step 4: Implement the contextual viewer UI**

Render `Open in...` only when at least one capability matches. The audio panel shows play/pause, stop, elapsed/total time, seek, scheduled row count, and an actionable invalid-row message. Closing it calls `dispose`. Do not add a permanent audio bar to the application shell.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @byteql/web test -- --run src/lib/viewers src/components/AudioViewer.test.ts`

Expected: all capability and audio tests pass without creating a real `AudioContext`.

```bash
git add apps/web/src/lib/viewers apps/web/src/components/ViewerMenu.svelte apps/web/src/components/AudioViewer.svelte apps/web/src/components/AudioViewer.test.ts apps/web/src/components/Inspector.svelte apps/web/src/components/Workbench.svelte
git commit -m "feat(web): add contextual MIDI audio viewer"
```

### Task 12: Verify privacy, recovery, performance, and static delivery

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/open-query-inspect.spec.ts`
- Create: `apps/web/e2e/recovery.spec.ts`
- Create: `apps/web/e2e/privacy.spec.ts`
- Create: `apps/web/e2e/audio.spec.ts`
- Create: `apps/web/e2e/performance.spec.ts`
- Create: `apps/web/scripts/check-bundle.mjs`
- Create: `apps/web/src/lib/benchmark.ts`
- Create: `docs/phase-0-benchmark.md`
- Create: `docs/privacy.md`
- Create: `docs/phase-0-external-test.md`
- Modify: `apps/web/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: the complete Phase 0 application.
- Produces: repeatable Chromium acceptance tests, bundle report, benchmark record format, and external tester checklist.

- [ ] **Step 1: Configure Chromium-only Playwright and write the failing happy-path test**

Start `pnpm dev --host 127.0.0.1` from `apps/web`, use only the Chromium project, and test:

```ts
await page.goto('/');
await page.getByRole('button', { name: 'Try sample' }).click();
await expect(page.getByText(/3 tables/)).toBeVisible();
await page.getByLabel('SQL query').fill('select * from events limit 5');
await page.getByRole('button', { name: 'Run query' }).click();
await expect(page.getByText('5 rows')).toBeVisible();
await page.getByRole('row', { name: /note_/ }).first().click();
await expect(page.getByText('_src_start')).toBeVisible();
```

Run: `pnpm --filter @byteql/web test:e2e -- open-query-inspect.spec.ts`

Expected before final wiring: FAIL at the first incomplete integration point.

- [ ] **Step 2: Add recovery and audio browser tests**

Upload `malformed-then-valid.mid`, assert successful rows plus one explorer error badge and a queryable `errors` table. Force a parse-worker crash through a test-only injected worker factory and assert retry creates a new worker. For audio, stub the audio engine at the capability boundary, run the `play_all` pack query, and assert opening/closing the viewer calls load/dispose.

- [ ] **Step 3: Add the post-readiness privacy test**

Wait for `[data-app-ready="true"]`, subscribe to `page.on('request')`, then open a local fixture, run SQL containing a unique sentinel, inspect a row, and open the stubbed viewer. Assert the request list remains empty and that no recorded URL, header, or body contains the file name or sentinel. Set Playwright `serviceWorkers: 'block'` so routing sees every request.

- [ ] **Step 4: Add performance reporting and bundle checks**

Measure from clicking `Try sample` in a fresh context to the first result-grid paint and attach JSON containing browser version, OS, CPU description supplied by the runner, fixture hash, uncompressed size, and elapsed milliseconds. The test reports the PRD's 10-second target but does not fail normal CI for timing variance.

`check-bundle.mjs` walks runtime source files under `apps/web/src` and `packages/*/src`, rejecting direct `http://`, `https://`, `cdn.jsdelivr`, or `unpkg` references outside tests. It then reports every `dist/assets` size, rejects a JavaScript chunk above 5 MiB uncompressed, and prints Wasm sizes separately. The Playwright privacy test—not a string scan of bundled DuckDB internals—is authoritative for runtime requests.

- [ ] **Step 5: Run the complete acceptance gate and commit**

Run:

```bash
pnpm lint
pnpm check
pnpm test
pnpm build
pnpm --filter @byteql/web check:bundle
pnpm test:e2e
```

Expected: all commands exit 0; Playwright reports Chromium tests passed; the benchmark attachment records elapsed time; no external URL is present in built assets.

Document one manual audible smoke test and an unaided external-tester script in `docs/phase-0-external-test.md`. Record the actual reference machine and measured cold time in `docs/phase-0-benchmark.md`; do not claim the 10-second metric until that measurement exists.

```bash
git add apps/web/playwright.config.ts apps/web/e2e apps/web/scripts apps/web/src/lib/benchmark.ts apps/web/package.json package.json docs/phase-0-benchmark.md docs/privacy.md docs/phase-0-external-test.md
git commit -m "test: verify ByteQL phase 0 acceptance criteria"
```

## Final verification

After Task 12, run the complete acceptance gate again from a clean checkout with dependencies installed from `pnpm-lock.yaml`. Confirm `git status --short` contains no generated Kaitai files, build output, reports, or visual-companion state. Compare each acceptance criterion in `docs/superpowers/specs/2026-07-17-byteql-phase-0-design.md` against a passing automated test, benchmark record, or explicit manual/external check before declaring Phase 0 complete.
