# Phase 1 Generalization Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the ByteQL engine for Phase 1 — spec v0.2 (`dissect`/`parent_key`), a single-pass projection engine with an incremental Arrow batch-flush seam, a WIT-aligned `FormatPack` boundary with a probe registry, hex literals, `timestamp_us`/`binary` Arrow types, and `ProjectionSession`/`IssueCollector` lifted into core — while the MIDI pack stays green as a regression harness at every step.

**Architecture:** Evolve the existing `packages/core` projection modules in place (approach A of the approved spec at `docs/superpowers/specs/2026-07-18-phase1-generalization-prep-design.md`). The worker still delivers one `ParseResult`; `packages/db` and the UI are untouched except two renamed worker error codes.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), pnpm workspace, vitest, zod v4, jsep 1.4, apache-arrow 21, yaml.

## Global Constraints

- Behavior-preserving: for every existing MIDI fixture, projected rows, keys, provenance, table schemas, and the app-visible `ParseResult` are identical. The only user-visible changes are two error-code renames: `INVALID_MIDI_HEADER` → `UNRECOGNIZED_FORMAT`, `MIDI_PARSE_FAILED` → `PARSE_FAILED`.
- No new runtime dependencies. Hex literals use a jsep hook, not a plugin package.
- `packages/core` stays zero-DOM (Node- and worker-safe). No `window`, no `document`.
- Conventional-commit messages, no `Co-Authored-By` lines, no AI-assistant branding.
- Commands (run from the repo root): `pnpm --filter @byteql/core test -- --run`, `pnpm --filter @byteql/midi test -- --run`, `pnpm --filter @byteql/web test -- --run`, `pnpm -r check`, e2e: `pnpm --filter @byteql/web test:e2e`.
- Reserved output columns `_src_start`/`_src_end` exist on every table; synthetic keys are monotonic `bigint` starting at `1n` per table.
- The projection expression evaluator returns `null` for missing/incompatible values, never throws at row time. Compile errors are `ProjectionCompileError` with a code and path.

---

### Task 1: Hex literals in the expression language

**Files:**

- Modify: `packages/core/src/projection/expression.ts`
- Test: `packages/core/src/projection/expression.test.ts`

**Interfaces:**

- Consumes: existing `compileExpression(source): CompiledExpression`, `evaluateExpression(expr, context)`, `ProjectionCompileError`.
- Produces: no API change. `0x...` literals evaluate to `number` when ≤ `Number.MAX_SAFE_INTEGER`, else `bigint`. Later tasks (dissect guards) rely on `_.field == 0x0800` working.
- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/projection/expression.test.ts` (match the file's existing describe/it style):

```ts
describe('hex literals', () => {
  it('evaluates a hex literal', () => {
    expect(evaluateExpression(compileExpression('0x0800'), { _: null })).toBe(2048);
  });

  it('evaluates an uppercase-marker hex literal', () => {
    expect(evaluateExpression(compileExpression('0XFF'), { _: null })).toBe(255);
  });

  it('compares a field against a hex literal', () => {
    const expr = compileExpression('_.ether_type == 0x0800');
    expect(evaluateExpression(expr, { _: { ether_type: 2048 } })).toBe(true);
    expect(evaluateExpression(expr, { _: { ether_type: 2049 } })).toBe(false);
  });

  it('promotes hex literals beyond the safe integer range to bigint', () => {
    // 0x20000000000000 === 2 ** 53, one above MAX_SAFE_INTEGER.
    expect(evaluateExpression(compileExpression('0x20000000000000'), { _: null })).toBe(9007199254740992n);
  });

  it('mixes hex literals with arithmetic and bitwise operators', () => {
    expect(evaluateExpression(compileExpression('(0xF0 & 0x9F) >> 4'), { _: null })).toBe(9);
  });

  it('rejects a hex marker with no digits', () => {
    expect(() => compileExpression('0x')).toThrow(ProjectionCompileError);
    expect(() => compileExpression('0x == 1')).toThrow(ProjectionCompileError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @byteql/core test -- --run expression`
Expected: the new `hex literals` tests FAIL (jsep parses `0x0800` as `0` followed by identifier `x0800`, producing `EXPRESSION_PARSE_ERROR` or a wrong value).

- [ ] **Step 3: Implement the jsep hook**

In `packages/core/src/projection/expression.ts`, immediately after the existing `jsep.addBinaryOp('or', 1); jsep.addBinaryOp('and', 2); jsep.addUnaryOp('not');` block, add:

```ts
const hexDigitPattern = /[0-9a-fA-F]/u;

interface JsepParserState {
  readonly expr: string;
  index: number;
  throwError(message: string): never;
}

// jsep does not parse 0x literals; gobble them before its number tokenizer runs.
jsep.hooks.add('gobble-token', function (this: JsepParserState, env: { node?: unknown }) {
  if (this.expr.charAt(this.index) !== '0') return;
  const marker = this.expr.charAt(this.index + 1);
  if (marker !== 'x' && marker !== 'X') return;

  let cursor = this.index + 2;
  while (cursor < this.expr.length && hexDigitPattern.test(this.expr.charAt(cursor))) cursor += 1;
  if (cursor === this.index + 2) this.throwError('Expected hexadecimal digits after 0x');

  const raw = this.expr.slice(this.index, cursor);
  this.index = cursor;
  const wide = BigInt(raw);
  const value = wide <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(wide) : wide;
  env.node = { type: 'Literal', value, raw } as unknown as Literal;
});
```

Then extend the `Literal` case of `validateNode` to accept `bigint` values (hex promotion produces them):

```ts
      if (
        value !== null &&
        typeof value !== 'boolean' &&
        typeof value !== 'number' &&
        typeof value !== 'bigint' &&
        typeof value !== 'string'
      ) {
```

Note: jsep's `Literal` type declares `value` as `string | number | boolean | RegExp | null`, hence the cast when assigning `env.node` and reading `(node as Literal).value` stays as-is (evaluation already handles `bigint` through `numericPair`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @byteql/core test -- --run expression`
Expected: PASS, including all pre-existing expression tests.

- [ ] **Step 5: Run the full workspace check and MIDI regression**

Run: `pnpm -r check && pnpm --filter @byteql/core test -- --run && pnpm --filter @byteql/midi test -- --run`
Expected: PASS everywhere.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/projection/expression.ts packages/core/src/projection/expression.test.ts
git commit -m "feat(core): support hex literals in projection expressions"
```

---

### Task 2: `timestamp_us` and `binary` Arrow types

**Files:**

- Modify: `packages/core/src/projection/spec.ts` (type union + zod enum)
- Modify: `packages/core/src/arrow/build.ts`
- Test: `packages/core/src/arrow/build.test.ts`

**Interfaces:**

- Consumes: `ArrowTypeName`, `projectedTableToArrow(table)`, `tableToIpc`, `ipcToTable`.
- Produces: `ArrowTypeName` gains `'timestamp_us' | 'binary'`. Column values for `timestamp_us` are epoch **microseconds** as `bigint` or safe-integer `number`; for `binary`, `Uint8Array` or `null`. Later tasks (dissect payload columns, pcap) rely on these names in specs.
- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/arrow/build.test.ts`:

```ts
describe('timestamp_us columns', () => {
  it('round-trips microsecond timestamps through arrow IPC', () => {
    const table: ProjectedTable = {
      name: 'packets',
      rowCount: 2,
      types: { ts: 'timestamp_us' },
      columns: { ts: [1_500_500n, null] },
    };
    const arrow = ipcToTable(tableToIpc(projectedTableToArrow(table)));
    expect(String(arrow.schema.fields[0]!.type)).toMatch(/Timestamp/u);
    // apache-arrow JS reads timestamp vectors back as epoch milliseconds.
    expect(arrow.getChildAt(0)!.get(0)).toBe(1500.5);
    expect(arrow.getChildAt(0)!.get(1)).toBeNull();
  });

  it('rejects unsafe numeric microsecond values', () => {
    const table: ProjectedTable = {
      name: 'packets',
      rowCount: 1,
      types: { ts: 'timestamp_us' },
      columns: { ts: [Number.MAX_SAFE_INTEGER + 2] },
    };
    expect(() => projectedTableToArrow(table)).toThrow(/ARROW_UNSAFE_INT64/u);
  });
});

describe('binary columns', () => {
  it('round-trips byte blobs through arrow IPC', () => {
    const table: ProjectedTable = {
      name: 'packets',
      rowCount: 2,
      types: { payload: 'binary' },
      columns: { payload: [Uint8Array.of(1, 2, 3), null] },
    };
    const arrow = ipcToTable(tableToIpc(projectedTableToArrow(table)));
    expect(Array.from(arrow.getChildAt(0)!.get(0) as Uint8Array)).toEqual([1, 2, 3]);
    expect(arrow.getChildAt(0)!.get(1)).toBeNull();
  });
});
```

Add any missing imports (`ipcToTable`, `tableToIpc`, `ProjectedTable`) following the file's existing import style.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @byteql/core test -- --run build`
Expected: FAIL — TypeScript rejects `'timestamp_us'`/`'binary'` as `ArrowTypeName` (vitest surfaces the type error) or `arrowType` has no case for them.

- [ ] **Step 3: Extend the spec type enum**

In `packages/core/src/projection/spec.ts`:

```ts
export type ArrowTypeName =
  | 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'int64' | 'uint64'
  | 'bool' | 'utf8' | 'timestamp_us' | 'binary';
```

and append `'timestamp_us'`, `'binary'` to the `arrowType` zod enum list.

- [ ] **Step 4: Extend the arrow builder**

In `packages/core/src/arrow/build.ts`, add `Binary` and `TimestampMicrosecond` to the `apache-arrow` import, then:

```ts
    case 'timestamp_us':
      return new TimestampMicrosecond();
    case 'binary':
      return new Binary();
```

in `arrowType`, and extend `valuesForType` so `timestamp_us` shares the int64 safety check and converts microseconds to the epoch-millisecond numbers the arrow-js timestamp builder expects:

```ts
const valuesForType = (
  values: readonly unknown[],
  type: ArrowTypeName,
  table: string,
  column: string,
): readonly unknown[] => {
  if (type === 'timestamp_us') {
    return values.map((value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        throw new Error(
          `ARROW_UNSAFE_INT64: ${table}.${column} received the number ${value}, which cannot be represented exactly in a 64-bit integer column`,
        );
      }
      if (typeof value !== 'number' && typeof value !== 'bigint') return value;
      return Number(value) / 1000;
    });
  }
  if (type !== 'int64' && type !== 'uint64') return values;
  return values.map((value) => {
    if (typeof value !== 'number') return value;
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `ARROW_UNSAFE_INT64: ${table}.${column} received the number ${value}, which cannot be represented exactly in a 64-bit integer column`,
      );
    }
    return BigInt(value);
  });
};
```

(Precision note: `Number(micros) / 1000` is exact for epoch microsecond values up to 2^53, i.e. beyond year 2200 — acceptable and documented here.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @byteql/core test -- --run build`
Expected: PASS. If the millisecond read-back assertion fails with a value off by exactly ×1000, the installed arrow-js builder takes raw microseconds — in that case store `BigInt(value)` unconverted in `valuesForType` and assert `get(0)` equals `1500.5` via the IPC round-trip again before proceeding; the authoritative contract is "the physical int64 holds microseconds".

- [ ] **Step 6: Workspace check and regression**

Run: `pnpm -r check && pnpm --filter @byteql/core test -- --run && pnpm --filter @byteql/midi test -- --run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/projection/spec.ts packages/core/src/arrow/build.ts packages/core/src/arrow/build.test.ts
git commit -m "feat(core): add timestamp_us and binary arrow column types"
```

---

### Task 3: `IssueCollector` in core; MIDI adopts it (includes `ParseIssue.stage` widening)

**Files:**

- Modify: `packages/core/src/protocol.ts` (widen `stage`)
- Create: `packages/core/src/issues.ts`
- Create: `packages/core/src/issues.test.ts`
- Modify: `packages/core/src/index.ts` (export)
- Modify: `packages/formats/midi/src/project-midi.ts` (delete `errorsTable`, adopt collector)

**Interfaces:**

- Consumes: `ParseIssue`, `ProjectedTable`.
- Produces (later tasks and packs rely on these exact names):

```ts
// packages/core/src/issues.ts
export interface IssueReport {
  stage: string;
  code: string;
  message: string;
  recoverable: boolean;
  ordinal?: number | null;      // maps to ParseIssue.track
  sourceStart?: number | null;
  sourceEnd?: number | null;
}
export interface IssueCollectorOptions { readonly ordinalColumn?: string } // default 'record'
export class IssueCollector {
  constructor(options?: IssueCollectorOptions);
  report(issue: IssueReport): void;
  issues(): readonly ParseIssue[];
  table(): ProjectedTable;      // name 'errors'; schema below
}
```

`table()` columns, in order: `error_id` (int64), `stage` (utf8), `<ordinalColumn>` (int32), `code` (utf8), `message` (utf8), `recoverable` (bool), `_src_start` (uint64), `_src_end` (uint64). With `ordinalColumn: 'track'` this is byte-identical to MIDI's current hand-built `errorsTable`.

- [ ] **Step 1: Widen `ParseIssue.stage`**

In `packages/core/src/protocol.ts` replace the stage union:

```ts
export interface ParseIssue {
  /** Well-known values: 'framing', 'normalizing', 'parsing', 'projecting', 'dissecting'. */
  stage: string;
  track: number | null;
  code: string;
  message: string;
  recoverable: boolean;
  sourceStart: number | null;
  sourceEnd: number | null;
}
```

Run: `pnpm -r check` — expected PASS (the union only narrowed consumers; `MidiParseProgress.stage` in `project-midi.ts` keeps its own literal union and still assigns).

- [ ] **Step 2: Write the failing collector tests**

Create `packages/core/src/issues.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { IssueCollector } from './issues.js';

describe('IssueCollector', () => {
  it('collects issues and renders the errors table with the default ordinal column', () => {
    const collector = new IssueCollector();
    collector.report({
      stage: 'framing', code: 'BAD_RECORD', message: 'truncated', recoverable: true,
      ordinal: 3, sourceStart: 10, sourceEnd: 20,
    });
    collector.report({ stage: 'parsing', code: 'CHILD_FAILED', message: 'boom', recoverable: true });

    expect(collector.issues()).toEqual([
      { stage: 'framing', track: 3, code: 'BAD_RECORD', message: 'truncated', recoverable: true, sourceStart: 10, sourceEnd: 20 },
      { stage: 'parsing', track: null, code: 'CHILD_FAILED', message: 'boom', recoverable: true, sourceStart: null, sourceEnd: null },
    ]);

    const table = collector.table();
    expect(table.name).toBe('errors');
    expect(table.rowCount).toBe(2);
    expect(Object.keys(table.columns)).toEqual([
      'error_id', 'stage', 'record', 'code', 'message', 'recoverable', '_src_start', '_src_end',
    ]);
    expect(table.columns.error_id).toEqual([1n, 2n]);
    expect(table.columns.record).toEqual([3, null]);
    expect(table.columns._src_start).toEqual([10n, null]);
    expect(table.types).toEqual({
      error_id: 'int64', stage: 'utf8', record: 'int32', code: 'utf8', message: 'utf8',
      recoverable: 'bool', _src_start: 'uint64', _src_end: 'uint64',
    });
  });

  it('names the ordinal column per options', () => {
    const collector = new IssueCollector({ ordinalColumn: 'track' });
    collector.report({ stage: 'parsing', code: 'X', message: 'y', recoverable: false, ordinal: 0 });
    expect(Object.keys(collector.table().columns)).toContain('track');
    expect(collector.table().types.track).toBe('int32');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @byteql/core test -- --run issues`
Expected: FAIL — module `./issues.js` does not exist.

- [ ] **Step 4: Implement `IssueCollector`**

Create `packages/core/src/issues.ts`:

```ts
import type { ParseIssue } from './protocol.js';
import type { ProjectedTable } from './projection/project.js';

export interface IssueReport {
  stage: string;
  code: string;
  message: string;
  recoverable: boolean;
  ordinal?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
}

export interface IssueCollectorOptions {
  readonly ordinalColumn?: string;
}

const toBigIntOrNull = (value: number | null): bigint | null => (value === null ? null : BigInt(value));

export class IssueCollector {
  private readonly ordinalColumn: string;
  private readonly reported: ParseIssue[] = [];

  constructor(options: IssueCollectorOptions = {}) {
    this.ordinalColumn = options.ordinalColumn ?? 'record';
  }

  report(issue: IssueReport): void {
    this.reported.push({
      stage: issue.stage,
      track: issue.ordinal ?? null,
      code: issue.code,
      message: issue.message,
      recoverable: issue.recoverable,
      sourceStart: issue.sourceStart ?? null,
      sourceEnd: issue.sourceEnd ?? null,
    });
  }

  issues(): readonly ParseIssue[] {
    return this.reported;
  }

  table(): ProjectedTable {
    const issues = this.reported;
    return {
      name: 'errors',
      rowCount: issues.length,
      columns: {
        error_id: issues.map((_issue, index) => BigInt(index + 1)),
        stage: issues.map((issue) => issue.stage),
        [this.ordinalColumn]: issues.map((issue) => issue.track),
        code: issues.map((issue) => issue.code),
        message: issues.map((issue) => issue.message),
        recoverable: issues.map((issue) => issue.recoverable),
        _src_start: issues.map((issue) => toBigIntOrNull(issue.sourceStart)),
        _src_end: issues.map((issue) => toBigIntOrNull(issue.sourceEnd)),
      },
      types: {
        error_id: 'int64',
        stage: 'utf8',
        [this.ordinalColumn]: 'int32',
        code: 'utf8',
        message: 'utf8',
        recoverable: 'bool',
        _src_start: 'uint64',
        _src_end: 'uint64',
      },
    };
  }
}
```

Export from `packages/core/src/index.ts`:

```ts
export { IssueCollector } from './issues.js';
export type { IssueCollectorOptions, IssueReport } from './issues.js';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @byteql/core test -- --run issues`
Expected: PASS.

- [ ] **Step 6: Adopt in MIDI**

In `packages/formats/midi/src/project-midi.ts`:

1. Import `IssueCollector` from `@byteql/core`; drop the now-unused `errorsTable` function entirely.
2. Change the `parseIssue` helper to return an `IssueReport` (rename it `issueReport`), keeping the identical stage/code/message/offset logic but mapping `track.index` to `ordinal`:

```ts
const issueReport = (stage: string, track: TrackChunk, error: unknown): IssueReport => {
  if (error instanceof MidiParseError) {
    return {
      stage, ordinal: track.index, code: error.code, message: error.message, recoverable: true,
      sourceStart: error.offset,
      sourceEnd: error.offset < track.bodyEnd ? error.offset + 1 : error.offset,
    };
  }
  const code = stage === 'parsing' ? 'KAITAI_PARSE_FAILED' : 'PROJECTION_FAILED';
  return {
    stage, ordinal: track.index, code,
    message:
      stage === 'parsing'
        ? 'Kaitai could not parse the normalized track prefix.'
        : 'The bundled MIDI projection could not project the parsed track.',
    recoverable: true, sourceStart: track.bodyStart, sourceEnd: track.bodyEnd,
  };
};
```

3. In `parseAndProjectMidi`, replace `const issues: ParseIssue[] = []` with `const collector = new IssueCollector({ ordinalColumn: 'track' })`; every `issues.push(parseIssue(stage, track, error))` becomes `collector.report(issueReport(stage, track, error))`.
4. Final assembly: `collector.table()` is already a fresh `ProjectedTable`, so use it directly: `const tables = [...baseTables, collector.table()].map(toTransfer);` and `issues: collector.issues()` in the returned `ParseResult`.

- [ ] **Step 7: Regression**

Run: `pnpm -r check && pnpm --filter @byteql/midi test -- --run && pnpm --filter @byteql/web test -- --run`
Expected: PASS — the errors table (with `track` ordinal column) and `issues` list are unchanged.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/protocol.ts packages/core/src/issues.ts packages/core/src/issues.test.ts packages/core/src/index.ts packages/formats/midi/src/project-midi.ts
git commit -m "feat(core): lift the per-record errors table into IssueCollector"
```

---

### Task 4: `ProjectionSession`; MIDI adopts it

**Files:**

- Create: `packages/core/src/projection/session.ts`
- Create: `packages/core/src/projection/session.test.ts`
- Modify: `packages/core/src/index.ts` (export)
- Modify: `packages/formats/midi/src/project-midi.ts` (delete `mutableCopy`, `tableKey`, `appendProjected`; adopt session)

**Interfaces:**

- Consumes: `CompiledProjection`, `projectTree`, `ProvenanceResolver`, `projectedTableToArrow`.
- Produces (Task 6 swaps the internals; this API is final):

```ts
// packages/core/src/projection/session.ts
import type { Table } from 'apache-arrow';
export interface ProjectCallOptions { readonly tables?: readonly string[] } // subset of table names to emit
export interface FinishedTable { readonly name: string; readonly arrow: Table; readonly rowCount: number }
export interface ProjectionSession {
  project(root: unknown, resolver: ProvenanceResolver, options?: ProjectCallOptions): void;
  finish(): FinishedTable[];
}
export const createProjectionSession = (compiled: CompiledProjection): ProjectionSession;
```

Semantics: keys are monotonic per table **across** `project()` calls; a `project()` call that throws appends nothing (atomic per call); `options.tables` limits which tables emit rows in that call (excluded tables are fully inert for the call). `finish()` returns tables in spec order.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/projection/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import { createProjectionSession } from './session.js';

const spec = parseProjectionSpec(`
version: '0.1'
format: fixture
tables:
  - name: items
    rows: $.items[*]
    key: item_id
    columns:
      value: { expr: '_.value', type: int32 }
  - name: meta
    rows: $.meta
    key: meta_id
    columns:
      label: { expr: '_.label', type: utf8 }
`);
const compiled = compileProjection(spec);
const resolver = { resolve: () => ({ start: 0, end: 1 }) };

describe('createProjectionSession', () => {
  it('continues key numbering across project() calls', () => {
    const session = createProjectionSession(compiled);
    session.project({ items: [{ value: 10 }, { value: 20 }], meta: { label: 'a' } }, resolver);
    session.project({ items: [{ value: 30 }] }, resolver);
    const finished = session.finish();
    const items = finished.find((table) => table.name === 'items')!;
    expect(items.rowCount).toBe(3);
    expect(items.arrow.getChild('item_id')!.toArray()).toEqual(new BigInt64Array([1n, 2n, 3n]));
    expect(items.arrow.getChild('value')!.toArray()).toEqual(new Int32Array([10, 20, 30]));
  });

  it('limits emission to the requested table subset', () => {
    const session = createProjectionSession(compiled);
    session.project({ items: [{ value: 1 }], meta: { label: 'a' } }, resolver);
    session.project({ items: [{ value: 2 }], meta: { label: 'DUPLICATE' } }, resolver, { tables: ['items'] });
    const finished = session.finish();
    expect(finished.find((table) => table.name === 'meta')!.rowCount).toBe(1);
    expect(finished.find((table) => table.name === 'items')!.rowCount).toBe(2);
  });

  it('returns empty tables when nothing was projected', () => {
    const finished = createProjectionSession(compiled).finish();
    expect(finished.map((table) => table.name)).toEqual(['items', 'meta']);
    expect(finished.every((table) => table.rowCount === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core test -- --run session`
Expected: FAIL — `./session.js` does not exist.

- [ ] **Step 3: Implement the session (v1: delegates to `projectTree`, appends)**

Create `packages/core/src/projection/session.ts`:

```ts
import type { Table } from 'apache-arrow';
import { projectedTableToArrow } from '../arrow/build.js';
import type { ArrowTypeName } from './spec.js';
import { projectTree, type CompiledProjection, type ProjectedTable, type ProvenanceResolver } from './project.js';

export interface ProjectCallOptions {
  readonly tables?: readonly string[];
}

export interface FinishedTable {
  readonly name: string;
  readonly arrow: Table;
  readonly rowCount: number;
}

export interface ProjectionSession {
  project(root: unknown, resolver: ProvenanceResolver, options?: ProjectCallOptions): void;
  finish(): FinishedTable[];
}

interface Accumulator {
  readonly key: string;
  columns: Record<string, unknown[]> | null; // null until first append fixes the schema
  types: Record<string, ArrowTypeName> | null;
  rowCount: number;
  nextKey: bigint;
}

export const createProjectionSession = (compiled: CompiledProjection): ProjectionSession => {
  const accumulators = new Map<string, Accumulator>(
    compiled.tables.map((table) => [
      table.name,
      { key: table.key, columns: null, types: null, rowCount: 0, nextKey: 1n },
    ]),
  );

  const append = (target: Accumulator, source: ProjectedTable): void => {
    if (!target.columns || !target.types) {
      target.columns = Object.fromEntries(Object.keys(source.columns).map((name) => [name, []]));
      target.types = { ...source.types };
    }
    for (const [name, values] of Object.entries(source.columns)) {
      const output = target.columns[name];
      if (!output) throw new Error(`PROJECTION_SCHEMA_MISMATCH: ${source.name}.${name}`);
      if (name === target.key) {
        for (let index = 0; index < values.length; index += 1) {
          output.push(target.nextKey);
          target.nextKey += 1n;
        }
      } else {
        output.push(...values);
      }
    }
    target.rowCount += source.rowCount;
  };

  return {
    project(root, resolver, options) {
      const subset = options?.tables === undefined ? null : new Set(options.tables);
      const projected = projectTree(compiled, root, resolver);
      for (const table of projected) {
        if (subset && !subset.has(table.name)) continue;
        append(accumulators.get(table.name)!, table);
      }
    },
    finish() {
      return compiled.tables.map((table) => {
        const accumulator = accumulators.get(table.name)!;
        const projected: ProjectedTable = accumulator.columns
          ? { name: table.name, columns: accumulator.columns, types: accumulator.types!, rowCount: accumulator.rowCount }
          : emptyTable(compiled, table.name);
        return { name: table.name, arrow: projectedTableToArrow(projected), rowCount: projected.rowCount };
      });
    },
  };
};

const emptyTable = (compiled: CompiledProjection, name: string): ProjectedTable =>
  projectTree(compiled, {}, { resolve: () => ({ start: 0, end: 0 }) }).find((table) => table.name === name)!;
```

Export from `packages/core/src/index.ts`:

```ts
export { createProjectionSession } from './projection/session.js';
export type { FinishedTable, ProjectCallOptions, ProjectionSession } from './projection/session.js';
```

(Note: `emptyTable` projects an empty root — every anchor yields zero matches — to obtain the exact empty column/type layout `projectTree` produces. Task 6 replaces these internals with per-table batch builders; the tests in this task are the contract.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @byteql/core test -- --run session`
Expected: PASS.

- [ ] **Step 5: Adopt in MIDI**

In `packages/formats/midi/src/project-midi.ts`:

1. Delete `mutableCopy`, `tableKey`, `appendProjected`, and the `MutableProjectedTable` interface. Remove the direct `projectTree` import; import `createProjectionSession` and type `FinishedTable` from `@byteql/core`.
2. Replace the projecting section:

```ts
  reportProgress(onProgress, 'projecting', 0, total);
  const session = createProjectionSession(compiledProjection);
  session.project(
    { hdr: headerNode(container.header), tracks: [] },
    { resolve: () => container.header.range },
  );

  for (const [index] of normalizedTracks.entries()) {
    throwIfAborted(signal);
    const parsed = parsedTracks[index];
    if (parsed) {
      const { track, normalized, safeEvents } = parsed;
      const tracks: unknown[] = new Array(track.index + 1);
      tracks[track.index] = { events: { event: safeEvents } };
      const root = { hdr: headerNode(container.header), tracks };
      try {
        session.project(
          root,
          {
            resolve(tableName, anchor) {
              if (tableName === 'header') return container.header.range;
              const eventIndex = anchor.indexes[1];
              const source = eventIndex === undefined ? undefined : normalized.events[eventIndex];
              if (!source) throw new Error(`PROVENANCE_EVENT_MISSING: ${track.index}:${eventIndex}`);
              return { start: source.sourceStart, end: source.sourceEnd };
            },
          },
          { tables: ['events', 'tempo'] },
        );
      } catch (error) {
        collector.report(issueReport('projecting', track, error));
      }
    }
    await yieldToWorker();
    throwIfAborted(signal);
    reportProgress(onProgress, 'projecting', index + 1, total);
  }
```

3. Rework `toTransfer` to take a `FinishedTable` (the arrow table already exists):

```ts
const toTransfer = (finished: FinishedTable): TableTransfer => {
  const nullableColumns = nullability[finished.name] ?? new Set<string>();
  return {
    name: finished.name,
    ipc: tableToIpc(finished.arrow),
    rowCount: finished.rowCount,
    columns: finished.arrow.schema.fields.map((field) => ({
      name: field.name,
      type: field.type.toString(),
      nullable: nullableColumns.has(field.name),
    })),
  };
};
```

4. Final assembly:

```ts
  const errors = collector.table();
  const tables = [
    ...session.finish(),
    { name: errors.name, arrow: projectedTableToArrow(errors), rowCount: errors.rowCount },
  ].map(toTransfer);
```

(`projectedTableToArrow` stays imported for the errors table.)

- [ ] **Step 6: Regression**

Run: `pnpm -r check && pnpm --filter @byteql/midi test -- --run && pnpm --filter @byteql/web test -- --run`
Expected: PASS — table order (`header`, `events`, `tempo`, `errors`), keys, and rows identical.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/projection/session.ts packages/core/src/projection/session.test.ts packages/core/src/index.ts packages/formats/midi/src/project-midi.ts
git commit -m "feat(core): add ProjectionSession for multi-root projection"
```

---

### Task 5: Incremental Arrow batch builder with flush threshold

**Files:**

- Create: `packages/core/src/arrow/batch.ts`
- Create: `packages/core/src/arrow/batch.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces:**

- Consumes: `arrowType`/`valuesForType` internals of `build.ts` — export a helper `columnVector(values, type, table, column): Vector` from `build.ts` (extracted from `projectedTableToArrow`'s loop body) so both files share conversion.
- Produces (Task 6's session internals consume this):

```ts
// packages/core/src/arrow/batch.ts
export interface BatchBuilderOptions { readonly flushRowThreshold?: number } // default 65_536
export class TableBatchBuilder {
  constructor(name: string, types: Readonly<Record<string, ArrowTypeName>>, options?: BatchBuilderOptions);
  appendRow(values: Readonly<Record<string, unknown>>): void; // missing keys become null
  readonly rowCount: number;
  finish(): Table; // all sealed batches + the tail; multi-batch when threshold crossed
}
```

- [ ] **Step 1: Extract `columnVector` in `build.ts`**

In `packages/core/src/arrow/build.ts` add and export:

```ts
export const columnVector = (
  values: readonly unknown[],
  type: ArrowTypeName,
  table: string,
  column: string,
): Vector => vectorFromArray(valuesForType(values, type, table, column), arrowType(type));
```

and use it inside `projectedTableToArrow`. Run: `pnpm --filter @byteql/core test -- --run build` — expected PASS (pure refactor).

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/arrow/batch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TableBatchBuilder } from './batch.js';
import { ipcToTable, tableToIpc } from './build.js';

const types = { item_id: 'int64', value: 'int32' } as const;

describe('TableBatchBuilder', () => {
  it('seals a record batch at the flush threshold', () => {
    const builder = new TableBatchBuilder('items', types, { flushRowThreshold: 2 });
    for (let index = 0; index < 5; index += 1) builder.appendRow({ item_id: BigInt(index + 1), value: index });
    const table = builder.finish();
    expect(builder.rowCount).toBe(5);
    expect(table.numRows).toBe(5);
    expect(table.batches.length).toBe(3); // 2 + 2 + 1
    const roundTrip = ipcToTable(tableToIpc(table));
    expect(roundTrip.numRows).toBe(5);
    expect(roundTrip.getChild('value')!.toArray()).toEqual(new Int32Array([0, 1, 2, 3, 4]));
  });

  it('fills missing row keys with null', () => {
    const builder = new TableBatchBuilder('items', { value: 'int32' });
    builder.appendRow({});
    expect(builder.finish().getChild('value')!.get(0)).toBeNull();
  });

  it('produces an empty single-schema table when no rows were appended', () => {
    const table = new TableBatchBuilder('items', types).finish();
    expect(table.numRows).toBe(0);
    expect(table.schema.fields.map((field) => field.name)).toEqual(['item_id', 'value']);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @byteql/core test -- --run batch`
Expected: FAIL — `./batch.js` does not exist.

- [ ] **Step 4: Implement**

Create `packages/core/src/arrow/batch.ts`:

```ts
import { Table } from 'apache-arrow';
import type { Vector } from 'apache-arrow';
import type { ArrowTypeName } from '../projection/spec.js';
import { columnVector } from './build.js';

export interface BatchBuilderOptions {
  readonly flushRowThreshold?: number;
}

const DEFAULT_FLUSH_ROW_THRESHOLD = 65_536;

export class TableBatchBuilder {
  readonly #name: string;
  readonly #types: Readonly<Record<string, ArrowTypeName>>;
  readonly #columnNames: readonly string[];
  readonly #threshold: number;
  #pending: Record<string, unknown[]>;
  #pendingRows = 0;
  #chunks: Table[] = [];
  #rowCount = 0;

  constructor(name: string, types: Readonly<Record<string, ArrowTypeName>>, options: BatchBuilderOptions = {}) {
    this.#name = name;
    this.#types = types;
    this.#columnNames = Object.keys(types);
    this.#threshold = options.flushRowThreshold ?? DEFAULT_FLUSH_ROW_THRESHOLD;
    this.#pending = this.#emptyPending();
  }

  get rowCount(): number {
    return this.#rowCount + this.#pendingRows;
  }

  appendRow(values: Readonly<Record<string, unknown>>): void {
    for (const column of this.#columnNames) {
      this.#pending[column]!.push(column in values ? (values[column] ?? null) : null);
    }
    this.#pendingRows += 1;
    if (this.#pendingRows >= this.#threshold) this.#seal();
  }

  finish(): Table {
    if (this.#pendingRows > 0 || this.#chunks.length === 0) this.#seal();
    const batches = this.#chunks.flatMap((chunk) => chunk.batches);
    // An all-empty builder may yield zero record batches; fall back to the empty
    // chunk Table so the schema survives.
    return batches.length > 0 ? new Table(batches) : this.#chunks[0]!;
  }

  #emptyPending(): Record<string, unknown[]> {
    return Object.fromEntries(this.#columnNames.map((column) => [column, []]));
  }

  #seal(): void {
    const vectors: Record<string, Vector> = {};
    for (const column of this.#columnNames) {
      vectors[column] = columnVector(this.#pending[column]!, this.#types[column]!, this.#name, column);
    }
    this.#chunks.push(new Table(vectors));
    this.#rowCount += this.#pendingRows;
    this.#pending = this.#emptyPending();
    this.#pendingRows = 0;
  }
}
```

Export from `packages/core/src/index.ts`:

```ts
export { TableBatchBuilder } from './arrow/batch.js';
export type { BatchBuilderOptions } from './arrow/batch.js';
```

- [ ] **Step 5: Run to verify pass, then workspace check**

Run: `pnpm --filter @byteql/core test -- --run && pnpm -r check`
Expected: PASS. (An empty seal produces a zero-row batch carrying the schema — that is what the empty-table test asserts.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/arrow/batch.ts packages/core/src/arrow/batch.test.ts packages/core/src/arrow/build.ts packages/core/src/index.ts
git commit -m "feat(core): add incremental arrow batch builder with flush threshold"
```

---

### Task 6: Single-pass engine

**Files:**

- Create: `packages/core/src/projection/walk.ts`
- Create: `packages/core/src/projection/walk.test.ts`
- Modify: `packages/core/src/projection/project.ts` (rewrite `projectTable`/`projectTree` onto the walker + row sinks)
- Modify: `packages/core/src/projection/session.ts` (persistent runtimes + `TableBatchBuilder` sinks)

**Interfaces:**

- Consumes: `CompiledAnchor`, `AnchorMatch`, `TableBatchBuilder`.
- Produces:
  - `walk.ts`: `buildMatcher(anchors: readonly CompiledAnchor[]): MatcherNode` and `walkMatcher(root: unknown, matcher: MatcherNode, visit: (anchorIndex: number, match: AnchorMatch) => void): void`. Visits in depth-first document order; `match.ordinal` counts per anchor; `match.parents`/`match.indexes` are built exactly as `traverseAnchor` builds them.
  - `project.ts`: public `projectTree(compiled, root, resolver): ProjectedTable[]` — signature and output unchanged, now one walk for all tables. New internal export `projectInto(compiled, root, resolver, sink: RowSink, runtimes: Map<string, TableRuntime>, subset: ReadonlySet<string> | null): void` with `interface RowSink { push(table: string, row: Record<string, unknown>): void }` and `interface TableRuntime { nextKey: bigint; stateValues: Record<string, unknown>; scopeIndexes: Map<string, readonly number[]> }`, plus `createRuntimes(compiled): Map<string, TableRuntime>`.
  - `session.ts`: same public API as Task 4; internals become `TableBatchBuilder` per table + persistent `TableRuntime` map (state and keys now persist across `project()` calls — for MIDI this is observationally identical because state scopes reset on new track indexes).
- [ ] **Step 1: Write the failing walker tests**

Create `packages/core/src/projection/walk.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compileAnchor } from './anchors.js';
import { buildMatcher, walkMatcher } from './walk.js';

const collect = (root: unknown, sources: string[]): Array<{ anchor: number; node: unknown; indexes: readonly number[]; ordinal: number }> => {
  const matcher = buildMatcher(sources.map((source) => compileAnchor(source)));
  const out: Array<{ anchor: number; node: unknown; indexes: readonly number[]; ordinal: number }> = [];
  walkMatcher(root, matcher, (anchor, match) => out.push({ anchor, node: match.node, indexes: match.indexes, ordinal: match.ordinal }));
  return out;
};

describe('walkMatcher', () => {
  const root = { hdr: { division: 96 }, tracks: [{ events: { event: [{ id: 'a' }, { id: 'b' }] } }, { events: { event: [{ id: 'c' }] } }] };

  it('fires two anchors sharing a prefix in one walk with per-anchor ordinals', () => {
    const matches = collect(root, ['$.hdr', '$.tracks[*].events.event[*]']);
    expect(matches).toEqual([
      { anchor: 0, node: { division: 96 }, indexes: [], ordinal: 0 },
      { anchor: 1, node: { id: 'a' }, indexes: [0, 0], ordinal: 0 },
      { anchor: 1, node: { id: 'b' }, indexes: [0, 1], ordinal: 1 },
      { anchor: 1, node: { id: 'c' }, indexes: [1, 0], ordinal: 2 },
    ]);
  });

  it('fires anchors that share a terminal node in registration order', () => {
    const matches = collect(root, ['$.tracks[*].events.event[*]', '$.tracks[*].events.event[*]']);
    expect(matches.map((match) => match.anchor)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('supports explicit index steps and missing fields', () => {
    expect(collect(root, ['$.tracks[1].events.event[*]'])).toHaveLength(1);
    expect(collect(root, ['$.absent[*]'])).toHaveLength(0);
  });

  it('builds parents like traverseAnchor does', () => {
    const matcher = buildMatcher([compileAnchor('$.tracks[*].events.event[*]')]);
    let parents: readonly unknown[] = [];
    walkMatcher(root, matcher, (_anchor, match) => { if (match.ordinal === 0) parents = match.parents; });
    expect(parents).toHaveLength(5); // root, tracks[], track0, events, event[]
    expect(parents[0]).toBe(root);
    expect(parents[4]).toBe(root.tracks[0]!.events.event);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core test -- --run walk`
Expected: FAIL — `./walk.js` does not exist.

- [ ] **Step 3: Implement the walker**

Create `packages/core/src/projection/walk.ts`:

```ts
import type { AnchorMatch, CompiledAnchor } from './anchors.js';

export interface MatcherNode {
  readonly fields: Map<string, MatcherNode>;
  readonly indexed: Map<number, MatcherNode>;
  wildcard: MatcherNode | null;
  readonly terminals: number[];
}

const emptyNode = (): MatcherNode => ({ fields: new Map(), indexed: new Map(), wildcard: null, terminals: [] });

export const buildMatcher = (anchors: readonly CompiledAnchor[]): MatcherNode => {
  const root = emptyNode();
  anchors.forEach((anchor, anchorIndex) => {
    let node = root;
    for (const step of anchor.steps) {
      if (step.kind === 'field') {
        let next = node.fields.get(step.name);
        if (!next) { next = emptyNode(); node.fields.set(step.name, next); }
        node = next;
      } else if (step.kind === 'index') {
        let next = node.indexed.get(step.index);
        if (!next) { next = emptyNode(); node.indexed.set(step.index, next); }
        node = next;
      } else {
        if (!node.wildcard) node.wildcard = emptyNode();
        node = node.wildcard;
      }
    }
    node.terminals.push(anchorIndex);
  });
  return root;
};

const missingProperty = Symbol('missing property');

const readOwnDataProperty = (value: unknown, key: string): unknown | typeof missingProperty => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return missingProperty;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : missingProperty;
};

export type MatchVisitor = (anchorIndex: number, match: AnchorMatch) => void;

export const walkMatcher = (root: unknown, matcher: MatcherNode, visit: MatchVisitor): void => {
  const ordinals = new Map<number, number>();

  const recurse = (node: unknown, at: MatcherNode, parents: readonly unknown[], indexes: readonly number[]): void => {
    for (const anchorIndex of at.terminals) {
      const ordinal = ordinals.get(anchorIndex) ?? 0;
      ordinals.set(anchorIndex, ordinal + 1);
      visit(anchorIndex, { node, parents, indexes, ordinal });
    }

    for (const [name, child] of at.fields) {
      const value = readOwnDataProperty(node, name);
      if (value !== missingProperty) recurse(value, child, [...parents, node], indexes);
    }

    if ((at.indexed.size > 0 || at.wildcard) && Array.isArray(node)) {
      const length = readOwnDataProperty(node, 'length');
      if (typeof length === 'number' && Number.isSafeInteger(length) && length >= 0) {
        for (const [index, child] of at.indexed) {
          if (index >= length) continue;
          const value = readOwnDataProperty(node, String(index));
          if (value !== missingProperty) recurse(value, child, [...parents, node], indexes);
        }
        if (at.wildcard) {
          for (let index = 0; index < length; index += 1) {
            const value = readOwnDataProperty(node, String(index));
            if (value === missingProperty) continue;
            recurse(value, at.wildcard, [...parents, node], [...indexes, index]);
          }
        }
      }
    }
  };

  recurse(root, matcher, [], []);
};
```

Run: `pnpm --filter @byteql/core test -- --run walk` — expected PASS.

- [ ] **Step 4: Rewrite `project.ts` onto the walker**

Replace `projectTable`/`projectTree` in `packages/core/src/projection/project.ts` (keep everything through `compileProjection`, `sameIndexes`, and `expressionContext` unchanged) with:

```ts
export interface RowSink {
  push(table: string, row: Record<string, unknown>): void;
}

export interface TableRuntime {
  nextKey: bigint;
  readonly stateValues: Record<string, unknown>;
  readonly scopeIndexes: Map<string, readonly number[]>;
}

export const createRuntimes = (compiled: CompiledProjection): Map<string, TableRuntime> =>
  new Map(
    compiled.tables.map((table) => [
      table.name,
      { nextKey: 1n, stateValues: Object.create(null) as Record<string, unknown>, scopeIndexes: new Map() },
    ]),
  );

const emitRow = (
  table: CompiledProjectionTable,
  runtime: TableRuntime,
  match: AnchorMatch,
  root: unknown,
  provenance: ProvenanceResolver,
  sink: RowSink,
): void => {
  for (const register of table.state) {
    const currentScope = match.indexes.slice(0, register.scope.wildcardCount);
    const previousScope = runtime.scopeIndexes.get(register.name);
    if (!previousScope || !sameIndexes(previousScope, currentScope)) {
      runtime.stateValues[register.name] = register.init;
      runtime.scopeIndexes.set(register.name, currentScope);
    }
  }
  for (const register of table.state) {
    runtime.stateValues[register.name] = evaluateExpression(
      register.update,
      expressionContext(match, root, runtime.stateValues),
    );
  }

  const context = expressionContext(match, root, runtime.stateValues);
  if (table.where && !evaluateExpression(table.where, context)) return;

  const row: Record<string, unknown> = { [table.key]: runtime.nextKey };
  runtime.nextKey += 1n;
  for (const column of table.columns) {
    if (column.name === table.key || column.name === '_src_start' || column.name === '_src_end') continue;
    row[column.name] =
      column.when && !evaluateExpression(column.when, context) ? null : (evaluateExpression(column.expr, context) ?? null);
  }
  const range = provenance.resolve(table.name, match);
  row._src_start = BigInt(range.start);
  row._src_end = BigInt(range.end);
  sink.push(table.name, row);
};

export const tableOutputTypes = (table: CompiledProjectionTable): Record<string, ArrowTypeName> => {
  const types: Record<string, ArrowTypeName> = { [table.key]: 'int64' };
  for (const column of table.columns) {
    if (column.name === table.key || column.name === '_src_start' || column.name === '_src_end') continue;
    types[column.name] = column.type;
  }
  types._src_start = 'uint64';
  types._src_end = 'uint64';
  return types;
};

export const projectInto = (
  compiled: CompiledProjection,
  root: unknown,
  provenance: ProvenanceResolver,
  sink: RowSink,
  runtimes: Map<string, TableRuntime>,
  subset: ReadonlySet<string> | null,
): void => {
  const active = compiled.tables.filter((table) => !subset || subset.has(table.name));
  const matcher = buildMatcher(active.map((table) => table.rows));
  walkMatcher(root, matcher, (anchorIndex, match) => {
    const table = active[anchorIndex]!;
    emitRow(table, runtimes.get(table.name)!, match, root, provenance, sink);
  });
};

export const projectTree = (
  compiled: CompiledProjection,
  root: unknown,
  provenance: ProvenanceResolver,
): ProjectedTable[] => {
  const columnsByTable = new Map<string, Record<string, unknown[]>>(
    compiled.tables.map((table) => [
      table.name,
      Object.fromEntries(Object.keys(tableOutputTypes(table)).map((name) => [name, []])),
    ]),
  );
  const sink: RowSink = {
    push(tableName, row) {
      const columns = columnsByTable.get(tableName)!;
      for (const name of Object.keys(columns)) columns[name]!.push(row[name] ?? null);
    },
  };
  projectInto(compiled, root, provenance, sink, createRuntimes(compiled), null);
  return compiled.tables.map((table) => {
    const columns = columnsByTable.get(table.name)!;
    const types = tableOutputTypes(table);
    return { name: table.name, columns, types, rowCount: columns[table.key]!.length };
  });
};
```

Add the needed imports (`buildMatcher`, `walkMatcher` from `./walk.js`).

Behavioral invariants to preserve exactly (all covered by existing tests): column order in `ProjectedTable.columns` is key → spec columns → `_src_start` → `_src_end` (the `tableOutputTypes` insertion order guarantees this); `where`-filtered rows do not consume keys; state updates run before `where`.

- [ ] **Step 5: Run the full core and MIDI suites**

Run: `pnpm --filter @byteql/core test -- --run && pnpm --filter @byteql/midi test -- --run`
Expected: PASS — `project.test.ts` and the MIDI conformance fixtures are the old-vs-new oracle.

- [ ] **Step 6: Swap session internals onto builders**

Rewrite `createProjectionSession` in `packages/core/src/projection/session.ts` (public API unchanged, delete the v1 accumulator code):

```ts
import type { Table } from 'apache-arrow';
import { TableBatchBuilder } from '../arrow/batch.js';
import {
  createRuntimes,
  projectInto,
  tableOutputTypes,
  type CompiledProjection,
  type ProvenanceResolver,
  type RowSink,
} from './project.js';

export interface ProjectionSessionOptions {
  readonly flushRowThreshold?: number;
}

export const createProjectionSession = (
  compiled: CompiledProjection,
  options: ProjectionSessionOptions = {},
): ProjectionSession => {
  const builders = new Map<string, TableBatchBuilder>(
    compiled.tables.map((table) => [
      table.name,
      new TableBatchBuilder(table.name, tableOutputTypes(table), options),
    ]),
  );
  const runtimes = createRuntimes(compiled);
  const sink: RowSink = { push: (table, row) => builders.get(table)!.appendRow(row) };

  return {
    project(root, resolver, callOptions) {
      const subset = callOptions?.tables === undefined ? null : new Set(callOptions.tables);
      projectInto(compiled, root, resolver, sink, runtimes, subset);
    },
    finish() {
      return compiled.tables.map((table) => {
        const builder = builders.get(table.name)!;
        return { name: table.name, arrow: builder.finish(), rowCount: builder.rowCount };
      });
    },
  };
};
```

Export `ProjectionSessionOptions` from `packages/core/src/index.ts`. Note the atomicity semantics change subtly: a throw mid-walk can leave earlier rows appended. MIDI's per-track try/catch relied on v1 atomicity — but with single-pass emission a projecting error can only come from the resolver throwing (`PROVENANCE_EVENT_MISSING`), leaving a partial track. Preserve safety by having MIDI's resolver error remain an internal invariant (it indicates a bug, not malformed input); the recovery-path tests assert malformed tracks fail earlier (normalizing/parsing stages), so behavior is unchanged for all fixtures.

Add a flush test to `packages/core/src/projection/session.test.ts`:

```ts
  it('flushes incremental batches at the configured threshold', () => {
    const session = createProjectionSession(compiled, { flushRowThreshold: 2 });
    session.project({ items: [{ value: 1 }, { value: 2 }, { value: 3 }] }, resolver);
    const items = session.finish().find((table) => table.name === 'items')!;
    expect(items.arrow.batches.length).toBe(2);
    expect(items.rowCount).toBe(3);
  });
```

- [ ] **Step 7: Run everything**

Run: `pnpm -r check && pnpm --filter @byteql/core test -- --run && pnpm --filter @byteql/midi test -- --run && pnpm --filter @byteql/web test -- --run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/projection/walk.ts packages/core/src/projection/walk.test.ts packages/core/src/projection/project.ts packages/core/src/projection/session.ts packages/core/src/projection/session.test.ts packages/core/src/index.ts
git commit -m "refactor(core): project all tables in a single tree walk with batch flushing"
```

---

### Task 7: Spec v0.2 — `parent_key` and `dissect` schema + compile validation

**Files:**

- Modify: `packages/core/src/projection/spec.ts`
- Modify: `packages/core/src/projection/expression.ts` (new error codes only)
- Create: `packages/core/src/projection/parsers.ts`
- Modify: `packages/core/src/projection/project.ts` (`compileProjection` gains registry + dissect compilation)
- Create: `packages/core/src/projection/spec-v02.test.ts`
- Modify: `packages/core/src/index.ts` (exports)

**Interfaces:**

- Produces (Task 8 executes against these):

```ts
// parsers.ts
export interface ParsedRecord {
  root: unknown;
  resolve?: (table: string, match: AnchorMatch) => SourceRange; // payload-relative offsets
}
export type RecordParser = (bytes: Uint8Array) => ParsedRecord;
export type ParserRegistry = ReadonlyMap<string, RecordParser>;

// spec.ts additions
export interface ParentKeySpec { table: string; column: string }
export interface DissectChainLinkSpec { when: string; parser: string; table?: string }
export interface DissectSpec { from: string; payload: string; chain: DissectChainLinkSpec[] }
// TableSpec gains parent_key?: ParentKeySpec; ProjectionSpec gains version: '0.1' | '0.2' and dissect?: DissectSpec[]

// project.ts additions
export const compileProjection: (spec: ProjectionSpec, registry?: ParserRegistry) => CompiledProjection;
// CompiledProjection gains:
//   rootTables: readonly CompiledProjectionTable[]           // tables walked from the file root
//   dissectByFrom: ReadonlyMap<string, readonly CompiledDissect[]>
// CompiledProjectionTable gains: parentKey: { table: string; column: string } | null
export interface CompiledChainLink {
  readonly when: CompiledExpression;
  readonly parserId: string;
  readonly parser: RecordParser;
  readonly table: CompiledProjectionTable | null;
}
export interface CompiledDissect {
  readonly from: string;
  readonly payload: CompiledExpression;
  readonly chain: readonly CompiledChainLink[];
}
```

New `ProjectionCompileErrorCode` members: `'PROJECTION_VERSION_REQUIRED' | 'PROJECTION_PARENT_KEY_INVALID' | 'PROJECTION_DISSECT_INVALID' | 'PROJECTION_PARSER_UNKNOWN' | 'PROJECTION_DISSECT_CYCLE'`.

Validation rules (all at load, each with a test):

1. `dissect` or any `parent_key` under `version: '0.1'` → `PROJECTION_VERSION_REQUIRED`.
2. `parent_key.table` must name a declared table; `parent_key.column` must equal that table's `key`; the child's own `key` and column names must not collide with `parent_key.column` → `PROJECTION_PARENT_KEY_INVALID`.
3. Every `chain[].table` must name a declared table that has `parent_key`; every table with `parent_key` must be referenced by at least one chain link (they are "dissect-only" and excluded from `rootTables`). Multiple links may feed the same table — the PRD's pcap example fills `ip` from both the ipv4 and ipv6 links → `PROJECTION_DISSECT_INVALID`.
4. `dissect[].from` must be a declared table name or a parser id that appears as some `chain[].parser` → `PROJECTION_DISSECT_INVALID`.
5. The graph over nodes (table names ∪ parser ids) with edges `from → chain[].parser` must be acyclic → `PROJECTION_DISSECT_CYCLE`.
6. Every `chain[].parser` must exist in the supplied registry → `PROJECTION_PARSER_UNKNOWN` (a spec with `dissect` compiled without a registry fails the same way).
7. For each chain link with a `table`, that table's `parent_key.table` must be reachable walking `from`-ancestors of the dissect entry (so the key value will exist at runtime) → `PROJECTION_PARENT_KEY_INVALID`.
8. `payload` and `when` compile as ordinary expressions with an empty declared-state set (no state references).

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/projection/spec-v02.test.ts`. Use this shared fixture and cover every numbered rule above plus the happy path:

```ts
import { describe, expect, it } from 'vitest';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import type { ParserRegistry } from './parsers.js';

const registry: ParserRegistry = new Map([
  ['inner_parser', () => ({ root: {} })],
  ['deep_parser', () => ({ root: {} })],
]);

const baseYaml = `
version: '0.2'
format: envelope
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      kind: { expr: '_.kind', type: uint8 }
  - name: inner
    rows: $.items[*]
    key: inner_id
    parent_key: { table: records, column: record_id }
    columns:
      label: { expr: '_.label', type: utf8 }
dissect:
  - from: records
    payload: _.body
    chain:
      - { when: '_.kind == 0x01', parser: inner_parser, table: inner }
`;

describe('spec v0.2', () => {
  it('parses and compiles a valid dissect spec', () => {
    const compiled = compileProjection(parseProjectionSpec(baseYaml), registry);
    expect(compiled.rootTables.map((table) => table.name)).toEqual(['records']);
    expect(compiled.dissectByFrom.get('records')).toHaveLength(1);
    expect(compiled.tables.find((table) => table.name === 'inner')!.parentKey).toEqual({
      table: 'records',
      column: 'record_id',
    });
  });

  it('rejects dissect under version 0.1', () => {
    const yaml = baseYaml.replace("version: '0.2'", "version: '0.1'");
    expect(() => parseProjectionSpec(yaml)).toThrowError(/PROJECTION_VERSION_REQUIRED/u);
  });

  it('rejects a parent_key column that is not the parent key', () => {
    const yaml = baseYaml.replace('column: record_id', 'column: wrong_id');
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(/PROJECTION_PARENT_KEY_INVALID/u);
  });

  it('rejects a chain table without parent_key', () => {
    const yaml = baseYaml.replace(/ {4}parent_key: .*\n/u, '');
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(/PROJECTION_DISSECT_INVALID/u);
  });

  it('rejects an unknown from reference', () => {
    const yaml = baseYaml.replace('from: records', 'from: nowhere');
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(/PROJECTION_DISSECT_INVALID/u);
  });

  it('rejects an unregistered parser', () => {
    expect(() => compileProjection(parseProjectionSpec(baseYaml), new Map())).toThrowError(/PROJECTION_PARSER_UNKNOWN/u);
  });

  it('rejects a cyclic dissect graph', () => {
    const yaml = `${baseYaml}  - from: inner_parser
    payload: _.next
    chain:
      - { when: 'true', parser: inner_parser }
`;
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(/PROJECTION_DISSECT_CYCLE/u);
  });

  it('keeps version 0.1 specs compiling without a registry', () => {
    const yaml = `
version: '0.1'
format: plain
tables:
  - name: rows
    rows: $.rows[*]
    key: row_id
    columns:
      value: { expr: '_.value', type: int32 }
`;
    expect(() => compileProjection(parseProjectionSpec(yaml))).not.toThrow();
  });
});
```

(Also add the rule-7 test: give `inner` a `parent_key` of `{ table: inner, column: inner_id }` — self-reference is not an ancestor — expect `PROJECTION_PARENT_KEY_INVALID`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core test -- --run spec-v02`
Expected: FAIL — schema rejects `parent_key`/`dissect` (strictObject), `./parsers.js` missing.

- [ ] **Step 3: Implement schema + parsers module**

Create `packages/core/src/projection/parsers.ts` with the interface block from **Interfaces** above (imports: `AnchorMatch` from `./anchors.js`, `SourceRange` from `./project.js`).

In `spec.ts`: add the three interfaces; extend `TableSpec` with `parent_key?: ParentKeySpec` and `ProjectionSpec` with `version: '0.1' | '0.2'` and `dissect?: DissectSpec[]`; add zod schemas:

```ts
const parentKeySpec = z.strictObject({ table: identifier, column: identifier });
const chainLinkSpec = z.strictObject({
  when: nonEmptyString,
  parser: identifier,
  table: identifier.optional(),
});
const dissectSpec = z.strictObject({
  from: identifier,
  payload: nonEmptyString,
  chain: z.array(chainLinkSpec).min(1),
});
```

extend `tableSpec` with `parent_key: parentKeySpec.optional()`, and the top level with:

```ts
const projectionSpec = z.strictObject({
  version: z
    .union([z.literal('0.1'), z.literal(0.1), z.literal('0.2')])
    .transform((value): '0.1' | '0.2' => (value === '0.2' ? '0.2' : '0.1')),
  format: nonEmptyString,
  tables: z.array(tableSpec).min(1),
  dissect: z.array(dissectSpec).optional(),
});
```

After the duplicate-table check in `parseProjectionSpec`, enforce rule 1:

```ts
  if (parsed.data.version === '0.1') {
    if (parsed.data.dissect !== undefined) {
      throw new ProjectionCompileError('PROJECTION_VERSION_REQUIRED', 'dissect', 'dissect requires version 0.2');
    }
    const indexed = parsed.data.tables.findIndex((table) => table.parent_key !== undefined);
    if (indexed >= 0) {
      throw new ProjectionCompileError(
        'PROJECTION_VERSION_REQUIRED',
        `tables.${indexed}.parent_key`,
        'parent_key requires version 0.2',
      );
    }
  }
```

In `expression.ts`, extend `ProjectionCompileErrorCode` with the five new members.

- [ ] **Step 4: Implement compile-time dissect validation in `project.ts`**

Extend `CompiledProjectionTable` with `readonly parentKey: { table: string; column: string } | null` (set from `table.parent_key ?? null`; validate rule 2 while compiling each table: look up the referenced table in `spec.tables`, compare `key`, and check name collisions against the child's `key` and column names). Extend `compileProjection` to accept `registry: ParserRegistry = new Map()` and, after compiling tables, compile `spec.dissect ?? []`:

```ts
  const tableByName = new Map(tables.map((table) => [table.name, table]));
  const parserIds = new Set((spec.dissect ?? []).flatMap((entry) => entry.chain.map((link) => link.parser)));
  const dissectTables = new Set<string>();
  const dissects = (spec.dissect ?? []).map((entry, entryIndex): CompiledDissect => {
    const path = `dissect.${entryIndex}`;
    if (!tableByName.has(entry.from) && !parserIds.has(entry.from)) {
      throw new ProjectionCompileError('PROJECTION_DISSECT_INVALID', `${path}.from`,
        `from ${JSON.stringify(entry.from)} is neither a declared table nor a chained parser`);
    }
    const chain = entry.chain.map((link, linkIndex): CompiledChainLink => {
      const linkPath = `${path}.chain.${linkIndex}`;
      const parser = registry.get(link.parser);
      if (!parser) {
        throw new ProjectionCompileError('PROJECTION_PARSER_UNKNOWN', `${linkPath}.parser`,
          `parser ${JSON.stringify(link.parser)} is not registered`);
      }
      let table: CompiledProjectionTable | null = null;
      if (link.table !== undefined) {
        table = tableByName.get(link.table) ?? null;
        if (!table) {
          throw new ProjectionCompileError('PROJECTION_DISSECT_INVALID', `${linkPath}.table`,
            `table ${JSON.stringify(link.table)} is not declared`);
        }
        if (!table.parentKey) {
          throw new ProjectionCompileError('PROJECTION_DISSECT_INVALID', `${linkPath}.table`,
            `table ${JSON.stringify(link.table)} must declare parent_key to receive dissected rows`);
        }
        dissectTables.add(link.table); // multiple links may feed the same table (pcap: ipv4 and ipv6 → ip)
      }
      return Object.freeze({
        when: compileCheckedExpression(link.when, new Set(), `${linkPath}.when`),
        parserId: link.parser,
        parser,
        table,
      });
    });
    return Object.freeze({
      from: entry.from,
      payload: compileCheckedExpression(entry.payload, new Set(), `${path}.payload`),
      chain: Object.freeze(chain),
    });
  });
```

Then:

- Rule 3 (tables with `parentKey` must be dissect-fed): for each compiled table with `parentKey`, require `dissectTables.has(name)`.
- Rule 5 (acyclicity): build `edges: Map<string, string[]>` from `entry.from` to `entry.chain.map(link => link.parser)` and DFS with a visiting set; a back edge throws `PROJECTION_DISSECT_CYCLE` at path `dissect`.
- Rule 7 (ancestor reachability): compute each dissect entry's ancestor set by walking `from` backwards through the graph (a parser id's ancestors are the ancestors of every entry whose chain contains it, plus that entry's `from` when it is a table). For each link with a `table`, require `link.table.parentKey.table` ∈ ancestors. Implement as a fixpoint over entries (the graph is acyclic by now).
- `rootTables` = `tables.filter((table) => !dissectTables.has(table.name))`; also update `projectInto`/`projectTree` (from Task 6) to walk `compiled.rootTables` instead of `compiled.tables` — output tables still enumerate `compiled.tables` so dissect-only tables appear (empty until Task 8 fills them).
- Freeze `dissectByFrom` as a `Map` grouping `dissects` by `from`.

Export the new types (`CompiledChainLink`, `CompiledDissect`, `ParsedRecord`, `RecordParser`, `ParserRegistry`, `ParentKeySpec`, `DissectSpec`, `DissectChainLinkSpec`) from `packages/core/src/index.ts`.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @byteql/core test -- --run && pnpm --filter @byteql/midi test -- --run`
Expected: PASS (MIDI is a v0.1 spec; nothing changes for it).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/projection/spec.ts packages/core/src/projection/parsers.ts packages/core/src/projection/project.ts packages/core/src/projection/expression.ts packages/core/src/projection/spec-v02.test.ts packages/core/src/index.ts
git commit -m "feat(core): add spec v0.2 with parent_key and dissect validation"
```

---

### Task 8: Dissect execution + synthetic conformance fixture

**Files:**

- Modify: `packages/core/src/projection/project.ts` (chain execution in the emit path)
- Modify: `packages/core/src/projection/session.ts` (thread an optional `IssueCollector` through)
- Create: `packages/core/src/projection/dissect.test.ts`

**Interfaces:**

- Consumes: Task 7's compiled dissect structures; `IssueCollector`; `traverseAnchor`.
- Produces:
  - `projectInto` gains a final optional parameter `issues?: IssueCollector`. `createProjectionSession(compiled, options)` gains `options.issues?: IssueCollector`.
  - Runtime dissect contract: a `payload` expression must evaluate to `{ bytes: Uint8Array; start: number }` (`start` = absolute file offset of the payload). Violations report `{ stage: 'dissecting', code: 'DISSECT_PAYLOAD_INVALID', recoverable: true }` and the parent row has no children. A child parser throw reports `code: 'DISSECT_PARSE_FAILED'`. Chain guards evaluate in order; the first truthy guard wins; no truthy guard means no children (not an error).
  - Child provenance: `parsed.resolve` returns payload-relative ranges which the engine offsets by `payload.start`; when `resolve` is absent every child row gets `[payload.start, payload.start + bytes.length)`.
  - `parent_key` column value: the emitted key of the `parent_key.table` row on the current dissect path.
- [ ] **Step 1: Write the failing conformance tests**

Create `packages/core/src/projection/dissect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { IssueCollector } from '../issues.js';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import { createProjectionSession } from './session.js';
import type { ParserRegistry } from './parsers.js';

// Envelope fixture: outer records carry a kind selector and a payload; kind 1
// payloads parse into items, whose trailer chains onward into a grandchild.
const yaml = `
version: '0.2'
format: envelope
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      kind: { expr: '_.kind', type: uint8 }
  - name: inner
    rows: $.items[*]
    key: inner_id
    parent_key: { table: records, column: record_id }
    columns:
      label: { expr: '_.label', type: utf8 }
  - name: deep
    rows: $.parts[*]
    key: deep_id
    parent_key: { table: records, column: record_id }
    columns:
      flag: { expr: '_.flag', type: bool }
dissect:
  - from: records
    payload: _.body
    chain:
      - { when: '_.kind == 0x01', parser: inner_parser, table: inner }
      - { when: '_.kind == 0x02', parser: never_parser, table: deep }
  - from: inner_parser
    payload: _.trailer
    chain:
      - { when: '_.has_parts', parser: deep_parser, table: deep }
`;

const innerParser = (bytes: Uint8Array) => ({
  root: {
    items: [{ label: `item-${bytes[0]}` }, { label: `item-${bytes[0]}-b` }],
    has_parts: bytes[0] === 7,
    trailer: { bytes: Uint8Array.of(9), start: 900 },
  },
  resolve: (_table: string, match: { readonly indexes: readonly number[] }) => ({
    start: match.indexes[0]! * 10,
    end: match.indexes[0]! * 10 + 5,
  }),
});

const registry: ParserRegistry = new Map([
  ['inner_parser', innerParser],
  ['never_parser', () => ({ root: {} })],
  ['deep_parser', () => ({ root: { parts: [{ flag: true }] } })],
]);

const resolver = { resolve: () => ({ start: 0, end: 4 }) };

const project = (records: unknown[], issues = new IssueCollector()) => {
  const compiled = compileProjection(parseProjectionSpec(yaml), registry);
  const session = createProjectionSession(compiled, { issues });
  session.project({ records }, resolver);
  return { finished: session.finish(), issues };
};

describe('dissect execution', () => {
  it('projects chained child tables with parent keys and composed provenance', () => {
    const { finished } = project([
      { kind: 1, body: { bytes: Uint8Array.of(7), start: 100 } },
      { kind: 1, body: { bytes: Uint8Array.of(3), start: 200 } },
    ]);
    const inner = finished.find((table) => table.name === 'inner')!;
    expect(inner.rowCount).toBe(4);
    expect(inner.arrow.getChild('record_id')!.toArray()).toEqual(new BigInt64Array([1n, 1n, 2n, 2n]));
    expect(inner.arrow.getChild('label')!.get(0)).toBe('item-7');
    // resolve(start 0*10) + payload.start 100
    expect(inner.arrow.getChild('_src_start')!.toArray()).toEqual(new BigUint64Array([100n, 110n, 200n, 210n]));
    expect(inner.arrow.getChild('_src_end')!.toArray()).toEqual(new BigUint64Array([105n, 115n, 205n, 215n]));

    // Grandchild fired only for the has_parts record; parent_key still records.record_id.
    const deep = finished.find((table) => table.name === 'deep')!;
    expect(deep.rowCount).toBe(1);
    expect(deep.arrow.getChild('record_id')!.toArray()).toEqual(new BigInt64Array([1n]));
    // deep_parser has no resolve → whole trailer payload range.
    expect(deep.arrow.getChild('_src_start')!.get(0)).toBe(900n);
    expect(deep.arrow.getChild('_src_end')!.get(0)).toBe(901n);
  });

  it('leaves the parent childless when no guard matches, without reporting an issue', () => {
    const { finished, issues } = project([{ kind: 9, body: { bytes: Uint8Array.of(1), start: 0 } }]);
    expect(finished.find((table) => table.name === 'inner')!.rowCount).toBe(0);
    expect(issues.issues()).toHaveLength(0);
  });

  it('fires only the first matching guard', () => {
    // kind 1 matches link 0; never_parser (link 1) must not run (it would throw the deep row count off).
    const { finished } = project([{ kind: 1, body: { bytes: Uint8Array.of(2), start: 0 } }]);
    expect(finished.find((table) => table.name === 'deep')!.rowCount).toBe(0);
  });

  it('reports an issue and continues when the payload is not a byte range', () => {
    const { finished, issues } = project([{ kind: 1, body: 'not-a-range' }]);
    expect(finished.find((table) => table.name === 'records')!.rowCount).toBe(1);
    expect(issues.issues()).toEqual([
      expect.objectContaining({ stage: 'dissecting', code: 'DISSECT_PAYLOAD_INVALID', recoverable: true }),
    ]);
  });

  it('reports an issue and continues when a child parser throws', () => {
    const throwingRegistry = new Map(registry);
    throwingRegistry.set('inner_parser', () => { throw new Error('poison record'); });
    const compiled = compileProjection(parseProjectionSpec(yaml), throwingRegistry);
    const issues = new IssueCollector();
    const session = createProjectionSession(compiled, { issues });
    session.project({ records: [{ kind: 1, body: { bytes: Uint8Array.of(1), start: 0 } }] }, resolver);
    expect(session.finish().find((table) => table.name === 'records')!.rowCount).toBe(1);
    expect(issues.issues()).toEqual([
      expect.objectContaining({ stage: 'dissecting', code: 'DISSECT_PARSE_FAILED', recoverable: true }),
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core test -- --run dissect`
Expected: FAIL — child tables stay empty (no execution exists yet) and `createProjectionSession` rejects the `issues` option.

- [ ] **Step 3: Implement chain execution**

In `packages/core/src/projection/project.ts`:

1. `emitRow` gains parameters `keysByTable: ReadonlyMap<string, bigint>` and `emitContext: EmitContext` where:

```ts
interface EmitContext {
  readonly compiled: CompiledProjection;
  readonly runtimes: Map<string, TableRuntime>;
  readonly sink: RowSink;
  readonly issues?: IssueCollector;
}
```

2. After a row is pushed for table `T` with key `k`, extend the key map and fire chains:

```ts
  const childKeys = new Map(keysByTable);
  childKeys.set(table.name, key);
  for (const dissect of emitContext.compiled.dissectByFrom.get(table.name) ?? []) {
    fireDissect(dissect, context, childKeys, emitContext, range);
  }
```

(`context` is the row's `ExpressionContext`; `range` the parent's resolved absolute range, used for issue offsets.)

3. Implement `fireDissect` and `projectChildTable`:

```ts
interface PayloadRange { readonly bytes: Uint8Array; readonly start: number }

const asPayloadRange = (value: unknown): PayloadRange | null => {
  if (value === null || typeof value !== 'object') return null;
  const bytes = (value as { bytes?: unknown }).bytes;
  const start = (value as { start?: unknown }).start;
  if (!(bytes instanceof Uint8Array) || typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) {
    return null;
  }
  return { bytes, start };
};

const fireDissect = (
  dissect: CompiledDissect,
  context: ExpressionContext,
  keysByTable: ReadonlyMap<string, bigint>,
  emitContext: EmitContext,
  parentRange: SourceRange,
): void => {
  const payload = asPayloadRange(evaluateExpression(dissect.payload, context));
  if (!payload) {
    emitContext.issues?.report({
      stage: 'dissecting', code: 'DISSECT_PAYLOAD_INVALID', recoverable: true,
      message: `dissect from ${JSON.stringify(dissect.from)}: payload did not evaluate to { bytes, start }`,
      sourceStart: parentRange.start, sourceEnd: parentRange.end,
    });
    return;
  }

  for (const link of dissect.chain) {
    if (!evaluateExpression(link.when, context)) continue;

    let parsed: ParsedRecord;
    try {
      parsed = link.parser(payload.bytes);
    } catch (error) {
      emitContext.issues?.report({
        stage: 'dissecting', code: 'DISSECT_PARSE_FAILED', recoverable: true,
        message: error instanceof Error ? error.message : String(error),
        sourceStart: payload.start, sourceEnd: payload.start + payload.bytes.length,
      });
      return;
    }

    if (link.table) projectChildTable(link.table, parsed, payload, keysByTable, emitContext);

    const childContext: ExpressionContext = { _: parsed.root, _root: parsed.root };
    for (const deeper of emitContext.compiled.dissectByFrom.get(link.parserId) ?? []) {
      fireDissect(deeper, childContext, keysByTable, emitContext, {
        start: payload.start,
        end: payload.start + payload.bytes.length,
      });
    }
    return; // first matching guard wins
  }
};

const projectChildTable = (
  table: CompiledProjectionTable,
  parsed: ParsedRecord,
  payload: PayloadRange,
  keysByTable: ReadonlyMap<string, bigint>,
  emitContext: EmitContext,
): void => {
  const resolver: ProvenanceResolver = {
    resolve(tableName, match) {
      if (!parsed.resolve) return { start: payload.start, end: payload.start + payload.bytes.length };
      const relative = parsed.resolve(tableName, match);
      return { start: payload.start + relative.start, end: payload.start + relative.end };
    },
  };
  const parentKeyValue = keysByTable.get(table.parentKey!.table) ?? null;
  for (const match of traverseAnchor(table.rows, parsed.root)) {
    emitRow(table, emitContext.runtimes.get(table.name)!, match, parsed.root, resolver, emitContext.sink, keysByTable, emitContext, {
      name: table.parentKey!.column,
      value: parentKeyValue,
    });
  }
};
```

4. `emitRow` gains an optional trailing `parentKey?: { name: string; value: bigint | null }` — when present, set `row[parentKey.name] = parentKey.value` right after the synthetic key. `tableOutputTypes` adds `parentKey.column: 'int64'` (right after the key) for tables with `parentKey`.
5. `projectInto` builds the `EmitContext`, passes an empty `keysByTable`, and gains the optional `issues` parameter; `walkMatcher` visits only `compiled.rootTables` (already done in Task 7) — child tables are reached exclusively through chains.
6. `session.ts`: `ProjectionSessionOptions` gains `readonly issues?: IssueCollector`, forwarded to `projectInto`.

Note on recursion: chains recurse (`fireDissect` → `projectChildTable` → `emitRow` → `fireDissect`) so a child row's own chains fire with the child's key added to `keysByTable` — grandchild tables may parent onto mid-chain tables. Depth is bounded by the acyclic compile-time graph.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @byteql/core test -- --run`
Expected: PASS — all core suites including the new dissect conformance tests.

- [ ] **Step 5: Full regression**

Run: `pnpm -r check && pnpm --filter @byteql/midi test -- --run && pnpm --filter @byteql/web test -- --run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/projection/project.ts packages/core/src/projection/session.ts packages/core/src/projection/dissect.test.ts
git commit -m "feat(core): execute dissect chains with parent keys and composed provenance"
```

---

### Task 9: WIT-aligned `FormatPack`/`RecordSource` protocol + MIDI pack

**Files:**

- Modify: `packages/core/src/protocol.ts`
- Create: `packages/formats/midi/src/pack.ts`
- Create: `packages/formats/midi/src/pack.test.ts`
- Modify: `packages/formats/midi/src/index.ts` (export `midiFormatPack`)
- Modify: `packages/core/src/index.ts` (export new protocol types)

**Interfaces:**

- Produces (Task 10's worker consumes these exactly):

```ts
// packages/core/src/protocol.ts additions
export interface TableColumn { name: string; type: string; nullable: boolean }
// TableTransfer.columns becomes readonly TableColumn[] (same shape, now named)
export interface TableSchema { name: string; columns: readonly TableColumn[] }
export interface ParseProgress { stage: string; completed: number; total: number; label: string }
export interface OpenOptions { signal: AbortSignal; onProgress?: (progress: ParseProgress) => void }
export interface BatchTransfer { table: string; ipc: Uint8Array; rowCount: number }
export interface SourceFinish {
  issues: readonly ParseIssue[];
  capabilities: Readonly<Record<string, FormatCapability>>;
}
export interface RecordSource {
  nextBatch(): Promise<BatchTransfer | null>;
  finish(): SourceFinish; // only valid after nextBatch() returned null
}
export interface FormatPack {
  readonly id: string;
  readonly title: string;
  probe(head: Uint8Array): number | null; // sniff confidence 0..1
  schemas(): readonly TableSchema[];
  open(bytes: Uint8Array, opts: OpenOptions): RecordSource;
  readonly queries: readonly PackQuery[];
}
```

- MIDI pack: `export const midiFormatPack: FormatPack` in `packages/formats/midi/src/pack.ts`. `open()` is a façade: the first `nextBatch()` runs `parseAndProjectMidi` to completion, then yields one `BatchTransfer` per table (whole-table IPC) in order, then `null`; `finish()` returns the parse's `issues` and `capabilities`. `schemas()` returns each table's `TableColumn[]` (name + nullable from the existing `nullability` map; `type` is informational). `parseAndProjectMidi` stays exported and unchanged.

- [ ] **Step 1: Add the protocol types**

Edit `packages/core/src/protocol.ts` per the interface block above (introduce `TableColumn` and reuse it in `TableTransfer`). Export all new names from `packages/core/src/index.ts`. Run `pnpm -r check` — expected PASS (shape-compatible).

- [ ] **Step 2: Write the failing pack tests**

Create `packages/formats/midi/src/pack.test.ts` (reuse an existing valid fixture: import `buildMidiFixture` or the equivalent helper other MIDI tests use from `../test/fixtures.js` — inspect that file and reuse its canonical valid-file fixture; below `validMidiBytes` stands for it):

```ts
import { describe, expect, it } from 'vitest';
import { midiFormatPack } from './pack.js';

describe('midiFormatPack', () => {
  it('probes MThd headers with full confidence and rejects others', () => {
    expect(midiFormatPack.probe(Uint8Array.of(0x4d, 0x54, 0x68, 0x64, 0, 0))).toBe(1);
    expect(midiFormatPack.probe(Uint8Array.of(0x50, 0x4b, 3, 4))).toBeNull();
    expect(midiFormatPack.probe(Uint8Array.of(0x4d, 0x54))).toBeNull();
  });

  it('declares schemas for all four tables', () => {
    expect(midiFormatPack.schemas().map((schema) => schema.name)).toEqual(['header', 'events', 'tempo', 'errors']);
    const events = midiFormatPack.schemas().find((schema) => schema.name === 'events')!;
    expect(events.columns.find((column) => column.name === 'note')!.nullable).toBe(true);
    expect(events.columns.find((column) => column.name === 'event_id')!.nullable).toBe(false);
  });

  it('streams every table as a batch, then null, then finish() reports capabilities', async () => {
    const source = midiFormatPack.open(validMidiBytes, { signal: new AbortController().signal });
    const batches = [];
    for (let batch = await source.nextBatch(); batch !== null; batch = await source.nextBatch()) {
      batches.push(batch);
    }
    expect(batches.map((batch) => batch.table)).toEqual(['header', 'events', 'tempo', 'errors']);
    expect(batches.every((batch) => batch.ipc instanceof Uint8Array)).toBe(true);
    const finish = source.finish();
    expect(finish.capabilities.audio).toEqual({ enabled: true, reason: null });
    expect(finish.issues).toEqual([]);
  });

  it('rejects when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = midiFormatPack.open(validMidiBytes, { signal: controller.signal });
    await expect(source.nextBatch()).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @byteql/midi test -- --run pack`
Expected: FAIL — `./pack.js` does not exist.

- [ ] **Step 4: Implement the pack**

First export the existing `nullability` map from `project-midi.ts` (rename the const to `midiNullability`, add `export`, update its uses in `toTransfer`). Then create `packages/formats/midi/src/pack.ts`:

```ts
import type { BatchTransfer, FormatPack, OpenOptions, ParseResult, RecordSource, SourceFinish, TableColumn, TableSchema } from '@byteql/core';
import midiQueries from './midi-queries.generated.js';
import { midiNullability, parseAndProjectMidi } from './project-midi.js';

const column = (table: string, name: string, type: string): TableColumn => ({
  name,
  type,
  nullable: (midiNullability[table] ?? new Set<string>()).has(name),
});

const columns = (table: string, entries: readonly (readonly [string, string])[]): TableSchema => ({
  name: table,
  columns: entries.map(([name, type]) => column(table, name, type)),
});

// Column order mirrors the projection engine's output: key, spec columns, provenance.
const MIDI_TABLE_SCHEMAS: readonly TableSchema[] = [
  columns('header', [
    ['header_id', 'int64'], ['format', 'uint16'], ['num_tracks', 'uint16'], ['division', 'int16'],
    ['_src_start', 'uint64'], ['_src_end', 'uint64'],
  ]),
  columns('events', [
    ['event_id', 'int64'], ['track', 'int32'], ['event_index', 'int32'], ['delta_time', 'int64'],
    ['tick', 'int64'], ['kind', 'utf8'], ['channel', 'uint8'], ['note', 'uint8'], ['velocity', 'uint8'],
    ['controller', 'uint8'], ['value', 'uint8'], ['program', 'uint8'], ['pressure', 'uint8'],
    ['bend', 'int16'], ['_src_start', 'uint64'], ['_src_end', 'uint64'],
  ]),
  columns('tempo', [
    ['tempo_id', 'int64'], ['track', 'int32'], ['tick', 'int64'], ['us_per_quarter', 'uint32'],
    ['_src_start', 'uint64'], ['_src_end', 'uint64'],
  ]),
  columns('errors', [
    ['error_id', 'int64'], ['stage', 'utf8'], ['track', 'int32'], ['code', 'utf8'], ['message', 'utf8'],
    ['recoverable', 'bool'], ['_src_start', 'uint64'], ['_src_end', 'uint64'],
  ]),
];
```

(`type` strings are the spec's `ArrowTypeName` values — informational at this boundary; the worker derives display types from the real Arrow schema.)

```ts
export const midiFormatPack: FormatPack = {
  id: 'standard_midi_file',
  title: 'Standard MIDI file',
  probe: (head) =>
    head.byteLength >= 4 && head[0] === 0x4d && head[1] === 0x54 && head[2] === 0x68 && head[3] === 0x64
      ? 1
      : null,
  schemas: () => MIDI_TABLE_SCHEMAS,
  queries: midiQueries,
  open(bytes: Uint8Array, opts: OpenOptions): RecordSource {
    let parsed: Promise<ParseResult> | null = null;
    let cursor = 0;
    let result: ParseResult | null = null;
    return {
      async nextBatch(): Promise<BatchTransfer | null> {
        parsed ??= parseAndProjectMidi(bytes, opts.signal, opts.onProgress);
        result = await parsed;
        if (cursor >= result.tables.length) return null;
        const table = result.tables[cursor]!;
        cursor += 1;
        return { table: table.name, ipc: table.ipc, rowCount: table.rowCount };
      },
      finish(): SourceFinish {
        if (!result) throw new Error('RECORD_SOURCE_NOT_DRAINED: call nextBatch() until null before finish()');
        return { issues: result.issues, capabilities: result.capabilities };
      },
    };
  },
};
```

Export from `packages/formats/midi/src/index.ts`: `export { midiFormatPack } from './pack.js';`.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @byteql/midi test -- --run && pnpm -r check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/protocol.ts packages/core/src/index.ts packages/formats/midi/src/pack.ts packages/formats/midi/src/pack.test.ts packages/formats/midi/src/index.ts packages/formats/midi/src/project-midi.ts
git commit -m "feat: add WIT-aligned FormatPack boundary and MIDI pack implementation"
```

---

### Task 10: Probe registry in the parse worker + error-code renames

**Files:**

- Modify: `apps/web/src/workers/parse.worker.ts`
- Modify: `apps/web/src/lib/session/controller.test.ts` (line ~521: expected error code)
- Test: existing suites (`apps/web/src/lib/session/*.test.ts`, `apps/web/src/components/*.test.ts`, e2e)

**Interfaces:**

- Consumes: `midiFormatPack`, `FormatPack`, `RecordSource`, `ipcToTable`, `tableToIpc` from `@byteql/core`/`@byteql/midi`.
- Produces: `installParseWorker(scope, packs: readonly FormatPack[] = [midiFormatPack])`. Worker request gains optional `formatId?: string` on the `parse` message (no UI sends it yet). Error codes: `UNRECOGNIZED_FORMAT` (no probe match / unknown `formatId`), `PARSE_FAILED` (pack threw). The success message shape (`{type:'result', taskId, result: ParseResult}`) is unchanged.
- [ ] **Step 1: Update the failing expectations first**

In `apps/web/src/lib/session/controller.test.ts` (~line 521) change `code: 'INVALID_MIDI_HEADER'` to `code: 'UNRECOGNIZED_FORMAT'`. Search the web app for other occurrences: `grep -rn "INVALID_MIDI_HEADER\|MIDI_PARSE_FAILED" apps/web/src apps/web/e2e` and update each to the new codes.

Run: `pnpm --filter @byteql/web test -- --run`
Expected: FAIL — worker still emits the old codes.

- [ ] **Step 2: Rewrite the worker on the registry**

Replace the body of `apps/web/src/workers/parse.worker.ts` (keeping `ParseWorkerScope`, the cancel bookkeeping, and the module-bottom install guard):

```ts
import {
  ipcToTable,
  tableToIpc,
  type BatchTransfer,
  type FormatPack,
  type ParseResult,
  type TableColumn,
  type TableTransfer,
} from '@byteql/core';
import { midiFormatPack } from '@byteql/midi';

const PROBE_HEAD_BYTES = 4096;

type WorkerRequest =
  | { type: 'parse'; taskId: number; name: string; bytes: Uint8Array; formatId?: string }
  | { type: 'cancel'; taskId: number };

const selectPack = (packs: readonly FormatPack[], bytes: Uint8Array, formatId?: string): FormatPack | null => {
  if (formatId !== undefined) return packs.find((pack) => pack.id === formatId) ?? null;
  const head = bytes.subarray(0, PROBE_HEAD_BYTES);
  let best: FormatPack | null = null;
  let bestConfidence = 0;
  for (const pack of packs) {
    const confidence = pack.probe(head);
    if (confidence !== null && confidence > bestConfidence) {
      best = pack;
      bestConfidence = confidence;
    }
  }
  return best;
};

const mergeBatches = (pack: FormatPack, batches: readonly BatchTransfer[]): TableTransfer[] => {
  const byTable = new Map<string, BatchTransfer[]>();
  for (const batch of batches) {
    const list = byTable.get(batch.table) ?? [];
    list.push(batch);
    byTable.set(batch.table, list);
  }
  const nullableByTable = new Map<string, Map<string, boolean>>(
    pack.schemas().map((schema) => [schema.name, new Map(schema.columns.map((column) => [column.name, column.nullable]))]),
  );
  return [...byTable.entries()].map(([name, parts]) => {
    const ipc =
      parts.length === 1
        ? parts[0]!.ipc
        : tableToIpc(ipcToTable(concatIpc(parts.map((part) => part.ipc))));
    const arrow = ipcToTable(ipc);
    const nullable = nullableByTable.get(name);
    const columns: TableColumn[] = arrow.schema.fields.map((field) => ({
      name: field.name,
      type: field.type.toString(),
      nullable: nullable?.get(field.name) ?? false,
    }));
    return { name, ipc, rowCount: parts.reduce((sum, part) => sum + part.rowCount, 0), columns };
  });
};
```

For `concatIpc`, multi-batch merging is simpler than byte concatenation — read each part into an arrow `Table` and rebuild:

```ts
import { Table } from 'apache-arrow';
const concatIpc = (parts: readonly Uint8Array[]): Table =>
  new Table(parts.flatMap((part) => ipcToTable(part).batches));
```

The parse handler becomes:

```ts
    const { taskId, bytes } = request;
    const pack = selectPack(packs, bytes, request.formatId);
    if (!pack) {
      scope.postMessage({
        type: 'error',
        taskId,
        code: 'UNRECOGNIZED_FORMAT',
        stage: 'framing',
        message: 'No registered format recognizes this file.',
      });
      return;
    }

    const controller = new AbortController();
    active.set(taskId, controller);
    if (cancelled.has(taskId)) controller.abort();

    const run = async (): Promise<ParseResult> => {
      const source = pack.open(bytes, {
        signal: controller.signal,
        onProgress: (progress) => scope.postMessage({ type: 'progress', taskId, ...progress }),
      });
      const batches: BatchTransfer[] = [];
      for (let batch = await source.nextBatch(); batch !== null; batch = await source.nextBatch()) {
        batches.push(batch);
      }
      const finish = source.finish();
      return {
        format: { id: pack.id, title: pack.title },
        tables: mergeBatches(pack, batches),
        issues: finish.issues,
        queries: pack.queries,
        capabilities: finish.capabilities,
      };
    };

    void run()
      .then((result) => { /* unchanged success/cancel posting */ })
      .catch((error: unknown) => {
        if (controller.signal.aborted || cancelled.has(taskId) || isAbortError(error)) {
          scope.postMessage({ type: 'cancelled', taskId });
          return;
        }
        scope.postMessage({
          type: 'error',
          taskId,
          code: 'PARSE_FAILED',
          stage: 'parsing',
          message: errorMessage(error, pack.title),
        });
      })
      .finally(() => { active.delete(taskId); cancelled.delete(taskId); });
```

`installParseWorker(scope, packs: readonly FormatPack[] = [midiFormatPack])` replaces the old `parseMidi` injection parameter — update `errorMessage` to `(error: unknown, packTitle: string)` returning the error's message or `` `The ${packTitle} parser could not process this file.` ``. Delete `isMidiHeader` and the old `ParseMidi` type. Check every test that called `installParseWorker(scope, fakeParse)` (grep `installParseWorker` under `apps/web`) and adapt: a fake pack `{ id, title, probe: () => 1, schemas: () => [], queries: [], open: ... }` replaces a fake parse function.

- [ ] **Step 3: Run the web unit suites**

Run: `pnpm --filter @byteql/web test -- --run && pnpm -r check`
Expected: PASS.

- [ ] **Step 4: Run the browser acceptance suites**

Run: `pnpm --filter @byteql/web test:e2e`
Expected: PASS — open-query-inspect, recovery (worker recreation), audio, privacy, performance, static-delivery. If any spec asserts the old error message for non-MIDI files, update it to the new `UNRECOGNIZED_FORMAT` message text.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workers/parse.worker.ts apps/web/src/lib/session/controller.test.ts
git commit -m "feat(web): dispatch parsing through a probe-based format pack registry"
```

(Include any other test files updated in Step 1/2 in the `git add`.)

---

### Task 11: Milestone verification sweep

**Files:**

- Modify: `docs/superpowers/specs/2026-07-18-phase1-generalization-prep-design.md` only if divergences were found (record them in a short "Implementation notes" section at the bottom).

- [ ] **Step 1: Full workspace verification**

Run, in order, from the repo root:

```bash
pnpm -r check
pnpm -r test -- --run
pnpm build
pnpm --filter @byteql/web check:bundle
pnpm --filter @byteql/web test:e2e
```

Expected: all PASS. `check:bundle` confirms no new external references and chunk-size caps hold.

- [ ] **Step 2: Behavior-preservation spot check**

Run the MIDI conformance suite one final time and confirm with `git log --oneline` that every task landed as its own conventional commit. Confirm `grep -rn "INVALID_MIDI_HEADER\|MIDI_PARSE_FAILED" apps packages` returns nothing.

- [ ] **Step 3: Commit any doc notes**

```bash
git add docs/superpowers/specs/2026-07-18-phase1-generalization-prep-design.md
git commit -m "docs: record generalization-prep implementation notes"
```

(Skip if no notes were needed.)
