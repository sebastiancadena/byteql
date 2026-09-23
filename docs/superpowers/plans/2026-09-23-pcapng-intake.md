# pcapng Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept pcapng captures as a second container of the `pcap` pack, with packet parity
against classic pcap, a new `interfaces` table, and `packets.interface_id`/`comment`/`ts_ns`.

**Architecture:** A hand-written, streaming pcapng block reader (`src/pcapng.ts`) sits on a
chunk-window helper extracted from the classic reader (`src/chunk-window.ts`). A new `pcapng`
framer maps reader items to `FramedRecord`s (`tables: ['interfaces']` or `['packets']`); the classic
framer yields one synthetic interface record from its global header. The projection spec, dissect
graph, streams, and queries are shared by both containers.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), apache-arrow 21, vitest 4,
Playwright, pnpm workspaces, the pack kit (`definePack`, `Framer`, `byteql-pack build`).

**Spec:** `docs/superpowers/specs/2026-09-23-pcapng-intake-design.md` — read it first (especially
"Block framing", "Timestamps", and "Errors"); this plan argues from it. Also read
`docs/pack-authoring.md` ("Framers" and "Adding a container to an existing pack").

## Global Constraints

- Dependency direction stays `app → db → core ← formats`; no change to `packages/core` is needed
  or allowed by this plan.
- Privacy: no network, CDN, or runtime-loaded code; `pnpm --filter @byteql/web check:bundle` and
  `apps/web/e2e/privacy.spec.ts` must stay green.
- Engine invariants: spec/compile errors throw at load; row-time evaluation returns null; a
  malformed block becomes an `errors` row — only an unreadable first Section Header Block is a
  `PackFatalError`.
- Existing classic-pcap column **values** never change. Allowed classic deltas, all additive: the
  synthetic `interfaces` row, the `interface_id`/`comment`/`ts_ns` columns, and `ts` nullable.
- `packets.ts` stays `timestamp_us`; `ts_ns` is `int64` epoch nanoseconds.
- Framers call `ctx.bytes()` **before** each `yield`.
- Commits: conventional-commit messages, **no `Co-Authored-By` trailers, no AI-assistant or vendor
  names, no absolute `/home/...` paths** in any committed file or message (a pre-commit hook
  enforces the vendor-name rule).
- Never publish `apps/web/dist-e2e`; deployable output is `apps/web/dist`.
- TDD; pcap package tests live under `packages/formats/pcap/test/`; keep test output pristine.
- Markdown: run `rumdl fmt <file>` on every `.md` you write (MD013 up to ~100 chars is accepted).
- Running one pcap test file: `pnpm --filter @byteql/core build && pnpm --filter @byteql/pcap exec byteql-pack build && pnpm --filter @byteql/pcap exec vitest run test/<file>`
  (do **not** use `pnpm --filter @byteql/pcap test -- --run <file>`: pnpm mangles the file filter
  and the whole suite runs).
- Gate per task: the whole pcap suite `pnpm --filter @byteql/pcap test -- --run`, then
  `pnpm -r check`. Full gate at Tasks 8 and 10: `pnpm check`, `pnpm lint`, `pnpm -r test -- --run`,
  `pnpm --filter @byteql/web check:bundle`, `pnpm --filter @byteql/web test:e2e`.
- Never regenerate goldens with `-u` except in the one step that says so; review the diff.

## Review Focus

1. **A malformed IDB followed by packets referencing later interfaces** — expected: indices stay
   positional, so packets bind to the right interface, and packets pointing at the malformed one
   become `UNKNOWN_INTERFACE` rows. Pinned in Task 6.
2. **A block that straddles a chunk edge and is held across later `next()` calls on a recycling
   `ByteSource`** — expected: its body bytes stay intact (the straddle-copy rule). Pinned in
   Task 5.
3. **Hostile timestamp resolution/offset (`10^0` with 2^64-1 units, huge `if_tsoffset`)** —
   expected: packet kept, `ts`/`ts_ns` null, `TIMESTAMP_OUT_OF_RANGE` row; never an Arrow build
   crash. Pinned in Task 6.
4. **A mixed `.pcap` + `.pcapng` session, and a join between `packets` and `interfaces`** —
   expected: each file probes to its own container; keys restart per file, so the join must also
   match `_src_file`. Pinned in Task 7 (key alignment) and Task 8 (e2e).
5. **A pcapng written with big-endian sections or an endianness flip between sections** —
   expected: identical rows to the little-endian equivalent. Pinned in Task 5.

---

## File Map

Under `packages/formats/pcap/`:

| File | Action | Responsibility |
|---|---|---|
| `src/chunk-window.ts` | Create | Chunk-window reads over a `ByteSource`; straddle-copy rule |
| `src/container.ts` | Modify | Classic reader on `ChunkWindow`; `ts_frac_ns`; export `normalizeLinktype` |
| `src/options.ts` | Create | pcapng option TLV walker + UTF-8 option text |
| `src/pcapng.ts` | Create | Streaming pcapng block reader |
| `src/framer.ts` | Modify | Shared root builders; classic synthetic interface; `pcapngFramer` |
| `src/probe.ts` | Create | `probePcapng` hook |
| `src/index.ts` | Modify | Register `pcapng` framer and probe |
| `pack.yaml` | Modify | Second container |
| `pcap.tables.yaml` | Modify | `interfaces` table; `packets` columns |
| `queries.yaml` | Modify | Overview adds `interfaces`; "Packets by interface" preset |
| `test/chunk-window.test.ts` | Create | Helper unit tests |
| `test/options.test.ts` | Create | Option walker tests |
| `test/build-pcapng.ts` | Create | Deterministic pcapng byte builder (tests only) |
| `test/build-pcapng.test.ts` | Create | Builder self-tests |
| `test/pcapng-fixtures.ts` | Create | Shared pcapng fixtures (multi-section, dns-stream) |
| `test/pcapng.test.ts` | Create | Reader tests: blocks, timestamps, straddles |
| `test/pcapng-errors.test.ts` | Create | Reader tests: every error code |
| `test/pcapng-pack.test.ts` | Create | Probe, parity, key alignment, interface rows |
| `test/fixtures.list.ts` | Modify | pcapng conformance fixtures |
| `test/pack.test.ts` | Modify | Table list and packets/interfaces schema |
| `test/schemas.snapshot.json` | Modify | Regenerated once (Task 3) |
| `test/goldens/*.golden.json` | Modify/Create | Regenerated once (Task 3), new pcapng goldens (Task 7) |
| `test/fixtures/manifest.md` | Modify | Document `build-pcapng.ts` |

Under `apps/web/`: `src/assets/http2-16-ssl.pcapng` (+ `PROVENANCE.md`),
`src/lib/session/samples.ts` (+ test), `e2e/fixtures/sample.pcapng`, `e2e/pcap.spec.ts`,
`e2e/hex-provenance.spec.ts`, `e2e/support/capture.ts`, `e2e/scale-metrics.spec.ts`,
`scripts/run-scale-bench.mjs`. Docs: `docs/pack-authoring.md`, `AGENTS.md`, `README.md`,
`ROADMAP.md`, the spec's implementation notes.

---

### Task 1: Extract the chunk window from the classic reader

A pure refactor: classic framing must behave exactly as before. `container.test.ts` and the
conformance goldens must pass **unchanged**.

**Files:**

- Create: `packages/formats/pcap/src/chunk-window.ts`
- Modify: `packages/formats/pcap/src/container.ts` (the `chunk`/`chunkStart`/`generation`/`ensure`
  locals inside `createPcapFramer`, and the raw-IP block in `next()`)
- Test: `packages/formats/pcap/test/chunk-window.test.ts`

**Interfaces:**

- Produces:
  - `interface WindowRead { bytes: Uint8Array; isChunkView: boolean }`
  - `interface ChunkWindow { readonly generation: number; ensure(absoluteStart: number, length: number): Promise<WindowRead>; stable(read: WindowRead, generationAtStart: number): Uint8Array }`
  - `createChunkWindow(source: ByteSource, chunkBytes: number, start: number): ChunkWindow`
  - `normalizeLinktype(linktype: number, body: Uint8Array): number` exported from `container.ts`
    (101 → 228/229 by the first byte's version nibble; anything else unchanged)

- [ ] **Step 1: Write the failing test**

`packages/formats/pcap/test/chunk-window.test.ts`:

```ts
import { memoryByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { createChunkWindow } from '../src/chunk-window.js';
import { normalizeLinktype } from '../src/container.js';

const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);

describe('createChunkWindow', () => {
  it('returns views into one chunk while reads stay inside it', async () => {
    const window = createChunkWindow(memoryByteSource(bytes), 32, 0);
    const first = await window.ensure(0, 8);
    const generation = window.generation;
    const second = await window.ensure(8, 8);
    expect(first.isChunkView).toBe(true);
    expect(second.isChunkView).toBe(true);
    expect(window.generation).toBe(generation);
    expect([...second.bytes]).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('reloads at the requested offset and bumps the generation when a read leaves the window', async () => {
    const window = createChunkWindow(memoryByteSource(bytes), 32, 0);
    await window.ensure(0, 8);
    const before = window.generation;
    const read = await window.ensure(30, 8);
    expect(window.generation).toBe(before + 1);
    expect([...read.bytes]).toEqual([30, 31, 32, 33, 34, 35, 36, 37]);
  });

  it('reads an oversized span directly, without touching the window', async () => {
    const window = createChunkWindow(memoryByteSource(bytes), 16, 0);
    await window.ensure(0, 4);
    const before = window.generation;
    const read = await window.ensure(10, 40);
    expect(read.isChunkView).toBe(false);
    expect(window.generation).toBe(before);
    expect(read.bytes).toHaveLength(40);
    expect(read.bytes[0]).toBe(10);
  });

  it('stable() copies a chunk view only when a reload happened since generationAtStart', async () => {
    const window = createChunkWindow(memoryByteSource(bytes), 32, 0);
    const start = window.generation;
    const inWindow = await window.ensure(0, 4);
    expect(window.stable(inWindow, start)).toBe(inWindow.bytes);
    const straddled = await window.ensure(30, 4);
    const copy = window.stable(straddled, start);
    expect(copy).not.toBe(straddled.bytes);
    expect([...copy]).toEqual([...straddled.bytes]);
  });
});

describe('normalizeLinktype', () => {
  it('maps raw IP 101 by version nibble and leaves others alone', () => {
    expect(normalizeLinktype(101, Uint8Array.of(0x45))).toBe(228);
    expect(normalizeLinktype(101, Uint8Array.of(0x60))).toBe(229);
    expect(normalizeLinktype(101, new Uint8Array(0))).toBe(229);
    expect(normalizeLinktype(1, Uint8Array.of(0x45))).toBe(1);
  });
});
```

(The empty-body case mirrors today's `bodyBytes[0] ?? 0` → nibble 0 → not 4 → 229.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @byteql/core build && pnpm --filter @byteql/pcap exec byteql-pack build && pnpm --filter @byteql/pcap exec vitest run test/chunk-window.test.ts`
Expected: FAIL — cannot resolve `../src/chunk-window.js`.

- [ ] **Step 3: Implement `chunk-window.ts`**

```ts
/**
 * A chunk-window reader over a `ByteSource`, shared by the classic-pcap and pcapng readers.
 *
 * Reads are served from one `chunkBytes`-sized window (reloaded at the requested offset, not
 * slid), so framing never needs the whole capture in memory. A span larger than one chunk is
 * read directly as an isolated copy. `generation` bumps on every reload; `stable()` applies the
 * straddle-copy rule: a chunk view obtained after a reload that happened while framing the
 * current record is copied, so it stays valid across later reads.
 */

import type { ByteSource } from '@byteql/core';

/** A window read, and whether the returned bytes are a view into the mutable chunk. */
export interface WindowRead {
  bytes: Uint8Array;
  isChunkView: boolean;
}

export interface ChunkWindow {
  /** Bumped every time the window is reloaded. */
  readonly generation: number;
  /** Returns `[absoluteStart, absoluteStart + length)`, reloading the window if needed. */
  ensure(absoluteStart: number, length: number): Promise<WindowRead>;
  /** `read.bytes`, copied when it is a chunk view and a reload happened since `generationAtStart`. */
  stable(read: WindowRead, generationAtStart: number): Uint8Array;
}

export function createChunkWindow(source: ByteSource, chunkBytes: number, start: number): ChunkWindow {
  // `chunk[i]` is absolute offset `chunkStart + i`.
  let chunk: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let chunkStart = start;
  let generation = 0;

  return {
    get generation() {
      return generation;
    },
    async ensure(absoluteStart, length) {
      const within = absoluteStart - chunkStart;
      if (within >= 0 && within + length <= chunk.length) {
        return { bytes: chunk.subarray(within, within + length), isChunkView: true };
      }
      if (length > chunkBytes) {
        // Larger than one chunk: read it directly rather than growing the shared window. Already
        // an isolated copy, so no reload/generation bump is needed.
        return { bytes: await source.read(absoluteStart, length), isChunkView: false };
      }
      chunkStart = absoluteStart;
      chunk = await source.read(absoluteStart, Math.max(chunkBytes, length));
      generation += 1;
      return { bytes: chunk.subarray(0, length), isChunkView: true };
    },
    stable(read, generationAtStart) {
      return read.isChunkView && generation !== generationAtStart ? read.bytes.slice() : read.bytes;
    },
  };
}
```

- [ ] **Step 4: Refactor `createPcapFramer` onto the window**

In `src/container.ts`:

1. Add `import { createChunkWindow } from './chunk-window.js';` and delete the local
   `EnsuredRead` interface.
2. Add, above `detectMagic`:

   ```ts
   /** Raw-IP linktype 101 → 228 (IPv4) / 229 (IPv6) by peeking the version nibble. */
   export function normalizeLinktype(linktype: number, body: Uint8Array): number {
     if (linktype !== LINKTYPE_RAW_IP) return linktype;
     const firstByte = body[0] ?? 0;
     return firstByte >> 4 === 4 ? LINKTYPE_RAW_IPV4 : LINKTYPE_RAW_IPV6;
   }
   ```

3. Replace the `chunk`, `chunkStart`, `generation` locals and the `ensure` closure with
   `const window = createChunkWindow(source, chunkBytes, GLOBAL_HEADER_SIZE);` (keep `cursor`,
   `index`, `stopped`).
4. In `next()`: `const generationAtStart = window.generation;`, `await window.ensure(...)` for
   both reads, then
   `const bodyBytes = window.stable(bodyRead, generationAtStart);` and
   `const packetLinktype = normalizeLinktype(header.linktype, bodyBytes);` (delete the inline
   raw-IP block). Keep the explanatory comment about straddled records next to the `stable()`
   call.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @byteql/pcap exec vitest run test/chunk-window.test.ts test/container.test.ts test/conformance.test.ts`
Expected: PASS, with no golden or container-test changes.

- [ ] **Step 6: Gate and commit**

Run: `pnpm --filter @byteql/pcap test -- --run && pnpm -r check`

```bash
git add packages/formats/pcap/src/chunk-window.ts packages/formats/pcap/src/container.ts packages/formats/pcap/test/chunk-window.test.ts
git commit -m "refactor(pcap): extract the chunk window shared by capture readers"
```

---

### Task 2: pcapng test builder

Test-only code every later task uses. It writes byte-exact pcapng blocks per the pcapng spec
(IETF draft-ietf-opsawg-pcapng): 8-byte block header (type u32, total length u32), body padded to
4, trailing total length u32; all fields in the enclosing section's byte order.

**Files:**

- Create: `packages/formats/pcap/test/build-pcapng.ts`
- Create: `packages/formats/pcap/test/build-pcapng.test.ts`
- Modify: `packages/formats/pcap/test/fixtures/manifest.md` (add a `buildPcapng` section)

**Interfaces:**

- Consumes: `PcapPacket` (`{ tsSec, tsFrac, data }`) from `test/build-pcap.ts`.
- Produces:
  - `type Endian = 'le' | 'be'`
  - `interface PcapngOption { code: number; value: Uint8Array | bigint }`
  - `optText(code: number, text: string): PcapngOption`, `optU8(code: number, value: number): PcapngOption`,
    `optI64(code: number, value: bigint): PcapngOption`
  - `type PcapngBlock` (see code) with kinds `shb`, `idb`, `epb`, `opb`, `spb`, `raw`
  - `buildPcapngWithOffsets(blocks: PcapngBlock[]): { bytes: Uint8Array; blocks: { start: number; end: number }[] }`
  - `buildPcapng(blocks: PcapngBlock[]): Uint8Array`
  - `pcapngFromPackets(opts: { endian: Endian; linktype: number; packets: PcapPacket[] }): Uint8Array`
    (one SHB, one IDB with default µs resolution, one EPB per packet with
    `ts = tsSec * 1_000_000 + tsFrac`)
  - Option codes: `OPT_COMMENT = 1`, `IF_NAME = 2`, `IF_DESCRIPTION = 3`, `SHB_OS = 3`,
    `IF_TSRESOL = 9`, `IF_TSOFFSET = 14`
- [ ] **Step 1: Write the failing builder tests**

`test/build-pcapng.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { buildPcapngWithOffsets, OPT_COMMENT, optText, pcapngFromPackets } from './build-pcapng.js';

const u32 = (bytes: Uint8Array, at: number, le: boolean) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, le);

describe('buildPcapng', () => {
  it('writes an SHB with the byte-order magic in the section byte order', () => {
    for (const endian of ['le', 'be'] as const) {
      const { bytes, blocks } = buildPcapngWithOffsets([{ type: 'shb', endian }]);
      const le = endian === 'le';
      expect([...bytes.subarray(0, 4)]).toEqual([0x0a, 0x0d, 0x0d, 0x0a]);
      expect(u32(bytes, 8, le)).toBe(0x1a2b3c4d);
      expect(blocks[0]).toEqual({ start: 0, end: 28 });
      expect(u32(bytes, 4, le)).toBe(28);
      expect(u32(bytes, 24, le)).toBe(28);
    }
  });

  it('pads EPB data and options to 4 bytes and records exact block offsets', () => {
    const { bytes, blocks } = buildPcapngWithOffsets([
      { type: 'shb', endian: 'le' },
      { type: 'idb', linktype: 1 },
      {
        type: 'epb',
        interfaceId: 0,
        ts: 5n,
        data: Uint8Array.of(1, 2, 3),
        options: [optText(OPT_COMMENT, 'hi')],
      },
    ]);
    const epb = blocks[2]!;
    // 28 fixed + 4 (3 data bytes padded) + 8 (comment option: 4 header + 2 padded to 4) + 4 end-of-opt + 4 trailer
    expect(epb.end - epb.start).toBe(48);
    expect(u32(bytes, epb.start, true)).toBe(6);
    expect(u32(bytes, epb.start + 20, true)).toBe(3); // captured length
    expect(bytes.length).toBe(epb.end);
  });

  it('builds a one-interface pcapng from classic packet descriptions', () => {
    const bytes = pcapngFromPackets({
      endian: 'le',
      linktype: 1,
      packets: [{ tsSec: 2, tsFrac: 7, data: Uint8Array.of(9) }],
    });
    // SHB 28 + IDB 20 + EPB 36
    expect(bytes.length).toBe(84);
    expect(u32(bytes, 48 + 16, true)).toBe(2_000_007); // timestamp low word
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @byteql/pcap exec vitest run test/build-pcapng.test.ts`
Expected: FAIL — cannot resolve `./build-pcapng.js`.

- [ ] **Step 3: Implement `build-pcapng.ts`**

```ts
/**
 * Deterministic `.pcapng` byte builder, for tests only. Hand-rolled `DataView` writers following
 * the pcapng block layout: type u32, total length u32, body padded to 4, total length u32 again,
 * every multi-byte field in the enclosing section's byte order. No third-party writer.
 */

import type { PcapPacket } from './build-pcap.js';

export type Endian = 'le' | 'be';

export interface PcapngOption {
  code: number;
  /** Raw bytes, or a bigint written as an 8-byte signed integer in the section byte order. */
  value: Uint8Array | bigint;
}

export const OPT_COMMENT = 1;
export const IF_NAME = 2;
export const IF_DESCRIPTION = 3;
export const SHB_OS = 3;
export const IF_TSRESOL = 9;
export const IF_TSOFFSET = 14;

export type PcapngBlock =
  | {
      type: 'shb';
      endian: Endian;
      options?: PcapngOption[];
      /** Major version; default 1. */
      major?: number;
      /** Byte-order magic override (written in `endian`); default 0x1A2B3C4D. */
      byteOrderMagic?: number;
    }
  | { type: 'idb'; linktype: number; snaplen?: number; options?: PcapngOption[] }
  | {
      type: 'epb';
      interfaceId: number;
      /** Raw 64-bit timestamp units, in the interface's resolution. */
      ts: bigint;
      data: Uint8Array;
      origLen?: number;
      options?: PcapngOption[];
    }
  | { type: 'opb'; interfaceId: number; ts: bigint; data: Uint8Array; options?: PcapngOption[] }
  | { type: 'spb'; data: Uint8Array; origLen?: number }
  /** Any block type with a verbatim body (header and trailer are added). */
  | { type: 'raw'; blockType: number; body: Uint8Array };

const textEncoder = new TextEncoder();
const pad4 = (length: number): number => (length + 3) & ~3;

export const optText = (code: number, text: string): PcapngOption => ({
  code,
  value: textEncoder.encode(text),
});
export const optU8 = (code: number, value: number): PcapngOption => ({ code, value: Uint8Array.of(value) });
export const optI64 = (code: number, value: bigint): PcapngOption => ({ code, value });

class Writer {
  private bytes = new Uint8Array(256);
  private view = new DataView(this.bytes.buffer);
  length = 0;
  constructor(public le: boolean) {}
  private grow(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra));
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }
  u16(value: number): void {
    this.grow(2);
    this.view.setUint16(this.length, value, this.le);
    this.length += 2;
  }
  u32(value: number): void {
    this.grow(4);
    this.view.setUint32(this.length, value >>> 0, this.le);
    this.length += 4;
  }
  i64(value: bigint): void {
    this.grow(8);
    this.view.setBigInt64(this.length, value, this.le);
    this.length += 8;
  }
  raw(data: Uint8Array, padTo4 = true): void {
    const size = padTo4 ? pad4(data.length) : data.length;
    this.grow(size);
    this.bytes.set(data, this.length);
    this.bytes.fill(0, this.length + data.length, this.length + size);
    this.length += size;
  }
  patchU32(at: number, value: number): void {
    this.view.setUint32(at, value >>> 0, this.le);
  }
  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

const encodeOptions = (w: Writer, options: PcapngOption[] | undefined): void => {
  if (!options || options.length === 0) return;
  for (const option of options) {
    w.u16(option.code);
    if (typeof option.value === 'bigint') {
      w.u16(8);
      w.i64(option.value);
    } else {
      w.u16(option.value.length);
      w.raw(option.value);
    }
  }
  w.u16(0); // opt_endofopt
  w.u16(0);
};

const BLOCK_TYPES = { shb: 0x0a0d0d0a, idb: 1, opb: 2, spb: 3, epb: 6 } as const;

export function buildPcapngWithOffsets(blocks: PcapngBlock[]): {
  bytes: Uint8Array;
  blocks: { start: number; end: number }[];
} {
  const w = new Writer(true);
  const offsets: { start: number; end: number }[] = [];
  for (const block of blocks) {
    if (block.type === 'shb') w.le = block.endian === 'le';
    const start = w.length;
    w.u32(block.type === 'raw' ? block.blockType : BLOCK_TYPES[block.type]);
    w.u32(0); // total length, patched below
    switch (block.type) {
      case 'shb':
        w.u32(block.byteOrderMagic ?? 0x1a2b3c4d);
        w.u16(block.major ?? 1);
        w.u16(0);
        w.i64(-1n); // section length unknown
        encodeOptions(w, block.options);
        break;
      case 'idb':
        w.u16(block.linktype);
        w.u16(0);
        w.u32(block.snaplen ?? 0);
        encodeOptions(w, block.options);
        break;
      case 'epb':
      case 'opb':
        if (block.type === 'epb') {
          w.u32(block.interfaceId);
        } else {
          w.u16(block.interfaceId);
          w.u16(0); // drops
        }
        w.u32(Number(block.ts >> 32n));
        w.u32(Number(block.ts & 0xffff_ffffn));
        w.u32(block.data.length);
        w.u32(block.type === 'epb' ? (block.origLen ?? block.data.length) : block.data.length);
        w.raw(block.data);
        encodeOptions(w, block.options);
        break;
      case 'spb':
        w.u32(block.origLen ?? block.data.length);
        w.raw(block.data);
        break;
      case 'raw':
        w.raw(block.body);
        break;
    }
    const total = w.length + 4 - start;
    w.u32(total);
    w.patchU32(start + 4, total);
    offsets.push({ start, end: w.length });
  }
  return { bytes: w.result(), blocks: offsets };
}

export const buildPcapng = (blocks: PcapngBlock[]): Uint8Array => buildPcapngWithOffsets(blocks).bytes;

export function pcapngFromPackets(opts: { endian: Endian; linktype: number; packets: PcapPacket[] }): Uint8Array {
  return buildPcapng([
    { type: 'shb', endian: opts.endian },
    { type: 'idb', linktype: opts.linktype },
    ...opts.packets.map(
      (packet): PcapngBlock => ({
        type: 'epb',
        interfaceId: 0,
        ts: BigInt(packet.tsSec) * 1_000_000n + BigInt(packet.tsFrac),
        data: packet.data,
      }),
    ),
  ]);
}
```

If `erasableSyntaxOnly` rejects the `constructor(public le: boolean)` parameter property during
`pnpm -r check`, replace it with a plain `le: boolean;` field assigned in the constructor.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @byteql/pcap exec vitest run test/build-pcapng.test.ts`
Expected: PASS.

- [ ] **Step 5: Document the builder**

Append to `test/fixtures/manifest.md`:

```markdown
## `buildPcapng(blocks)` / `buildPcapngWithOffsets(blocks)`

`test/build-pcapng.ts` writes byte-exact pcapng: each block is type u32 + total length u32 +
body padded to 4 + total length u32, in the byte order of the most recent `shb` block. Block kinds:
`shb` (byte-order magic and major version overridable for error tests), `idb`, `epb`, `opb`,
`spb`, and `raw` (any type with a verbatim body — used for NRB/ISB/unknown blocks and malformed
blocks). `buildPcapngWithOffsets` also returns each block's absolute `[start, end)` so tests can
assert provenance or patch fields. `pcapngFromPackets` converts classic `buildPcap` packet
descriptions into a one-interface µs-resolution pcapng, for parity tests.
```

Run `rumdl fmt packages/formats/pcap/test/fixtures/manifest.md`.

- [ ] **Step 6: Gate and commit**

Run: `pnpm --filter @byteql/pcap test -- --run && pnpm -r check`

```bash
git add packages/formats/pcap/test/build-pcapng.ts packages/formats/pcap/test/build-pcapng.test.ts packages/formats/pcap/test/fixtures/manifest.md
git commit -m "test(pcap): add a deterministic pcapng byte builder"
```

---

### Task 3: Shared data model — `interfaces` table, new `packets` columns, classic synthetic interface

Classic pcap gains the additive columns and one synthetic interface row. This is the only task
that regenerates existing goldens.

**Files:**

- Modify: `packages/formats/pcap/pcap.tables.yaml` (the `packets` table; add `interfaces` right
  after it)
- Modify: `packages/formats/pcap/src/container.ts` (`PcapPacket` gains `ts_frac_ns`)
- Modify: `packages/formats/pcap/src/framer.ts`
- Modify: `packages/formats/pcap/queries.yaml`
- Modify: `packages/formats/pcap/test/pack.test.ts`, `test/container.test.ts` (one new assertion)
- Regenerate: `packages/formats/pcap/test/goldens/*.golden.json`, `test/schemas.snapshot.json`

**Interfaces:**

- Consumes: `createPcapFramer`, `PcapHeader` (Task 1).
- Produces (in `src/framer.ts`, used by Task 7's `pcapngFramer`):
  - `interface PacketRootFields { ts_us: bigint | null; ts_ns: bigint | null; incl_len: number; orig_len: number; linktype: number; interface_id: number; comment: string | null; body: PcapPacketBody }`
  - `interface InterfaceRootFields { section: number; if_index: number; linktype: number; snaplen: number; name: string | null; description: string | null; os: string | null; comment: string | null; ts_resolution: string; ts_offset_s: bigint }`
  - `packetRoot(fields: PacketRootFields): PacketRootFields` and
    `interfaceRoot(fields: InterfaceRootFields): InterfaceRootFields` (identity builders that pin
    the total root shape required by `strictFields`)
- `PcapPacket.ts_frac_ns: number` — exact nanosecond fraction (µs × 1000, or the ns field as
  written).
- [ ] **Step 1: Write the failing tests**

In `test/pack.test.ts`, replace the table-list expectation in
`'declares schemas for all eight pcap tables plus errors'` with:

```ts
    expect(pcapFormatPack.schemas().map((schema) => schema.name)).toEqual([
      'packets',
      'interfaces',
      'ip',
      'tcp',
      'udp',
      'dns',
      'icmp',
      'icmpv6',
      'tls',
      'streams',
      'stream_segments',
      'errors',
    ]);
```

and add a new test:

```ts
  it('declares the interfaces table and the pcapng-era packets columns', () => {
    const byName = new Map(pcapFormatPack.schemas().map((s) => [s.name, s]));
    const packets = byName.get('packets')!;
    expect(packets.columns.map((c) => c.name)).toEqual([
      'packet_id',
      'ts',
      'caplen',
      'len',
      'linktype',
      'interface_id',
      'comment',
      'ts_ns',
      '_src_start',
      '_src_end',
    ]);
    const nullable = (table: string, column: string) =>
      byName.get(table)!.columns.find((c) => c.name === column)!.nullable;
    expect(nullable('packets', 'ts')).toBe(true);
    expect(nullable('packets', 'ts_ns')).toBe(true);
    expect(nullable('packets', 'comment')).toBe(true);
    expect(nullable('packets', 'interface_id')).toBe(false);
    expect(byName.get('interfaces')!.columns.map((c) => c.name)).toEqual([
      'interface_id',
      'section',
      'if_index',
      'linktype',
      'snaplen',
      'name',
      'description',
      'os',
      'comment',
      'ts_resolution',
      'ts_offset_s',
      '_src_start',
      '_src_end',
    ]);
  });

  it('projects one synthetic interface and interface_id/ts_ns for a classic capture', async () => {
    const bytes = buildPcap({
      magic: 'le_ns',
      linktype: 1,
      packets: [{ tsSec: 3, tsFrac: 123_456_789, data: new Uint8Array(14) }],
    });
    const result = await parseAndProjectPcap(bytes, new AbortController().signal);
    const table = (name: string) => ipcToTable(result.tables.find((t) => t.name === name)!.ipc).toArray();
    const [iface] = table('interfaces');
    expect(iface.toJSON()).toMatchObject({
      interface_id: 1,
      section: 0,
      if_index: 0,
      linktype: 1,
      snaplen: 65535,
      name: null,
      ts_resolution: '10^-9',
      ts_offset_s: 0n,
      _src_start: 0n,
      _src_end: 24n,
    });
    const [packet] = table('packets');
    expect(packet.interface_id).toBe(1);
    expect(packet.comment).toBeNull();
    expect(packet.ts_ns).toBe(3_123_456_789n);
  });
```

Add the imports this needs at the top of `pack.test.ts`: `ipcToTable` from `@byteql/core` and
`parseAndProjectPcap` from `./parse-and-project.js`. Check what `buildPcap` writes as snaplen
(`grep -n snaplen test/build-pcap.ts`) and use that value in place of `65535` if it differs.

In `test/container.test.ts`, inside `'normalizes ns fraction to microseconds'`, add
`expect(c.packets[0].ts_frac_ns).toBe(2500);`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @byteql/pcap exec vitest run test/pack.test.ts test/container.test.ts`
Expected: FAIL — no `interfaces` table; `ts_frac_ns` undefined.

- [ ] **Step 3: Add `ts_frac_ns` to the classic reader**

In `src/container.ts`, add to `PcapPacket` after `ts_frac_us`:

```ts
  /** Exact fractional timestamp in nanoseconds (µs field × 1000, or the ns field as written). */
  ts_frac_ns: number;
```

and in `next()` set `ts_frac_ns: timeUnit === 'ns' ? tsUsecOrNsec : tsUsecOrNsec * 1000,`.

- [ ] **Step 4: Update the spec**

In `pcap.tables.yaml`, replace the `packets` table with:

```yaml
  - name: packets
    rows: $
    key: packet_id
    columns:
      # ts_us/ts_ns are exact bigints computed by the framers; ts is null only for pcapng
      # Simple Packet Blocks, which carry no timestamp.
      ts: { expr: _.ts_us, type: timestamp_us, nullable: true }
      caplen: { expr: _.incl_len, type: uint32 }
      len: { expr: _.orig_len, type: uint32 }
      linktype: { expr: _.linktype, type: uint32 }
      # 1-based per-file ordinal of the packet's interface; equals interfaces.interface_id for the
      # same _src_file (keys restart per file — join on both).
      interface_id: { expr: _.interface_id, type: uint32 }
      comment: { expr: _.comment, type: utf8, nullable: true }
      ts_ns: { expr: _.ts_ns, type: int64, nullable: true }
  - name: interfaces
    rows: $
    key: interface_id
    columns:
      section: { expr: _.section, type: uint32 }
      if_index: { expr: _.if_index, type: uint32 }
      linktype: { expr: _.linktype, type: uint32 }
      snaplen: { expr: _.snaplen, type: uint32 }
      name: { expr: _.name, type: utf8, nullable: true }
      description: { expr: _.description, type: utf8, nullable: true }
      os: { expr: _.os, type: utf8, nullable: true }
      comment: { expr: _.comment, type: utf8, nullable: true }
      ts_resolution: { expr: _.ts_resolution, type: utf8 }
      ts_offset_s: { expr: _.ts_offset_s, type: int64 }
```

- [ ] **Step 5: Update the classic framer**

Replace `src/framer.ts` with:

```ts
import type { Framer } from '@byteql/core';

import { createPcapFramer, type PcapPacketBody } from './container.js';

/** Root shape of every `packets` record, from either container. Must stay total (strictFields). */
export interface PacketRootFields {
  ts_us: bigint | null;
  ts_ns: bigint | null;
  incl_len: number;
  orig_len: number;
  linktype: number;
  interface_id: number;
  comment: string | null;
  body: PcapPacketBody;
}

/** Root shape of every `interfaces` record, from either container. Must stay total. */
export interface InterfaceRootFields {
  section: number;
  if_index: number;
  linktype: number;
  snaplen: number;
  name: string | null;
  description: string | null;
  os: string | null;
  comment: string | null;
  ts_resolution: string;
  ts_offset_s: bigint;
}

export const packetRoot = (fields: PacketRootFields): PacketRootFields => fields;
export const interfaceRoot = (fields: InterfaceRootFields): InterfaceRootFields => fields;

const GLOBAL_HEADER_SIZE = 24;

export const pcapFramer: Framer = async function* (source, ctx) {
  const framer = await createPcapFramer(source, ctx.chunkBytes);
  // Classic pcap has exactly one implicit interface: the global header. It is yielded first so
  // the engine assigns it interface_id 1, which every classic packet references.
  ctx.bytes(GLOBAL_HEADER_SIZE);
  yield {
    root: interfaceRoot({
      section: 0,
      if_index: 0,
      linktype: framer.header.linktype,
      snaplen: framer.header.snaplen,
      name: null,
      description: null,
      os: null,
      comment: null,
      ts_resolution: framer.header.timeUnit === 'ns' ? '10^-9' : '10^-6',
      ts_offset_s: 0n,
    }),
    provenance: { start: 0, end: GLOBAL_HEADER_SIZE },
    tables: ['interfaces'],
  };
  for (let packet = await framer.next(); packet !== null; packet = await framer.next()) {
    ctx.bytes(framer.bytesConsumed()); // before yield: the driver flushes progress while this record is current
    const seconds = BigInt(packet.ts_sec);
    yield {
      root: packetRoot({
        ts_us: seconds * 1_000_000n + BigInt(packet.ts_frac_us),
        ts_ns: seconds * 1_000_000_000n + BigInt(packet.ts_frac_ns),
        incl_len: packet.incl_len,
        orig_len: packet.orig_len,
        linktype: packet.linktype,
        interface_id: 1,
        comment: null,
        body: packet.body,
      }),
      provenance: { start: packet.recordStart, end: packet.bodyEnd },
      tables: ['packets'],
    };
  }
  // Truncation is discovered at EOF; the driver still orders framing issues first.
  for (const issue of framer.issues()) ctx.report(issue);
  ctx.bytes(framer.bytesConsumed());
};
```

- [ ] **Step 6: Update the queries**

In `queries.yaml`, add `union all select 'interfaces', count(*) from interfaces` to the
`overview` query right after the `packets` line, and append a preset:

```yaml
  - id: packets_by_interface
    title: Packets by interface
    kind: grid
    # Keys restart per file, so the join matches _src_file too (see pcap.tables.yaml).
    sql: |
      select i._src_file, i.interface_id, i.name, i.linktype, i.ts_resolution,
             count(p.packet_id) as packets, sum(p.len) as bytes
      from interfaces i
      left join packets p on p.interface_id = i.interface_id and p._src_file = i._src_file
      group by all
      order by i._src_file, i.interface_id
      limit 100;
```

Before committing to this query, check how existing queries reference `_src_file` (it is added
at ingest, not by the pack) and whether the query linter in `packages/pack-tools/src/queries.mjs`
accepts it the same way `dns_join` does; mirror `dns_join`'s pattern exactly.

- [ ] **Step 7: Run the targeted tests**

Run: `pnpm --filter @byteql/pcap exec vitest run test/pack.test.ts test/container.test.ts`
Expected: PASS.

- [ ] **Step 8: Find other pinned column lists**

Run: `grep -rn "'linktype'\|caplen\|ts_frac_us\|ts_sec" packages apps --include=*.ts --include=*.svelte | grep -v node_modules | grep -v /dist`
Update every test that pins the exact `packets` column list or the old root shape (e.g.
`project-pcap.test.ts`, `flatten.test.ts`, web unit tests) to the new shape. Do not change any
expected **value** of an existing column.

- [ ] **Step 9: Regenerate the classic goldens and schema snapshot — in their own commit**

Generate the goldens as the last change, and inspect the diff before staging anything:

```bash
pnpm --filter @byteql/pcap exec vitest run -u test/conformance.test.ts
git diff --stat packages/formats/pcap/test/goldens
git diff packages/formats/pcap/test/goldens | grep '^[-+]' | grep -v '^[-+][-+]' | head -80
```

Acceptable diff: each golden gains an `interfaces` table (1 row) and `packets` gains
`interface_id` (1), `comment` (null), `ts_ns` columns and a changed `sha256` for `packets`. Any
changed value in an existing column, or any change in another table, is a regression — stop and
fix. Then regenerate `test/schemas.snapshot.json` from the derived schemas:

```bash
pnpm --filter @byteql/pcap build
cd packages/formats/pcap && node --input-type=module -e "
import { writeFileSync } from 'node:fs';
import { pcapFormatPack } from './dist/index.js';
import { schemaSnapshotText } from '@byteql/core/testing';
writeFileSync('test/schemas.snapshot.json', schemaSnapshotText(pcapFormatPack.schemas()));
" && cd -
git diff packages/formats/pcap/test/schemas.snapshot.json
```

Acceptable diff: the new `interfaces` entry, three new `packets` columns, and `packets.ts`
`nullable: true`. The `errors` table's `_src_*` nullability must be unchanged.

- [ ] **Step 10: Gate and commit (two commits)**

Run: `pnpm --filter @byteql/pcap test -- --run && pnpm -r check`

```bash
git add packages/formats/pcap/pcap.tables.yaml packages/formats/pcap/queries.yaml packages/formats/pcap/src packages/formats/pcap/test/pack.test.ts packages/formats/pcap/test/container.test.ts
# plus any test files updated in Step 8
git commit -m "feat(pcap): add the interfaces table and interface_id/comment/ts_ns packet columns"
git add packages/formats/pcap/test/goldens packages/formats/pcap/test/schemas.snapshot.json
git commit -m "test(pcap): regenerate classic goldens for the additive interface columns"
```

(If the first commit's gate fails only because goldens are stale, run the gate after both
commits instead; the golden commit must still be separate so the diff is reviewable on its own.)

---

### Task 4: pcapng option walker

**Files:**

- Create: `packages/formats/pcap/src/options.ts`
- Test: `packages/formats/pcap/test/options.test.ts`

**Interfaces:**

- Produces:
  - `type OptionWalk = 'ok' | 'malformed'`
  - `walkOptions(view: DataView, start: number, end: number, littleEndian: boolean, visit: (code: number, valueStart: number, valueLength: number) => void): OptionWalk`
    — offsets are relative to `view`; stops at `opt_endofopt` (code 0) or `end`
  - `optionText(bytes: Uint8Array, start: number, length: number): string` — non-fatal UTF-8,
    trailing NULs stripped

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

import { optionText, walkOptions } from '../src/options.js';

const encode = (le: boolean, entries: [number, number[]][], terminate = true): DataView => {
  const bytes: number[] = [];
  const u16 = (v: number) => (le ? bytes.push(v & 0xff, v >> 8) : bytes.push(v >> 8, v & 0xff));
  for (const [code, value] of entries) {
    u16(code);
    u16(value.length);
    bytes.push(...value);
    while (bytes.length % 4 !== 0) bytes.push(0);
  }
  if (terminate) {
    u16(0);
    u16(0);
  }
  return new DataView(Uint8Array.from(bytes).buffer);
};

describe('walkOptions', () => {
  it('visits options in order with padded advancement, in either byte order', () => {
    for (const le of [true, false]) {
      const view = encode(le, [
        [2, [0x65, 0x74, 0x68]],
        [9, [9]],
      ]);
      const seen: [number, number, number][] = [];
      expect(walkOptions(view, 0, view.byteLength, le, (c, s, n) => seen.push([c, s, n]))).toBe('ok');
      expect(seen).toEqual([
        [2, 4, 3],
        [9, 12, 1],
      ]);
    }
  });

  it('stops at opt_endofopt and ignores bytes after it', () => {
    const view = encode(true, [[1, [0x61]]]);
    const seen: number[] = [];
    walkOptions(view, 0, view.byteLength, true, (c) => seen.push(c));
    expect(seen).toEqual([1]);
  });

  it('accepts an options area without opt_endofopt', () => {
    const view = encode(true, [[1, [0x61]]], false);
    expect(walkOptions(view, 0, view.byteLength, true, () => {})).toBe('ok');
  });

  it('reports malformed when a value runs past the end, keeping earlier visits', () => {
    const view = encode(true, [[1, [0x61]]], false);
    const bytes = new Uint8Array(view.buffer.byteLength + 4);
    bytes.set(new Uint8Array(view.buffer));
    const dv = new DataView(bytes.buffer);
    dv.setUint16(8, 3, true); // second option: code 3
    dv.setUint16(10, 0xffff, true); // length far past the end
    const seen: number[] = [];
    expect(walkOptions(dv, 0, dv.byteLength, true, (c) => seen.push(c))).toBe('malformed');
    expect(seen).toEqual([1]);
  });

  it('reports malformed for 1–3 trailing bytes that cannot hold an option header', () => {
    const view = new DataView(new Uint8Array(2).buffer);
    expect(walkOptions(view, 0, 2, true, () => {})).toBe('malformed');
  });
});

describe('optionText', () => {
  it('decodes UTF-8 and strips trailing NULs', () => {
    const bytes = Uint8Array.of(0x65, 0x74, 0x68, 0x30, 0, 0);
    expect(optionText(bytes, 0, 6)).toBe('eth0');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @byteql/pcap exec vitest run test/options.test.ts`
Expected: FAIL — cannot resolve `../src/options.js`.

- [ ] **Step 3: Implement `options.ts`**

```ts
/**
 * pcapng option lists: a sequence of (code u16, length u16, value padded to 4) entries in the
 * section byte order, ended by opt_endofopt (code 0) or by the end of the options area.
 */

export type OptionWalk = 'ok' | 'malformed';

/**
 * Visits each option in `[start, end)` of `view`. Returns 'malformed' when an option header or
 * value does not fit; options visited before that point stay visited.
 */
export function walkOptions(
  view: DataView,
  start: number,
  end: number,
  littleEndian: boolean,
  visit: (code: number, valueStart: number, valueLength: number) => void,
): OptionWalk {
  let offset = start;
  while (offset + 4 <= end) {
    const code = view.getUint16(offset, littleEndian);
    const length = view.getUint16(offset + 2, littleEndian);
    if (code === 0) return 'ok';
    const valueStart = offset + 4;
    if (valueStart + length > end) return 'malformed';
    visit(code, valueStart, length);
    offset = valueStart + ((length + 3) & ~3);
  }
  return offset >= end ? 'ok' : 'malformed';
}

const decoder = new TextDecoder('utf-8');

/** A UTF-8 option value; writers sometimes include trailing NULs, which are dropped. */
export function optionText(bytes: Uint8Array, start: number, length: number): string {
  let stop = start + length;
  while (stop > start && bytes[stop - 1] === 0) stop -= 1;
  return decoder.decode(bytes.subarray(start, stop));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @byteql/pcap exec vitest run test/options.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

Run: `pnpm --filter @byteql/pcap test -- --run && pnpm -r check`

```bash
git add packages/formats/pcap/src/options.ts packages/formats/pcap/test/options.test.ts
git commit -m "feat(pcap): add the pcapng option walker"
```

---

### Task 5: pcapng reader — blocks, timestamps, straddles

The happy path plus stop-on-framing errors needed for EOF. Task 6 adds and pins the remaining
error codes; the full reader code is written here so Task 6 is test-first against it.

**Files:**

- Create: `packages/formats/pcap/src/pcapng.ts`
- Create: `packages/formats/pcap/test/pcapng-fixtures.ts`
- Test: `packages/formats/pcap/test/pcapng.test.ts`

**Interfaces:**

- Consumes: `createChunkWindow` (Task 1), `normalizeLinktype`, `PCAP_CHUNK_BYTES`,
  `PcapFramingIssue`, `PcapPacketBody` (`container.ts`), `walkOptions`, `optionText` (Task 4).
- Produces:
  - Block type constants `BLOCK_SHB`, `BLOCK_IDB`, `BLOCK_OPB`, `BLOCK_SPB`, `BLOCK_EPB`
  - `interface TsResolution { base: 10 | 2; exponent: number }`
  - `decodeTsResolution(byte: number): TsResolution`, `formatTsResolution(r: TsResolution): string`
    (`'10^-6'`, `'2^-20'`)
  - `interface PcapngInterface { ordinal: number; section: number; ifIndex: number; linktype: number; snaplen: number; name: string | null; description: string | null; os: string | null; comment: string | null; tsResolution: TsResolution; tsOffsetS: bigint; blockStart: number; blockEnd: number }`
  - `interface PcapngPacket { index: number; interfaceOrdinal: number; linktype: number; tsNs: bigint | null; inclLen: number; origLen: number; comment: string | null; blockStart: number; blockEnd: number; body: PcapPacketBody }`
  - `type PcapngItem = { kind: 'interface'; iface: PcapngInterface } | { kind: 'packet'; packet: PcapngPacket }`
  - `interface PcapngReader { next(): Promise<PcapngItem | null>; issues(): readonly PcapFramingIssue[]; bytesConsumed(): number }`
  - `createPcapngReader(source: ByteSource, chunkBytes?: number): Promise<PcapngReader>` —
    throws `PackFatalError` (`NOT_PCAPNG`, `BAD_BYTE_ORDER_MAGIC`,
    `UNSUPPORTED_SECTION_VERSION`) when the first block is unreadable
  - From `test/pcapng-fixtures.ts`: `multiSectionPcapng(): { bytes: Uint8Array; blocks: { start: number; end: number }[] }`
    and `dnsStreamPcapng(): Uint8Array`
- [ ] **Step 1: Write the shared fixtures**

`test/pcapng-fixtures.ts`:

```ts
import {
  dnsOverTcp,
  dnsQuery,
  ethFrame,
  icmpEcho,
  icmpv6Echo,
  ipv4,
  ipv6,
  tcp,
  udp,
} from './build-pcap.js';
import {
  buildPcapngWithOffsets,
  IF_DESCRIPTION,
  IF_NAME,
  IF_TSOFFSET,
  IF_TSRESOL,
  OPT_COMMENT,
  optI64,
  optText,
  optU8,
  pcapngFromPackets,
  SHB_OS,
} from './build-pcapng.js';

const dnsOverEthernet = (name: string) =>
  ethFrame({
    etherType: 0x0800,
    payload: ipv4({
      protocol: 17,
      src: '10.0.0.1',
      dst: '10.0.0.2',
      payload: udp({ srcPort: 5353, dstPort: 53, payload: dnsQuery({ txId: 1, name, type: 1 }) }),
    }),
  });

/**
 * Two sections (little-endian, then big-endian) exercising every projected block kind:
 *
 * - blocks[0] SHB le, shb_os "Linux"
 * - blocks[1] IDB 0: Ethernet, if_name eth0, if_description uplink, opt_comment "primary", tsresol 10^-9
 * - blocks[2] IDB 1: raw IP (101), tsresol 2^-20, tsoffset 100 s
 * - blocks[3] EPB if 0: DNS "one.example", ts 1_700_000_000_123_456_789 ns, comment "first"
 * - blocks[4] NRB (skipped silently)
 * - blocks[5] EPB if 1: raw IPv4 DNS "two.example", ts 5.5 s + 100 s
 * - blocks[6] unknown block type 0x7f (skipped, reported)
 * - blocks[7] ISB (skipped silently)
 * - blocks[8] SHB be
 * - blocks[9] IDB 0: Ethernet, default 10^-6
 * - blocks[10] OPB if 0: IPv6 ICMPv6 echo, ts 2 s
 * - blocks[11] SPB: IPv4 ICMP echo (no timestamp)
 */
export function multiSectionPcapng() {
  const rawDns = ipv4({
    protocol: 17,
    src: '10.0.0.3',
    dst: '10.0.0.4',
    payload: udp({ srcPort: 5353, dstPort: 53, payload: dnsQuery({ txId: 2, name: 'two.example', type: 1 }) }),
  });
  return buildPcapngWithOffsets([
    { type: 'shb', endian: 'le', options: [optText(SHB_OS, 'Linux')] },
    {
      type: 'idb',
      linktype: 1,
      snaplen: 262144,
      options: [
        optText(IF_NAME, 'eth0'),
        optText(IF_DESCRIPTION, 'uplink'),
        optText(OPT_COMMENT, 'primary'),
        optU8(IF_TSRESOL, 9),
      ],
    },
    { type: 'idb', linktype: 101, options: [optU8(IF_TSRESOL, 0x80 | 20), optI64(IF_TSOFFSET, 100n)] },
    {
      type: 'epb',
      interfaceId: 0,
      ts: 1_700_000_000_123_456_789n,
      data: dnsOverEthernet('one.example'),
      options: [optText(OPT_COMMENT, 'first')],
    },
    { type: 'raw', blockType: 4, body: new Uint8Array(4) },
    { type: 'epb', interfaceId: 1, ts: (5n << 20n) + (1n << 19n), data: rawDns },
    { type: 'raw', blockType: 0x7f, body: new Uint8Array(8) },
    { type: 'raw', blockType: 5, body: new Uint8Array(12) },
    { type: 'shb', endian: 'be' },
    { type: 'idb', linktype: 1 },
    {
      type: 'opb',
      interfaceId: 0,
      ts: 2_000_000n,
      data: ethFrame({
        etherType: 0x86dd,
        payload: ipv6({ nextHeader: 58, src: '2001:db8::1', dst: '2001:db8::2', payload: icmpv6Echo({ id: 1, seq: 1 }) }),
      }),
    },
    {
      type: 'spb',
      data: ethFrame({
        etherType: 0x0800,
        payload: ipv4({ protocol: 1, src: '10.0.0.5', dst: '10.0.0.6', payload: icmpEcho({ id: 2, seq: 2 }) }),
      }),
    },
  ]);
}

/** The classic dns-stream e2e fixture's two DNS-over-TCP segments, as a one-interface pcapng. */
export function dnsStreamPcapng(): Uint8Array {
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
  return pcapngFromPackets({
    endian: 'le',
    linktype: 1,
    packets: [
      { tsSec: 1, tsFrac: 0, data: packet(0, payload.subarray(0, 10)) },
      { tsSec: 1, tsFrac: 100, data: packet(10, payload.subarray(10)) },
    ],
  });
}
```

Check the exact option names of `icmpEcho`, `icmpv6Echo`, `ipv6` in `test/build-pcap.ts`
(`grep -n "export function" test/build-pcap.ts`) and adjust argument names if they differ.

- [ ] **Step 2: Write the failing reader tests**

`test/pcapng.test.ts`:

```ts
import { memoryByteSource, PackFatalError, type ByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { buildPcap } from './build-pcap.js';
import { buildPcapngWithOffsets } from './build-pcapng.js';
import { multiSectionPcapng } from './pcapng-fixtures.js';
import { createPcapngReader, type PcapngItem, type PcapngReader } from '../src/pcapng.js';

const drain = async (reader: PcapngReader): Promise<PcapngItem[]> => {
  const items: PcapngItem[] = [];
  for (let item = await reader.next(); item !== null; item = await reader.next()) items.push(item);
  return items;
};

/** Every read lands in ONE reused scratch buffer (see container.test.ts). */
const recyclingByteSource = (bytes: Uint8Array): ByteSource => {
  let scratch = new Uint8Array(0);
  return {
    size: bytes.byteLength,
    async read(offset, length) {
      const end = Math.min(offset + length, bytes.byteLength);
      const span = Math.max(end - offset, 0);
      if (scratch.byteLength < span) scratch = new Uint8Array(span);
      const view = scratch.subarray(0, span);
      view.set(bytes.subarray(offset, end));
      return view;
    },
  };
};

describe('createPcapngReader', () => {
  it('yields interfaces and packets in file order across sections and byte orders', async () => {
    const { bytes, blocks } = multiSectionPcapng();
    const reader = await createPcapngReader(memoryByteSource(bytes));
    const items = await drain(reader);
    expect(items.map((i) => i.kind)).toEqual([
      'interface',
      'interface',
      'packet',
      'packet',
      'interface',
      'packet',
      'packet',
    ]);
    const ifaces = items.flatMap((i) => (i.kind === 'interface' ? [i.iface] : []));
    expect(ifaces.map((f) => [f.ordinal, f.section, f.ifIndex, f.linktype])).toEqual([
      [1, 0, 0, 1],
      [2, 0, 1, 101],
      [3, 1, 0, 1],
    ]);
    expect(ifaces[0]).toMatchObject({
      name: 'eth0',
      description: 'uplink',
      comment: 'primary',
      os: 'Linux',
      snaplen: 262144,
      tsResolution: { base: 10, exponent: 9 },
      tsOffsetS: 0n,
      blockStart: blocks[1]!.start,
      blockEnd: blocks[1]!.end,
    });
    expect(ifaces[1]).toMatchObject({ tsResolution: { base: 2, exponent: 20 }, tsOffsetS: 100n });
    expect(ifaces[2]).toMatchObject({ os: null, tsResolution: { base: 10, exponent: 6 } });
    expect(reader.bytesConsumed()).toBe(bytes.length);
  });

  it('computes timestamps, linktypes, comments, and provenance per packet', async () => {
    const { bytes, blocks } = multiSectionPcapng();
    const packets = (await drain(await createPcapngReader(memoryByteSource(bytes)))).flatMap((i) =>
      i.kind === 'packet' ? [i.packet] : [],
    );
    expect(packets.map((p) => [p.index, p.interfaceOrdinal, p.linktype, p.tsNs, p.comment])).toEqual([
      [0, 1, 1, 1_700_000_000_123_456_789n, 'first'],
      [1, 2, 228, 105_500_000_000n, null],
      [2, 3, 1, 2_000_000_000n, null],
      [3, 3, 1, null, null],
    ]);
    const epb = blocks[3]!;
    expect(packets[0]).toMatchObject({ blockStart: epb.start, blockEnd: epb.end });
    expect(packets[0]!.body.start).toBe(epb.start + 28);
    expect(packets[0]!.body.bytes).toHaveLength(packets[0]!.inclLen);
    const spb = blocks[11]!;
    expect(packets[3]!.body.start).toBe(spb.start + 12);
  });

  it('reports each unknown block type once with a count, and skips known unprojected blocks silently', async () => {
    const { bytes, blocks } = multiSectionPcapng();
    const reader = await createPcapngReader(memoryByteSource(bytes));
    await drain(reader);
    expect(reader.issues()).toEqual([
      {
        code: 'UNSUPPORTED_BLOCK_TYPE',
        message: 'block type 0x0000007f: 1 block(s) skipped',
        sourceStart: blocks[6]!.start,
        sourceEnd: blocks[6]!.end,
      },
    ]);
  });

  it('parses a big-endian-only file identically to its little-endian twin', async () => {
    const make = (endian: 'le' | 'be') =>
      buildPcapngWithOffsets([
        { type: 'shb', endian },
        { type: 'idb', linktype: 1 },
        { type: 'epb', interfaceId: 0, ts: 42n, data: Uint8Array.of(1, 2, 3, 4, 5) },
      ]).bytes;
    const strip = (items: PcapngItem[]) => JSON.stringify(items, (_k, v) => (typeof v === 'bigint' ? `${v}` : v));
    const le = await drain(await createPcapngReader(memoryByteSource(make('le'))));
    const be = await drain(await createPcapngReader(memoryByteSource(make('be'))));
    expect(strip(be)).toBe(strip(le));
  });

  it('keeps a straddling block body intact across later reads on a recycling source', async () => {
    // Layout with chunkBytes 64: SHB [0,28), IDB [28,48), EPB [48,88) reloads the window at 48
    // ([48,112)), EPB [88,144) straddles 112 and fits in one chunk (56 <= 64), so it reloads at 88
    // and must be copied. A block larger than the chunk would take the direct-read path instead.
    const straddling = Uint8Array.from({ length: 24 }, (_, i) => i + 1);
    const { bytes } = buildPcapngWithOffsets([
      { type: 'shb', endian: 'le' },
      { type: 'idb', linktype: 1 },
      { type: 'epb', interfaceId: 0, ts: 1n, data: new Uint8Array(8) },
      { type: 'epb', interfaceId: 0, ts: 2n, data: straddling },
      { type: 'epb', interfaceId: 0, ts: 3n, data: new Uint8Array(8).fill(0xee) },
      { type: 'epb', interfaceId: 0, ts: 4n, data: new Uint8Array(8).fill(0xdd) },
    ]);
    const reader = await createPcapngReader(recyclingByteSource(bytes), 64);
    let held: Uint8Array | null = null;
    for (let item = await reader.next(); item !== null; item = await reader.next()) {
      if (item.kind === 'packet' && item.packet.index === 1) held = item.packet.body.bytes;
    }
    expect([...held!]).toEqual([...straddling]);
  });

  it('reads a block larger than the chunk size', async () => {
    const big = new Uint8Array(300).fill(7);
    const { bytes } = buildPcapngWithOffsets([
      { type: 'shb', endian: 'le' },
      { type: 'idb', linktype: 1 },
      { type: 'epb', interfaceId: 0, ts: 1n, data: big },
    ]);
    const items = await drain(await createPcapngReader(memoryByteSource(bytes), 32));
    const packet = items.find((i) => i.kind === 'packet')!;
    expect(packet.kind === 'packet' && [...packet.packet.body.bytes]).toEqual([...big]);
  });

  it('throws PackFatalError NOT_PCAPNG for a classic pcap', async () => {
    const bytes = buildPcap({ magic: 'le_us', linktype: 1, packets: [] });
    await expect(createPcapngReader(memoryByteSource(bytes))).rejects.toMatchObject({
      name: 'PackFatalError',
      code: 'NOT_PCAPNG',
    });
    await expect(createPcapngReader(memoryByteSource(bytes))).rejects.toBeInstanceOf(PackFatalError);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @byteql/pcap exec vitest run test/pcapng.test.ts`
Expected: FAIL — cannot resolve `../src/pcapng.js`.

- [ ] **Step 4: Implement `pcapng.ts`**

```ts
/**
 * Streaming pcapng block reader. Walks blocks over a shared `ChunkWindow` (the same chunking,
 * straddle-copy, and oversized-read rules as the classic reader), tracking per-section byte
 * order and interfaces. Yields interface and packet items in file order; everything else is
 * skipped by its length. See docs/superpowers/specs/2026-09-23-pcapng-intake-design.md
 * ("Block framing", "Timestamps", "Errors") — this file implements that contract.
 */

import { PackFatalError, type ByteSource } from '@byteql/core';

import { createChunkWindow, type WindowRead } from './chunk-window.js';
import { normalizeLinktype, PCAP_CHUNK_BYTES, type PcapFramingIssue, type PcapPacketBody } from './container.js';
import { optionText, walkOptions } from './options.js';

export const BLOCK_SHB = 0x0a0d0d0a;
export const BLOCK_IDB = 1;
export const BLOCK_OPB = 2;
export const BLOCK_SPB = 3;
export const BLOCK_EPB = 6;
/** Valid block types that are not projected: NRB, ISB, systemd journal, DSB, custom (copyable / not). */
const SILENTLY_SKIPPED = new Set([4, 5, 9, 10, 0xbad, 0x40000bad]);

const BYTE_ORDER_MAGIC = 0x1a2b3c4d;
const MIN_LENGTH = { shb: 28, idb: 20, epb: 32, opb: 32, spb: 16 } as const;
const OPT_COMMENT = 1;
const SHB_OS = 3;
const IF_NAME = 2;
const IF_DESCRIPTION = 3;
const IF_TSRESOL = 9;
const IF_TSOFFSET = 14;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX_EXCLUSIVE = 2n ** 63n;
const NS_PER_S = 1_000_000_000n;

export interface TsResolution {
  base: 10 | 2;
  exponent: number;
}

export interface PcapngInterface {
  /** 1-based file-global ordinal of yielded interfaces; equals the engine's interface_id. */
  ordinal: number;
  section: number;
  ifIndex: number;
  linktype: number;
  snaplen: number;
  name: string | null;
  description: string | null;
  os: string | null;
  comment: string | null;
  tsResolution: TsResolution;
  tsOffsetS: bigint;
  blockStart: number;
  blockEnd: number;
}

export interface PcapngPacket {
  /** 0-based index among yielded packets. */
  index: number;
  interfaceOrdinal: number;
  /** The interface's linktype, raw-IP 101 normalized to 228/229. */
  linktype: number;
  tsNs: bigint | null;
  inclLen: number;
  origLen: number;
  comment: string | null;
  blockStart: number;
  blockEnd: number;
  body: PcapPacketBody;
}

export type PcapngItem = { kind: 'interface'; iface: PcapngInterface } | { kind: 'packet'; packet: PcapngPacket };

export interface PcapngReader {
  next(): Promise<PcapngItem | null>;
  issues(): readonly PcapFramingIssue[];
  bytesConsumed(): number;
}

export const decodeTsResolution = (byte: number): TsResolution =>
  byte & 0x80 ? { base: 2, exponent: byte & 0x7f } : { base: 10, exponent: byte };

export const formatTsResolution = (r: TsResolution): string => `${r.base}^-${r.exponent}`;

/** Precomputed per interface so the per-packet cost is one multiply/divide or shift. */
interface TsScale {
  multiply: bigint;
  divide: bigint;
  shift: bigint;
  offsetNs: bigint;
}

const tsScale = (r: TsResolution, offsetS: bigint): TsScale =>
  r.base === 10
    ? r.exponent <= 9
      ? { multiply: 10n ** BigInt(9 - r.exponent), divide: 1n, shift: 0n, offsetNs: offsetS * NS_PER_S }
      : { multiply: 1n, divide: 10n ** BigInt(r.exponent - 9), shift: 0n, offsetNs: offsetS * NS_PER_S }
    : { multiply: NS_PER_S, divide: 1n, shift: BigInt(r.exponent), offsetNs: offsetS * NS_PER_S };

/** floor(units · 10⁹ · resolution) + offset. `units` is non-negative, so `/` and `>>` floor. */
const toNs = (units: bigint, s: TsScale): bigint => ((units * s.multiply) / s.divide >> s.shift) + s.offsetNs;

const dataView = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** true = little-endian, false = big-endian, null = not a byte-order magic. */
const byteOrderAt = (view: DataView, offset: number): boolean | null => {
  if (view.getUint32(offset, true) === BYTE_ORDER_MAGIC) return true;
  if (view.getUint32(offset, false) === BYTE_ORDER_MAGIC) return false;
  return null;
};

const hex8 = (value: number): string => `0x${value.toString(16).padStart(8, '0')}`;

export async function createPcapngReader(
  source: ByteSource,
  chunkBytes: number = PCAP_CHUNK_BYTES,
): Promise<PcapngReader> {
  // The first Section Header Block decides whether this is pcapng at all: fatal paths only here.
  const head = await source.read(0, 16);
  const headView = dataView(head);
  if (head.length < 16 || headView.getUint32(0, false) !== BLOCK_SHB) {
    throw new PackFatalError('NOT_PCAPNG', 'NOT_PCAPNG: the file does not start with a pcapng Section Header Block');
  }
  const firstOrder = byteOrderAt(headView, 8);
  if (firstOrder === null) {
    throw new PackFatalError(
      'BAD_BYTE_ORDER_MAGIC',
      `BAD_BYTE_ORDER_MAGIC: first section byte-order magic is ${hex8(headView.getUint32(8, false))}`,
    );
  }
  const firstMajor = headView.getUint16(12, firstOrder);
  if (firstMajor !== 1) {
    throw new PackFatalError(
      'UNSUPPORTED_SECTION_VERSION',
      `UNSUPPORTED_SECTION_VERSION: first section major version ${firstMajor} is not 1`,
    );
  }

  const window = createChunkWindow(source, chunkBytes, 0);
  const issues: PcapFramingIssue[] = [];
  const unsupported = new Map<number, { count: number; start: number; end: number }>();
  let littleEndian = firstOrder;
  let section = -1;
  let sectionOs: string | null = null;
  // Positional per section; a malformed IDB leaves `null` so later indices stay correct.
  let interfaces: ({ iface: PcapngInterface; scale: TsScale } | null)[] = [];
  let ordinal = 0;
  let packetIndex = 0;
  let cursor = 0;
  let stopped = false;
  let finished = false;

  const report = (code: string, message: string, start: number, end: number) =>
    issues.push({ code, message, sourceStart: start, sourceEnd: end });
  const stop = (code: string, message: string, start: number, end: number) => {
    report(code, message, start, end);
    stopped = true;
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const [type, entry] of unsupported) {
      report(
        'UNSUPPORTED_BLOCK_TYPE',
        `block type ${hex8(type)}: ${entry.count} block(s) skipped`,
        entry.start,
        entry.end,
      );
    }
  };

  const next = async (): Promise<PcapngItem | null> => {
    while (!stopped) {
      const blockStart = cursor;
      if (blockStart >= source.size) {
        stopped = true;
        break;
      }
      const remaining = source.size - blockStart;
      if (remaining < 12) {
        stop(
          'TRUNCATED_BLOCK',
          `block at ${blockStart}: expected a 12-byte block header but only ${remaining} bytes remain`,
          blockStart,
          source.size,
        );
        break;
      }
      const generationAtStart = window.generation;
      const headerView = dataView((await window.ensure(blockStart, 12)).bytes);
      const isShb = headerView.getUint32(0, false) === BLOCK_SHB; // palindrome: order-independent
      if (isShb) {
        const order = byteOrderAt(headerView, 8);
        if (order === null) {
          stop(
            'BAD_BYTE_ORDER_MAGIC',
            `section header at ${blockStart}: byte-order magic is ${hex8(headerView.getUint32(8, false))}`,
            blockStart,
            blockStart + 12,
          );
          break;
        }
        littleEndian = order;
      }
      const type = headerView.getUint32(0, littleEndian);
      const length = headerView.getUint32(4, littleEndian);
      if (length < 12 || length % 4 !== 0) {
        stop(
          'BLOCK_LENGTH_MISMATCH',
          `block at ${blockStart}: total length ${length} is not a multiple of 4 of at least 12`,
          blockStart,
          blockStart + 12,
        );
        break;
      }
      if (length > remaining) {
        stop(
          'TRUNCATED_BLOCK',
          `block at ${blockStart}: declared ${length} bytes but only ${remaining} remain`,
          blockStart,
          source.size,
        );
        break;
      }
      const blockEnd = blockStart + length;
      const parsed =
        isShb || type === BLOCK_IDB || type === BLOCK_EPB || type === BLOCK_OPB || type === BLOCK_SPB;
      // Parsed blocks are read whole (one window read, so the body view and the trailer come from
      // the same chunk); skipped blocks only read their trailer.
      const read: WindowRead | null = parsed ? await window.ensure(blockStart, length) : null;
      const trailer = read
        ? dataView(read.bytes).getUint32(length - 4, littleEndian)
        : dataView((await window.ensure(blockEnd - 4, 4)).bytes).getUint32(0, littleEndian);
      if (trailer !== length) {
        stop(
          'BLOCK_LENGTH_MISMATCH',
          `block at ${blockStart}: trailing length ${trailer} does not match leading length ${length}`,
          blockStart,
          blockEnd,
        );
        break;
      }
      cursor = blockEnd;

      if (!read) {
        if (!SILENTLY_SKIPPED.has(type)) {
          const entry = unsupported.get(type);
          if (entry) entry.count += 1;
          else unsupported.set(type, { count: 1, start: blockStart, end: blockEnd });
        }
        continue;
      }

      const bytes = read.bytes;
      const view = dataView(bytes);
      const le = littleEndian;
      const malformedOptions = () =>
        report('MALFORMED_OPTION', `block at ${blockStart}: an option runs past the options area`, blockStart, blockEnd);

      if (isShb) {
        if (length < MIN_LENGTH.shb) {
          stop(
            'MALFORMED_BLOCK',
            `section header at ${blockStart}: ${length} bytes is shorter than the 28-byte minimum`,
            blockStart,
            blockEnd,
          );
          break;
        }
        const major = view.getUint16(12, le);
        if (major !== 1) {
          stop(
            'UNSUPPORTED_SECTION_VERSION',
            `section header at ${blockStart}: major version ${major} is not 1`,
            blockStart,
            blockEnd,
          );
          break;
        }
        section += 1;
        interfaces = [];
        sectionOs = null;
        const walk = walkOptions(view, 24, length - 4, le, (code, start, size) => {
          if (code === SHB_OS && sectionOs === null) sectionOs = optionText(bytes, start, size);
        });
        if (walk === 'malformed') malformedOptions();
        continue;
      }

      if (type === BLOCK_IDB) {
        if (length < MIN_LENGTH.idb) {
          interfaces.push(null);
          report(
            'MALFORMED_BLOCK',
            `interface description at ${blockStart}: ${length} bytes is shorter than the 20-byte minimum`,
            blockStart,
            blockEnd,
          );
          continue;
        }
        let name: string | null = null;
        let description: string | null = null;
        let comment: string | null = null;
        let tsResolution: TsResolution = { base: 10, exponent: 6 };
        let tsOffsetS = 0n;
        const walk = walkOptions(view, 16, length - 4, le, (code, start, size) => {
          if (code === OPT_COMMENT) comment ??= optionText(bytes, start, size);
          else if (code === IF_NAME) name ??= optionText(bytes, start, size);
          else if (code === IF_DESCRIPTION) description ??= optionText(bytes, start, size);
          else if (code === IF_TSRESOL && size >= 1) tsResolution = decodeTsResolution(bytes[start]!);
          else if (code === IF_TSOFFSET && size >= 8) tsOffsetS = view.getBigInt64(start, le);
        });
        if (walk === 'malformed') malformedOptions();
        ordinal += 1;
        const iface: PcapngInterface = {
          ordinal,
          section,
          ifIndex: interfaces.length,
          linktype: view.getUint16(8, le),
          snaplen: view.getUint32(12, le),
          name,
          description,
          os: sectionOs,
          comment,
          tsResolution,
          tsOffsetS,
          blockStart,
          blockEnd,
        };
        interfaces.push({ iface, scale: tsScale(tsResolution, tsOffsetS) });
        return { kind: 'interface', iface };
      }

      // Packet blocks: EPB, OPB, SPB.
      const isSpb = type === BLOCK_SPB;
      const minimum = isSpb ? MIN_LENGTH.spb : MIN_LENGTH.epb;
      if (length < minimum) {
        report(
          'MALFORMED_BLOCK',
          `packet block at ${blockStart}: ${length} bytes is shorter than the ${minimum}-byte minimum`,
          blockStart,
          blockEnd,
        );
        continue;
      }
      const interfaceIndex = isSpb ? 0 : type === BLOCK_EPB ? view.getUint32(8, le) : view.getUint16(8, le);
      const entry = interfaces[interfaceIndex];
      if (entry === undefined || entry === null) {
        report(
          'UNKNOWN_INTERFACE',
          `packet block at ${blockStart}: interface ${interfaceIndex} is not declared in section ${section}`,
          blockStart,
          blockEnd,
        );
        continue;
      }
      let dataStart: number;
      let inclLen: number;
      let origLen: number;
      let tsNs: bigint | null = null;
      let comment: string | null = null;
      if (isSpb) {
        dataStart = 12;
        origLen = view.getUint32(8, le);
        const room = length - 16;
        const snaplen = entry.iface.snaplen === 0 ? room : entry.iface.snaplen;
        inclLen = Math.min(origLen, snaplen, room);
      } else {
        dataStart = 28;
        inclLen = view.getUint32(20, le);
        origLen = view.getUint32(24, le);
        if (dataStart + inclLen > length - 4) {
          report(
            'MALFORMED_BLOCK',
            `packet block at ${blockStart}: captured length ${inclLen} exceeds the block's ${length - 32} data bytes`,
            blockStart,
            blockEnd,
          );
          continue;
        }
        const units = (BigInt(view.getUint32(12, le)) << 32n) | BigInt(view.getUint32(16, le));
        tsNs = toNs(units, entry.scale);
        if (tsNs < INT64_MIN || tsNs >= INT64_MAX_EXCLUSIVE) {
          report(
            'TIMESTAMP_OUT_OF_RANGE',
            `packet block at ${blockStart}: timestamp ${tsNs} ns does not fit in 64 bits`,
            blockStart,
            blockEnd,
          );
          tsNs = null;
        }
        const optionsStart = dataStart + ((inclLen + 3) & ~3);
        const walk = walkOptions(view, optionsStart, length - 4, le, (code, start, size) => {
          if (code === OPT_COMMENT) comment ??= optionText(bytes, start, size);
        });
        if (walk === 'malformed') malformedOptions();
      }
      const body = window.stable(
        { bytes: bytes.subarray(dataStart, dataStart + inclLen), isChunkView: read.isChunkView },
        generationAtStart,
      );
      const packet: PcapngPacket = {
        index: packetIndex,
        interfaceOrdinal: entry.iface.ordinal,
        linktype: normalizeLinktype(entry.iface.linktype, body),
        tsNs,
        inclLen,
        origLen,
        comment,
        blockStart,
        blockEnd,
        body: { start: blockStart + dataStart, bytes: body },
      };
      packetIndex += 1;
      return { kind: 'packet', packet };
    }
    finish();
    return null;
  };

  return { next, issues: () => issues, bytesConsumed: () => cursor };
}
```

Notes for the implementer:

- Keep `head.length < 16 ||` first in the NOT_PCAPNG check: the short-circuit stops
  `getUint32(0)` from reading past a buffer shorter than 4 bytes.
- `(units * s.multiply) / s.divide >> s.shift`: JS precedence makes `>>` bind looser than `/`, so
  this is `((units * m) / d) >> shift` as intended; keep the outer parentheses as written for
  readability.
- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @byteql/pcap exec vitest run test/pcapng.test.ts`
Expected: PASS.

- [ ] **Step 6: Gate and commit**

Run: `pnpm --filter @byteql/pcap test -- --run && pnpm -r check && pnpm lint`

```bash
git add packages/formats/pcap/src/pcapng.ts packages/formats/pcap/test/pcapng.test.ts packages/formats/pcap/test/pcapng-fixtures.ts
git commit -m "feat(pcap): add the streaming pcapng block reader"
```

---

### Task 6: pcapng reader — every error path

Test-first against Task 5's reader; fix the reader wherever a test disagrees with the spec's
"Errors" section.

**Files:**

- Test: `packages/formats/pcap/test/pcapng-errors.test.ts`
- Modify (only if a test fails): `packages/formats/pcap/src/pcapng.ts`

**Interfaces:**

- Consumes: `createPcapngReader`, `PcapngItem` (Task 5); `buildPcapngWithOffsets`, option helpers
  (Task 2).

- [ ] **Step 1: Write the tests**

```ts
import { memoryByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { buildPcapngWithOffsets, IF_TSOFFSET, IF_TSRESOL, OPT_COMMENT, optI64, optText, optU8, type PcapngBlock } from './build-pcapng.js';
import { createPcapngReader, type PcapngItem } from '../src/pcapng.js';

const base: PcapngBlock[] = [
  { type: 'shb', endian: 'le' },
  { type: 'idb', linktype: 1 },
  { type: 'epb', interfaceId: 0, ts: 1n, data: Uint8Array.of(1, 2, 3, 4) },
];

const run = async (bytes: Uint8Array) => {
  const reader = await createPcapngReader(memoryByteSource(bytes));
  const items: PcapngItem[] = [];
  for (let item = await reader.next(); item !== null; item = await reader.next()) items.push(item);
  return { items, issues: reader.issues(), packets: items.filter((i) => i.kind === 'packet').length };
};

const setU32 = (bytes: Uint8Array, at: number, value: number) =>
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(at, value, true);

describe('pcapng fatal first block', () => {
  it('BAD_BYTE_ORDER_MAGIC on the first SHB is fatal', async () => {
    const { bytes } = buildPcapngWithOffsets([{ type: 'shb', endian: 'le', byteOrderMagic: 0x11223344 }]);
    await expect(createPcapngReader(memoryByteSource(bytes))).rejects.toMatchObject({ code: 'BAD_BYTE_ORDER_MAGIC' });
  });

  it('a first SHB with major version 2 is fatal', async () => {
    const { bytes } = buildPcapngWithOffsets([{ type: 'shb', endian: 'le', major: 2 }]);
    await expect(createPcapngReader(memoryByteSource(bytes))).rejects.toMatchObject({
      code: 'UNSUPPORTED_SECTION_VERSION',
    });
  });

  it('a head shorter than 16 bytes is NOT_PCAPNG', async () => {
    await expect(createPcapngReader(memoryByteSource(Uint8Array.of(0x0a, 0x0d)))).rejects.toMatchObject({
      code: 'NOT_PCAPNG',
    });
  });
});

describe('pcapng stop-and-keep errors', () => {
  it('BLOCK_LENGTH_MISMATCH when the trailer disagrees, keeping earlier packets', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets([...base, ...base.slice(2)]);
    const second = blocks[3]!;
    setU32(bytes, second.end - 4, 999);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(1);
    expect(issues).toEqual([expect.objectContaining({ code: 'BLOCK_LENGTH_MISMATCH', sourceStart: second.start, sourceEnd: second.end })]);
  });

  it('BLOCK_LENGTH_MISMATCH when the length is not a multiple of 4', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets(base);
    setU32(bytes, blocks[2]!.start + 4, 33);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(0);
    expect(issues[0]).toMatchObject({ code: 'BLOCK_LENGTH_MISMATCH', sourceStart: blocks[2]!.start });
  });

  it('TRUNCATED_BLOCK when a block runs past EOF, and when fewer than 12 bytes remain', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets(base);
    const cut = await run(bytes.subarray(0, bytes.length - 2));
    expect(cut.issues[0]).toMatchObject({ code: 'TRUNCATED_BLOCK', sourceStart: blocks[2]!.start });
    const tail = new Uint8Array(bytes.length + 6);
    tail.set(bytes);
    const short = await run(tail);
    expect(short.packets).toBe(1);
    expect(short.issues[0]).toMatchObject({ code: 'TRUNCATED_BLOCK', sourceStart: bytes.length, sourceEnd: bytes.length + 6 });
  });

  it('a later SHB with a bad byte-order magic stops with BAD_BYTE_ORDER_MAGIC', async () => {
    const { bytes } = buildPcapngWithOffsets([...base, { type: 'shb', endian: 'le', byteOrderMagic: 0 }, ...base.slice(1)]);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(1);
    expect(issues[0]!.code).toBe('BAD_BYTE_ORDER_MAGIC');
  });

  it('a later SHB with major version 2 stops with UNSUPPORTED_SECTION_VERSION', async () => {
    const { bytes } = buildPcapngWithOffsets([...base, { type: 'shb', endian: 'be', major: 2 }, ...base.slice(1)]);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(1);
    expect(issues[0]!.code).toBe('UNSUPPORTED_SECTION_VERSION');
  });

  it('an SHB shorter than 28 bytes stops with MALFORMED_BLOCK', async () => {
    const { bytes } = buildPcapngWithOffsets([
      ...base,
      { type: 'raw', blockType: 0x0a0d0d0a, body: Uint8Array.of(0x4d, 0x3c, 0x2b, 0x1a) },
      ...base.slice(1),
    ]);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(1);
    expect(issues[0]!.code).toBe('MALFORMED_BLOCK');
  });
});

describe('pcapng skip-and-continue errors', () => {
  it('UNKNOWN_INTERFACE skips the packet and continues', async () => {
    const { bytes } = buildPcapngWithOffsets([
      ...base,
      { type: 'epb', interfaceId: 5, ts: 1n, data: Uint8Array.of(9) },
      ...base.slice(2),
    ]);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(2);
    expect(issues.map((i) => i.code)).toEqual(['UNKNOWN_INTERFACE']);
  });

  it('a malformed IDB keeps its positional index (Review Focus 1)', async () => {
    const { bytes } = buildPcapngWithOffsets([
      { type: 'shb', endian: 'le' },
      { type: 'raw', blockType: 1, body: new Uint8Array(4) }, // IDB index 0, too short
      { type: 'idb', linktype: 1 }, // IDB index 1
      { type: 'epb', interfaceId: 0, ts: 1n, data: Uint8Array.of(1) },
      { type: 'epb', interfaceId: 1, ts: 2n, data: Uint8Array.of(2) },
    ]);
    const { items, issues } = await run(bytes);
    expect(issues.map((i) => i.code)).toEqual(['MALFORMED_BLOCK', 'UNKNOWN_INTERFACE']);
    const packets = items.flatMap((i) => (i.kind === 'packet' ? [i.packet] : []));
    expect(packets.map((p) => [p.interfaceOrdinal, p.tsNs])).toEqual([[1, 2000n]]);
  });

  it('MALFORMED_BLOCK when the captured length exceeds the block', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets([...base, ...base.slice(2)]);
    setU32(bytes, blocks[2]!.start + 20, 400);
    const { packets, issues } = await run(bytes);
    expect(packets).toBe(1);
    expect(issues[0]).toMatchObject({ code: 'MALFORMED_BLOCK', sourceStart: blocks[2]!.start, sourceEnd: blocks[2]!.end });
  });

  it('MALFORMED_OPTION keeps the packet and the options decoded before the bad one', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets([
      ...base.slice(0, 2),
      {
        type: 'epb',
        interfaceId: 0,
        ts: 1n,
        data: Uint8Array.of(1, 2, 3, 4),
        options: [optText(OPT_COMMENT, 'kept'), optText(OPT_COMMENT, 'x')],
      },
    ]);
    // second option header: after 28 fixed + 4 data + 8 (first option) → length field at +2
    new DataView(bytes.buffer).setUint16(blocks[2]!.start + 28 + 4 + 8 + 2, 0xffff, true);
    const { items, issues } = await run(bytes);
    const packet = items.find((i) => i.kind === 'packet');
    expect(packet?.kind === 'packet' && packet.packet.comment).toBe('kept');
    expect(issues.map((i) => i.code)).toEqual(['MALFORMED_OPTION']);
  });

  it('TIMESTAMP_OUT_OF_RANGE keeps the packet with null timestamps (Review Focus 3)', async () => {
    const { bytes } = buildPcapngWithOffsets([
      { type: 'shb', endian: 'le' },
      { type: 'idb', linktype: 1, options: [optU8(IF_TSRESOL, 0), optI64(IF_TSOFFSET, 2n ** 62n)] },
      { type: 'epb', interfaceId: 0, ts: 0xffff_ffff_ffff_ffffn, data: Uint8Array.of(1) },
    ]);
    const { items, issues } = await run(bytes);
    const packet = items.find((i) => i.kind === 'packet');
    expect(packet?.kind === 'packet' && packet.packet.tsNs).toBeNull();
    expect(issues.map((i) => i.code)).toEqual(['TIMESTAMP_OUT_OF_RANGE']);
  });

  it('UNSUPPORTED_BLOCK_TYPE is one issue per distinct type with a count and first-occurrence range', async () => {
    const { bytes, blocks } = buildPcapngWithOffsets([
      ...base,
      { type: 'raw', blockType: 0x99, body: new Uint8Array(4) },
      { type: 'raw', blockType: 0x99, body: new Uint8Array(8) },
      { type: 'raw', blockType: 0xbad, body: new Uint8Array(4) },
    ]);
    const { issues } = await run(bytes);
    expect(issues).toEqual([
      {
        code: 'UNSUPPORTED_BLOCK_TYPE',
        message: 'block type 0x00000099: 2 block(s) skipped',
        sourceStart: blocks[3]!.start,
        sourceEnd: blocks[3]!.end,
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @byteql/pcap exec vitest run test/pcapng-errors.test.ts`
Expected: PASS against Task 5's reader. For any failure, decide from the spec's "Errors"
section whether the test or the reader is wrong, fix that side, and re-run. Do not weaken an
assertion to make it pass.

- [ ] **Step 3: Gate and commit**

Run: `pnpm --filter @byteql/pcap test -- --run && pnpm -r check`

```bash
git add packages/formats/pcap/test/pcapng-errors.test.ts packages/formats/pcap/src/pcapng.ts
git commit -m "test(pcap): pin every pcapng framing error path"
```

---

### Task 7: pcapng container — framer, probe, manifest, parity, conformance

**Files:**

- Create: `packages/formats/pcap/src/probe.ts`
- Modify: `packages/formats/pcap/src/framer.ts` (add `pcapngFramer`)
- Modify: `packages/formats/pcap/src/index.ts`
- Modify: `packages/formats/pcap/pack.yaml`
- Modify: `packages/formats/pcap/test/fixtures.list.ts`
- Create: `apps/web/src/assets/http2-16-ssl.pcapng`; modify `apps/web/src/assets/PROVENANCE.md`
- Test: `packages/formats/pcap/test/pcapng-pack.test.ts`; new goldens under `test/goldens/`

**Interfaces:**

- Consumes: `createPcapngReader`, `formatTsResolution` (Task 5); `packetRoot`, `interfaceRoot`
  (Task 3).
- Produces: `pcapngFramer: Framer`; `probePcapng(head: Uint8Array): number | null`; container id
  `pcapng`.
- [ ] **Step 1: Vendor the real sample**

```bash
curl -fsSL -o apps/web/src/assets/http2-16-ssl.pcapng \
  https://wiki.wireshark.org/uploads/__moin_import__/attachments/SampleCaptures/http2-16-ssl.pcapng
sha256sum apps/web/src/assets/http2-16-ssl.pcapng
# expected: 3a53d7b87e80bc3a00e9851274f7661a5c51fceffd046cdeda2642d28797e084 (5180 bytes)
tshark -r apps/web/src/assets/http2-16-ssl.pcapng -Y 'tls.handshake.type==1' -T fields -e tcp.dstport -e tls.handshake.extensions_server_name
# expected: 443	localhost
```

It contains one SHB, one Ethernet IDB (`if_tsresol` 9), 24 EPBs (IPv4 and IPv6 loopback TCP/443,
one TLS ClientHello with SNI `localhost`), and one ISB. Add to `PROVENANCE.md` under "Network
captures":

```markdown
- `http2-16-ssl.pcapng` — Wireshark wiki, SampleCaptures.
  Source: https://wiki.wireshark.org/uploads/__moin_import__/attachments/SampleCaptures/http2-16-ssl.pcapng
  Contents: HTTP/2 over TLS on loopback (IPv4 and IPv6, TCP/443) with a TLS ClientHello carrying
  SNI `localhost` (pcapng, Ethernet, nanosecond timestamps, one interface statistics block).
```

Run `rumdl fmt apps/web/src/assets/PROVENANCE.md`.

- [ ] **Step 2: Write the failing pack tests**

`test/pcapng-pack.test.ts`:

```ts
import { readFile } from 'node:fs/promises';

import { ipcToTable, type ParseResult } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { pcapFormatPack } from '../src/index.js';
import { buildPcap, dnsOverTcp, dnsQuery, ethFrame, icmpv6Echo, ipv4, ipv6, tcp, tlsClientHello, udp, type PcapPacket } from './build-pcap.js';
import { pcapngFromPackets } from './build-pcapng.js';
import { multiSectionPcapng } from './pcapng-fixtures.js';
import { parseAndProjectPcap } from './parse-and-project.js';

const rows = (result: ParseResult, name: string) =>
  ipcToTable(result.tables.find((t) => t.name === name)!.ipc)
    .toArray()
    .map((row) => row.toJSON() as Record<string, unknown>);

const parse = (bytes: Uint8Array) => parseAndProjectPcap(bytes, new AbortController().signal);

describe('pcapng probe', () => {
  it('probes pcapng only with both the SHB type and a byte-order magic', () => {
    const le = Uint8Array.of(0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0, 0x4d, 0x3c, 0x2b, 0x1a);
    const be = Uint8Array.of(0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0, 0x1a, 0x2b, 0x3c, 0x4d);
    expect(pcapFormatPack.probeContainer(le)).toEqual({ container: 'pcapng', confidence: 1 });
    expect(pcapFormatPack.probeContainer(be)).toEqual({ container: 'pcapng', confidence: 1 });
    expect(pcapFormatPack.probeContainer(Uint8Array.of(0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4))).toBeNull();
    expect(pcapFormatPack.probeContainer(Uint8Array.of(0x0a, 0x0d, 0x0d, 0x0a))).toBeNull();
    expect(pcapFormatPack.probeContainer(Uint8Array.of(0xd4, 0xc3, 0xb2, 0xa1))?.container).toBe('pcap');
  });
});

describe('pcapng parity with classic pcap', () => {
  const eth4 = (protocol: number, payload: Uint8Array) =>
    ethFrame({ etherType: 0x0800, payload: ipv4({ protocol, src: '10.0.0.1', dst: '10.0.0.2', payload }) });
  const hello = tlsClientHello({ sni: 'parity.example' });
  const dnsTcp = dnsOverTcp({ txId: 9, name: 'tcp.example', type: 1 });
  const packets: PcapPacket[] = [
    { tsSec: 1, tsFrac: 1, data: eth4(17, udp({ srcPort: 5353, dstPort: 53, payload: dnsQuery({ txId: 1, name: 'udp.example', type: 1 }) })) },
    { tsSec: 1, tsFrac: 2, data: eth4(6, tcp({ srcPort: 40001, dstPort: 443, flags: 0x18, seq: 0, payload: hello.subarray(0, 20) })) },
    { tsSec: 1, tsFrac: 3, data: eth4(6, tcp({ srcPort: 40002, dstPort: 53, flags: 0x18, seq: 0, payload: dnsTcp.subarray(0, 5) })) },
    { tsSec: 1, tsFrac: 4, data: eth4(6, tcp({ srcPort: 40001, dstPort: 443, flags: 0x18, seq: 20, payload: hello.subarray(20) })) },
    { tsSec: 1, tsFrac: 5, data: eth4(6, tcp({ srcPort: 40002, dstPort: 53, flags: 0x18, seq: 5, payload: dnsTcp.subarray(5) })) },
    {
      tsSec: 2,
      tsFrac: 0,
      data: ethFrame({
        etherType: 0x86dd,
        payload: ipv6({ nextHeader: 58, src: '2001:db8::1', dst: '2001:db8::2', payload: icmpv6Echo({ id: 3, seq: 4 }) }),
      }),
    },
  ];

  it('produces identical rows in every table except provenance and interface details', async () => {
    const classic = await parse(buildPcap({ magic: 'le_us', linktype: 1, packets }));
    const ng = await parse(pcapngFromPackets({ endian: 'be', linktype: 1, packets }));
    const strip = (r: Record<string, unknown>) =>
      JSON.stringify(
        Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_src_'))),
        (_k, v) => (typeof v === 'bigint' ? `${v}n` : v),
      );
    const tables = pcapFormatPack.schemas().map((s) => s.name).filter((n) => n !== 'interfaces');
    for (const name of tables) {
      const has = (r: ParseResult) => r.tables.some((t) => t.name === name);
      expect(has(ng), name).toBe(has(classic));
      if (!has(classic)) continue;
      expect(rows(ng, name).map(strip), name).toEqual(rows(classic, name).map(strip));
    }
    expect(rows(ng, 'tls').map((r) => r.sni)).toEqual(['parity.example']);
    expect(rows(ng, 'dns').map((r) => r.query_name).sort()).toEqual(['tcp.example', 'udp.example']);
  });
});

describe('pcapng projection', () => {
  it('projects interfaces and packets, with interface_id aligned to the interfaces key', async () => {
    const result = await parse(multiSectionPcapng().bytes);
    const ifaces = rows(result, 'interfaces');
    expect(ifaces.map((r) => [r.interface_id, r.section, r.if_index, r.linktype, r.name, r.os, r.ts_resolution, r.ts_offset_s])).toEqual([
      [1, 0, 0, 1, 'eth0', 'Linux', '10^-9', 0n],
      [2, 0, 1, 101, null, 'Linux', '2^-20', 100n],
      [3, 1, 0, 1, null, null, '10^-6', 0n],
    ]);
    const packets = rows(result, 'packets');
    expect(packets.map((r) => [r.interface_id, r.linktype, r.ts_ns, r.comment])).toEqual([
      [1, 1, 1_700_000_000_123_456_789n, 'first'],
      [2, 228, 105_500_000_000n, null],
      [3, 1, 2_000_000_000n, null],
      [3, 1, null, null],
    ]);
    const ids = new Set(ifaces.map((r) => r.interface_id));
    expect(packets.every((r) => ids.has(r.interface_id))).toBe(true);
    expect(packets[3]!.ts).toBeNull();
    expect(rows(result, 'dns').map((r) => r.query_name)).toEqual(['one.example', 'two.example']);
    expect(rows(result, 'errors').map((r) => r.code)).toEqual(['UNSUPPORTED_BLOCK_TYPE']);
  });

  it('projects the real Wireshark sample with TLS SNI from reassembled TCP', async () => {
    const bytes = new Uint8Array(await readFile(new URL('../../../../apps/web/src/assets/http2-16-ssl.pcapng', import.meta.url)));
    const result = await parse(bytes);
    expect(rows(result, 'packets')).toHaveLength(24);
    expect(rows(result, 'interfaces')).toHaveLength(1);
    expect(rows(result, 'tls').map((r) => r.sni)).toEqual(['localhost']);
    expect(rows(result, 'errors')).toEqual([]);
  });
});
```

Check the export names of the TLS/TCP builders and `tcp()`'s parameters in `test/build-pcap.ts`
before running (e.g. whether `tcp` takes `flags` as a number and whether a SYN is needed for
`tls_stream` to start at offset 0 — see `test/streams.test.ts` for the pattern existing
reassembly tests use, and mirror it). If the `errors` table is not emitted when empty in
`ParseResult`, adjust the last assertion to check that no `errors` rows exist.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @byteql/pcap exec vitest run test/pcapng-pack.test.ts`
Expected: FAIL — `probeContainer` returns null for pcapng.

- [ ] **Step 4: Add the probe, framer, manifest entry, and registration**

`src/probe.ts`:

```ts
/**
 * pcapng probe: the Section Header Block type (0A 0D 0D 0A — the text "\n\r\r\n", weak evidence on
 * its own) AND a byte-order magic at offset 8, in either byte order.
 */
export const probePcapng = (head: Uint8Array): number | null => {
  if (head.length < 12) return null;
  if (head[0] !== 0x0a || head[1] !== 0x0d || head[2] !== 0x0d || head[3] !== 0x0a) return null;
  const le = head[8] === 0x4d && head[9] === 0x3c && head[10] === 0x2b && head[11] === 0x1a;
  const be = head[8] === 0x1a && head[9] === 0x2b && head[10] === 0x3c && head[11] === 0x4d;
  return le || be ? 1 : null;
};
```

`pack.yaml`, append to `containers`:

```yaml
  - id: pcapng
    framer: pcapng
    probe: { hook: pcapng }
```

`src/framer.ts`, add below `pcapFramer` (and import `createPcapngReader`, `formatTsResolution`
from `./pcapng.js`):

```ts
const NS_PER_US = 1000n;

/** floor division for a possibly negative bigint (tsoffset can move timestamps before 1970). */
const floorDiv = (value: bigint, divisor: bigint): bigint => {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
};

export const pcapngFramer: Framer = async function* (source, ctx) {
  const reader = await createPcapngReader(source, ctx.chunkBytes);
  for (let item = await reader.next(); item !== null; item = await reader.next()) {
    ctx.bytes(reader.bytesConsumed()); // before yield
    if (item.kind === 'interface') {
      const iface = item.iface;
      yield {
        root: interfaceRoot({
          section: iface.section,
          if_index: iface.ifIndex,
          linktype: iface.linktype,
          snaplen: iface.snaplen,
          name: iface.name,
          description: iface.description,
          os: iface.os,
          comment: iface.comment,
          ts_resolution: formatTsResolution(iface.tsResolution),
          ts_offset_s: iface.tsOffsetS,
        }),
        provenance: { start: iface.blockStart, end: iface.blockEnd },
        tables: ['interfaces'],
      };
    } else {
      const packet = item.packet;
      yield {
        root: packetRoot({
          ts_us: packet.tsNs === null ? null : floorDiv(packet.tsNs, NS_PER_US),
          ts_ns: packet.tsNs,
          incl_len: packet.inclLen,
          orig_len: packet.origLen,
          linktype: packet.linktype,
          interface_id: packet.interfaceOrdinal,
          comment: packet.comment,
          body: packet.body,
        }),
        provenance: { start: packet.blockStart, end: packet.blockEnd },
        tables: ['packets'],
      };
    }
  }
  for (const issue of reader.issues()) ctx.report(issue);
  ctx.bytes(reader.bytesConsumed());
};
```

`src/index.ts`: import `pcapngFramer` and `probePcapng`; set
`framers: { pcap: pcapFramer, pcapng: pcapngFramer }` and `probes: { pcapng: probePcapng }`.

Rebuild so `pack.generated.ts` gains `FramerName = 'pcap' | 'pcapng'` and
`ProbeHookName = 'pcapng'`: `pnpm --filter @byteql/pcap exec byteql-pack build`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @byteql/pcap exec vitest run test/pcapng-pack.test.ts test/pack.test.ts`
Expected: PASS. If the parity test fails, print the first differing table's rows and find the
cause — parity is the success criterion; do not exclude a table to make it pass.

- [ ] **Step 6: Add conformance fixtures**

In `test/fixtures.list.ts`, give `file`/`built` a container parameter defaulting to `'pcap'`:

```ts
const file = (name: string, path: string, container = 'pcap'): FixtureCase => ({
  name,
  container,
  load: async () => new Uint8Array(await readFile(new URL(path, import.meta.url))),
});
const built = (name: string, make: () => Uint8Array, container = 'pcap'): FixtureCase => ({
  name,
  container,
  load: async () => make(),
});
```

and append:

```ts
  file('http2-16-ssl.pcapng', '../../../../apps/web/src/assets/http2-16-ssl.pcapng', 'pcapng'),
  built('multi-section.pcapng', () => multiSectionPcapng().bytes, 'pcapng'),
  built('dns-stream.pcapng', dnsStreamPcapng, 'pcapng'),
```

(importing `multiSectionPcapng`, `dnsStreamPcapng` from `./pcapng-fixtures.js`).

Generate only the three new goldens and confirm no existing golden changes:

```bash
pnpm --filter @byteql/pcap exec vitest run -u test/conformance.test.ts
git status --short packages/formats/pcap/test/goldens
```

Expected: exactly three new files (`http2-16-ssl.pcapng.golden.json`,
`multi-section.pcapng.golden.json`, `dns-stream.pcapng.golden.json`) and no modified ones. Open
`multi-section.pcapng.golden.json` and check it against the fixture's doc comment (3 interfaces,
4 packets, one `UNSUPPORTED_BLOCK_TYPE` error). Then run the suite **without** `-u`; the fuzz
section must pass (any non-`PackFatalError` throw is a reader bug — fix it in `pcapng.ts` with a
test in `pcapng-errors.test.ts`).

- [ ] **Step 7: Gate and commit**

Run: `pnpm --filter @byteql/pcap test -- --run && pnpm -r check && pnpm lint`

```bash
git add packages/formats/pcap apps/web/src/assets/http2-16-ssl.pcapng apps/web/src/assets/PROVENANCE.md
git commit -m "feat(pcap): accept pcapng as a second capture container"
```

---

### Task 8: Web — sample picker, e2e fixture, acceptance tests

**Files:**

- Modify: `apps/web/src/lib/session/samples.ts`, `apps/web/src/lib/session/samples.test.ts`
- Modify (if it pins the file list): `apps/web/src/lib/session/controller.test.ts` (the "opens the
  pcap sample as a three-file batch" test)
- Modify: `packages/formats/pcap/test/generate-e2e-fixture.test.ts`
- Create: `apps/web/e2e/fixtures/sample.pcapng`
- Modify: `apps/web/e2e/pcap.spec.ts`, `apps/web/e2e/hex-provenance.spec.ts`

**Interfaces:**

- Consumes: the `pcapng` container (Task 7), `pcapngFromPackets` (Task 2).

- [ ] **Step 1: Generate the e2e fixture**

In `generate-e2e-fixture.test.ts`, add (importing `pcapngFromPackets` from `./build-pcapng.js`):

```ts
// Regenerates apps/web/e2e/fixtures/sample.pcapng: the same single eth -> ipv4 -> udp -> dns
// packet as sample.pcap (query "a.ru"), written as a one-interface little-endian pcapng.
it.runIf(process.env.GENERATE_E2E_FIXTURES === '1')('writes the sample.pcapng e2e fixture', () => {
  const data = ethFrame({
    etherType: 0x0800,
    payload: ipv4({
      protocol: 17,
      src: '1.1.1.1',
      dst: '8.8.8.8',
      payload: udp({ srcPort: 5000, dstPort: 53, payload: dnsQuery({ txId: 0x1234, name: 'a.ru', type: 1 }) }),
    }),
  });
  const bytes = pcapngFromPackets({ endian: 'le', linktype: 1, packets: [{ tsSec: 1, tsFrac: 0, data }] });
  const target = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/web/e2e/fixtures/sample.pcapng');
  writeFileSync(target, bytes);
});
```

Run: `GENERATE_E2E_FIXTURES=1 pnpm --filter @byteql/pcap exec vitest run test/generate-e2e-fixture.test.ts`
then `git status --short apps/web/e2e/fixtures` — expected: only `sample.pcapng` is new (the
other fixtures regenerate byte-identically; if any shows as modified, revert it and investigate).

- [ ] **Step 2: Add the pcapng file to the pcap sample**

`samples.ts`: `import http2TlsUrl from '../../assets/http2-16-ssl.pcapng?url';`, append
`{ name: 'http2-16-ssl.pcapng', url: http2TlsUrl }` to the pcap sample's `files`, and change its
description to `'Four captures (pcap and pcapng) projected into packet, interface, IP, TCP, UDP, DNS and TLS tables.'`.
Update `samples.test.ts`'s expected file list and any `controller.test.ts` assertion that pins
the three-file list. Run `pnpm --filter @byteql/web exec vitest run src/lib/session` — PASS.

- [ ] **Step 3: Write the e2e tests**

In `e2e/pcap.spec.ts`, rename the picker test to `'loads the bundled pcap sample as a four-file
session from the picker'` and add after the `dns-stream.pcap` assertion:

```ts
  await expect(page.getByRole('gridcell', { name: 'http2-16-ssl.pcapng' })).toBeVisible();
```

and before the multi-file join regression block:

```ts
  // http2-16-ssl.pcapng is a real Wireshark pcapng: its TLS ClientHello's SNI reaches the tls
  // table, and its single interface lands in interfaces alongside the classic synthetic ones.
  await runSql(page, "select sni from tls where sni = 'localhost'");
  await expect(page.getByRole('gridcell', { name: 'localhost', exact: true }).first()).toBeVisible();
  await runSql(page, "select ts_resolution from interfaces where _src_file = 'http2-16-ssl.pcapng'");
  await expect(page.getByRole('gridcell', { name: '10^-9', exact: true })).toBeVisible();
```

Add a new test (define `samplePcapngPath` next to `samplePcapPath`):

```ts
test('opens a mixed pcap + pcapng session and joins packets to interfaces per file', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);

  await page.getByLabel('Open file input').setInputFiles([samplePcapPath, samplePcapngPath]);
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Both files carry the same DNS packet; each resolves to its own interface row.
  await runSql(
    page,
    `select count(*) as joined from packets p
     join interfaces i on p.interface_id = i.interface_id and p._src_file = i._src_file`,
  );
  await expect(page.getByRole('gridcell', { name: '2', exact: true })).toBeVisible();
  await runSql(page, "select count(*) as n from dns where query_name = 'a.ru'");
  await expect(page.getByRole('gridcell', { name: '2', exact: true })).toBeVisible();
});
```

In `e2e/hex-provenance.spec.ts`, add a pcapng case modeled on `'pcap: browse, reveal,
filter-to-selection, and hidden columns chip'`, using `./fixtures/sample.pcapng`: click
"Browse packets", click Row 1, and assert the highlighted hex range is exactly the EPB block:
`start` 48 (SHB 28 + IDB 20) and `end` 48 + 32 + 64 = 144 (28 fixed + 64 data bytes, already a
multiple of 4, + 4 trailer; the packet is eth 14 + IPv4 20 + UDP 8 + DNS 22 = 64 bytes — the whole fixture is therefore 144 bytes) — then run the same
`gotoOffset` / Shift+ArrowRight / "Filter results to selection" steps and assert Row 1 remains.
Use the helpers already imported in that file (`highlightedHexRange`, `gotoOffset`,
`hexCanvas`).

- [ ] **Step 4: Run the e2e tests**

Run: `pnpm --filter @byteql/web test:e2e -- pcap.spec.ts hex-provenance.spec.ts`
Expected: PASS. (Check `apps/web/scripts/run-playwright.mjs` for how file filters are passed if
this form does not scope the run.)

- [ ] **Step 5: Full gate**

Run: `pnpm check && pnpm lint && pnpm -r test -- --run && pnpm --filter @byteql/web check:bundle && pnpm --filter @byteql/web test:e2e`
Expected: all green. `check:bundle` must accept the new asset (it is a local file referenced by
a `?url` import, like `SkypeIRC.cap`); the wiki URL appears only in `PROVENANCE.md`, which is not
bundled.

- [ ] **Step 6: Commit**

```bash
git add apps/web packages/formats/pcap/test/generate-e2e-fixture.test.ts
git commit -m "feat(web): add a real pcapng TLS capture to the pcap sample"
```

---

### Task 9: Scale benchmark for pcapng

**Files:**

- Modify: `apps/web/e2e/support/capture.ts` (`generateCapture`)
- Modify: `apps/web/e2e/scale-metrics.spec.ts` (line ~56 `generateCapture` call, line ~63 file
  name)
- Modify: `apps/web/scripts/run-scale-bench.mjs`
- Modify (conditional): `packages/formats/pcap/src/pcapng.ts`

**Interfaces:**

- Produces: `generateCapture(bytesTarget: number, seed: number, container?: 'pcap' | 'pcapng'): GeneratedCapture`;
  env `BYTEQL_SCALE_CONTAINER`; CLI flag `--container pcap|pcapng`.

- [ ] **Step 1: Let the generator write pcapng**

In `capture.ts`, import `pcapngFromPackets` from
`'../../../../packages/formats/pcap/test/build-pcapng.js'`, add the `container` parameter
(default `'pcap'`), account sizes per container, and build accordingly:

```ts
const PCAPNG_PREFIX_SIZE = 28 + 20; // SHB + IDB
const PCAPNG_EPB_OVERHEAD = 32; // 28 fixed + 4 trailer, plus data padding (added per packet)
```

In the loop, replace `totalBytes += PCAP_RECORD_HEADER_SIZE + data.length;` with

```ts
    totalBytes += container === 'pcap' ? PCAP_RECORD_HEADER_SIZE + data.length : PCAPNG_EPB_OVERHEAD + ((data.length + 3) & ~3);
```

initialize `totalBytes` to `container === 'pcap' ? PCAP_GLOBAL_HEADER_SIZE : PCAPNG_PREFIX_SIZE`,
and build with
`container === 'pcap' ? buildPcap({ magic: 'be_us', linktype: 1, packets }) : pcapngFromPackets({ endian: 'le', linktype: 1, packets })`.

- [ ] **Step 2: Thread the container through the spec and the script**

`scale-metrics.spec.ts`:
`const container = process.env.BYTEQL_SCALE_CONTAINER === 'pcapng' ? 'pcapng' : 'pcap';`, pass it
to `generateCapture`, and name the capture file `` `scale.${container}` ``.

`run-scale-bench.mjs`: parse `--container` (default `pcap`, reject anything else with the same
style of error as `--gb`), document it in `HELP_TEXT`, set `env.BYTEQL_SCALE_CONTAINER`, and name
the output `scale-${gb}gb-${date}.json` for pcap (unchanged) and
`scale-${gb}gb-pcapng-${date}.json` for pcapng; include `container=${container}` in the summary
line.

- [ ] **Step 3: Run a small smoke run of both containers**

Run: `pnpm --filter @byteql/web test:e2e -- scale-metrics.spec.ts` and
`BYTEQL_SCALE_CONTAINER=pcapng pnpm --filter @byteql/web test:e2e -- scale-metrics.spec.ts`
Expected: both PASS at the default 96 MiB target.

- [ ] **Step 4: Measure at 1 GB**

Run: `node apps/web/scripts/run-scale-bench.mjs --gb 1` and
`node apps/web/scripts/run-scale-bench.mjs --gb 1 --container pcapng`
Record both `BYTEQL_SCALE_BENCH_SUMMARY` lines. Targets: classic must not regress beyond noise
versus the last recorded ~56 s; pcapng must be < 60 s.

- [ ] **Step 5 (only if pcapng misses 60 s): add exact fast paths**

In `pcapng.ts`, special-case the two common resolutions in `toNs` without changing results:

```ts
const toNs = (units: bigint, s: TsScale): bigint =>
  s.divide === 1n && s.shift === 0n
    ? units * s.multiply + s.offsetNs // 10^-6 and 10^-9 (and every exponent ≤ 9)
    : ((units * s.multiply) / s.divide >> s.shift) + s.offsetNs;
```

Re-run `pcapng.test.ts`, `pcapng-errors.test.ts`, conformance, and the 1 GB bench. If it still
misses, profile (Chromium performance panel on the scale spec) and report the finding instead of
guessing further.

- [ ] **Step 6: Gate and commit**

Run: `pnpm check && pnpm lint`

```bash
git add apps/web/e2e/support/capture.ts apps/web/e2e/scale-metrics.spec.ts apps/web/scripts/run-scale-bench.mjs packages/formats/pcap/src/pcapng.ts
git commit -m "test(web): benchmark pcapng intake at scale"
```

---

### Task 10: Documentation and final gate

**Files:**

- Modify: `docs/superpowers/specs/2026-09-23-pcapng-intake-design.md` (status, implementation
  notes)
- Modify: `docs/pack-authoring.md` ("Adding a container to an existing pack")
- Modify: `AGENTS.md` (Status, repo map entry for `packages/formats/pcap`)
- Modify: `README.md` (format list line 6, pcap package row)
- Modify: `ROADMAP.md` (priority 3 and "Next development cycle")
- [ ] **Step 1: Update the docs**
- Spec: `Status: Implemented.` and an `## Implementation notes` section with the two 1 GB bench
  summaries (date, machine, ms/GB), whether the Task 9 fast path was needed, and any engineering
  discoveries made during Tasks 1–8.
- `pack-authoring.md`: rewrite the "Adding a container" intro to say pcapng is the worked example,
  and reference `pack.yaml`'s `pcapng` entry, `src/probe.ts` (a probe hook, because the block type
  alone is weak evidence), `src/framer.ts` (`pcapngFramer` yielding `interfaces` and `packets`
  records), and the classic framer's synthetic interface as the way to keep a new table populated
  for every container.
- `AGENTS.md`: add a "pcapng intake: shipped <date>" status bullet (container, `interfaces` table,
  new packet columns, the sample, the documented limitations: no compressed captures, no DSB/NRB
  use, no resync after broken length framing) and point **Next** at saved queries; mention
  `chunk-window.ts`, `pcapng.ts`, `options.ts`, `probe.ts` in the repo map.
- `README.md`: "MIDI, pcap/pcapng, and ZIP today" and the pcap package row mentions pcapng.
- `ROADMAP.md`: mark priority 3 done with the date, evidence links (`pcapng-pack.test.ts`,
  `e2e/pcap.spec.ts`) and the design link; mark item 3 of "Next development cycle" done.

Run `rumdl fmt` on every edited Markdown file.

- [ ] **Step 2: Final gate**

Run: `pnpm check && pnpm lint && pnpm -r test -- --run && pnpm --filter @byteql/web check:bundle && pnpm --filter @byteql/web test:e2e`
Expected: all green; test output pristine.

- [ ] **Step 3: Commit**

```bash
git add docs AGENTS.md README.md ROADMAP.md
git commit -m "docs: record pcapng intake as shipped"
```
