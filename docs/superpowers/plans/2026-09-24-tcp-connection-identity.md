# TCP Connection Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split reused TCP tuples into separate streams, surface connection lifecycle, and survive
sequence wraparound and overlapping retransmissions without corrupting or abandoning streams.

**Architecture:** Spec v0.5 adds optional `open`/`close`/`reset`/`offset_bits` fields to stream
declarations. The engine (`packages/core`) evaluates them per contributing segment, lets empty
control segments reach the stream runtime, keys flows by (declaration, key, generation), unwraps
modular offsets, and reconciles overlaps first-bytes-win inside `StreamAssembler`. The pcap pack
opts in through YAML only, plus two raw flag fields on the `tcp` wrapper root.

**Tech Stack:** TypeScript, vitest, zod, Apache Arrow JS, Playwright, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-24-tcp-connection-identity-design.md` — read it in full
before starting any task. Also read the **Implementation notes** of
`docs/superpowers/specs/2026-07-18-phase1-generalization-prep-design.md` (engine contracts) and
the Phase 2 design `docs/superpowers/specs/2026-07-18-phase2-tcp-reassembly-design.md`.

## Global Constraints

- Engine invariants: spec/compile errors throw `ProjectionCompileError` at load; row-time
  evaluation returns null, never throws; document-order traversal is load-bearing.
- Specs at `0.1`–`0.4` must load and behave byte-identically to today (MIDI and ZIP goldens stay
  unchanged; they never use streams).
- `offset_bits` is an integer in `[8, 48]`.
- `close` or `reset` without `open` is a compile error (`PROJECTION_STREAM_INVALID`).
- Lifecycle expression results: anything other than boolean `true` counts as false.
- Neutral flow-root values on streams using no v0.5 feature: `opened: false`, `closed_by: null`,
  `generation: 1`, `conflict_count: 0`.
- Overlap policy: first-arrived bytes win; conflicts are counted and reported, status stays `ok`.
- New issue codes, all `recoverable: true`, stage `'reassembling'`: `STREAM_OVERLAP_CONFLICT` (one
  per conflicting segment), `STREAM_BELOW_BASE` (once per flow).
- Allowed pcap golden diffs: new `streams` columns, new control-only flow rows, control-segment
  `stream_segments` rows. Any other change to an existing row value is a bug.
- Privacy: no network, no new runtime dependencies.
- Commits: conventional-commit messages, **no** `Co-Authored-By` or other trailers, no AI branding.
- After changing `packages/core` or a pack, rebuild (`pnpm build`) before running the web e2e.
- No `CHANGELOG.md` exists in this repo; do not create one.
- Keep test output pristine (no stray console output).

## Review Focus

1. **SYN flood on one tuple** (thousands of SYNs, distinct ISNs, same 4-tuple): each must become
   its own generation without quadratic slow-down or eager buffer allocation — test in Task 5.
2. **SYN captured after its data was already framed** (`consumed > 0`, SYN offset equals the
   base): must adopt the flow (`opened` true), not start a new generation or report below-base —
   test in Task 5.
3. **FIN-only flow from a capture that started mid-connection** (no SYN, no data): one row,
   `opened` false, `closed_by` `'close'`, `byte_count` 0, span over the TCP header — test in
   Task 4.
4. **Late retransmitted FIN after close, then a new SYN**: the FIN joins the closed generation;
   the SYN starts generation 2 — test in Task 5.
5. **Conflicting retransmission of bytes already framed into a message**: compared against
   consumed bytes, counted as a conflict, the already-emitted message unchanged — test in Task 8.

---

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `packages/core/src/projection/spec.ts` | v0.5 schema, version gates, parse-level stream rules | 1 |
| `packages/core/src/pack/schemas.ts` | v0.4+ non-null default (version comparison) | 1 |
| `packages/core/src/projection/spec-v05.test.ts` (new) | parse-level tests | 1 |
| `packages/core/src/projection/project.ts` | compile lifecycle fields; runtime generations, control segments, overlap wiring, unwrapping, flush | 2, 4, 5, 8, 9 |
| `packages/core/src/projection/stream-compile.test.ts` | compile rules | 2 |
| `packages/core/src/projection/streams.ts` | `StreamAssembler.anchor`, overlap reconciliation, `unwrapOffset` | 3, 8, 9 |
| `packages/core/src/projection/streams.test.ts` | assembler + unwrap tests | 3, 8, 9 |
| `packages/core/src/projection/stream-lifecycle.test.ts` (new) | runtime lifecycle/overlap/wrap tests on a synthetic v0.5 spec | 4, 5, 8, 9 |
| `packages/formats/pcap/src/wrappers.ts` | `fin`/`rst` on the tcp root | 6 |
| `packages/formats/pcap/pcap.tables.yaml` | v0.5 lifecycle, new `streams` columns, `offset_bits` | 6, 10 |
| `packages/formats/pcap/queries.yaml` | "Reused or reset connections" | 6 |
| `packages/formats/pcap/test/tcp-identity.test.ts` (new) | adversarial pcap fixtures 1–7 | 6, 10 |
| `packages/formats/pcap/test/generate-e2e-fixture.test.ts` | `tcp-reuse.pcap` generator | 7 |
| `apps/web/e2e/pcap.spec.ts`, `apps/web/e2e/hex-provenance.spec.ts` | browser acceptance | 7 |
| docs (`AGENTS.md`, `ROADMAP.md`, Phase 2 design, `docs/pack-authoring.md`) | status + DSL docs | 11 |

---

## Phase A — Lifecycle

### Task 1: Spec v0.5 schema and version gates

**Files:**

- Modify: `packages/core/src/projection/spec.ts` (`StreamSpec`, `ProjectionSpec.version`,
  `streamSpec`, `projectionSpec.version`, `parseProjectionSpec` gates at ~lines 289–340)
- Modify: `packages/core/src/pack/schemas.ts:42`
- Create: `packages/core/src/projection/spec-v05.test.ts`

**Interfaces:**

- Produces: `ProjectionSpec['version']` now `'0.1' | '0.2' | '0.3' | '0.4' | '0.5'`;
  `StreamSpec` gains `offset_bits?: number; open?: string; close?: string; reset?: string`;
  exported helper `specVersionAtLeast(version: ProjectionSpec['version'], min: ProjectionSpec['version']): boolean`
  from `spec.ts`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/projection/spec-v05.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ProjectionCompileError, parseProjectionSpec, specVersionAtLeast } from './spec.js';

const spec = (version: string, streamExtra: string) => `
version: '${version}'
format: streamy
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      n: { expr: '_.n', type: uint8, nullable: true }
  - name: flows
    rows: $
    key: flow_id
    columns:
      status: { expr: '_.status', type: utf8 }
streams:
  - name: byte_stream
    key: chunk_key
    offset: _.seq
    framer: len_framer
    table: flows
    segments_table: flow_segments
    max_buffer: 64
${streamExtra}
    messages:
      - { when: 'true', parser: msg_parser }
`;

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProjectionCompileError) return `${error.code}@${error.path}`;
    throw error;
  }
  return 'ok';
};

describe('spec v0.5', () => {
  it('accepts lifecycle and offset_bits fields on 0.5', () => {
    const parsed = parseProjectionSpec(
      spec('0.5', "    offset_bits: 32\n    open: _.syn\n    close: _.fin\n    reset: _.rst"),
    );
    expect(parsed.version).toBe('0.5');
    expect(parsed.streams![0]).toMatchObject({ offset_bits: 32, open: '_.syn', close: '_.fin', reset: '_.rst' });
  });

  it('accepts numeric 0.5', () => {
    expect(parseProjectionSpec(spec('0.5', '').replace("'0.5'", '0.5')).version).toBe('0.5');
  });

  it.each(['offset_bits: 32', 'open: _.syn'])('rejects %s below 0.5', (field) => {
    expect(codeOf(() => parseProjectionSpec(spec('0.4', `    ${field}`)))).toBe(
      'PROJECTION_VERSION_REQUIRED@streams.0',
    );
  });

  it.each([7, 49, 32.5])('rejects offset_bits %s', (bits) => {
    expect(codeOf(() => parseProjectionSpec(spec('0.5', `    offset_bits: ${bits}`)))).toMatch(
      /^PROJECTION_(STREAM|SPEC)_INVALID@streams\.0\.offset_bits$/,
    );
  });

  it.each(['close: _.fin', 'reset: _.rst'])('rejects %s without open', (field) => {
    expect(codeOf(() => parseProjectionSpec(spec('0.5', `    ${field}`)))).toMatch(
      /^PROJECTION_STREAM_INVALID@streams\.0\.(close|reset)$/,
    );
  });

  it('keeps nullable legal on 0.5 (0.4 features carry forward)', () => {
    expect(codeOf(() => parseProjectionSpec(spec('0.5', '')))).toBe('ok');
  });

  it('orders versions', () => {
    expect(specVersionAtLeast('0.5', '0.4')).toBe(true);
    expect(specVersionAtLeast('0.4', '0.4')).toBe(true);
    expect(specVersionAtLeast('0.3', '0.4')).toBe(false);
  });
});
```

Check how existing spec tests assert zod-level failures (`grep -n PROJECTION_SPEC_INVALID
packages/core/src/projection/*.test.ts`) and tighten the `offset_bits` regex to the single code
your implementation produces.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/spec-v05.test.ts`
Expected: FAIL (`specVersionAtLeast` not exported; `'0.5'` rejected by the version union).

- [ ] **Step 3: Implement**

In `spec.ts`:

1. Extend `StreamSpec` with `offset_bits?: number; open?: string; close?: string; reset?: string;`
   and `ProjectionSpec.version` with `'0.5'`.
2. `streamSpec` zod object gains
   `offset_bits: z.number().int().optional(), open: nonEmptyString.optional(), close: nonEmptyString.optional(), reset: nonEmptyString.optional()`
   (range checked below so the error is `PROJECTION_STREAM_INVALID` at a precise path).
3. Version union adds `z.literal('0.5'), z.literal(0.5)`; the transform returns `'0.5'` for
   either.
4. Add and export:

```ts
const VERSION_ORDER = ['0.1', '0.2', '0.3', '0.4', '0.5'] as const;
export const specVersionAtLeast = (
  version: ProjectionSpec['version'],
  min: ProjectionSpec['version'],
): boolean => VERSION_ORDER.indexOf(version) >= VERSION_ORDER.indexOf(min);
```

5. Replace `if (parsed.data.version !== '0.4')` (nullable gate) with
   `if (!specVersionAtLeast(parsed.data.version, '0.4'))`.
6. After the nullable gate, add:

```ts
for (const [index, stream] of (parsed.data.streams ?? []).entries()) {
  const v05 = stream.offset_bits !== undefined || stream.open !== undefined ||
    stream.close !== undefined || stream.reset !== undefined;
  if (v05 && !specVersionAtLeast(parsed.data.version, '0.5')) {
    throw new ProjectionCompileError(
      'PROJECTION_VERSION_REQUIRED',
      `streams.${index}`,
      'offset_bits, open, close, and reset require version 0.5',
    );
  }
  if (stream.offset_bits !== undefined && (stream.offset_bits < 8 || stream.offset_bits > 48)) {
    throw new ProjectionCompileError(
      'PROJECTION_STREAM_INVALID',
      `streams.${index}.offset_bits`,
      `offset_bits must be an integer from 8 to 48, got ${stream.offset_bits}`,
    );
  }
  for (const field of ['close', 'reset'] as const) {
    if (stream[field] !== undefined && stream.open === undefined) {
      throw new ProjectionCompileError(
        'PROJECTION_STREAM_INVALID',
        `streams.${index}.${field}`,
        `${field} requires open: without an open signal no connection generation can start`,
      );
    }
  }
}
```

In `packages/core/src/pack/schemas.ts:42`, replace `compiled.specVersion !== '0.4'` with
`!specVersionAtLeast(compiled.specVersion, '0.4')` (import from `../projection/spec.js`).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/`
Expected: PASS, including every pre-existing spec test.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection/spec.ts packages/core/src/projection/spec-v05.test.ts packages/core/src/pack/schemas.ts
git commit -m "feat(core): add projection spec v0.5 stream lifecycle fields"
```

#### Task 2: Compile lifecycle fields into `CompiledStream`

**Files:**

- Modify: `packages/core/src/projection/project.ts` (`CompiledStream` ~line 78, the stream
  compile loop ~lines 407–535, `MutableCompiledStream` ~line 388)
- Test: `packages/core/src/projection/stream-compile.test.ts`

**Interfaces:**

- Consumes: `StreamSpec.open/close/reset/offset_bits` (Task 1).
- Produces: `CompiledStream` gains
  `readonly open: CompiledExpression | null; readonly close: CompiledExpression | null; readonly reset: CompiledExpression | null; readonly offsetBits: number | null;`
- [ ] **Step 1: Write the failing tests**

Append to `stream-compile.test.ts` (reuse its `validYaml`, `registry`, `streamRegistries`, and
error-assertion helpers — read the top of the file first):

```ts
describe('v0.5 lifecycle compile', () => {
  const v05 = (extra: string) =>
    validYaml.replace("version: '0.3'", "version: '0.5'").replace(
      '    offset: _.seq\n',
      `    offset: _.seq\n${extra}`,
    );

  it('compiles open/close/reset/offset_bits onto the stream', () => {
    const compiled = compileProjection(
      parseProjectionSpec(v05('    offset_bits: 8\n    open: _.port == 1\n    close: _.port == 2\n    reset: _.port == 3\n')),
      registry,
      streamRegistries,
    );
    const stream = compiled.streams[0]!;
    expect(stream.offsetBits).toBe(8);
    expect(stream.open).not.toBeNull();
    expect(stream.close).not.toBeNull();
    expect(stream.reset).not.toBeNull();
  });

  it('leaves them null on a 0.3 stream', () => {
    const stream = compileProjection(parseProjectionSpec(validYaml), registry, streamRegistries).streams[0]!;
    expect([stream.open, stream.close, stream.reset, stream.offsetBits]).toEqual([null, null, null, null]);
  });

  it('rejects a lifecycle expression that does not compile, at its path', () => {
    expect(() =>
      compileProjection(parseProjectionSpec(v05('    open: _.port ==\n')), registry, streamRegistries),
    ).toThrow(expect.objectContaining({ path: 'streams.0.open' }));
  });
});
```

`validYaml` (line 19) is declared `version: '0.3'` and its stream has the line
`offset: _.seq`, so both `replace` anchors above match exactly once.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/stream-compile.test.ts`
Expected: FAIL (`offsetBits` undefined).

- [ ] **Step 3: Implement**

Add the four fields to `CompiledStream` and `MutableCompiledStream`. In the compile loop, next to
`const offset = compileCheckedExpression(entry.offset, new Set(), `${path}.offset`);`:

```ts
const lifecycle = (source: string | undefined, field: 'open' | 'close' | 'reset') =>
  source === undefined ? null : compileCheckedExpression(source, new Set(), `${path}.${field}`);
const open = lifecycle(entry.open, 'open');
const close = lifecycle(entry.close, 'close');
const reset = lifecycle(entry.reset, 'reset');
```

and pass `open, close, reset, offsetBits: entry.offset_bits ?? null` into `streamByName.set(...)`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection/project.ts packages/core/src/projection/stream-compile.test.ts
git commit -m "feat(core): compile stream lifecycle expressions"
```

#### Task 3: `StreamAssembler.anchor`

**Files:**

- Modify: `packages/core/src/projection/streams.ts`
- Test: `packages/core/src/projection/streams.test.ts`

**Interfaces:**

- Produces: `StreamAssembler.anchor(offset: number): 'anchored' | 'rebased' | 'ignored'`.
  `'anchored'`: base was null, now `offset`. `'rebased'`: `offset` below the base, nothing
  consumed, extent fits `maxBuffer` — base moves down, data shifted. `'ignored'`: any other case
  (offset at/above base, consumed > 0, or extent would exceed the cap). Stores no segment and does
  not change `byteCount`, `segmentCount`, or `srcSpan`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('StreamAssembler.anchor', () => {
  it('sets the base without storing bytes', () => {
    const a = new StreamAssembler(64);
    expect(a.anchor(100)).toBe('anchored');
    expect(a.base).toBe(100);
    expect(a.segmentCount).toBe(0);
    expect(a.srcSpan).toBeNull();
    expect(a.hasGap()).toBe(false);
  });

  it('makes a missing first segment a gap', () => {
    const a = new StreamAssembler(64);
    a.anchor(100);
    expect(a.add(105, bytes(9), 0, 1)).toBe('added');
    expect(a.contiguousEnd).toBe(0);
    expect(a.hasGap()).toBe(true);
  });

  it('rebases below unconsumed data, and ignores at-or-above-base and consumed cases', () => {
    const a = new StreamAssembler(64);
    a.add(10, bytes(3, 4), 30, 32);
    expect(a.anchor(8)).toBe('rebased');
    expect(a.base).toBe(8);
    expect(a.hasGap()).toBe(true); // bytes 8..10 never arrived
    expect(a.anchor(12)).toBe('ignored');
    const b = new StreamAssembler(64);
    b.add(10, bytes(1, 2), 0, 2);
    b.consume(1);
    expect(b.anchor(5)).toBe('ignored');
    expect(b.base).toBe(10);
  });

  it('ignores an anchor whose rebase would exceed the cap', () => {
    const a = new StreamAssembler(4);
    a.add(10, bytes(1, 2), 0, 2);
    expect(a.anchor(0)).toBe('ignored');
    expect(a.base).toBe(10);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/streams.test.ts`
Expected: FAIL (`anchor` is not a function).

- [ ] **Step 3: Implement**

Extract the rebase block of `add()` (the `if (rebasing) { ... }` body) into a private
`#rebaseTo(newBase: number, newExtent: number): void` that performs the shift, resets
`#contiguousEnd`/`#frontierIndex`, and sets `#base`; then recompute the frontier by factoring the
existing frontier-scan loop into `#advanceFrontier(): void`. `add()` calls both exactly where it
did before (behavior unchanged). Then:

```ts
/** Pins the stream base to `offset` without storing bytes (an open/SYN segment). */
anchor(offset: number): 'anchored' | 'rebased' | 'ignored' {
  if (this.#base === null) {
    this.#base = offset;
    return 'anchored';
  }
  if (offset >= this.#base || this.#consumed > 0) return 'ignored';
  const newExtent = (this.#highestEndAbs ?? this.#base) - offset;
  if (newExtent > this.#maxBuffer) return 'ignored';
  this.#rebaseTo(offset, newExtent);
  this.#advanceFrontier();
  return 'rebased';
}
```

Note `hasGap()` must be true after rebasing below stored data: `highestEnd` is relative to the
new base, `contiguousEnd` rescans from 0 and stops at the first stored segment (start > 0).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/`
Expected: PASS (all prior assembler tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection/streams.ts packages/core/src/projection/streams.test.ts
git commit -m "feat(core): let an open segment anchor the stream base"
```

#### Task 4: Control segments, lifecycle fields, and flow-root values

**Files:**

- Modify: `packages/core/src/projection/project.ts` (`StreamRuntimeEntry`, `StreamsRuntime`,
  `createStreamsRuntime`, `fireDissect` stream call ~line 1302, `contributeToStream`,
  `flushStreams`)
- Create: `packages/core/src/projection/stream-lifecycle.test.ts`

**Interfaces:**

- Consumes: `CompiledStream.open/close/reset` (Task 2), `StreamAssembler.anchor` (Task 3).
- Produces:
  - `StreamRuntimeEntry` gains `opened: boolean; openOffset: number | null; closedBy: 'close' | 'reset' | null; generation: number; conflictCount: number; belowBaseReported: boolean; dataSegmentCount: number;`
    (`fallbackSpan` stays).
  - `StreamsRuntime` becomes
    `{ current: Map<string, Map<string, StreamRuntimeEntry>>; ordered: Map<string, StreamRuntimeEntry[]>; segmentKeys: Map<string, bigint> }`
    — `current` holds the live generation per (stream, key); `ordered` holds every entry of a
    stream in creation order and is what `flushStreams` iterates. (Rename from `flows`; only
    `project.ts` and `session.ts` touch it.)
  - `contributeToStream(..., ancestors, feedRange: SourceRange)` — `feedRange` is
    `fireDissect`'s `parentRange`.
  - Flow root fields: `opened`, `closed_by`, `generation`, `conflict_count`.
- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/projection/stream-lifecycle.test.ts`. The synthetic format: each record
body is a chunk `[port, flags, seq, ...payload]` at file offset `index * 100`, payload starting at
chunk byte 3. Flags: `1` open, `2` close, `4` reset. `offset_bits: 8` is exercised in Task 9; this
spec leaves it out.

```ts
import { describe, expect, it } from 'vitest';
import { IssueCollector } from '../issues.js';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import { createProjectionSession } from './session.js';
import type { ParserRegistry } from './parsers.js';
import type { StreamRegistries } from './streams.js';

export const lifecycleYaml = (streamExtra = '', maxBuffer = 64) => `
version: '0.5'
format: streamy
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      n: { expr: '_.n', type: uint32 }
  - name: chunks
    rows: $
    key: chunk_id
    parent_key: { table: records, column: record_id }
    columns:
      port: { expr: '_.port', type: uint16 }
  - name: flows
    rows: $
    key: flow_id
    columns:
      peer: { expr: '_.peer', type: utf8 }
      segment_count: { expr: '_.segment_count', type: uint32 }
      byte_count: { expr: '_.byte_count', type: uint32 }
      message_count: { expr: '_.message_count', type: uint32 }
      status: { expr: '_.status', type: utf8 }
      opened: { expr: '_.opened', type: bool }
      closed_by: { expr: '_.closed_by', type: utf8, nullable: true }
      generation: { expr: '_.generation', type: uint32 }
      conflict_count: { expr: '_.conflict_count', type: uint32 }
  - name: msgs
    rows: $.message
    key: msg_id
    parent_key: { table: records, column: record_id }
    columns:
      text: { expr: '_.text', type: utf8 }
dissect:
  - from: records
    payload: _.body
    chain:
      - { when: 'true', parser: chunk_parser, table: chunks }
  - from: chunks
    payload: _.payload
    chain:
      - { when: 'true', stream: byte_stream }
streams:
  - name: byte_stream
    key: chunk_key
    offset: _.seq
    open: _.open
    close: _.close
    reset: _.reset
${streamExtra}
    framer: len_framer
    table: flows
    segments_table: flow_segments
    max_buffer: ${maxBuffer}
    messages:
      - { when: 'true', parser: msg_parser, table: msgs }
`;

export const OPEN = 1;
export const CLOSE = 2;
export const RESET = 4;

export const registry: ParserRegistry = new Map([
  [
    'chunk_parser',
    (bytes: Uint8Array) => ({
      root: {
        port: bytes[0],
        open: (bytes[1]! & OPEN) !== 0,
        close: (bytes[1]! & CLOSE) !== 0,
        reset: (bytes[1]! & RESET) !== 0,
        seq: bytes[2],
        payload: { bytes: bytes.subarray(3), start: 3 },
      },
    }),
  ],
  [
    'msg_parser',
    (bytes: Uint8Array) => ({ root: { message: { text: new TextDecoder().decode(bytes.subarray(1)) } } }),
  ],
]);

export const streamRegistries: StreamRegistries = {
  keyExtractors: new Map([
    [
      'chunk_key',
      ({ node }) => {
        const port = (node as { port?: number }).port;
        return typeof port === 'number' ? { key: `flow-${port}`, root: { peer: `peer-${port}` } } : null;
      },
    ],
  ]),
  framers: new Map([
    [
      'len_framer',
      (buffer: Uint8Array) => {
        if (buffer.length < 1) return null;
        if (buffer[0] === 0) throw new Error('zero-length message');
        return 1 + buffer[0]!;
      },
    ],
  ]),
};

export const chunk = (port: number, flags: number, seq: number, payload: number[] = []) =>
  Uint8Array.from([port, flags, seq, ...payload]);

export const project = (chunks: Uint8Array[], streamExtra = '', maxBuffer = 64) => {
  const issues = new IssueCollector();
  const compiled = compileProjection(
    parseProjectionSpec(lifecycleYaml(streamExtra, maxBuffer)),
    registry,
    streamRegistries,
  );
  const session = createProjectionSession(compiled, { issues });
  session.project(
    { records: chunks.map((bytes, index) => ({ n: index, body: { bytes, start: index * 100 } })) },
    { resolve: () => ({ start: 0, end: 4 }) },
  );
  return { finished: session.finish(), issues };
};

type Col = { toArray(): unknown; get(i: number): unknown };
export const rows = (finished: { name: string }[], name: string) => {
  const t = finished.find((x) => x.name === name)! as never as {
    rowCount: number;
    arrow: { getChild(c: string): Col | null };
  };
  return {
    count: t.rowCount,
    col: (c: string) => Array.from({ length: t.rowCount }, (_, i) => t.arrow.getChild(c)!.get(i)),
  };
};

describe('stream lifecycle: control segments', () => {
  it('lets an empty open segment create a flow and anchor its base', () => {
    // SYN at seq 10 (no payload), then message [2,'a','b'] split: seq 10 [2,97], seq 12 [98]
    const { finished, issues } = project([
      chunk(7, OPEN, 10),
      chunk(7, 0, 10, [2, 97]),
      chunk(7, 0, 12, [98]),
    ]);
    expect(issues.issues()).toEqual([]);
    const flows = rows(finished, 'flows');
    expect(flows.count).toBe(1);
    expect(flows.col('opened')).toEqual([true]);
    expect(flows.col('closed_by')).toEqual([null]);
    expect(flows.col('generation')).toEqual([1]);
    expect(flows.col('conflict_count')).toEqual([0]);
    expect(flows.col('segment_count')).toEqual([2]); // data-bearing only
    expect(rows(finished, 'msgs').col('text')).toEqual(['ab']);
    const segs = rows(finished, 'flow_segments');
    expect(segs.count).toBe(3); // the SYN is recorded
    expect(segs.col('offset')).toEqual([0n, 0n, 2n]);
    // control segment provenance = the feeding chunk row's range (record 0's chunk at [0, 3))
    expect(segs.col('_src_start')[0]).toBe(0n);
    expect(segs.col('_src_end')[0]).toBe(3n);
  });

  it('turns a missing first data segment after an open into a gap', () => {
    const { finished } = project([chunk(7, OPEN, 10), chunk(7, 0, 12, [98])]);
    expect(rows(finished, 'flows').col('status')).toEqual(['gap']);
  });

  it('ignores empty segments with no lifecycle signal', () => {
    const { finished } = project([chunk(7, 0, 10)]);
    expect(rows(finished, 'flows').count).toBe(0);
    expect(rows(finished, 'flow_segments').count).toBe(0);
  });

  it('records close and lets reset take precedence', () => {
    const closeOnly = project([chunk(7, 0, 10, [1, 65]), chunk(7, CLOSE, 12)]).finished;
    expect(rows(closeOnly, 'flows').col('closed_by')).toEqual(['close']);
    const resetThenClose = project([chunk(7, OPEN, 10), chunk(7, RESET, 10), chunk(7, CLOSE, 10)]).finished;
    expect(rows(resetThenClose, 'flows').col('closed_by')).toEqual(['reset']);
    const closeThenReset = project([chunk(7, OPEN, 10), chunk(7, CLOSE, 10), chunk(7, RESET, 10)]).finished;
    expect(rows(closeThenReset, 'flows').col('closed_by')).toEqual(['reset']);
  });

  // Review Focus 3
  it('gives a close-only mid-connection flow a header-spanning row', () => {
    const { finished } = project([chunk(7, CLOSE, 40)]);
    const flows = rows(finished, 'flows');
    expect(flows.count).toBe(1);
    expect(flows.col('opened')).toEqual([false]);
    expect(flows.col('closed_by')).toEqual(['close']);
    expect(flows.col('byte_count')).toEqual([0]);
    expect(flows.col('status')).toEqual(['ok']);
    expect(flows.col('_src_start')).toEqual([0n]);
    expect(flows.col('_src_end')).toEqual([3n]);
  });

  it('keeps tracking lifecycle after the stream goes inactive', () => {
    // zero-length message stalls framing -> status error at flush; the later reset still lands
    const { finished } = project([chunk(7, OPEN, 10), chunk(7, 0, 10, [0]), chunk(7, RESET, 11)]);
    const flows = rows(finished, 'flows');
    expect(flows.col('status')).toEqual(['error']);
    expect(flows.col('closed_by')).toEqual(['reset']);
  });
});
```

Also add one neutral-values test to `stream-runtime.test.ts` (the 0.3 synthetic spec): add
`opened`, `closed_by` (nullable is not legal on 0.3 — use a plain `utf8` column, 0.3 columns are
implicitly nullable), `generation`, `conflict_count` columns to its `flows` table in a local copy
of its yaml, project one message, and assert `[false, null, 1, 0]`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/stream-lifecycle.test.ts src/projection/stream-runtime.test.ts`
Expected: FAIL — the empty open segment is dropped (`flows.count` 0), and new root fields are
undefined.

- [ ] **Step 3: Implement**

1. `StreamsRuntime` / `createStreamsRuntime`: replace `flows` with `current` and `ordered`
   (both keyed by every `compiled.streams[].name`, initialized empty).
2. `fireDissect` stream branch: pass `parentRange` as the new last argument `feedRange`.
3. `contributeToStream`:

```ts
const signal = (expression: CompiledExpression | null, context: ExpressionContext): boolean =>
  expression !== null && evaluateExpression(expression, context) === true;

// ... inside contributeToStream, replacing the early empty-payload return:
const open = signal(stream.open, context);
const close = signal(stream.close, context);
const reset = signal(stream.reset, context);
const isControl = payload.bytes.length === 0;
if (isControl && !open && !close && !reset) return; // pure ACK: nothing to record

const srcStart = isControl ? feedRange.start : absoluteStart;
const srcEnd = isControl ? feedRange.end : absoluteStart + payload.bytes.length;
```

   Offset and key evaluation stay as today (their issue ranges now use `srcStart/srcEnd` above).
   Entry creation moves into a helper `createFlowEntry(stream, keyResult, emitContext, generation)`
   that reserves the `stream_id`, pushes onto `ordered`, sets `current`, and initializes the new
   fields (`opened: false, openOffset: null, closedBy: null, generation, conflictCount: 0,
   belowBaseReported: false, dataSegmentCount: 0`). Task 5 adds the generation decision; for now:
   `entry = current.get(key) ?? createFlowEntry(..., 1)`.

   After obtaining `entry`, **before** the inactive-status check:

```ts
if (open && !entry.opened) {
  entry.opened = true;
  entry.openOffset = offset;
  entry.assembler.anchor(offset);
}
if (reset) entry.closedBy = 'reset';
else if (close && entry.closedBy === null) entry.closedBy = 'close';
if (isControl) {
  entry.segments.push({ absOffset: offset, srcStart, srcEnd, feedKeyValue: keysByTable.get(stream.feedTable) ?? null });
  return;
}
```

   Then the existing inactive check, `add`, and framing. On an accepted data contribution also
   increment `entry.dataSegmentCount`.
   Anchoring can clear a framing stall exactly like a data rebase: if `anchor` returns
   `'rebased'`, reset `framingStalled`/`stallMessage`.
4. `flushStreams`: iterate `streams.ordered.get(stream.name)`. Replace the span computation with a
   helper that takes the min/max over `entry.segments` (every recorded data **and** control
   segment) and `entry.fallbackSpan`, falling back to `{0, 0}` only when both are empty. Add to
   the flow root:

```ts
opened: entry.opened,
closed_by: entry.closedBy,
generation: entry.generation,
conflict_count: entry.conflictCount,
```

   `segment_count` stays `entry.assembler.segmentCount` in this task (controls never store
   segments; Task 8 switches it to `dataSegmentCount`). Flow `_src_ranges` already derives from
   `entry.segments`, so control ranges join it automatically.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @byteql/core test -- --run`
Expected: PASS, whole core suite.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection/project.ts packages/core/src/projection/stream-lifecycle.test.ts packages/core/src/projection/stream-runtime.test.ts
git commit -m "feat(core): route stream control segments and expose flow lifecycle"
```

#### Task 5: Connection generations

**Files:**

- Modify: `packages/core/src/projection/project.ts` (`contributeToStream`)
- Test: `packages/core/src/projection/stream-lifecycle.test.ts`

**Interfaces:**

- Consumes: Task 4's `createFlowEntry`, `StreamsRuntime.current/ordered`, entry lifecycle fields.
- Produces: `startsNewGeneration(entry: StreamRuntimeEntry, offset: number): boolean` (module
  private). Offsets passed here are the same values handed to the assembler (Task 9 makes them
  extended offsets).
- [ ] **Step 1: Write the failing tests**

Append to `stream-lifecycle.test.ts`:

```ts
describe('stream lifecycle: generations', () => {
  const msg = (text: string) => [text.length, ...[...text].map((c) => c.charCodeAt(0))];

  it('splits a reused tuple after close into two flows', () => {
    const { finished } = project([
      chunk(7, OPEN, 10),
      chunk(7, 0, 10, msg('ab')),
      chunk(7, CLOSE, 13),
      chunk(7, OPEN, 50),
      chunk(7, 0, 50, msg('cd')),
    ]);
    const flows = rows(finished, 'flows');
    expect(flows.count).toBe(2);
    expect(flows.col('flow_id')).toEqual([1n, 2n]);
    expect(flows.col('generation')).toEqual([1, 2]);
    expect(flows.col('closed_by')).toEqual(['close', null]);
    const msgs = rows(finished, 'msgs');
    expect(msgs.col('text')).toEqual(['ab', 'cd']);
    expect(msgs.col('stream_id')).toEqual([1n, 2n]);
    expect(rows(finished, 'flow_segments').col('stream_id')).toEqual([1n, 1n, 1n, 2n, 2n]);
  });

  it('keeps a retransmitted open in the same generation', () => {
    const { finished } = project([chunk(7, OPEN, 10), chunk(7, OPEN, 10), chunk(7, 0, 10, msg('a'))]);
    expect(rows(finished, 'flows').count).toBe(1);
    expect(rows(finished, 'flow_segments').count).toBe(3);
  });

  it('starts a new generation for an open at a different offset without any close', () => {
    const { finished } = project([chunk(7, OPEN, 10), chunk(7, OPEN, 90)]);
    expect(rows(finished, 'flows').col('generation')).toEqual([1, 2]);
  });

  it('adopts a mid-stream flow when a late open lands on its base', () => {
    // [5, 97] is an incomplete message, so nothing is consumed yet
    const { finished } = project([chunk(7, 0, 10, [5, 97]), chunk(7, OPEN, 10)]);
    const flows = rows(finished, 'flows');
    expect(flows.count).toBe(1);
    expect(flows.col('opened')).toEqual([true]);
  });

  // Review Focus 2
  it('adopts even after the data was framed (consumed > 0)', () => {
    const { finished, issues } = project([chunk(7, 0, 10, msg('ab')), chunk(7, OPEN, 10)]);
    expect(rows(finished, 'msgs').count).toBe(1);
    expect(rows(finished, 'flows').col('generation')).toEqual([1]);
    expect(issues.issues()).toEqual([]);
  });

  it('starts a new generation when an open follows a mid-stream flow at another offset', () => {
    const { finished } = project([chunk(7, 0, 10, msg('ab')), chunk(7, OPEN, 60)]);
    expect(rows(finished, 'flows').col('generation')).toEqual([1, 2]);
  });

  // Review Focus 4
  it('keeps a late FIN in the closed generation and lets the next open start generation 2', () => {
    const { finished } = project([
      chunk(7, OPEN, 10),
      chunk(7, CLOSE, 10),
      chunk(7, CLOSE, 10), // retransmitted FIN
      chunk(7, OPEN, 70),
    ]);
    expect(rows(finished, 'flow_segments').col('stream_id')).toEqual([1n, 1n, 1n, 2n]);
  });

  it('keeps generations independent per key', () => {
    const { finished } = project([chunk(7, OPEN, 10), chunk(9, OPEN, 10), chunk(7, OPEN, 20)]);
    expect(rows(finished, 'flows').col('peer')).toEqual(['peer-7', 'peer-9', 'peer-7']);
    expect(rows(finished, 'flows').col('generation')).toEqual([1, 1, 2]);
  });

  // Review Focus 1
  it('handles thousands of generations on one tuple in linear time', () => {
    const chunks = Array.from({ length: 5000 }, (_, i) => chunk(7, OPEN, i % 256));
    const started = performance.now();
    const { finished } = project(chunks);
    expect(rows(finished, 'flows').count).toBe(5000);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
```

Note on the last test: consecutive opens at distinct offsets each start a new generation; the
`i % 256` pattern repeats an offset only 256 chunks later, by which time a different generation
is current, so every chunk is a new generation.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/stream-lifecycle.test.ts`
Expected: FAIL — reuse tests see one merged flow.

- [ ] **Step 3: Implement**

```ts
// Spec "Generations": an open joins the current generation when it repeats that generation's
// open offset (retransmitted SYN), or when the generation has no open yet, is not closed, and
// the open lands exactly on its base (a SYN captured after its own first data). Anything else
// is a new connection on a reused tuple.
const startsNewGeneration = (entry: StreamRuntimeEntry, offset: number): boolean => {
  if (entry.openOffset !== null) return entry.openOffset !== offset;
  if (entry.closedBy !== null) return true;
  return entry.assembler.base !== offset;
};
```

In `contributeToStream`, replace the Task 4 lookup:

```ts
let entry = streams.current.get(stream.name)!.get(keyResult.key);
if (!entry) entry = createFlowEntry(stream, keyResult, emitContext, 1);
else if (open && startsNewGeneration(entry, offset)) {
  entry = createFlowEntry(stream, keyResult, emitContext, entry.generation + 1);
}
```

`createFlowEntry` replaces the `current` mapping, so the retired entry stays only in `ordered`
and is still flushed. The adopting case (`openOffset === null`, base equals offset) falls through
to Task 4's `if (open && !entry.opened)` block, which sets `opened`; `anchor` returns `'ignored'`
there (offset equals base), which is correct.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @byteql/core test -- --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection/project.ts packages/core/src/projection/stream-lifecycle.test.ts
git commit -m "feat(core): split reused stream keys into connection generations"
```

#### Task 6: pcap lifecycle opt-in, adversarial fixtures, goldens

**Files:**

- Modify: `packages/formats/pcap/src/wrappers.ts` (`tcpSegment` root)
- Modify: `packages/formats/pcap/pcap.tables.yaml` (version, both stream declarations, `streams`
  table)
- Modify: `packages/formats/pcap/queries.yaml`
- Create: `packages/formats/pcap/test/tcp-identity.test.ts`
- Modify: `packages/formats/pcap/test/wrappers.test.ts` (fin/rst assertions)
- Regenerate: `packages/formats/pcap/test/goldens/*.golden.json`,
  `packages/formats/pcap/test/schemas.snapshot.json`

**Interfaces:**

- Consumes: spec v0.5 (Tasks 1–5).
- Produces: tcp root fields `fin: boolean`, `rst: boolean`; `streams` columns `handshake` (bool),
  `close_reason` (utf8, nullable, `'fin' | 'rst' | null`), `generation` (uint32),
  `conflict_count` (uint32); canned query id `reused_connections`. Test helpers in
  `tcp-identity.test.ts`: `seg(opts)`, `capture(packets)` (Task 10 appends to this file).
- [ ] **Step 1: Write the failing tests**

Create `packages/formats/pcap/test/tcp-identity.test.ts`:

```ts
import { ipcToTable } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { buildPcap, dnsOverTcp, ethFrame, ipv4, tcp } from './build-pcap.js';
import { parseAndProjectPcap } from './parse-and-project.js';

const SYN = 0x02;
const FIN = 0x01;
const RST = 0x04;
const ACK = 0x10;
const PSH = 0x08;

export interface SegOptions {
  seq: number;
  flags: number;
  payload?: Uint8Array;
  reverse?: boolean; // server -> client
}
export const seg = ({ seq, flags, payload = new Uint8Array(0), reverse = false }: SegOptions) =>
  ethFrame({
    etherType: 0x0800,
    payload: ipv4({
      protocol: 6,
      src: reverse ? '10.0.0.2' : '10.0.0.1',
      dst: reverse ? '10.0.0.1' : '10.0.0.2',
      payload: tcp({
        srcPort: reverse ? 53 : 40000,
        dstPort: reverse ? 40000 : 53,
        flags,
        seq,
        payload,
      }),
    }),
  });
export const capture = (packets: Uint8Array[]) =>
  buildPcap({
    magic: 'be_us',
    linktype: 1,
    packets: packets.map((data, i) => ({ tsSec: i + 1, tsFrac: 0, data })),
  });
export const run = async (packets: Uint8Array[]) => {
  const result = await parseAndProjectPcap(capture(packets), new AbortController().signal);
  const table = (name: string) => ipcToTable(result.tables.find((t) => t.name === name)!.ipc);
  return { result, table };
};
const clientFlows = (table: ReturnType<typeof ipcToTable>) =>
  table.toArray().filter((row) => row.src_port === 40000);

describe('tcp connection identity (lifecycle)', () => {
  it('fixture 1: splits two connections on one 4-tuple separated by FIN', async () => {
    const a = dnsOverTcp({ txId: 1, name: 'first.example', type: 1 });
    const b = dnsOverTcp({ txId: 2, name: 'second.example', type: 1 });
    const { table } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 1001, flags: PSH | ACK, payload: a }),
      seg({ seq: 1001 + a.length, flags: FIN | ACK }),
      seg({ seq: 5000, flags: SYN }),
      seg({ seq: 5001, flags: PSH | ACK, payload: b }),
    ]);
    const flows = clientFlows(table('streams'));
    expect(flows.map((f) => [f.generation, f.handshake, f.close_reason, f.status])).toEqual([
      [1, true, 'fin', 'ok'],
      [2, true, null, 'ok'],
    ]);
    const dns = table('dns').toArray();
    expect(dns.map((d) => d.query_name)).toEqual(['first.example', 'second.example']);
    expect(dns[0]!.stream_id).not.toBe(dns[1]!.stream_id);
  });

  it('fixture 2: splits reuse after RST', async () => {
    const b = dnsOverTcp({ txId: 2, name: 'after-rst.example', type: 1 });
    const { table } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 1001, flags: RST }),
      seg({ seq: 9000, flags: SYN }),
      seg({ seq: 9001, flags: PSH | ACK, payload: b }),
    ]);
    const flows = clientFlows(table('streams'));
    expect(flows.map((f) => [f.generation, f.close_reason])).toEqual([
      [1, 'rst'],
      [2, null],
    ]);
    expect(table('dns').toArray().map((d) => d.query_name)).toEqual(['after-rst.example']);
  });

  it('fixture 6: gives a SYN answered by RST two control-only flows', async () => {
    const { table } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 0, flags: RST | ACK, reverse: true }),
    ]);
    const flows = table('streams').toArray();
    expect(flows).toHaveLength(2);
    expect(flows.map((f) => [f.src_port, f.byte_count, f.handshake, f.close_reason])).toEqual([
      [40000, 0, true, null],
      [53, 0, false, 'rst'],
    ]);
    expect(table('stream_segments').numRows).toBe(2);
  });

  it('fixture 7: reports a gap, not a framer error, when the first data segment is missing', async () => {
    const payload = dnsOverTcp({ txId: 7, name: 'lost.example', type: 1 });
    const { table, result } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 1011, flags: PSH | ACK, payload: payload.subarray(10) }),
    ]);
    expect(clientFlows(table('streams'))[0]!.status).toBe('gap');
    expect(result.issues.map((i) => i.code)).toEqual(['STREAM_GAP']);
  });

  it('control segments map packets to connections through stream_segments', async () => {
    const { table } = await run([seg({ seq: 1000, flags: SYN }), seg({ seq: 1001, flags: FIN | ACK })]);
    const segs = table('stream_segments').toArray();
    expect(segs.map((s) => [s.stream_id, s.tcp_id])).toEqual([
      [1n, 1n],
      [1n, 2n],
    ]);
    // provenance is the 20-byte TCP header
    expect(segs.map((s) => Number(s._src_end - s._src_start))).toEqual([20, 20]);
  });
});
```

Add to `wrappers.test.ts`, next to the existing tcp wrapper assertions: a segment built with
flags `0x05` (RST|FIN) yields `root.fin === true`, `root.rst === true`, `root.syn === false`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/pcap test -- --run test/tcp-identity.test.ts test/wrappers.test.ts`
(if the file filter does not scope, see the note in `generate-e2e-fixture.test.ts` and use
`pnpm --filter @byteql/core build && pnpm --filter @byteql/pcap exec byteql-pack build && pnpm --filter @byteql/pcap exec vitest run test/tcp-identity.test.ts test/wrappers.test.ts`)
Expected: FAIL — merged flows, missing columns.

- [ ] **Step 3: Implement**

1. `wrappers.ts` `tcpSegment` root: add `fin: f.fin, rst: f.rst,` next to `syn` and extend the
   comment: the stream `open`/`close`/`reset` expressions read these raw flags.
2. `pcap.tables.yaml`: `version: '0.5'`. In both `tls_stream` and `dns_tcp_stream`, after the
   `offset:` line:

```yaml
    # Connection lifecycle (spec v0.5): a SYN (or SYN-ACK) opens a generation, so a reused
    # 4-tuple becomes a new stream; FIN and RST record how this direction ended.
    open: _.syn
    close: _.fin
    reset: _.rst
```

   `streams` table columns, appended after `status`:

```yaml
      handshake: { expr: _.opened, type: bool }
      close_reason:
        expr: "_.closed_by == 'reset' ? 'rst' : (_.closed_by == 'close' ? 'fin' : null)"
        type: utf8
        nullable: true
      generation: { expr: _.generation, type: uint32 }
      conflict_count: { expr: _.conflict_count, type: uint32 }
```

   Update the YAML header comment that documents the stream limitations (search the file for
   `FIN` / `teardown`) to say teardown and reuse are handled.
3. `queries.yaml`, after `tcp_flows`:

```yaml
  - id: reused_connections
    title: Reused or reset connections
    kind: grid
    sql: |
      select s.*
      from streams s
      where s.generation > 1 or s.close_reason = 'rst'
      order by s._src_file, s.stream_id
      limit 100;
```

   (`s.*` keeps hidden provenance columns so rows stay hex-navigable, same convention as
   `dns_join`.)

- [ ] **Step 4: Run tests; review and regenerate goldens**

Run: `pnpm --filter @byteql/pcap test -- --run`
Expected: the new tests PASS; golden and schema snapshot tests FAIL with diffs.

Regenerate: `pnpm --filter @byteql/pcap test -- --run -u`, then `git diff --stat` and inspect
every changed golden. For each, confirm the diff is **only**: (a) the four new `streams` columns
in the schema/field list, (b) additional `streams` rows (control-only flows; `byte_count` 0), (c)
additional `stream_segments` rows, and (d) row counts/SHA-256 changes those imply. Any other value
change in an existing `dns`/`tls`/`streams` row is a bug — stop and fix it. Record in the commit
body which goldens changed and why (e.g. `http2-16-ssl.pcapng`: SYN/FIN segments now recorded).

Then run the whole gate for the packages touched:
`pnpm --filter @byteql/core test -- --run && pnpm --filter @byteql/pcap test -- --run && pnpm -r check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap
git commit -m "feat(pcap): split reused TCP connections and expose their lifecycle"
```

#### Task 7: Browser acceptance for lifecycle

**Files:**

- Modify: `packages/formats/pcap/test/generate-e2e-fixture.test.ts` (new gated generator)
- Create: `apps/web/e2e/fixtures/tcp-reuse.pcap` (generated, committed)
- Modify: `apps/web/e2e/pcap.spec.ts`, `apps/web/e2e/hex-provenance.spec.ts`

**Interfaces:**

- Consumes: Task 6's columns and `reused_connections` query.

- [ ] **Step 1: Add the fixture generator and generate**

Append to `generate-e2e-fixture.test.ts`, following the existing generators' style (reuse
`dnsOverTcp`, `ethFrame`, `ipv4`, `tcp`, `buildPcap`):

```ts
// Regenerates apps/web/e2e/fixtures/tcp-reuse.pcap: two DNS-over-TCP connections on one 4-tuple
// (10.0.0.1:40000 -> 10.0.0.2:53). Connection 1: SYN, query "reuse-one.example", FIN.
// Connection 2: SYN (new ISN), query "reuse-two.example", RST. Packet 1 is the first SYN, whose
// TCP header starts at file offset 24 + 16 + 14 + 20 = 74 (global header, record header,
// Ethernet, IPv4) and is 20 bytes long.
it.runIf(process.env.GENERATE_E2E_FIXTURES === '1')('writes the tcp-reuse e2e fixture', () => {
  const one = dnsOverTcp({ txId: 0x0101, name: 'reuse-one.example', type: 1 });
  const two = dnsOverTcp({ txId: 0x0202, name: 'reuse-two.example', type: 1 });
  const packet = (seq: number, flags: number, data = new Uint8Array(0)) =>
    ethFrame({
      etherType: 0x0800,
      payload: ipv4({
        protocol: 6,
        src: '10.0.0.1',
        dst: '10.0.0.2',
        payload: tcp({ srcPort: 40000, dstPort: 53, flags, seq, payload: data }),
      }),
    });
  const pcap = buildPcap({
    magic: 'be_us',
    linktype: 1,
    packets: [
      packet(1000, 0x02),
      packet(1001, 0x18, one),
      packet(1001 + one.length, 0x11),
      packet(70000, 0x02),
      packet(70001, 0x18, two),
      packet(70001 + two.length, 0x04),
    ].map((data, i) => ({ tsSec: i + 1, tsFrac: 0, data })),
  });
  const target = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/web/e2e/fixtures/tcp-reuse.pcap');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, pcap);
});
```

Run: `GENERATE_E2E_FIXTURES=1 pnpm --filter @byteql/pcap exec vitest run test/generate-e2e-fixture.test.ts`
Then confirm with `git status` that **only** `tcp-reuse.pcap` is new and the other fixtures are
byte-identical (`git diff --stat apps/web/e2e/fixtures` shows no modifications). If an existing
fixture changed, restore it with `git checkout -- <file>` — the generators must be deterministic.

- [ ] **Step 2: Write the failing e2e tests**

In `pcap.spec.ts`, beside `streamPcapPath`:

```ts
const reusePcapPath = fileURLToPath(new URL('./fixtures/tcp-reuse.pcap', import.meta.url));

test('splits a reused 4-tuple into two connections with close reasons', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
  await page.getByLabel('Open file input').setInputFiles(reusePcapPath);
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();

  await runSql(
    page,
    `select d.query_name, s.generation, s.close_reason
     from dns d join streams s using (stream_id)
     order by s.generation`,
  );
  await expect(page.getByRole('gridcell', { name: 'reuse-one.example' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'reuse-two.example' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'fin', exact: true })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'rst', exact: true })).toBeVisible();
});
```

In `hex-provenance.spec.ts` (reuse its `pane`, `highlightedHexRange` helpers and `runSql`):

```ts
test('pcap: a SYN stream_segments row highlights its TCP header', async ({ page }) => {
  await page.goto('/');
  await page
    .getByLabel('Open file input')
    .setInputFiles(fileURLToPath(new URL('./fixtures/tcp-reuse.pcap', import.meta.url)));
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();
  await runSql(page, 'select * from stream_segments order by segment_id limit 1');
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  expect(await highlightedHexRange(page)).toEqual({ start: 74, end: 94 });
});
```

(Check `runSql`'s import in `hex-provenance.spec.ts`; add it from `./support/app.js` if missing.
If `highlightedHexRange` returns an inclusive end, adjust to its documented convention — read
its implementation at the top of the file.)

- [ ] **Step 3: Run**

Run: `pnpm build && pnpm --filter @byteql/web test:e2e -- pcap.spec.ts hex-provenance.spec.ts pack-queries.spec.ts`
Expected: PASS (`pack-queries.spec.ts` runs every canned query per pack, so it covers
`reused_connections`; confirm by reading that spec — if it only runs a fixed subset, add
`reused_connections` there).

- [ ] **Step 4: Commit**

```bash
git add packages/formats/pcap/test/generate-e2e-fixture.test.ts apps/web/e2e
git commit -m "test(e2e): cover reused TCP tuples and control-segment provenance"
```

**Phase A checkpoint:** run the full gate — `pnpm -r check`, `pnpm -r test -- --run`,
`pnpm --filter @byteql/web check:bundle`, `pnpm --filter @byteql/web test:e2e`. All green before
Phase B.

---

## Phase B — Wraparound and overlap

### Task 8: Overlap reconciliation and below-base trimming

**Files:**

- Modify: `packages/core/src/projection/streams.ts` (`AssemblerAddResult` → outcome object,
  `add`)
- Modify: `packages/core/src/projection/project.ts` (`contributeToStream` result handling,
  `flushStreams` `segment_count`)
- Test: `packages/core/src/projection/streams.test.ts`,
  `packages/core/src/projection/stream-lifecycle.test.ts`

**Interfaces:**

- Consumes: Task 3's `#rebaseTo`/`#advanceFrontier`; Task 4's `conflictCount`,
  `belowBaseReported`, `dataSegmentCount`.
- Produces:

```ts
export type AssemblerAddStatus = 'added' | 'rebased' | 'duplicate' | 'conflict' | 'dropped' | 'truncated';
export interface AssemblerAddOutcome {
  status: AssemblerAddStatus;
  /** Some incoming bytes overlapped stored bytes and differed; the stored bytes were kept. */
  conflicted: boolean;
  /** A prefix below the locked (consumed > 0) base was discarded. */
  trimmedBelowBase: boolean;
}
add(offset: number, bytes: Uint8Array, srcStart: number, srcEnd: number): AssemblerAddOutcome;
```

  `'dropped'`: the whole segment lay below the locked base. `'duplicate'`/`'conflict'`: fully
  covered, identical/different, nothing stored. `'added'`/`'rebased'`: at least one new byte
  stored. `'below_base'` and `'overlap'` no longer exist.

- [ ] **Step 1: Write the failing tests**

First, mechanically migrate existing assertions in `streams.test.ts`:
`expect(a.add(...)).toBe('x')` → `expect(a.add(...).status).toBe('x')` (sed is fine:
`sed -i -E "s/expect\(([ab])\.add\((.*)\)\)\.toBe\(/expect(\1.add(\2).status).toBe(/" packages/core/src/projection/streams.test.ts`,
then eyeball the result). Replace the two tests whose expectations change:

```ts
it('drops exact and subsumed duplicates, and keeps first bytes on a partial conflict', () => {
  const a = new StreamAssembler(64);
  a.add(0, bytes(1, 2, 3), 0, 3);
  expect(a.add(0, bytes(1, 2, 3), 50, 53)).toEqual({ status: 'duplicate', conflicted: false, trimmedBelowBase: false });
  expect(a.add(1, bytes(2), 60, 61).status).toBe('duplicate'); // subsumed
  expect(a.byteCount).toBe(3);
  expect(a.add(2, bytes(9, 4), 70, 72)).toEqual({ status: 'added', conflicted: true, trimmedBelowBase: false });
  expect([...a.contiguousView()]).toEqual([1, 2, 3, 4]); // 3 kept, only the new tail stored
  expect(a.segmentsOverlapping(3, 4)).toEqual([{ start: 3, end: 4, srcStart: 71, srcEnd: 72 }]);
});

it('stores only the fresh parts of a segment bridging two stored segments', () => {
  const a = new StreamAssembler(64);
  a.add(0, bytes(1), 0, 1);
  a.add(2, bytes(3), 10, 11);
  expect(a.add(0, bytes(1, 2, 3, 4), 20, 24).status).toBe('added');
  expect([...a.contiguousView()]).toEqual([1, 2, 3, 4]);
  expect(a.segmentsOverlapping(0, 4).map((s) => [s.start, s.end, s.srcStart, s.srcEnd])).toEqual([
    [0, 1, 0, 1],
    [1, 2, 21, 22],
    [2, 3, 10, 11],
    [3, 4, 23, 24],
  ]);
});

it('reports a fully covered, different retransmission as a conflict', () => {
  const a = new StreamAssembler(64);
  a.add(0, bytes(1, 2), 0, 2);
  expect(a.add(0, bytes(1, 9), 5, 7)).toEqual({ status: 'conflict', conflicted: true, trimmedBelowBase: false });
  expect([...a.contiguousView()]).toEqual([1, 2]);
});

it('trims a below-base prefix once consumed instead of failing', () => {
  const a = new StreamAssembler(64);
  a.add(10, bytes(1, 2), 0, 2);
  a.consume(1);
  expect(a.add(8, bytes(9, 9, 1, 2, 3), 20, 25)).toEqual({ status: 'added', conflicted: false, trimmedBelowBase: true });
  expect([...a.contiguousView()]).toEqual([2, 3]);
  expect(a.add(4, bytes(7, 7), 30, 32).status).toBe('dropped');
});

it('checks the cap against fresh parts only', () => {
  const a = new StreamAssembler(4);
  a.add(0, bytes(1, 2, 3, 4), 0, 4);
  expect(a.add(0, bytes(1, 2, 3, 4), 9, 13).status).toBe('duplicate'); // no growth, no truncation
  expect(a.add(2, bytes(3, 4, 5), 20, 23).status).toBe('truncated');
});

it('never stores overlapping segments (randomized)', () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  for (let round = 0; round < 200; round += 1) {
    const a = new StreamAssembler(256);
    for (let i = 0; i < 20; i += 1) {
      const start = rand(64);
      const length = 1 + rand(16);
      a.add(start, Uint8Array.from({ length }, () => rand(3)), 1000 + i * 100, 1000 + i * 100 + length);
      const segs = a.segmentsOverlapping(-1e9, 1e9);
      for (let k = 1; k < segs.length; k += 1) expect(segs[k]!.start).toBeGreaterThanOrEqual(segs[k - 1]!.end);
    }
  }
});
```

Update the old `'rejects a below-base segment once consumed'` test to expect `'dropped'` with
`trimmedBelowBase: true`.

In `stream-lifecycle.test.ts` append:

```ts
describe('stream overlap reconciliation (runtime)', () => {
  it('counts a conflict, reports it at the conflicting segment, and keeps going', () => {
    // msg [3,'a','b','c'] = seq 10..14; retransmit of seq 11..13 with 'X' instead of 'b'
    // Base 10 (the open). Record n's payload sits at file offset n * 100 + 3.
    const { finished, issues } = project([
      chunk(7, OPEN, 10),
      chunk(7, 0, 10, [3, 97]), // offsets 10..11: length byte 3, 'a'
      chunk(7, 0, 11, [88, 99]), // offset 11 conflicts (88 vs stored 97, 97 kept); offset 12 'c' is new
      chunk(7, 0, 13, [100]), // offset 13 'd' completes [3, 97, 99, 100]
    ]);
    expect(rows(finished, 'msgs').col('text')).toEqual(['acd']);
    const flows = rows(finished, 'flows');
    expect(flows.col('conflict_count')).toEqual([1]);
    expect(flows.col('status')).toEqual(['ok']);
    expect(issues.issues().map((i) => [i.code, i.sourceStart, i.sourceEnd])).toEqual([
      ['STREAM_OVERLAP_CONFLICT', 203, 205],
    ]);
  });
});
```

Also add (Review Focus 5):

```ts
it('compares a retransmission of already-framed bytes against the consumed data', () => {
  const { finished, issues } = project([
    chunk(7, OPEN, 10),
    chunk(7, 0, 10, [1, 97]), // message 'a', framed and consumed
    chunk(7, 0, 10, [1, 98]), // same offsets, different byte
  ]);
  expect(rows(finished, 'msgs').col('text')).toEqual(['a']);
  expect(rows(finished, 'flows').col('conflict_count')).toEqual([1]);
  expect(issues.issues().map((i) => i.code)).toEqual(['STREAM_OVERLAP_CONFLICT']);
});

it('reports STREAM_BELOW_BASE once per flow and keeps the stream ok', () => {
  const { finished, issues } = project([
    chunk(7, 0, 20, [1, 97]), // mid-stream start; framed, base locked at 20
    chunk(7, 0, 18, [5, 5, 1]), // 18,19 below base; offset 20 duplicates the stored 1
    chunk(7, 0, 17, [5]),
  ]);
  expect(rows(finished, 'flows').col('status')).toEqual(['ok']);
  expect(issues.issues().map((i) => i.code)).toEqual(['STREAM_BELOW_BASE']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/streams.test.ts src/projection/stream-lifecycle.test.ts`
Expected: FAIL (outcome objects, conflicts, trimming not implemented).

- [ ] **Step 3: Implement the assembler**

Refactor the store path of `add()` into `#store(start: number, bytes: Uint8Array, srcStart: number, srcEnd: number): void`
(data copy with growth, sorted insertion, counters, `#highestEndAbs`, `#srcMin/#srcMax`,
`#frontierIndex` adjust — everything after the base is settled), followed by one
`#advanceFrontier()` per `add`. Then:

```ts
add(offset: number, bytes: Uint8Array, srcStart: number, srcEnd: number): AssemblerAddOutcome {
  let trimmedBelowBase = false;
  if (this.#base !== null && this.#consumed > 0 && offset < this.#base) {
    const cut = Math.min(this.#base - offset, bytes.length);
    trimmedBelowBase = true;
    if (cut === bytes.length) return { status: 'dropped', conflicted: false, trimmedBelowBase };
    offset += cut;
    srcStart += cut;
    bytes = bytes.subarray(cut);
  }
  const end = offset + bytes.length;

  // Covered/fresh split over the stored segments this range touches (sorted, non-overlapping).
  const fresh: { start: number; end: number }[] = [];
  let conflicted = false;
  let cursor = offset;
  for (let i = this.#firstEndingAfter(offset); i < this.#segments.length; i += 1) {
    const s = this.#segments[i]!;
    if (s.start >= end) break;
    if (s.start > cursor) fresh.push({ start: cursor, end: s.start });
    const coveredStart = Math.max(s.start, offset);
    const coveredEnd = Math.min(s.end, end);
    if (!conflicted && !this.#matchesStored(coveredStart, coveredEnd, bytes, offset)) conflicted = true;
    cursor = Math.max(cursor, coveredEnd);
  }
  if (cursor < end) fresh.push({ start: cursor, end });
  if (fresh.length === 0) {
    return { status: conflicted ? 'conflict' : 'duplicate', conflicted, trimmedBelowBase };
  }

  const freshStart = fresh[0]!.start;
  const freshEnd = fresh[fresh.length - 1]!.end;
  const rebasing = this.#base !== null && freshStart < this.#base; // consumed === 0 here
  const newBase = this.#base === null ? freshStart : Math.min(this.#base, freshStart);
  const newExtent = Math.max(freshEnd, this.#highestEndAbs ?? freshEnd) - newBase;
  if (newExtent > this.#maxBuffer) return { status: 'truncated', conflicted, trimmedBelowBase };
  if (rebasing) this.#rebaseTo(newBase, newExtent);
  else this.#base = newBase;

  for (const piece of fresh) {
    this.#store(
      piece.start,
      bytes.subarray(piece.start - offset, piece.end - offset),
      srcStart + (piece.start - offset),
      srcStart + (piece.end - offset),
    );
  }
  this.#advanceFrontier();
  return { status: rebasing ? 'rebased' : 'added', conflicted, trimmedBelowBase };
}

/** Index of the first stored segment whose end is past `offset` (ends are non-decreasing). */
#firstEndingAfter(offset: number): number {
  let lo = 0;
  let hi = this.#segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (this.#segments[mid]!.end <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

#matchesStored(start: number, end: number, bytes: Uint8Array, offset: number): boolean {
  const base = this.#base!;
  for (let p = start; p < end; p += 1) {
    if (this.#data[p - base] !== bytes[p - offset]) return false;
  }
  return true;
}
```

`srcEnd` is now unused inside `add` beyond validation — keep the parameter (callers pass it) and
drop it from the body; `tsc`'s unused-parameter settings: prefix with `_` only if lint demands.
Update the cost-bound comment: splitting adds at most one pass over the touched segments.

- [ ] **Step 4: Wire the runtime**

In `contributeToStream`, replace the result handling:

```ts
const outcome = entry.assembler.add(offset, payload.bytes, srcStart, srcEnd);
const flow = `stream ${JSON.stringify(stream.name)} flow ${JSON.stringify(keyResult.key)}`;
if (outcome.conflicted) {
  entry.conflictCount += 1;
  emitContext.issues?.report({
    stage: 'reassembling',
    code: 'STREAM_OVERLAP_CONFLICT',
    recoverable: true,
    message: `${flow}: retransmitted bytes at offset ${offset} differ from the first-arrived bytes (kept)`,
    sourceStart: srcStart,
    sourceEnd: srcEnd,
  });
}
if (outcome.trimmedBelowBase && !entry.belowBaseReported) {
  entry.belowBaseReported = true;
  emitContext.issues?.report({
    stage: 'reassembling',
    code: 'STREAM_BELOW_BASE',
    recoverable: true,
    message: `${flow}: bytes before the reassembled start arrived after framing began and were dropped`,
    sourceStart: srcStart,
    sourceEnd: srcEnd,
  });
}
if (outcome.status === 'duplicate' || outcome.status === 'conflict' || outcome.status === 'dropped') return;
if (outcome.status === 'truncated') { /* existing truncated block, unchanged */ }
```

Remove the `below_base`/`overlap` → `error` block. Keep the rebase stall-clearing on
`outcome.status === 'rebased'`. In `flushStreams`, set `segment_count: entry.dataSegmentCount`
(the assembler's `segmentCount` now counts stored pieces, not packets). Update the
`StreamRuntimeEntry.status` doc comment: `'error'` now only comes from framer stalls and invalid
offsets.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @byteql/core test -- --run`
Expected: PASS. If a pre-existing runtime test asserted `STREAM_ERROR` for a partial overlap
(`grep -n "overlap" packages/core/src/projection/stream-runtime.test.ts`), update it to the new
contract (conflict or clean overlap, status `ok`) and say so in the commit body.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/projection/streams.ts packages/core/src/projection/streams.test.ts packages/core/src/projection/project.ts packages/core/src/projection/stream-lifecycle.test.ts packages/core/src/projection/stream-runtime.test.ts
git commit -m "feat(core): reconcile overlapping stream segments first-bytes-win"
```

#### Task 9: Offset wraparound

**Files:**

- Modify: `packages/core/src/projection/streams.ts` (new `unwrapOffset`)
- Modify: `packages/core/src/projection/project.ts` (`contributeToStream`, entry field)
- Test: `packages/core/src/projection/streams.test.ts`,
  `packages/core/src/projection/stream-lifecycle.test.ts`

**Interfaces:**

- Produces: `export const unwrapOffset = (raw: number, bits: number, reference: number | null): number`
  exported from `streams.ts`; `StreamRuntimeEntry.unwrapReference: number | null` (highest
  extended offset or end seen in the generation).

- [ ] **Step 1: Write the failing tests**

`streams.test.ts`:

```ts
describe('unwrapOffset', () => {
  it('biases the first offset by the modulus', () => {
    expect(unwrapOffset(5, 8, null)).toBe(261);
  });
  it('reduces raw values modulo 2^bits first', () => {
    expect(unwrapOffset(256, 8, null)).toBe(256); // 256 % 256 = 0, + 256
  });
  it('moves forward across a wrap', () => {
    expect(unwrapOffset(2, 8, 256 + 250)).toBe(512 + 2);
  });
  it('moves backward for a pre-wrap retransmission', () => {
    expect(unwrapOffset(250, 8, 512 + 3)).toBe(256 + 250);
  });
  it('stays in the same epoch for nearby offsets', () => {
    expect(unwrapOffset(100, 8, 256 + 90)).toBe(356);
  });
});
```

`stream-lifecycle.test.ts` (8-bit sequence space, `offset_bits: 8` passed as `streamExtra`):

```ts
describe('stream wraparound', () => {
  const wrap = '    offset_bits: 8';
  it('reassembles a message straddling the 2^8 wrap', () => {
    // open at 253; message [4,'w','r','a','p'] at 253..257 -> raw 253,254,255,0,1
    const { finished, issues } = project(
      [chunk(7, OPEN, 253), chunk(7, 0, 253, [4, 119, 114]), chunk(7, 0, 0, [97, 112])],
      wrap,
    );
    expect(issues.issues()).toEqual([]);
    expect(rows(finished, 'msgs').col('text')).toEqual(['wrap']);
    expect(rows(finished, 'flows').col('status')).toEqual(['ok']);
    expect(rows(finished, 'flow_segments').col('offset')).toEqual([0n, 0n, 3n]);
  });

  it('crosses the wrap twice within a small extent', () => {
    // 3 messages of 101 bytes each starting at raw 200: 200..301..402..503 crosses 256 and 512
    const message = (fill: number) => [100, ...Array.from({ length: 100 }, () => fill)];
    const data = [...message(65), ...message(66), ...message(67)];
    const chunks = [chunk(7, OPEN, 200)];
    for (let at = 0; at < data.length; at += 50) {
      chunks.push(chunk(7, 0, (200 + at) % 256, data.slice(at, at + 50)));
    }
    const { finished } = project(chunks, wrap, 512); // 303 bytes exceed the default 64-byte cap
    expect(rows(finished, 'msgs').count).toBe(3);
    expect(rows(finished, 'flows').col('status')).toEqual(['ok']);
  });

  it('matches a retransmitted open after the stream wrapped', () => {
    const { finished } = project(
      [chunk(7, OPEN, 250), chunk(7, 0, 250, [9, 1, 2, 3, 4, 5, 6, 7, 8, 9]), chunk(7, OPEN, 250)],
      wrap,
    );
    expect(rows(finished, 'flows').count).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/streams.test.ts src/projection/stream-lifecycle.test.ts`
Expected: FAIL (`unwrapOffset` missing; wrap message never frames — flow `truncated`).

- [ ] **Step 3: Implement**

`streams.ts`:

```ts
/**
 * Maps a modular raw offset (e.g. a 32-bit TCP sequence number) into a monotonic extended
 * offset space: the first offset of a generation lands in epoch 1 (raw + 2^bits, so a
 * retransmission from just before a wrap stays non-negative); every later one takes the epoch
 * that puts it closest to `reference` (RFC 1982 serial arithmetic, correct within ±2^(bits-1)).
 */
export const unwrapOffset = (raw: number, bits: number, reference: number | null): number => {
  const modulus = 2 ** bits;
  const reduced = raw % modulus;
  if (reference === null) return reduced + modulus;
  const half = modulus / 2;
  let candidate = reference - (reference % modulus) + reduced;
  if (candidate - reference > half) candidate -= modulus;
  else if (reference - candidate > half) candidate += modulus;
  return candidate;
};
```

`project.ts` `contributeToStream`: after `toSafeOffset` yields `raw`, and after the key is
resolved, compute the offset used for everything downstream (generation checks, anchor, add,
segment records):

```ts
const current = streams.current.get(stream.name)!.get(keyResult.key);
const unwrap = (reference: number | null) =>
  stream.offsetBits === null ? raw : unwrapOffset(raw, stream.offsetBits, reference);
let offset = unwrap(current?.unwrapReference ?? null);
let entry = current;
if (!entry) entry = createFlowEntry(stream, keyResult, emitContext, 1);
else if (open && startsNewGeneration(entry, offset)) {
  entry = createFlowEntry(stream, keyResult, emitContext, entry.generation + 1);
  offset = unwrap(null); // a new generation restarts unwrapping from its own first offset
}
entry.unwrapReference = Math.max(entry.unwrapReference ?? offset, offset + payload.bytes.length);
```

Initialize `unwrapReference: null` in `createFlowEntry`. Offset issue messages keep reporting
the raw value.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @byteql/core test -- --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection/streams.ts packages/core/src/projection/streams.test.ts packages/core/src/projection/project.ts packages/core/src/projection/stream-lifecycle.test.ts
git commit -m "feat(core): unwrap modular stream offsets across sequence wraparound"
```

#### Task 10: pcap wraparound and overlap fixtures

**Files:**

- Modify: `packages/formats/pcap/pcap.tables.yaml` (`offset_bits: 32` in both streams)
- Modify: `packages/formats/pcap/test/tcp-identity.test.ts`
- Regenerate: goldens if needed
- [ ] **Step 1: Write the failing tests**

Append to `tcp-identity.test.ts`:

```ts
describe('tcp connection identity (wraparound and overlap)', () => {
  it('fixture 3: reassembles a DNS response straddling 2^32', async () => {
    // 32-byte message; payload starts at 0xfffffff1, so byte 15 sits at 2^32. The third
    // segment's raw seq is (0xfffffff0 + 21) mod 2^32 = 5: without unwrapping it lands ~4 GiB
    // below the base and the stream truncates.
    const payload = dnsOverTcp({ txId: 3, name: 'wrap.example', type: 1 });
    const isn = 0xfffffff0;
    const { table, result } = await run([
      seg({ seq: isn, flags: SYN }),
      seg({ seq: isn + 1, flags: PSH | ACK, payload: payload.subarray(0, 10) }),
      seg({ seq: isn + 11, flags: PSH | ACK, payload: payload.subarray(10, 20) }),
      seg({ seq: (isn + 21) >>> 0, flags: PSH | ACK, payload: payload.subarray(20) }),
    ]);
    expect(result.issues).toEqual([]);
    expect(table('dns').toArray().map((d) => d.query_name)).toEqual(['wrap.example']);
    expect(clientFlows(table('streams'))[0]!.status).toBe('ok');
  });

  it('fixture 4: accepts a repacked retransmission spanning two segments', async () => {
    const payload = dnsOverTcp({ txId: 4, name: 'repack.example', type: 1 });
    const { table, result } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 1001, flags: PSH | ACK, payload: payload.subarray(0, 6) }),
      seg({ seq: 1007, flags: PSH | ACK, payload: payload.subarray(6, 12) }),
      seg({ seq: 1004, flags: PSH | ACK, payload: payload.subarray(3) }), // covers both + the rest
    ]);
    expect(result.issues).toEqual([]);
    expect(table('dns').toArray().map((d) => d.query_name)).toEqual(['repack.example']);
    const flow = clientFlows(table('streams'))[0]!;
    expect([flow.status, flow.conflict_count]).toEqual(['ok', 0]);
  });

  it('fixture 5: keeps the first bytes of a conflicting retransmission and flags it', async () => {
    const payload = dnsOverTcp({ txId: 5, name: 'first.example', type: 1 });
    const forged = payload.slice(0, 12);
    forged[11] ^= 0xff;
    const { table, result } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 1001, flags: PSH | ACK, payload: payload.subarray(0, 12) }),
      seg({ seq: 1001, flags: PSH | ACK, payload: forged }), // packet 3: the conflicting one
      seg({ seq: 1013, flags: PSH | ACK, payload: payload.subarray(12) }),
    ]);
    expect(table('dns').toArray().map((d) => d.query_name)).toEqual(['first.example']);
    expect(clientFlows(table('streams'))[0]!.conflict_count).toBe(1);
    const errors = table('errors').toArray();
    expect(errors.map((e) => e.code)).toEqual(['STREAM_OVERLAP_CONFLICT']);
    const conflictSeg = table('tcp').toArray()[2]!;
    expect(errors[0]!._src_start).toBe(conflictSeg._src_start + 20n); // its payload, past the TCP header
  });
});
```

For fixture 5, check that the `tcp` table exposes `_src_start` in the Arrow result (hidden
provenance columns are present in IPC); `tcp` rows' `_src_start` is the TCP header start and the
tcp header is 20 bytes (no options in `build-pcap.ts`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/pcap test -- --run` (see Task 6 for the scoped form)
Expected: fixture 3 FAILs (stream `truncated`: extent spans ~4 GiB); fixtures 4 and 5 already
pass thanks to Task 8's engine change — that is expected: they are the pcap-level proof of Task 8.
(If you want to see them fail, run them against `git stash`-ed Phase B engine changes; not
required.)

- [ ] **Step 3: Implement**

In `pcap.tables.yaml`, both stream declarations gain, right after `offset:`:

```yaml
    # TCP sequence numbers are 32-bit and wrap; the engine unwraps them (spec v0.5).
    offset_bits: 32
```

- [ ] **Step 4: Run tests and review goldens**

Run: `pnpm --filter @byteql/pcap test -- --run`. If goldens diff, regenerate with `-u` and apply
Task 6's rule: `offset_bits` must not change any golden row unless a bundled capture really
contains a wrapping stream — inspect and justify any diff in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap
git commit -m "feat(pcap): unwrap 32-bit TCP sequence numbers"
```

#### Task 11: Performance check, documentation, full gate

**Files:**

- Modify: `docs/superpowers/specs/2026-09-24-tcp-connection-identity-design.md` (append
  "Implementation notes")
- Modify: `docs/superpowers/specs/2026-07-18-phase2-tcp-reassembly-design.md` (amendment note)
- Modify: `docs/pack-authoring.md` (spec v0.5 section), `AGENTS.md`, `ROADMAP.md`, `PRD.md`
  Appendix A only if it documents stream fields (`grep -n "max_buffer\|streams:" PRD.md`)
- [ ] **Step 1: Benchmark**

Run: `pnpm build && node apps/web/scripts/run-scale-bench.mjs --gb 1` (one run at a time; record
the parse s/GB). Compare with the 42.6 s/GB median in `ROADMAP.md`. Bar: < 60 s/GB; if the
regression exceeds 5 %, profile `contributeToStream` (lifecycle evaluation runs only for
segments routed to a stream link) and explain the cause in the implementation notes.

- [ ] **Step 2: Documentation**

1. Design doc: append `## Implementation notes` — measured bench number, golden diffs and why,
   any deviations from the design with reasons.
2. Phase 2 design: under "Scope decisions", after the 2026-09-22 amendment, add
   `> Amended 2026-09-24: FIN/RST teardown, tuple-reuse generations, sequence wraparound, and
   > first-bytes-win overlap reconciliation now exist; see
   > 2026-09-24-tcp-connection-identity-design.md.` and the same note under "Non-goals".
3. `docs/pack-authoring.md`: add "Projection spec v0.5 stream lifecycle" after the v0.4 section:
   the four fields, their compile rules, the flow-root fields and neutral values, and the pcap
   YAML as the example. Update the `(v0.4)` label on line 17 to `(v0.5)`.
4. `AGENTS.md`: add a status bullet ("TCP connection identity: shipped 2026-09-24" with the
   design path and remaining limitations: no bidirectional pairing, no idle-timeout splitting,
   closed flows flush at finish, single-record ClientHello); remove FIN/RST, wraparound, and
   partial-overlap from the Phase 2 bullet's limitation list; update the spec-version mention in
   the repo map (`v0.1–v0.4` → `v0.1–v0.5`); set **Next** to ROADMAP #6.
5. `ROADMAP.md`: mark priority 5 done (2026-09-24) with evidence links
   (`packages/formats/pcap/test/tcp-identity.test.ts`, `apps/web/e2e/pcap.spec.ts`) and the
   design link; update "Next development cycle".
6. Run `rumdl fmt` on every touched `.md` file and `pnpm format:check`.

- [ ] **Step 3: Full gate**

Run, in order:
`pnpm -r check` · `pnpm -r test -- --run` · `pnpm lint` · `pnpm --filter @byteql/web check:bundle` ·
`pnpm --filter @byteql/web test:e2e`
Expected: all PASS, output pristine.

- [ ] **Step 4: Commit**

```bash
git add docs AGENTS.md ROADMAP.md PRD.md
git commit -m "docs: record TCP connection identity and mark roadmap priority 5 done"
```
