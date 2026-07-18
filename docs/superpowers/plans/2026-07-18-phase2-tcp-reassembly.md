# TCP Stream Reassembly (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A generic, declarative stream-reassembly capability in `@byteql/core` (spec v0.3
`streams:` section + registered key-extractor/framer code hooks), consumed by the pcap pack for
multi-segment TLS ClientHello and DNS-over-TCP.

**Architecture:** Dissect chain links may target a `stream:` instead of a `parser:`. The engine
buffers per-flow contributions in a pure `StreamAssembler` (ordering, dedup, rebase, gap/cap), cuts
messages with a registered framer, and re-enters the ordinary dissect path per message — parent
keys come from the completing contribution's `keysByTable` snapshot, `stream_id` is injected like
the parent-key column, exact per-segment provenance goes to an engine-synthesized segments link
table, and one flow row per stream flushes at `finish()`.

**Tech Stack:** TypeScript, zod, vitest, Apache Arrow JS, Kaitai Struct JS runtime, Playwright,
pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-07-18-phase2-tcp-reassembly-design.md` (amended by Task 1).

## Global Constraints

- **Spec version `0.3`**; `0.2`/`0.1` specs must keep parsing and behaving exactly as today.
- **Reassembly issues** use `stage: 'reassembling'`, codes `STREAM_KEY_INVALID` / `STREAM_GAP` /
  `STREAM_TRUNCATED` / `STREAM_ERROR`, all `recoverable: true`, always with a source range.
  Message parsers that throw keep `stage: 'dissecting'`, code `DISSECT_PARSE_FAILED`.
- **Flow status enum:** `'ok' | 'gap' | 'truncated' | 'error'`. Silent by design: exact-duplicate
  retransmissions, empty payloads, trailing incomplete messages (surfaced as `pending_bytes`).
- **Stream links are only legal in table-rooted dissect entries** (`from: <table>`); all entries
  feeding one stream must share the same `from` table (the stream's *feed table*).
- **Framer contract:** `(buffer: Uint8Array) => number | null` — total length of the first message
  once determinable (MAY exceed `buffer.length`; the engine waits), `null` when undeterminable
  yet. A throw or non-positive/non-integer return *stalls* framing; a stream still stalled at
  flush is status `error`.
- **Rebase rule:** the assembler's base is the lowest offset seen so far *while nothing has been
  consumed*; once a message has been framed (`consumed > 0`), a below-base segment is an error.
- **`stream_id` injection:** every table fed by a stream `messages` chain gains an engine-injected
  `stream_id` int64 column (nullable on rows from non-stream paths), ordered key → parent key →
  `stream_id` → spec columns → `_src_start`/`_src_end`.
- **Engine cap default for pcap:** `max_buffer: 1048576` (1 MiB), declared in YAML per stream.
- **MIDI + existing pcap suites stay green at every step.** Full gate: `pnpm -r check`,
  `pnpm -r test -- --run`, `pnpm --filter @byteql/web check:bundle`,
  `pnpm --filter @byteql/web test:e2e`.
- **Format gate:** prettier + eslint clean before every commit (`docs/superpowers/` and `PRD.md`
  are prettier-ignored; everything under `packages/` is not).
- **Conventional commits; no Co-Authored-By trailers or AI branding.**

## Reference: current shapes (verified) that tasks modify

- `packages/core/src/projection/spec.ts`: zod schemas; `chainLinkSpec` requires `parser`;
  `projectionSpec.version` accepts `'0.1' | 0.1 | '0.2' | 0.2`; v0.1 gating rejects
  `dissect`/`parent_key`.
- `packages/core/src/projection/project.ts` (732 lines): `compileProjection(spec, registry)`;
  `CompiledChainLink { when, parserId, parser, table }`; `emitRow(table, runtime, match, root,
  provenance, sink, keysByTable, emitContext, baseOffset, enclosingLength, parentKey?)`;
  `fireDissect(dissect, context, keysByTable, emitContext, parentRange, baseOffset,
  enclosingLength)` — evaluates payload once, first matching guard wins, `deeper` loop recurses
  with the OUTER `keysByTable`; `projectChildTable(table, parsed, payloadBytes,
  absolutePayloadStart, keysByTable, emitContext)`; `tableOutputTypes` orders key → parent key →
  columns → `_src_*`; Rule 3/5/7 validations with an `ancestorsByParser` fixpoint;
  `createRuntimes`, `projectInto(compiled, root, provenance, sink, runtimes, subset, issues?)`,
  `projectTree`.
- `packages/core/src/projection/expression.ts`: `ProjectionCompileErrorCode` union (line ~14);
  builtins object with inline `ip4_str` / `ip6_str` (line ~604); `evaluateExpression`,
  `ExpressionContext`, `getExpressionContextReferences`.
- `packages/core/src/projection/session.ts`: builders from `compiled.tables` via
  `tableOutputTypes`; `finish()` returns `FinishedTable[]` in `compiled.tables` order.
- `packages/core/src/arrow/batch.ts`: `TableBatchBuilder.appendRow` fills missing keys with
  `null` — injected nullable columns need no pack-side changes to row emission.
- `packages/core/src/issues.ts`: `IssueReport.stage`/`code` are free strings.
- `packages/core/src/index.ts`: export surface to extend.
- `packages/formats/pcap/pcap.tables.yaml`: v0.2; `from: tcp_segment` entry chains
  `tls_client_hello` (443) and `dns_tcp_message` (53).
- `packages/formats/pcap/src/wrappers.ts`: `tcpSegment` root has `src_port`, `dst_port`,
  `seq_num`, `body`; `tlsClientHello` guards `bytes[0] === 0x16 && bytes[5] === 0x01`, else
  `{ root: {} }`; `dnsTcpMessage` strips the 2-byte prefix with a "fits in this segment" guard.
- `packages/formats/pcap/src/parsers.ts`: `pcapParserRegistry` (10 wrappers).
- `packages/formats/pcap/src/project-pcap.ts`: `compileProjection(parseProjectionSpec(tablesYaml),
  pcapParserRegistry)` at module top; `pcapNullability`.
- `packages/formats/pcap/src/pack.ts`: `PCAP_TABLE_SCHEMAS` literal list.
- `packages/formats/pcap/test/build-pcap.ts`: `tcp({ srcPort, dstPort, flags, payload })` writes
  `seq_num` fixed 0 at offset 4.
- `packages/formats/pcap/queries.yaml` + `scripts/generate-pack.mjs` (regenerates
  `src/pcap-*.generated.ts`; runs automatically in `pnpm --filter @byteql/pcap test|check|build`).
- `apps/web/e2e/pcap.spec.ts` + `apps/web/e2e/fixtures/sample.pcap`.

---

### Task 1: Spec amendments (design-doc corrections discovered in code trace)

**Files:**

- Modify: `docs/superpowers/specs/2026-07-18-phase2-tcp-reassembly-design.md`

Three corrections, each forced by verified engine behavior. No code.

- [ ] **Step 1: Amend the spec**

1. **Feed-table rule.** In *Spec surface*, replace the dissect YAML's `from: tcp_segment` with
   `from: tcp`, and add after the YAML block:

   > A `stream:` link is only legal in a dissect entry whose `from` is a **table** — chains rooted
   > at a parser id run with the outer `keysByTable` and never see the feeding table's row key,
   > which the segments link table records. All entries feeding one stream must share the same
   > `from` table (the stream's *feed table*); its key column (e.g. `tcp_id`) becomes the segments
   > table's reference column. This also implicitly forbids nested reassembly: dissect entries
   > rooted at a message parser are parser-rooted and therefore cannot contain stream links.

   Apply the same `from: tcp` fix to the *pcap pack changes* bullet.
2. **Framer contract.** Replace the framer bullet's contract sentence with:

   > **Framer** — `(buffer) => number | null`. Total byte length of the first message once
   > determinable from the header — the returned length MAY exceed `buffer.length`, in which case
   > the engine waits for more contiguous bytes; `null` when it cannot be determined yet. A throw
   > or a non-positive length *stalls* the stream's framing: the stall clears only when a rebase
   > (below) changes byte 0, and a stream still stalled at `finish()` is status `error`.
3. **Rebase instead of hard base.** In *Engine runtime* → "Ordering and dedup", replace "The
   first contribution's offset is the stream base ... below-base segment ... marks the stream
   `error`" with:

   > The stream base is the lowest offset seen so far: while nothing has been consumed, a
   > contribution below the current base *rebases* the stream downward (shifting buffered data)
   > and clears any framing stall — this is how an out-of-order first segment (captured before the
   > true stream start) reassembles instead of erroring. Once a message has been framed
   > (`consumed > 0`) the base is locked and a below-base segment marks the stream `error`.

   And in *Message emission* add: "A message parser's optional `resolve` is ignored — stream
   messages use the coarse contributing-segment span; deeper dissects chained off a message parser
   likewise compose against the coarse span start."
4. Run `rumdl fmt docs/superpowers/specs/2026-07-18-phase2-tcp-reassembly-design.md` (MD013
   line-length warnings are house-accepted; fix anything else).

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-07-18-phase2-tcp-reassembly-design.md
git commit -m "docs: amend reassembly spec with feed-table rule, framer wait, rebase semantics"
```

---

### Task 2: Spec parsing v0.3 (`spec.ts`)

**Files:**

- Modify: `packages/core/src/projection/spec.ts`
- Test: `packages/core/src/projection/spec-v03.test.ts` (create)

**Interfaces:**

- Produces: `StreamSpec { name, key, offset, framer, table, segments_table, max_buffer,
  messages }`, `StreamMessageLinkSpec { when, parser, table? }`, `DissectChainLinkSpec` with
  optional `parser`/`stream` (exactly one), `ProjectionSpec.version: '0.1'|'0.2'|'0.3'`,
  `ProjectionSpec.streams?: StreamSpec[]`.

- [ ] **Step 1: Write the failing tests** — `spec-v03.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseProjectionSpec } from './spec.js';

const base = `
version: '0.3'
format: streamy
tables:
  - name: chunks
    rows: $
    key: chunk_id
    columns:
      port: { expr: '_.port', type: uint16 }
  - name: flows
    rows: $
    key: flow_id
    columns:
      status: { expr: '_.status', type: utf8 }
  - name: msgs
    rows: $.message
    key: msg_id
    parent_key: { table: chunks, column: chunk_id }
    columns:
      text: { expr: '_.text', type: utf8 }
dissect:
  - from: chunks
    payload: _.payload
    chain:
      - { when: 'true', stream: byte_stream }
streams:
  - name: byte_stream
    key: chunk_key
    offset: _.seq
    framer: len_framer
    table: flows
    segments_table: flow_segments
    max_buffer: 64
    messages:
      - { when: 'true', parser: msg_parser, table: msgs }
`;

describe('projection spec v0.3', () => {
  it('parses streams and stream chain links', () => {
    const spec = parseProjectionSpec(base);
    expect(spec.version).toBe('0.3');
    expect(spec.streams).toHaveLength(1);
    expect(spec.streams![0]!.max_buffer).toBe(64);
    expect(spec.streams![0]!.messages[0]!.parser).toBe('msg_parser');
    expect(spec.dissect![0]!.chain[0]!.stream).toBe('byte_stream');
    expect(spec.dissect![0]!.chain[0]!.parser).toBeUndefined();
  });

  it('accepts numeric 0.3 and keeps 0.2 parsing unchanged', () => {
    expect(parseProjectionSpec(base.replace("version: '0.3'", 'version: 0.3')).version).toBe('0.3');
  });

  it('rejects streams below version 0.3', () => {
    expect(() => parseProjectionSpec(base.replace("version: '0.3'", "version: '0.2'"))).toThrowError(
      /PROJECTION_VERSION_REQUIRED|version 0.3/,
    );
  });

  it('rejects a stream chain link below version 0.3', () => {
    const v02 = `
version: '0.2'
format: f
tables:
  - name: t
    rows: $
    key: k
    columns:
      a: { expr: '_.a', type: uint8 }
dissect:
  - from: t
    payload: _.body
    chain:
      - { when: 'true', stream: s }
`;
    expect(() => parseProjectionSpec(v02)).toThrowError(/version 0.3/);
  });

  it('rejects a link with both parser and stream, and with neither', () => {
    expect(() =>
      parseProjectionSpec(base.replace('stream: byte_stream', 'stream: byte_stream, parser: p')),
    ).toThrowError(/exactly one of parser or stream/);
    expect(() => parseProjectionSpec(base.replace(', stream: byte_stream', ''))).toThrowError(
      /exactly one of parser or stream/,
    );
  });

  it('rejects table on a stream link', () => {
    expect(() =>
      parseProjectionSpec(base.replace('stream: byte_stream', 'stream: byte_stream, table: msgs')),
    ).toThrowError(/table is not allowed on a stream link/);
  });

  it('rejects a non-positive or non-integer max_buffer', () => {
    expect(() => parseProjectionSpec(base.replace('max_buffer: 64', 'max_buffer: 0'))).toThrow();
    expect(() => parseProjectionSpec(base.replace('max_buffer: 64', 'max_buffer: 1.5'))).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/spec-v03.test.ts`
Expected: FAIL (`streams` unknown key / version rejected).

- [ ] **Step 3: Implement in `spec.ts`**

Type additions/changes:

```ts
export interface DissectChainLinkSpec {
  when: string;
  parser?: string;
  stream?: string;
  table?: string;
}

export interface StreamMessageLinkSpec {
  when: string;
  parser: string;
  table?: string;
}

export interface StreamSpec {
  name: string;
  key: string;
  offset: string;
  framer: string;
  table: string;
  segments_table: string;
  max_buffer: number;
  messages: StreamMessageLinkSpec[];
}

export interface ProjectionSpec {
  version: '0.1' | '0.2' | '0.3';
  format: string;
  tables: TableSpec[];
  dissect?: DissectSpec[];
  streams?: StreamSpec[];
}
```

zod changes:

```ts
const chainLinkSpec = z
  .strictObject({
    when: nonEmptyString,
    parser: identifier.optional(),
    stream: identifier.optional(),
    table: identifier.optional(),
  })
  .superRefine((link, context) => {
    if ((link.parser === undefined) === (link.stream === undefined)) {
      context.addIssue({ code: 'custom', message: 'exactly one of parser or stream is required' });
    }
    if (link.stream !== undefined && link.table !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'table is not allowed on a stream link',
        path: ['table'],
      });
    }
  });

const messageLinkSpec = z.strictObject({
  when: nonEmptyString,
  parser: identifier,
  table: identifier.optional(),
});

const streamSpec = z.strictObject({
  name: identifier,
  key: identifier,
  offset: nonEmptyString,
  framer: identifier,
  table: identifier,
  segments_table: identifier,
  max_buffer: z.number().int().positive(),
  messages: z.array(messageLinkSpec).min(1),
});
```

`projectionSpec.version` union gains `z.literal('0.3'), z.literal(0.3)`; transform maps to the
string forms (`0.3`/`'0.3'` → `'0.3'`, `0.2`/`'0.2'` → `'0.2'`, else `'0.1'`).
`projectionSpec` gains `streams: z.array(streamSpec).optional()`.

Version gating after the existing v0.1 block:

```ts
if (parsed.data.version !== '0.3') {
  if (parsed.data.streams !== undefined) {
    throw new ProjectionCompileError('PROJECTION_VERSION_REQUIRED', 'streams', 'streams requires version 0.3');
  }
  const entryIndex = (parsed.data.dissect ?? []).findIndex((entry) =>
    entry.chain.some((link) => link.stream !== undefined),
  );
  if (entryIndex >= 0) {
    throw new ProjectionCompileError(
      'PROJECTION_VERSION_REQUIRED',
      `dissect.${entryIndex}.chain`,
      'stream chain links require version 0.3',
    );
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/spec-v03.test.ts src/projection/spec-v02.test.ts`
Expected: PASS (v0.2 suite untouched).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection/spec.ts packages/core/src/projection/spec-v03.test.ts
git commit -m "feat(core): parse projection spec v0.3 streams section and stream chain links"
```

---

### Task 3: `StreamAssembler` — pure reassembly buffer

**Files:**

- Create: `packages/core/src/projection/streams.ts`
- Test: `packages/core/src/projection/streams.test.ts` (create)

**Interfaces:**

- Produces (all exported from `streams.ts`):
  - `StreamKeyContext { node: unknown; ancestors: readonly unknown[] }`
  - `StreamKeyResult { key: string; root: Readonly<Record<string, unknown>> }`
  - `StreamKeyExtractor = (context: StreamKeyContext) => StreamKeyResult | null`
  - `StreamFramer = (buffer: Uint8Array) => number | null`
  - `StreamKeyRegistry = ReadonlyMap<string, StreamKeyExtractor>`
  - `StreamFramerRegistry = ReadonlyMap<string, StreamFramer>`
  - `StreamRegistries { keyExtractors?: StreamKeyRegistry; framers?: StreamFramerRegistry }`
  - `AssemblerSegment { start: number; end: number; srcStart: number; srcEnd: number }`
    (start/end are stream-relative to the CURRENT base)
  - `AssemblerAddResult = 'added' | 'rebased' | 'duplicate' | 'below_base' | 'overlap' | 'truncated'`
  - `class StreamAssembler`: `constructor(maxBuffer: number)`;
    `add(offset: number, bytes: Uint8Array, srcStart: number, srcEnd: number): AssemblerAddResult`;
    getters `base: number | null`, `segmentCount: number`, `byteCount: number`,
    `consumed: number`, `contiguousEnd: number`, `highestEnd: number`,
    `srcSpan: { start: number; end: number } | null`; methods `hasGap(): boolean`,
    `pendingBytes(): number`, `contiguousView(): Uint8Array`, `consume(length: number): void`,
    `segmentsOverlapping(start: number, end: number): AssemblerSegment[]`.

- [ ] **Step 1: Write the failing tests** — `streams.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { StreamAssembler } from './streams.js';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('StreamAssembler', () => {
  it('assembles in-order contributions into a contiguous view', () => {
    const a = new StreamAssembler(64);
    expect(a.add(100, bytes(1, 2), 10, 12)).toBe('added');
    expect(a.add(102, bytes(3), 20, 21)).toBe('added');
    expect(a.base).toBe(100);
    expect([...a.contiguousView()]).toEqual([1, 2, 3]);
    expect(a.byteCount).toBe(3);
    expect(a.segmentCount).toBe(2);
    expect(a.hasGap()).toBe(false);
  });

  it('reorders an out-of-order later segment', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1), 0, 1);
    expect(a.add(3, bytes(9), 30, 31)).toBe('added'); // gap 1..3
    expect(a.contiguousEnd).toBe(1);
    expect(a.hasGap()).toBe(true);
    expect(a.add(1, bytes(2, 3), 10, 12)).toBe('added'); // fills the gap
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 9]);
    expect(a.hasGap()).toBe(false);
  });

  it('rebases downward while nothing is consumed', () => {
    const a = new StreamAssembler(64);
    a.add(10, bytes(3, 4), 30, 32);
    expect(a.add(8, bytes(1, 2), 10, 12)).toBe('rebased');
    expect(a.base).toBe(8);
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 4]);
  });

  it('rejects a below-base segment once consumed', () => {
    const a = new StreamAssembler(64);
    a.add(10, bytes(1, 2), 0, 2);
    a.consume(1);
    expect(a.add(8, bytes(9, 9), 0, 2)).toBe('below_base');
  });

  it('drops exact duplicates silently and flags partial overlaps', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1, 2, 3), 0, 3);
    expect(a.add(0, bytes(1, 2, 3), 50, 53)).toBe('duplicate');
    expect(a.byteCount).toBe(3);
    expect(a.add(2, bytes(9, 9), 60, 62)).toBe('overlap');
  });

  it('reports truncated when a segment would exceed the cap (including via rebase)', () => {
    const a = new StreamAssembler(4);
    expect(a.add(0, bytes(1, 2, 3, 4, 5), 0, 5)).toBe('truncated');
    const b = new StreamAssembler(4);
    b.add(4, bytes(1, 2), 0, 2);
    expect(b.add(0, bytes(9), 10, 11)).toBe('truncated'); // extent 0..6 after rebase
  });

  it('consume advances the framing watermark and pendingBytes tracks the remainder', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1, 2, 3, 4), 0, 4);
    a.consume(3);
    expect(a.consumed).toBe(3);
    expect([...a.contiguousView()]).toEqual([4]);
    expect(a.pendingBytes()).toBe(1);
  });

  it('maps a relative range back to its contributing segments and overall srcSpan', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1, 2), 100, 102);
    a.add(2, bytes(3, 4), 200, 202);
    a.add(4, bytes(5), 300, 301);
    expect(a.segmentsOverlapping(1, 3).map((s) => s.srcStart)).toEqual([100, 200]);
    expect(a.srcSpan).toEqual({ start: 100, end: 301 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/streams.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `streams.ts`** — hook types (verbatim from Interfaces above, with the
      doc comments from the spec) plus:

```ts
interface StoredSegment {
  /** Absolute offset-space [start, end) (the raw `offset` values, not rebased). */
  start: number;
  end: number;
  srcStart: number;
  srcEnd: number;
}

export class StreamAssembler {
  readonly #maxBuffer: number;
  #base: number | null = null;
  #data = new Uint8Array(0);
  /** Sorted by start; absolute offset space. */
  #segments: StoredSegment[] = [];
  #consumed = 0;
  #contiguousEnd = 0; // relative to #base
  #byteCount = 0;

  constructor(maxBuffer: number) {
    this.#maxBuffer = maxBuffer;
  }

  get base(): number | null {
    return this.#base;
  }
  get segmentCount(): number {
    return this.#segments.length;
  }
  get byteCount(): number {
    return this.#byteCount;
  }
  get consumed(): number {
    return this.#consumed;
  }
  get contiguousEnd(): number {
    return this.#contiguousEnd;
  }
  get highestEnd(): number {
    if (this.#base === null || this.#segments.length === 0) return 0;
    return Math.max(...this.#segments.map((s) => s.end)) - this.#base;
  }
  get srcSpan(): { start: number; end: number } | null {
    if (this.#segments.length === 0) return null;
    return {
      start: Math.min(...this.#segments.map((s) => s.srcStart)),
      end: Math.max(...this.#segments.map((s) => s.srcEnd)),
    };
  }

  hasGap(): boolean {
    return this.highestEnd > this.#contiguousEnd;
  }
  pendingBytes(): number {
    return this.#contiguousEnd - this.#consumed;
  }
  contiguousView(): Uint8Array {
    return this.#data.subarray(this.#consumed, this.#contiguousEnd);
  }
  consume(length: number): void {
    this.#consumed += length;
  }

  segmentsOverlapping(start: number, end: number): AssemblerSegment[] {
    const base = this.#base ?? 0;
    return this.#segments
      .filter((s) => s.start - base < end && start < s.end - base)
      .map((s) => ({ start: s.start - base, end: s.end - base, srcStart: s.srcStart, srcEnd: s.srcEnd }));
  }

  add(offset: number, bytes: Uint8Array, srcStart: number, srcEnd: number): AssemblerAddResult {
    const end = offset + bytes.length;
    if (this.#segments.some((s) => s.start === offset && s.end === end)) return 'duplicate';
    if (this.#segments.some((s) => s.start < end && offset < s.end)) return 'overlap';

    const rebasing = this.#base !== null && offset < this.#base;
    if (rebasing && this.#consumed > 0) return 'below_base';
    const newBase = this.#base === null ? offset : Math.min(this.#base, offset);
    const newExtent = Math.max(end, ...this.#segments.map((s) => s.end), newBase) - newBase;
    if (newExtent > this.#maxBuffer) return 'truncated';

    if (rebasing) {
      const shift = this.#base! - newBase;
      const shifted = new Uint8Array(Math.max(this.#data.length + shift, newExtent));
      shifted.set(this.#data, shift);
      this.#data = shifted;
      // contiguousEnd is a filled-from-base frontier; a rebase moves the base, so reset it
      // here and let the frontier scan below recompute it from the (re-sorted) segments.
      this.#contiguousEnd = 0;
    }
    this.#base = newBase;

    const relStart = offset - this.#base;
    if (relStart + bytes.length > this.#data.length) {
      const grown = new Uint8Array(Math.max(relStart + bytes.length, this.#data.length * 2));
      grown.set(this.#data);
      this.#data = grown;
    }
    this.#data.set(bytes, relStart);

    const segment: StoredSegment = { start: offset, end, srcStart, srcEnd };
    const at = this.#segments.findIndex((s) => s.start > offset);
    if (at < 0) this.#segments.push(segment);
    else this.#segments.splice(at, 0, segment);
    this.#byteCount += bytes.length;

    let frontier = this.#contiguousEnd;
    for (const s of this.#segments) {
      if (s.start - this.#base > frontier) break;
      if (s.end - this.#base > frontier) frontier = s.end - this.#base;
    }
    this.#contiguousEnd = frontier;
    return rebasing ? 'rebased' : 'added';
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/streams.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection/streams.ts packages/core/src/projection/streams.test.ts
git commit -m "feat(core): add stream hook types and StreamAssembler reassembly buffer"
```

---

### Task 4: Stream compilation and validation (`project.ts`)

**Files:**

- Modify: `packages/core/src/projection/project.ts`
- Modify: `packages/core/src/projection/expression.ts` (one union member)
- Test: `packages/core/src/projection/stream-compile.test.ts` (create)

**Interfaces:**

- Consumes: Task 2 spec types, Task 3 hook types.
- Produces:
  - `ProjectionCompileErrorCode` gains `'PROJECTION_STREAM_INVALID'`.
  - `compileProjection(spec, registry?, streamRegistries?: StreamRegistries)`.
  - `CompiledStreamMessageLink { when: CompiledExpression; parserId: string; parser: RecordParser;
    table: CompiledProjectionTable | null }`.
  - `CompiledStream { name: string; keyExtractor: StreamKeyExtractor; offset: CompiledExpression;
    framer: StreamFramer; maxBuffer: number; flowTable: CompiledProjectionTable;
    segmentsTable: string; feedTable: string; feedKeyColumn: string;
    messages: readonly CompiledStreamMessageLink[] }`.
  - `CompiledChainLink` becomes `{ when; parserId: string | null; parser: RecordParser | null;
    table: CompiledProjectionTable | null; stream: CompiledStream | null }`.
  - `CompiledProjection` gains `streams: readonly CompiledStream[]` and
    `segmentsTables: readonly { name: string; feedKeyColumn: string }[]` (unique by name).
  - `CompiledProjectionTable` gains `readonly streamFed: boolean` (fed by a `messages` link →
    `tableOutputTypes` injects `stream_id: 'int64'` after the parent-key column).
  - `streamSegmentsOutputTypes(feedKeyColumn: string): Record<string, ArrowTypeName>` returning
    `{ segment_id: 'int64', stream_id: 'int64', [feedKeyColumn]: 'int64', offset: 'int64',
    _src_start: 'uint64', _src_end: 'uint64' }`.

**Validation rules (each is one test):**

1. `stream:` link referencing an undeclared stream → `PROJECTION_STREAM_INVALID`.
2. `stream:` link in a parser-rooted entry (`from` is not a table) → `PROJECTION_STREAM_INVALID`.
3. Two entries with different `from` tables feeding one stream → `PROJECTION_STREAM_INVALID`;
   a stream never fed by any link → `PROJECTION_STREAM_INVALID`.
4. Stream `name` colliding with a table name or a registered/chained parser id →
   `PROJECTION_STREAM_INVALID`.
5. Unknown `key` extractor id or `framer` id → `PROJECTION_STREAM_INVALID` (message names the
   missing registry entry).
6. `table` (flow table) undeclared, or declaring `parent_key`, or also dissect-fed/message-fed, or
   whose `rows` anchor is not `$` → `PROJECTION_STREAM_INVALID`. Flow tables are excluded from
   `rootTables`.
7. `segments_table` colliding with a declared table, stream, or parser id →
   `PROJECTION_STREAM_INVALID`. Two streams may share a `segments_table` only if they also share
   the feed table.
8. `messages[].parser` unregistered → `PROJECTION_PARSER_UNKNOWN`; `messages[].table` undeclared or
   missing `parent_key` → `PROJECTION_DISSECT_INVALID` (same texts as chain links); message-fed
   tables count as dissect-fed for Rule 3 and root exclusion.
9. Message-link `table.parent_key.table` must be *available at contribution time*: compute an
   availability fixpoint (below); unavailable → `PROJECTION_PARENT_KEY_INVALID`.
10. A message-fed (`streamFed`) table declaring a column or key named `stream_id` →
    `PROJECTION_SPEC_INVALID`.
11. Acyclicity (Rule 5) extends over stream nodes: edges `fromTable → streamName` and
    `streamName → message parserId`; a message parser whose deeper dissect chains back into the
    feed table → `PROJECTION_DISSECT_CYCLE`.
12. Message `when` compiles with an empty declared-state set and must not reference
    `_parent`/`indexes` (`rejectContextReferences`); stream `offset` compiles with an empty
    declared-state set (row-context references allowed).

**Availability fixpoint (implements rule 9):**

```ts
// avail(entry)      = entry.from is a table T ? {T} ∪ tableAvail(T) : parserAvail(entry.from)
// parserAvail[p]   ⊇ avail(e)  for every entry e whose chain has a parser link with parser p
// tableAvail[T]    ⊇ avail(e)  for every entry e whose chain has a parser link feeding table T
// streamAvail[X]   ⊇ avail(e)  for every entry e whose chain has a stream link targeting X
// tableAvail[Tmsg] ⊇ streamAvail[X]  for every message link of X feeding table Tmsg
// Iterate to fixpoint (sets only grow; the graph is small). Rule 9 checks
// parentKey.table ∈ streamAvail[X] for each message link with a table.
```

The existing `ancestorsByParser` fixpoint and Rule 7 stay untouched (parser-link behavior is
unchanged).

- [ ] **Step 1: Write the failing tests** — `stream-compile.test.ts`. Use this shared harness and
      one `it` per rule above (asserting `ProjectionCompileError.code`), plus one happy-path test
      asserting the compiled shape:

```ts
import { describe, expect, it } from 'vitest';
import { ProjectionCompileError } from './expression.js';
import { compileProjection, streamSegmentsOutputTypes, tableOutputTypes } from './project.js';
import { parseProjectionSpec } from './spec.js';
import type { StreamRegistries } from './streams.js';
import type { ParserRegistry } from './parsers.js';

const registry: ParserRegistry = new Map([
  ['chunk_parser', () => ({ root: {} })],
  ['msg_parser', () => ({ root: {} })],
]);
const streamRegistries: StreamRegistries = {
  keyExtractors: new Map([['chunk_key', () => ({ key: 'k', root: {} })]]),
  framers: new Map([['len_framer', () => null]]),
};

// The valid v0.3 spec from Task 2 (records → chunks feed table added so parent-key
// availability is exercised):
const validYaml = `
version: '0.3'
format: streamy
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      n: { expr: '_.n', type: uint8 }
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
      status: { expr: '_.status', type: utf8 }
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
    framer: len_framer
    table: flows
    segments_table: flow_segments
    max_buffer: 64
    messages:
      - { when: 'true', parser: msg_parser, table: msgs }
`;

const compile = (yaml: string) =>
  compileProjection(parseProjectionSpec(yaml), registry, streamRegistries);

const expectCode = (yaml: string, code: string) => {
  try {
    compile(yaml);
    expect.unreachable('expected compile to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectionCompileError);
    expect((error as ProjectionCompileError).code).toBe(code);
  }
};
```

Happy-path assertions:

```ts
it('compiles a valid stream graph', () => {
  const compiled = compile(validYaml);
  expect(compiled.streams).toHaveLength(1);
  const stream = compiled.streams[0]!;
  expect(stream.feedTable).toBe('chunks');
  expect(stream.feedKeyColumn).toBe('chunk_id');
  expect(stream.segmentsTable).toBe('flow_segments');
  expect(compiled.segmentsTables).toEqual([{ name: 'flow_segments', feedKeyColumn: 'chunk_id' }]);
  expect(compiled.rootTables.map((t) => t.name)).toEqual(['records']); // flows + msgs excluded
  const msgs = compiled.tables.find((t) => t.name === 'msgs')!;
  expect(msgs.streamFed).toBe(true);
  expect(Object.keys(tableOutputTypes(msgs))).toEqual([
    'msg_id',
    'record_id',
    'stream_id',
    'text',
    '_src_start',
    '_src_end',
  ]);
  expect(Object.keys(streamSegmentsOutputTypes('chunk_id'))).toEqual([
    'segment_id',
    'stream_id',
    'chunk_id',
    'offset',
    '_src_start',
    '_src_end',
  ]);
});
```

Each rule test mutates `validYaml` with `.replace(...)` (e.g. rule 2: change the stream link's
entry to `from: chunk_parser`; rule 9: change `msgs.parent_key.table` to a table not on the feed
path; rule 11: add a dissect entry `from: msg_parser` chaining `chunk_parser, table: chunks`
feeding back — expect `PROJECTION_DISSECT_CYCLE`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/stream-compile.test.ts`
Expected: FAIL (`compileProjection` has no third parameter; unknown exports).

- [ ] **Step 3: Implement**
- `expression.ts`: add `| 'PROJECTION_STREAM_INVALID'` to `ProjectionCompileErrorCode`.
- `project.ts`:
  1. Import the Task 3 types from `./streams.js`.
  2. Pre-scan `spec.streams` for `messages[].table` names → `streamFedNames: Set<string>`; the
     table compile loop sets `streamFed: streamFedNames.has(table.name)` and, when set, rejects a
     declared `stream_id` column/key (`PROJECTION_SPEC_INVALID`).
  3. `tableOutputTypes`: after the parent-key insertion, `if (table.streamFed)
     types.stream_id = 'int64';`. Add `streamSegmentsOutputTypes` (shape above).
  4. Build mutable stream records from `spec.streams` (resolve key extractor + framer from
     `streamRegistries`, compile `offset` via `compileCheckedExpression(entry.offset, new Set(),
     path)`, compile message links exactly like chain links but from `messageLinkSpec`), keyed in
     `streamByName`. `feedTable`/`feedKeyColumn` start `null` and are filled while compiling
     dissect chains (rule 3 on conflict); freeze streams after the dissect loop.
  5. Chain-link compile: branch on `link.stream !== undefined` → resolve via `streamByName`
     (rules 1–2), record the feeding `from` table, emit
     `{ when, parserId: null, parser: null, table: null, stream }`; else existing behavior with
     `stream: null`.
  6. Apply validation rules 4–10 (rule texts as in Step 1's expectations), the availability
     fixpoint (rule 9), and extend the cycle-detection edge map (rule 11).
  7. `CompiledProjection` return gains `streams` and `segmentsTables`; `rootTables` filter also
     excludes flow tables.

- [ ] **Step 4: Run all core tests**

Run: `pnpm --filter @byteql/core exec vitest run`
Expected: PASS — new suite green, `project.test.ts`/`dissect.test.ts` untouched behavior.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection/project.ts packages/core/src/projection/expression.ts packages/core/src/projection/stream-compile.test.ts
git commit -m "feat(core): compile and validate spec v0.3 stream declarations"
```

---

### Task 5: Runtime — contribution, framing, message emission, flush

**Files:**

- Modify: `packages/core/src/projection/project.ts`
- Modify: `packages/core/src/projection/session.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/projection/stream-runtime.test.ts` (create)

**Interfaces:**

- Consumes: Task 3 `StreamAssembler`, Task 4 compiled shapes.
- Produces (exported from `project.ts`):
  - `StreamRuntimeEntry { assembler: StreamAssembler; streamId: bigint;
    flowRoot: Record<string, unknown>; messageCount: number; framingStalled: boolean;
    stallMessage: string | null; status: 'ok' | 'gap' | 'truncated' | 'error' }`
  - `StreamsRuntime { flows: Map<string, Map<string, StreamRuntimeEntry>>;
    segmentKeys: Map<string, bigint> }`
  - `createStreamsRuntime(compiled: CompiledProjection): StreamsRuntime`
  - `flushStreams(emitContext: EmitContext): void`
  - `EmitContext` gains `readonly streams: StreamsRuntime | null`.
  - `projectInto(compiled, root, provenance, sink, runtimes, subset, issues?, streams?)` — new
    optional last parameter (default `null`).
  - Internal signature changes (not exported): `emitRow(..., baseOffset, enclosingLength,
    ancestors: readonly unknown[], parentKey?, extraColumns?: Readonly<Record<string, unknown>>,
    forcedKey?: bigint)`; `fireDissect(..., parentRange, baseOffset, enclosingLength,
    ancestors: readonly unknown[])`; `projectChildTable(..., emitContext, ancestors,
    streamMeta?: { streamId: bigint; span: SourceRange })`.
- `session.ts`: `createProjectionSession` builds one extra `TableBatchBuilder` per
  `compiled.segmentsTables` entry (types from `streamSegmentsOutputTypes`), creates a
  `StreamsRuntime`, passes it to `projectInto`, and `finish()` calls `flushStreams` first, then
  returns `compiled.tables` + segments tables (in that order).
- `index.ts`: export `createStreamsRuntime`, `flushStreams`, `streamSegmentsOutputTypes`,
  `CompiledStream`, and the Task 3 types (`StreamKeyContext`, `StreamKeyResult`,
  `StreamKeyExtractor`, `StreamFramer`, `StreamKeyRegistry`, `StreamFramerRegistry`,
  `StreamRegistries`), plus spec types `StreamSpec`, `StreamMessageLinkSpec`.

**Ancestor threading invariants (comment them in code):**

- `fireDissect`'s `ancestors` parameter includes the firing tree's root as its LAST element.
- `emitRow` holds `ancestors` = parse roots strictly above its own `root`; it calls `fireDissect`
  with `[...ancestors, root]`.
- Inside `fireDissect`, deeper recursion passes `[...ancestors, parsed.root]`;
  `projectChildTable` receives `ancestors` unchanged (it is the strictly-above stack for
  `parsed.root`).
- `projectInto`'s root-level `emitRow` gets `[]`.
- The key extractor is called with `{ node: context._, ancestors: ancestors.slice(0, -1) }`.

**Runtime semantics (from the amended spec):**

1. Stream link matched in `fireDissect` → `contributeToStream(...)`, then `return` (first match
   wins). Empty payload → no-op. `offset` expression must evaluate to a non-negative safe integer
   (accept bigint, convert) else `STREAM_ERROR` issue and skip. Extractor `null`/throw →
   `STREAM_KEY_INVALID` issue and skip.
2. New flow → reserve `streamId` from the flow table's runtime (`nextKey`, then increment), store
   `flowRoot = { ...keyResult.root }` (first contribution wins).
3. Inactive statuses (`truncated`/`error`) drop contributions silently.
4. `assembler.add` result handling: `duplicate` → silent; `below_base`/`overlap` → status
   `error` + `STREAM_ERROR` issue; `truncated` → status `truncated` + `STREAM_TRUNCATED` issue;
   `added`/`rebased` → emit one segments-table row `{ segment_id (from
   streams.segmentKeys, then increment), stream_id, [feedKeyColumn]:
   keysByTable.get(stream.feedTable) ?? null, offset: BigInt(<relative start> = offset −
   assembler.base), _src_start, _src_end }`, clear the framing stall on `rebased`, then run the
   framing loop.
5. Framing loop: while not stalled — `view = assembler.contiguousView()`; empty → stop;
   `length = framer(view)` (throw → stall with the error message; `null` → stop; non-positive or
   non-integer → stall; `> view.length` → stop and wait); else cut: `messageStart =
   assembler.consumed`, `messageBytes = view.subarray(0, length)` **copied before consume**
   (`Uint8Array.from` — a later rebase reallocates the buffer under the subarray),
   `assembler.consume(length)`, `messageCount += 1`, emit the message.
6. Message emission: exact span endpoints from contributing segments —
   `span.start = first.srcStart + (messageStart − first.start)`,
   `span.end = last.srcStart + (messageEnd − last.start)` where first/last =
   `assembler.segmentsOverlapping(messageStart, messageEnd)` boundary segments. Message context
   `{ _: { offset: messageStart, length }, _root: <same object> }`. First `messages` link whose
   `when` passes wins: parser throw → `DISSECT_PARSE_FAILED` issue (stage `dissecting`, span as
   range) and stop; else `projectChildTable(link.table, parsed, messageBytes, span.start,
   completingKeys, emitContext, [], { streamId, span })` when the link has a table, then deeper
   dissects `dissectByFrom.get(link.parserId)` fire with `baseOffset = span.start`,
   `enclosingLength = messageBytes.length`, `ancestors = [parsed.root]`.
   `completingKeys` is the CURRENT contribution's `keysByTable` (the packet whose arrival framed
   the message — chronologically last, even when its offset is earlier).
7. `projectChildTable` with `streamMeta`: provenance resolver returns `streamMeta.span`
   constantly (parser `resolve` ignored — comment why: relative offsets cannot map through a
   discontiguous reassembled buffer); `emitRow` is called with
   `extraColumns = { stream_id: streamMeta.streamId }`.
8. `emitRow` changes: `const key = forcedKey ?? runtime.nextKey; if (forcedKey === undefined)
   runtime.nextKey += 1n;` and after the parentKey line: `if (extraColumns)
   Object.assign(row, extraColumns);`.
9. `flushStreams`: for each stream, each flow entry — if status `ok` and
   (`assembler.hasGap()` → status `gap` + `STREAM_GAP` issue) else if `framingStalled` → status
   `error` + `STREAM_ERROR` issue (with `stallMessage`); flow root =
   `{ ...flowRoot, segment_count, byte_count, message_count, pending_bytes:
   assembler.pendingBytes(), status }`; provenance = `assembler.srcSpan ?? { start: 0, end: 0 }`;
   emit via `traverseAnchor(stream.flowTable.rows, root)` → `emitRow(..., forcedKey =
   entry.streamId)` with empty `keysByTable` and `ancestors = []`.
10. `projectTree` creates its own `StreamsRuntime`, flushes after the walk, and appends segments
    tables to its output (`ProjectedTable` entries with `streamSegmentsOutputTypes` types).

- [ ] **Step 1: Write the failing tests** — `stream-runtime.test.ts`. Harness (reuses Task 4's
      `validYaml` shape with real parsers/hooks):

```ts
import { describe, expect, it } from 'vitest';
import { IssueCollector } from '../issues.js';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import { createProjectionSession } from './session.js';
import type { ParserRegistry } from './parsers.js';
import type { StreamRegistries } from './streams.js';

// Same table/dissect/stream YAML as stream-compile.test.ts's validYaml, with flow columns:
//   flows: peer utf8, segment_count uint32, byte_count uint32, message_count uint32,
//          pending_bytes uint32, status utf8
// records root shape: { records: [{ n, body: { bytes, start } }] }
// chunk bytes layout: [port, seq, ...payload]
const yaml = `
version: '0.3'
format: streamy
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      n: { expr: '_.n', type: uint8 }
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
      pending_bytes: { expr: '_.pending_bytes', type: uint32 }
      status: { expr: '_.status', type: utf8 }
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
    framer: len_framer
    table: flows
    segments_table: flow_segments
    max_buffer: 64
    messages:
      - { when: 'true', parser: msg_parser, table: msgs }
`;

const registry: ParserRegistry = new Map([
  // chunk bytes: [port, seq, ...payload]; payload starts at byte 2 of the chunk buffer.
  [
    'chunk_parser',
    (bytes: Uint8Array) => ({
      root: {
        port: bytes[0],
        seq: bytes[1],
        payload: { bytes: bytes.subarray(2), start: 2 },
      },
    }),
  ],
  // message bytes: [len, ...ascii]; text decodes the ascii payload.
  [
    'msg_parser',
    (bytes: Uint8Array) => ({
      root: { message: { text: new TextDecoder().decode(bytes.subarray(1)) } },
    }),
  ],
]);

const streamRegistries: StreamRegistries = {
  keyExtractors: new Map([
    [
      'chunk_key',
      ({ node }) => {
        const port = (node as { port?: number }).port;
        if (typeof port !== 'number') return null;
        return { key: `flow-${port}`, root: { peer: `peer-${port}` } };
      },
    ],
  ]),
  // 1-byte length prefix; total = 1 + len. Throws on len 0.
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
];

// One record per chunk; chunk n at file offset n*100 for readable provenance.
const chunk = (port: number, seq: number, payload: number[]) =>
  Uint8Array.from([port, seq, ...payload]);
const project = (chunks: Uint8Array[], issues = new IssueCollector()) => {
  const compiled = compileProjection(parseProjectionSpec(yaml), registry, streamRegistries);
  const session = createProjectionSession(compiled, { issues });
  session.project(
    {
      records: chunks.map((bytes, index) => ({
        n: index,
        body: { bytes, start: index * 100 },
      })),
    },
    { resolve: () => ({ start: 0, end: 4 }) },
  );
  return { finished: session.finish(), issues };
};
const table = (finished: { name: string }[], name: string) =>
  finished.find((t) => t.name === name)! as never as {
    rowCount: number;
    arrow: { getChild(c: string): { toArray(): unknown; get(i: number): unknown } | null };
  };
```

Tests:

```ts
describe('stream runtime', () => {
  it('frames a message split across two in-order chunks and attributes it to the completing record', () => {
    // message: len=4, 'abcd' → bytes [4, 97, 98, 99, 100]; split [4,97,98] + [99,100]
    const { finished, issues } = project([
      chunk(7, 0, [4, 97, 98]),
      chunk(7, 3, [99, 100]),
    ]);
    expect(issues.issues()).toHaveLength(0);
    const msgs = table(finished, 'msgs');
    expect(msgs.rowCount).toBe(1);
    expect(msgs.arrow.getChild('text')!.get(0)).toBe('abcd');
    expect(msgs.arrow.getChild('record_id')!.get(0)).toBe(2n); // completing record
    expect(msgs.arrow.getChild('stream_id')!.get(0)).toBe(1n);
    const flows = table(finished, 'flows');
    expect(flows.rowCount).toBe(1);
    expect(flows.arrow.getChild('flow_id')!.get(0)).toBe(1n);
    expect(flows.arrow.getChild('peer')!.get(0)).toBe('peer-7');
    expect(flows.arrow.getChild('segment_count')!.get(0)).toBe(2);
    expect(flows.arrow.getChild('byte_count')!.get(0)).toBe(5);
    expect(flows.arrow.getChild('message_count')!.get(0)).toBe(1);
    expect(flows.arrow.getChild('pending_bytes')!.get(0)).toBe(0);
    expect(flows.arrow.getChild('status')!.get(0)).toBe('ok');
    const segments = table(finished, 'flow_segments');
    expect(segments.rowCount).toBe(2);
    expect(segments.arrow.getChild('stream_id')!.toArray()).toEqual(new BigInt64Array([1n, 1n]));
    expect(segments.arrow.getChild('chunk_id')!.toArray()).toEqual(new BigInt64Array([1n, 2n]));
    expect(segments.arrow.getChild('offset')!.toArray()).toEqual(new BigInt64Array([0n, 3n]));
  });

  it('cuts multiple messages from one contribution and separate flows stay separate', () => {
    // two 1-byte messages [1,65][1,66] in one chunk on port 7; port 9 gets its own flow
    const { finished } = project([chunk(7, 0, [1, 65, 1, 66]), chunk(9, 0, [1, 67])]);
    const msgs = table(finished, 'msgs');
    expect(msgs.rowCount).toBe(3);
    const flows = table(finished, 'flows');
    expect(flows.rowCount).toBe(2);
    expect(flows.arrow.getChild('flow_id')!.toArray()).toEqual(new BigInt64Array([1n, 2n]));
  });

  it('reassembles an out-of-order start via rebase, attributing to the chronologically last chunk', () => {
    // arrival order: [99,100] at seq 3, then [4,97,98] at seq 0 — completes on record 2
    const { finished, issues } = project([
      chunk(7, 3, [99, 100]),
      chunk(7, 0, [4, 97, 98]),
    ]);
    expect(issues.issues()).toHaveLength(0);
    const msgs = table(finished, 'msgs');
    expect(msgs.rowCount).toBe(1);
    expect(msgs.arrow.getChild('text')!.get(0)).toBe('abcd');
    expect(msgs.arrow.getChild('record_id')!.get(0)).toBe(2n);
    expect(table(finished, 'flows').arrow.getChild('status')!.get(0)).toBe('ok');
  });

  it('computes exact provenance spans per message', () => {
    // Record n's body sits at file offset n*100 and the chunk payload starts 2 bytes in
    // (the [port, seq] header), so chunk 0's payload covers stream [0, 3) at file [2, 5) and
    // chunk 1's payload covers stream [3, 5) at file [102, 104).
    // Message 1 [1, 65] occupies stream [0, 2) → file [2, 4).
    // Message 2 [2, 66, 67] starts at stream 2 → file 4, ends at stream 5 → file 104.
    const { finished } = project([chunk(7, 0, [1, 65, 2]), chunk(7, 3, [66, 67])]);
    const msgs = table(finished, 'msgs');
    expect(msgs.rowCount).toBe(2);
    expect(msgs.arrow.getChild('_src_start')!.toArray()).toEqual(new BigUint64Array([2n, 4n]));
    expect(msgs.arrow.getChild('_src_end')!.toArray()).toEqual(new BigUint64Array([4n, 104n]));
  });

  it('leaves a trailing incomplete message as pending bytes with status ok', () => {
    const { finished, issues } = project([chunk(7, 0, [5, 97, 98])]); // needs 6 bytes, has 3
    expect(issues.issues()).toHaveLength(0);
    const flows = table(finished, 'flows');
    expect(flows.arrow.getChild('status')!.get(0)).toBe('ok');
    expect(flows.arrow.getChild('pending_bytes')!.get(0)).toBe(3);
    expect(table(finished, 'msgs').rowCount).toBe(0);
  });

  it('stream_id stays null on rows fed by a non-stream path', () => {
    // A second dissect path feeding msgs directly (udp-analog) is not declared in this spec;
    // instead assert the msgs schema contains stream_id and chunks does not.
    const compiled = compileProjection(parseProjectionSpec(yaml), registry, streamRegistries);
    expect(compiled.tables.find((t) => t.name === 'chunks')!.streamFed).toBe(false);
    expect(compiled.tables.find((t) => t.name === 'msgs')!.streamFed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/stream-runtime.test.ts`
Expected: FAIL (flow_segments table missing / stream link ignored at runtime).

- [ ] **Step 3: Implement** per the semantics block above: `contributeToStream`,
      `frameStreamMessages`, `emitStreamMessage` (new functions in `project.ts`), the
      `emitRow`/`fireDissect`/`projectChildTable`/`projectInto`/`projectTree` signature changes,
      ancestor threading, `createStreamsRuntime`, `flushStreams`, `session.ts` wiring, and the
      `index.ts` exports listed in Interfaces.

- [ ] **Step 4: Run all core tests**

Run: `pnpm --filter @byteql/core exec vitest run`
Expected: PASS, including untouched `dissect.test.ts` / `project.test.ts` / `session.test.ts`
(signature changes are additive-optional at every exported surface).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection/project.ts packages/core/src/projection/session.ts packages/core/src/index.ts packages/core/src/projection/stream-runtime.test.ts
git commit -m "feat(core): reassemble streams at runtime with framing, attribution, and flush"
```

---

### Task 6: Runtime robustness — statuses and issues

**Files:**

- Modify: `packages/core/src/projection/project.ts` (only if Step 1 exposes gaps — the Task 5
  implementation should already cover these paths)
- Test: extend `packages/core/src/projection/stream-runtime.test.ts`
- [ ] **Step 1: Write the failing tests** (same harness):

```ts
describe('stream runtime robustness', () => {
  it('drops an exact duplicate silently', () => {
    const { finished, issues } = project([
      chunk(7, 0, [4, 97, 98]),
      chunk(7, 0, [4, 97, 98]), // retransmission
      chunk(7, 3, [99, 100]),
    ]);
    expect(issues.issues()).toHaveLength(0);
    expect(table(finished, 'msgs').rowCount).toBe(1);
    const flows = table(finished, 'flows');
    expect(flows.arrow.getChild('segment_count')!.get(0)).toBe(2);
    expect(flows.arrow.getChild('byte_count')!.get(0)).toBe(5);
    expect(table(finished, 'flow_segments').rowCount).toBe(2);
  });

  it('marks a partial overlap as error, keeps prior messages, and stops', () => {
    const { finished, issues } = project([
      chunk(7, 0, [1, 65]), // complete message, consumed
      chunk(7, 2, [3, 66, 67, 68]),
      chunk(7, 4, [9, 9]), // overlaps [2,6)
      chunk(7, 6, [1, 70]), // dropped: stream inactive
    ]);
    expect(issues.issues()).toEqual([
      expect.objectContaining({ stage: 'reassembling', code: 'STREAM_ERROR', recoverable: true }),
    ]);
    const flows = table(finished, 'flows');
    expect(flows.arrow.getChild('status')!.get(0)).toBe('error');
    expect(table(finished, 'msgs').rowCount).toBe(2); // 'A' + the [3,66,67,68] message framed before the overlap
  });

  it('marks a below-base segment after consumption as error', () => {
    const { finished, issues } = project([
      chunk(7, 10, [1, 65]), // framed immediately, consumed
      chunk(7, 8, [9, 9]), // below locked base
    ]);
    expect(issues.issues()).toEqual([
      expect.objectContaining({ code: 'STREAM_ERROR' }),
    ]);
    expect(table(finished, 'flows').arrow.getChild('status')!.get(0)).toBe('error');
  });

  it('truncates at the buffer cap, keeping completed messages', () => {
    // max_buffer 64: first a complete message, then a segment stretching past the cap
    const big = Array.from({ length: 63 }, (_, i) => i % 251);
    const { finished, issues } = project([
      chunk(7, 0, [1, 65]),
      chunk(7, 2, big), // extent 2+63 = 65 > 64
    ]);
    expect(issues.issues()).toEqual([
      expect.objectContaining({ code: 'STREAM_TRUNCATED' }),
    ]);
    const flows = table(finished, 'flows');
    expect(flows.arrow.getChild('status')!.get(0)).toBe('truncated');
    expect(table(finished, 'msgs').rowCount).toBe(1);
  });

  it('reports an unfilled gap once at finish', () => {
    const { finished, issues } = project([
      chunk(7, 0, [4, 97]), // bytes 0..2 of a 5-byte message
      chunk(7, 4, [100]), // gap at 2..4 never fills
    ]);
    expect(issues.issues()).toEqual([
      expect.objectContaining({ code: 'STREAM_GAP' }),
    ]);
    expect(table(finished, 'flows').arrow.getChild('status')!.get(0)).toBe('gap');
    expect(table(finished, 'msgs').rowCount).toBe(0);
  });

  it('stalls on a framer throw and reports error at finish (garbage stream)', () => {
    const { finished, issues } = project([chunk(7, 0, [0, 1, 2])]); // len byte 0 → framer throws
    expect(issues.issues()).toEqual([
      expect.objectContaining({ code: 'STREAM_ERROR', message: expect.stringContaining('zero-length') }),
    ]);
    expect(table(finished, 'flows').arrow.getChild('status')!.get(0)).toBe('error');
  });

  it('clears a framing stall when a rebase changes byte zero', () => {
    // First capture starts mid-stream: framer sees [0, 67] and throws (stall). The true start
    // then arrives at seq 0; the rebase shifts the buffer to [2, 65, 0, 67] and clears the
    // stall, so framing retries: len=2 → message [2, 65, 0] (text decodes [65, 0]), leaving
    // [67] as the pending tail of the next message.
    const { finished, issues } = project([
      chunk(7, 2, [0, 67]),
      chunk(7, 0, [2, 65]),
    ]);
    expect(issues.issues()).toHaveLength(0);
    expect(table(finished, 'msgs').rowCount).toBe(1);
    expect(table(finished, 'flows').arrow.getChild('status')!.get(0)).toBe('ok');
    expect(table(finished, 'flows').arrow.getChild('pending_bytes')!.get(0)).toBe(1);
  });

  it('skips empty payloads silently (no contribution, no flow)', () => {
    const { finished, issues } = project([chunk(7, 0, [])]);
    expect(issues.issues()).toHaveLength(0);
    expect(table(finished, 'flows').rowCount).toBe(0);
  });

  it('reports STREAM_KEY_INVALID and skips when the extractor returns null', () => {
    // Doctor the chunk parser to omit `port`, so chunk_key returns null.
    const badRegistry = new Map(registry);
    badRegistry.set('chunk_parser', (bytes: Uint8Array) => ({
      root: { seq: bytes[1], payload: { bytes: bytes.subarray(2), start: 2 } },
    }));
    const compiled = compileProjection(parseProjectionSpec(yaml), badRegistry, streamRegistries);
    const issues = new IssueCollector();
    const session = createProjectionSession(compiled, { issues });
    session.project(
      { records: [{ n: 0, body: { bytes: chunk(7, 0, [1, 65]), start: 0 } }] },
      { resolve: () => ({ start: 0, end: 4 }) },
    );
    const finished = session.finish();
    expect(issues.issues()).toEqual([
      expect.objectContaining({ stage: 'reassembling', code: 'STREAM_KEY_INVALID', recoverable: true }),
    ]);
    expect(finished.find((t) => t.name === 'flows')!.rowCount).toBe(0);
  });

  it('reports STREAM_ERROR when offset is not a non-negative integer', () => {
    // seq byte is uint8 so a negative offset needs a doctored parser: recompile with a
    // chunk_parser emitting seq: -1 and assert the issue.
    const badRegistry = new Map(registry);
    badRegistry.set('chunk_parser', (bytes: Uint8Array) => ({
      root: { port: bytes[0], seq: -1, payload: { bytes: bytes.subarray(2), start: 2 } },
    }));
    const compiled = compileProjection(parseProjectionSpec(yaml), badRegistry, streamRegistries);
    const issues = new IssueCollector();
    const session = createProjectionSession(compiled, { issues });
    session.project(
      { records: [{ n: 0, body: { bytes: chunk(7, 0, [1, 65]), start: 0 } }] },
      { resolve: () => ({ start: 0, end: 4 }) },
    );
    session.finish();
    expect(issues.issues()).toEqual([
      expect.objectContaining({ code: 'STREAM_ERROR', message: expect.stringContaining('offset') }),
    ]);
  });
});
```

- [ ] **Step 2: Run; fix any gaps in the Task 5 implementation until green**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/stream-runtime.test.ts`
Expected: PASS (fix `project.ts` inline where a path was missed).

- [ ] **Step 3: Full core suite + commit**

```bash
pnpm --filter @byteql/core exec vitest run && pnpm --filter @byteql/core check
git add packages/core/src/projection
git commit -m "test(core): cover stream reassembly statuses, issues, and edge paths"
```

---

### Task 7: pcap code hooks — flow key extractor and framers

**Files:**

- Modify: `packages/core/src/projection/expression.ts` (extract formatters)
- Modify: `packages/core/src/index.ts` (export them)
- Create: `packages/formats/pcap/src/streams.ts`
- Test: `packages/formats/pcap/test/streams.test.ts` (create)

**Interfaces:**

- Produces from core: `formatIpv4(value: unknown): string | null`,
  `formatIpv6(value: unknown): string | null` (exact bodies of the current `ip4_str`/`ip6_str`
  builtins, extracted to named exports; the builtins object references them —
  `ip4_str: formatIpv4, ip6_str: formatIpv6` — behavior unchanged).
- Produces from pcap `streams.ts`: `tcpFlowKey: StreamKeyExtractor`,
  `tlsRecord: StreamFramer`, `dnsTcp: StreamFramer`,
  `pcapStreamRegistries: StreamRegistries` =
  `{ keyExtractors: new Map([['tcp_flow_key', tcpFlowKey]]),
  framers: new Map([['tls_record', tlsRecord], ['dns_tcp', dnsTcp]]) }`.
- [ ] **Step 1: Write the failing tests** — `test/streams.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dnsTcp, tcpFlowKey, tlsRecord } from '../src/streams.js';

const ip4 = (a: number, b: number, c: number, d: number) => Uint8Array.of(a, b, c, d);

describe('tcpFlowKey', () => {
  const tcpNode = { src_port: 40000, dst_port: 53 };
  it('builds a directional key from the innermost IP ancestor', () => {
    const result = tcpFlowKey({
      node: tcpNode,
      ancestors: [
        { linktype: 1 },
        { ether_type: 0x0800 },
        { is_v4: true, src_addr: ip4(10, 0, 0, 1), dst_addr: ip4(10, 0, 0, 2) },
      ],
    });
    expect(result).toEqual({
      key: '10.0.0.1:40000→10.0.0.2:53',
      root: { src_addr: '10.0.0.1', src_port: 40000, dst_addr: '10.0.0.2', dst_port: 53 },
    });
  });
  it('formats IPv6 ancestors', () => {
    const addr = new Uint8Array(16);
    addr[15] = 1; // ::1
    const result = tcpFlowKey({
      node: tcpNode,
      ancestors: [{ is_v4: false, src_addr: addr, dst_addr: addr }],
    });
    expect(result!.root.src_addr).toBe('::1');
  });
  it('returns null without an IP ancestor or with malformed ports', () => {
    expect(tcpFlowKey({ node: tcpNode, ancestors: [{ ether_type: 0x0800 }] })).toBeNull();
    expect(
      tcpFlowKey({
        node: {},
        ancestors: [{ is_v4: true, src_addr: ip4(1, 1, 1, 1), dst_addr: ip4(2, 2, 2, 2) }],
      }),
    ).toBeNull();
  });
});

describe('framers', () => {
  it('tlsRecord frames the 5-byte header + body length, waiting on short headers', () => {
    expect(tlsRecord(Uint8Array.of(0x16, 3, 3))).toBeNull();
    expect(tlsRecord(Uint8Array.of(0x16, 3, 3, 0x00, 0x10))).toBe(5 + 16);
    expect(tlsRecord(Uint8Array.of(0x16, 3, 3, 0x00, 0x10, 1, 2))).toBe(21); // exceeds buffer: engine waits
  });
  it('tlsRecord throws on impossible content types and lengths', () => {
    expect(() => tlsRecord(Uint8Array.of(0x42, 3, 3, 0, 1))).toThrowError(/content type/);
    expect(() => tlsRecord(Uint8Array.of(0x16, 3, 3, 0, 0))).toThrowError(/length/);
    expect(() => tlsRecord(Uint8Array.of(0x16, 3, 3, 0x48, 0x01))).toThrowError(/length/); // > 18432
  });
  it('dnsTcp frames the 2-byte prefix + message, throwing on zero length', () => {
    expect(dnsTcp(Uint8Array.of(0))).toBeNull();
    expect(dnsTcp(Uint8Array.of(0x00, 0x05))).toBe(7);
    expect(() => dnsTcp(Uint8Array.of(0, 0))).toThrowError(/zero-length/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/pcap test -- --run test/streams.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — in `expression.ts` extract the two builtin bodies to
      `export const formatIpv4 = ...` / `export const formatIpv6 = ...` (builtin entries become
      references), export both from `index.ts`; then `packages/formats/pcap/src/streams.ts`:

```ts
/**
 * pcap stream hooks: the flow-key extractor and message framers the projection
 * YAML's `streams:` section references by id (see `parsers.ts` for the parser
 * registry counterpart). Pure functions over already-parsed wrapper roots
 * (`wrappers.ts`) and raw reassembled bytes.
 */

import type { StreamFramer, StreamKeyExtractor, StreamRegistries } from '@byteql/core';
import { formatIpv4, formatIpv6 } from '@byteql/core';

/** Innermost dissect ancestor that looks like an ip wrapper root. */
interface IpAncestor {
  is_v4: boolean;
  src_addr?: Uint8Array;
  dst_addr?: Uint8Array;
}

const isIpAncestor = (value: unknown): value is IpAncestor =>
  typeof value === 'object' && value !== null && typeof (value as IpAncestor).is_v4 === 'boolean';

/**
 * Directional TCP flow key: "src:sport→dst:dport" plus the flow metadata the
 * `streams` table projects. Null when no IP ancestor or malformed ports — the
 * engine reports STREAM_KEY_INVALID and skips the segment.
 */
export const tcpFlowKey: StreamKeyExtractor = ({ node, ancestors }) => {
  const tcp = node as { src_port?: unknown; dst_port?: unknown };
  if (typeof tcp.src_port !== 'number' || typeof tcp.dst_port !== 'number') return null;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (!isIpAncestor(ancestor)) continue;
    const format = ancestor.is_v4 ? formatIpv4 : formatIpv6;
    const src = format(ancestor.src_addr);
    const dst = format(ancestor.dst_addr);
    if (src === null || dst === null) return null;
    return {
      key: `${src}:${tcp.src_port}→${dst}:${tcp.dst_port}`,
      root: { src_addr: src, src_port: tcp.src_port, dst_addr: dst, dst_port: tcp.dst_port },
    };
  }
  return null;
};

/** TLS content types run 0x14 (change_cipher_spec) through 0x18 (heartbeat). */
const TLS_CONTENT_TYPE_MIN = 0x14;
const TLS_CONTENT_TYPE_MAX = 0x18;
/** TLSPlaintext max fragment (2^14) plus expansion headroom (RFC 8446 record_overflow). */
const TLS_MAX_RECORD_BODY = 16384 + 2048;

export const tlsRecord: StreamFramer = (buffer) => {
  if (buffer.length < 5) return null;
  const contentType = buffer[0]!;
  if (contentType < TLS_CONTENT_TYPE_MIN || contentType > TLS_CONTENT_TYPE_MAX) {
    throw new Error(`not a TLS record: content type ${contentType}`);
  }
  const length = (buffer[3]! << 8) | buffer[4]!;
  if (length === 0 || length > TLS_MAX_RECORD_BODY) {
    throw new Error(`not a TLS record: body length ${length}`);
  }
  return 5 + length;
};

export const dnsTcp: StreamFramer = (buffer) => {
  if (buffer.length < 2) return null;
  const length = (buffer[0]! << 8) | buffer[1]!;
  if (length === 0) throw new Error('zero-length DNS-over-TCP message');
  return 2 + length;
};

export const pcapStreamRegistries: StreamRegistries = {
  keyExtractors: new Map([['tcp_flow_key', tcpFlowKey]]),
  framers: new Map([
    ['tls_record', tlsRecord],
    ['dns_tcp', dnsTcp],
  ]),
};
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @byteql/pcap test -- --run test/streams.test.ts && pnpm --filter @byteql/core exec vitest run src/projection/expression.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/projection/expression.ts packages/core/src/index.ts packages/formats/pcap/src/streams.ts packages/formats/pcap/test/streams.test.ts
git commit -m "feat(pcap): add tcp flow-key extractor and tls/dns stream framers"
```

---

### Task 8: pcap spec v0.3 + wiring + multi-segment projection tests

**Files:**

- Modify: `packages/formats/pcap/pcap.tables.yaml`
- Modify: `packages/formats/pcap/src/project-pcap.ts` (compile call + nullability)
- Modify: `packages/formats/pcap/src/wrappers.ts` (comment update only, `dnsTcpMessage`)
- Modify: `packages/formats/pcap/test/build-pcap.ts` (tcp `seq` option)
- Test: extend `packages/formats/pcap/test/build-pcap.test.ts`,
  `packages/formats/pcap/test/project-pcap.test.ts`
- [ ] **Step 1: Extend the tcp builder** — `TcpOptions` gains `/** seq_num (default 0). */
  seq?: number;` and `tcp()` writes `view.setUint32(4, seq ?? 0, false);`. Add a round-trip
  assertion in `build-pcap.test.ts`'s tcp case: build with `seq: 1000`, parse via
  `gen/TcpSegment.js`, expect `seqNum === 1000`. Run
  `pnpm --filter @byteql/pcap test -- --run test/build-pcap.test.ts` → PASS. Commit:

```bash
git add packages/formats/pcap/test/build-pcap.ts packages/formats/pcap/test/build-pcap.test.ts
git commit -m "test(pcap): control tcp seq_num in fixture builder"
```

- [ ] **Step 2: Write the failing projection tests** — in `project-pcap.test.ts`. Shared helper:

```ts
const tcpPacket = (seq: number, payload: Uint8Array, srcPort = 40000, dstPort = 53) =>
  ethFrame({
    etherType: 0x0800,
    payload: ipv4({
      protocol: 6,
      src: '10.0.0.1',
      dst: '10.0.0.2',
      payload: tcp({ srcPort, dstPort, flags: 0x18, seq, payload }),
    }),
  });
const capture = (packets: Uint8Array[]) =>
  buildPcap({
    magic: 'be_us',
    linktype: 1,
    packets: packets.map((data, i) => ({ tsSec: i + 1, tsFrac: 0, data })),
  });
```

Tests:

```ts
describe('tcp stream reassembly', () => {
  it('reassembles a DNS-over-TCP message split across two segments', async () => {
    const payload = dnsOverTcp({ txId: 0xbeef, name: 'stream.example', type: 1 });
    const result = await parseAndProjectPcap(
      capture([tcpPacket(0, payload.subarray(0, 10)), tcpPacket(10, payload.subarray(10))]),
      new AbortController().signal,
    );
    expect(result.issues).toHaveLength(0);
    const dnsT = findTable(result, 'dns');
    expect(dnsT.numRows).toBe(1);
    expect(dnsT.get(0)!.query_name).toBe('stream.example');
    expect(dnsT.get(0)!.packet_id).toBe(2n); // completing packet
    expect(dnsT.get(0)!.stream_id).toBe(1n);
    const streams = findTable(result, 'streams');
    expect(streams.numRows).toBe(1);
    const flow = streams.get(0)!;
    expect(flow.src_addr).toBe('10.0.0.1');
    expect(flow.dst_port).toBe(53);
    expect(flow.status).toBe('ok');
    expect(flow.message_count).toBe(1);
    const segs = findTable(result, 'stream_segments');
    expect(segs.numRows).toBe(2);
    expect(segs.get(0)!.stream_id).toBe(1n);
    expect(segs.get(0)!.tcp_id).toBe(1n);
    expect(segs.get(1)!.tcp_id).toBe(2n);
  });

  it('reassembles a TLS ClientHello split across three out-of-order segments', async () => {
    const record = tlsClientHello({ sni: 'split.example' });
    const third = Math.ceil(record.length / 3);
    const [s1, s2, s3] = [
      record.subarray(0, third),
      record.subarray(third, 2 * third),
      record.subarray(2 * third),
    ];
    const result = await parseAndProjectPcap(
      capture([
        tcpPacket(third, s2, 50000, 443), // out-of-order first capture
        tcpPacket(0, s1, 50000, 443),
        tcpPacket(2 * third, s3, 50000, 443),
      ]),
      new AbortController().signal,
    );
    expect(result.issues).toHaveLength(0);
    const tlsT = findTable(result, 'tls');
    expect(tlsT.numRows).toBe(1);
    expect(tlsT.get(0)!.sni).toBe('split.example');
    expect(tlsT.get(0)!.packet_id).toBe(3n);
    expect(findTable(result, 'stream_segments').numRows).toBe(3);
  });

  it('drops a retransmitted segment without an issue', async () => {
    const payload = dnsOverTcp({ txId: 1, name: 'dup.example', type: 1 });
    const result = await parseAndProjectPcap(
      capture([
        tcpPacket(0, payload.subarray(0, 8)),
        tcpPacket(0, payload.subarray(0, 8)),
        tcpPacket(8, payload.subarray(8)),
      ]),
      new AbortController().signal,
    );
    expect(result.issues).toHaveLength(0);
    expect(findTable(result, 'dns').numRows).toBe(1);
    expect(findTable(result, 'streams').get(0)!.segment_count).toBe(2);
  });

  it('marks a gapped stream and emits no message', async () => {
    const payload = dnsOverTcp({ txId: 2, name: 'gap.example', type: 1 });
    const result = await parseAndProjectPcap(
      capture([tcpPacket(0, payload.subarray(0, 8)), tcpPacket(12, payload.subarray(12))]),
      new AbortController().signal,
    );
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'STREAM_GAP' }),
    ]);
    expect(findTable(result, 'dns').numRows).toBe(0);
    expect(findTable(result, 'streams').get(0)!.status).toBe('gap');
  });

  it('keeps udp dns rows with a null stream_id', async () => {
    const result = await parseAndProjectPcap(pcap, new AbortController().signal); // existing udp fixture
    expect(findTable(result, 'dns').get(0)!.stream_id).toBeNull();
  });
});
```

Run: `pnpm --filter @byteql/pcap test -- --run test/project-pcap.test.ts`
Expected: FAIL (`streams` table unknown — YAML still v0.2).

- [ ] **Step 3: Rewrite `pcap.tables.yaml`** — bump `version: '0.3'`; keep the 8 existing tables
      verbatim; append:

```yaml
  - name: streams
    rows: $
    key: stream_id
    columns:
      src_addr: { expr: _.src_addr, type: utf8 }
      src_port: { expr: _.src_port, type: uint16 }
      dst_addr: { expr: _.dst_addr, type: utf8 }
      dst_port: { expr: _.dst_port, type: uint16 }
      segment_count: { expr: _.segment_count, type: uint32 }
      byte_count: { expr: _.byte_count, type: uint32 }
      message_count: { expr: _.message_count, type: uint32 }
      pending_bytes: { expr: _.pending_bytes, type: uint32 }
      status: { expr: _.status, type: utf8 }
```

Replace the `from: tcp_segment` dissect entry with:

```yaml
  - from: tcp
    payload: _.body
    chain:
      - { when: _.dst_port == 443 or _.src_port == 443, stream: tls_stream }
      - { when: _.dst_port == 53 or _.src_port == 53, stream: dns_tcp_stream }
```

Append the streams section:

```yaml
streams:
  - name: tls_stream
    key: tcp_flow_key
    offset: _.seq_num
    framer: tls_record
    table: streams
    segments_table: stream_segments
    max_buffer: 1048576
    messages:
      - { when: _.offset == 0, parser: tls_client_hello, table: tls }
  - name: dns_tcp_stream
    key: tcp_flow_key
    offset: _.seq_num
    framer: dns_tcp
    table: streams
    segments_table: stream_segments
    max_buffer: 1048576
    messages:
      - { when: 'true', parser: dns_tcp_message, table: dns }
```

- [ ] **Step 4: Wire the registries** — `project-pcap.ts`:

```ts
import { pcapStreamRegistries } from './streams.js';

const compiledProjection = compileProjection(
  parseProjectionSpec(tablesYaml),
  pcapParserRegistry,
  pcapStreamRegistries,
);
```

`pcapNullability` additions:

```ts
  tcp: new Set(['_src_start', '_src_end']),
  dns: new Set(['_src_start', '_src_end', 'query_name', 'query_type', 'stream_id']),
  tls: new Set(['_src_start', '_src_end', 'sni', 'stream_id']),
  streams: new Set(['_src_start', '_src_end']),
  stream_segments: new Set(['_src_start', '_src_end', 'tcp_id']),
```

`wrappers.ts`: update `dnsTcpMessage`'s doc comment — the framer now guarantees a complete
message, the length guard stays as a defensive check.

- [ ] **Step 5: Run the full pcap suite**

Run: `pnpm --filter @byteql/pcap test -- --run`
Expected: PASS — new reassembly tests AND all existing single-segment tests with unchanged row
values (the regression guard: `dns` `_src_start === 82`, single-segment DNS-over-TCP, TLS SNI,
empty/handshake segments emitting no rows).

- [ ] **Step 6: Commit**

```bash
git add packages/formats/pcap/pcap.tables.yaml packages/formats/pcap/src packages/formats/pcap/test
git commit -m "feat(pcap): reassemble tcp streams for multi-segment tls and dns-over-tcp"
```

---

### Task 9: Pack surface — schemas, queries

**Files:**

- Modify: `packages/formats/pcap/src/pack.ts`
- Modify: `packages/formats/pcap/queries.yaml`
- Test: extend `packages/formats/pcap/test/pack.test.ts`
- [ ] **Step 1: Write the failing tests** — in `pack.test.ts`, add:

```ts
it('declares schemas for streams and stream_segments, and stream_id on tls/dns', () => {
  const schemas = pcapFormatPack.schemas();
  const byName = new Map(schemas.map((s) => [s.name, s]));
  expect(byName.get('streams')!.columns.map((c) => c.name)).toEqual([
    'stream_id', 'src_addr', 'src_port', 'dst_addr', 'dst_port',
    'segment_count', 'byte_count', 'message_count', 'pending_bytes', 'status',
    '_src_start', '_src_end',
  ]);
  expect(byName.get('stream_segments')!.columns.map((c) => c.name)).toEqual([
    'segment_id', 'stream_id', 'tcp_id', 'offset', '_src_start', '_src_end',
  ]);
  expect(byName.get('dns')!.columns.map((c) => c.name)).toContain('stream_id');
  expect(byName.get('tls')!.columns.map((c) => c.name)).toContain('stream_id');
  const dnsStreamId = byName.get('dns')!.columns.find((c) => c.name === 'stream_id')!;
  expect(dnsStreamId.nullable).toBe(true);
});
```

Run: `pnpm --filter @byteql/pcap test -- --run test/pack.test.ts` → FAIL.

- [ ] **Step 2: Implement** — `pack.ts`: insert `['stream_id', 'int64']` after `['packet_id',
  'int64']` in the `dns` and `tls` entries; append before `errors`:

```ts
  columns('streams', [
    ['stream_id', 'int64'],
    ['src_addr', 'utf8'],
    ['src_port', 'uint16'],
    ['dst_addr', 'utf8'],
    ['dst_port', 'uint16'],
    ['segment_count', 'uint32'],
    ['byte_count', 'uint32'],
    ['message_count', 'uint32'],
    ['pending_bytes', 'uint32'],
    ['status', 'utf8'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('stream_segments', [
    ['segment_id', 'int64'],
    ['stream_id', 'int64'],
    ['tcp_id', 'int64'],
    ['offset', 'int64'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
```

`queries.yaml`: extend the `overview` union with `union all select 'streams', count(*) from
streams` and `union all select 'stream_segments', count(*) from stream_segments`; append:

```yaml
  - id: tcp_flows
    title: TCP flows
    kind: grid
    sql: |
      select s.stream_id, s.src_addr, s.src_port, s.dst_addr, s.dst_port,
             s.status, s.message_count, s.byte_count, s.pending_bytes
      from streams s
      order by s.stream_id
      limit 100;
```

- [ ] **Step 3: Run and commit**

Run: `pnpm --filter @byteql/pcap test -- --run && pnpm --filter @byteql/pcap check`
Expected: PASS.

```bash
git add packages/formats/pcap/src/pack.ts packages/formats/pcap/queries.yaml packages/formats/pcap/src/pcap-queries.generated.ts packages/formats/pcap/src/pcap-tables.generated.ts
git commit -m "feat(pcap): expose streams and stream_segments schemas and a tcp flows query"
```

(The `.generated.ts` files are rewritten by `generate:pack` during `test`/`check`; commit them
together with their sources.)

---

### Task 10: e2e — multi-segment fixture and browser assertion

**Files:**

- Create: `packages/formats/pcap/test/generate-e2e-fixture.test.ts`
- Create: `apps/web/e2e/fixtures/dns-stream.pcap` (generated, committed)
- Modify: `apps/web/e2e/pcap.spec.ts`
- [ ] **Step 1: Add the gated generator test**:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

import { buildPcap, dnsOverTcp, ethFrame, ipv4, tcp } from './build-pcap.js';

// Regenerates apps/web/e2e/fixtures/dns-stream.pcap. Skipped unless explicitly requested:
//   GENERATE_E2E_FIXTURES=1 pnpm --filter @byteql/pcap test -- --run test/generate-e2e-fixture.test.ts
it.runIf(process.env.GENERATE_E2E_FIXTURES === '1')('writes the dns-stream e2e fixture', () => {
  const payload = dnsOverTcp({ txId: 0xbeef, name: 'stream.example', type: 1 });
  const packet = (seq: number, data: Uint8Array) =>
    ethFrame({
      etherType: 0x0800,
      payload: ipv4({
        protocol: 6,
        src: '10.0.0.1',
        dst: '10.0.0.2',
        payload: tcp({ srcPort: 40000, dstPort: 53, flags: 0x18, seq, payload: data }),
      }),
    });
  const pcap = buildPcap({
    magic: 'be_us',
    linktype: 1,
    packets: [
      { tsSec: 1, tsFrac: 0, data: packet(0, payload.subarray(0, 10)) },
      { tsSec: 1, tsFrac: 100, data: packet(10, payload.subarray(10)) },
    ],
  });
  const target = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../apps/web/e2e/fixtures/dns-stream.pcap',
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, pcap);
});
```

- [ ] **Step 2: Generate the fixture**

Run: `GENERATE_E2E_FIXTURES=1 pnpm --filter @byteql/pcap test -- --run test/generate-e2e-fixture.test.ts`
Expected: PASS; `apps/web/e2e/fixtures/dns-stream.pcap` exists (verify with `ls -l`).

- [ ] **Step 3: Add the e2e test** — in `apps/web/e2e/pcap.spec.ts`:

```ts
const streamPcapPath = fileURLToPath(new URL('./fixtures/dns-stream.pcap', import.meta.url));

test('reassembles a two-segment DNS-over-TCP query and joins its stream tables', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);

  await page.getByLabel('Open file').setInputFiles(streamPcapPath);
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();

  await runSql(
    page,
    `select d.query_name, s.status, count(g.segment_id) as segments
     from dns d
     join streams s using (stream_id)
     join stream_segments g using (stream_id)
     group by d.query_name, s.status`,
  );
  await expect(page.getByRole('gridcell', { name: 'stream.example' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'ok', exact: true })).toBeVisible();
});
```

- [ ] **Step 4: Run the e2e suite**

Run: `pnpm --filter @byteql/web test:e2e`
Expected: PASS (both pcap e2e tests).

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap/test/generate-e2e-fixture.test.ts apps/web/e2e/fixtures/dns-stream.pcap apps/web/e2e/pcap.spec.ts
git commit -m "test(web): e2e-verify multi-segment dns-over-tcp reassembly"
```

---

### Task 11: Full gate + status docs

**Files:**

- Modify: `AGENTS.md` (phase status section)

- [ ] **Step 1: Full verification gate**

Run, in order, expecting all green:

```bash
pnpm -r check
pnpm -r test -- --run
pnpm --filter @byteql/web check:bundle
pnpm --filter @byteql/web test:e2e
```

- [ ] **Step 2: Update `AGENTS.md`** — record: engine spec v0.3 stream reassembly shipped
      (streams section, key-extractor/framer registries, `streams`/`stream_segments` tables,
      `stream_id` injection); pcap now reassembles multi-segment TLS ClientHello and
      DNS-over-TCP; note the documented limitations (no FIN/RST teardown → 4-tuple reuse merges;
      no partial-overlap reconciliation; no seq wraparound; single-record ClientHello).

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: record phase-2 tcp stream reassembly status"
```

---

## Self-review notes

- **Spec coverage:** spec surface (Task 2), registries + validation (Tasks 3–4), runtime
  semantics incl. attribution/provenance/flush (Tasks 5–6), pcap hooks (Task 7), pack spec and
  replacement of the single-segment path (Task 8), schemas/queries (Task 9), e2e + regression
  gate (Tasks 10–11). Spec deviations (feed-table rule, framer wait semantics, rebase/stall) are
  folded back into the spec document by Task 1.
- **Type consistency:** `StreamKeyExtractor`/`StreamFramer`/`StreamRegistries` (Task 3) are the
  exact types consumed by `compileProjection` (Task 4), `pcapStreamRegistries` (Task 7), and the
  session wiring (Task 5). `feedKeyColumn` = feed table's `key` name (`chunk_id` in engine tests,
  `tcp_id` in pcap). Status strings and issue codes match the Global Constraints everywhere.
