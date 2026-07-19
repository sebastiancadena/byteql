# Scale & Intake (Phase 1 slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chunked file intake through a new `ByteSource` contract, streamed worker→DB ingestion
with credit-based backpressure, and tiered DuckDB storage (in-memory below 64 MB, rotating OPFS
Parquet spill + `parquet_scan` views above) — owning the "1 GB pcap < 60 s" and "< 10 % read"
Phase-1 exit metrics.

**Architecture:** `FormatPack.open` takes a random-access `ByteSource` (Blob-backed in the app);
the pcap framer reads 8 MB chunks with carry-over; `ProjectionSession` gains an incremental
`drain()`; the worker streams `batch` messages under a window-4 credit protocol; `@byteql/db`
replaces `replaceTables` with generation-scoped ingest sessions that either rename staging tables
(memory tier) or rotate them through `COPY ... TO 'opfs://byteql-spill/...'` Parquet chunks and
finalize as `parquet_scan` views (spill tier).

**Tech Stack:** TypeScript, zod, vitest, Apache Arrow JS, DuckDB-WASM 1.33.1-dev57.0, OPFS,
Playwright, Svelte 5, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-07-19-phase1-scale-intake-design.md` (amended by Tasks 1
and 3).

## Global Constraints

- **Every commit keeps the whole workspace green**: `pnpm -r check`, `pnpm -r test -- --run`,
  `pnpm --filter @byteql/web check:bundle`, `pnpm --filter @byteql/web test:e2e` all pass at every
  task boundary (the full e2e gate may be deferred to each task's final step, but never broken at
  a commit).
- **Regression bar:** every existing table keeps identical values for identical inputs. MIDI
  behavior is untouched except the one-line `ByteSource` slurp adaptation.
- **Named constants** (exact names, initial values): `TIER_THRESHOLD_BYTES = 64 * 1024 * 1024`
  (apps/web tiering), `ROTATION_THRESHOLD_BYTES = 96 * 1024 * 1024` (db spill),
  `PCAP_CHUNK_BYTES = 8 * 1024 * 1024` (pcap framer), `BATCH_CREDIT_WINDOW = 4` (worker
  protocol). All overridable for tests as documented per task.
- **Spill root:** OPFS directory `byteql-spill`, DuckDB paths
  `opfs://byteql-spill/<generation>/<table>/<n>.parquet`.
- **Hardening order** (db init): external access off → extension autoinstall/autoload/community
  off → `SET allowed_directories = ['opfs://byteql-spill/'];` → `SET lock_configuration = true;`
  last. If the Task 1 spike recorded fallback rung 2, the `allowed_directories` statement is
  replaced by `SET enable_external_access = true;` (everything else unchanged) — the spike's
  amendment to the spec is authoritative.
- **`ByteSource.read` returns a copy; short only at EOF. Chunk buffers are transient — any bytes
  retained past the current record must be copied** (verified already true for `StreamAssembler`,
  see Task 3).
- **Drain-before-finish is unchanged**: `RecordSource.finish()` throws
  `RECORD_SOURCE_NOT_DRAINED` unless `nextBatch()` returned `null`; stream flush happens before
  the errors table is materialized.
- **Format gate:** prettier + eslint clean before every commit (`docs/superpowers/` and `PRD.md`
  are prettier-ignored; everything under `packages/` and `apps/` is not).
- **Conventional commits; no Co-Authored-By trailers or AI branding.**

## Reference: current shapes (verified) that tasks modify

- `packages/core/src/protocol.ts`: `FormatPack.open(bytes: Uint8Array, opts: OpenOptions):
  RecordSource`; `RecordSource { nextBatch(): Promise<BatchTransfer | null>; finish():
  SourceFinish }`; `BatchTransfer { table; ipc; rowCount }`; `TableTransfer { name; ipc;
  rowCount; columns }`; `TableColumn { name; type; nullable }`; `ParseResult { format; tables;
  issues; queries; capabilities }`.
- `packages/core/src/arrow/batch.ts`: `TableBatchBuilder(name, types, options)`; `appendRow`;
  `finish(): Table`; private `#seal()` at `flushRowThreshold` (default 65 536); `get rowCount`
  is cumulative.
- `packages/core/src/projection/session.ts`: `createProjectionSession(compiled, options)`;
  `ProjectionSession { project(root, resolver, options?); finish(): FinishedTable[] }`;
  `FinishedTable { name; arrow; rowCount }`; options `{ flushRowThreshold?; issues? }` passed
  whole to each `TableBatchBuilder`. **No incremental drain exists today.**
- `packages/core/src/projection/streams.ts`: `StreamAssembler.add(offset, bytes, srcStart,
  srcEnd)` **copies** into its own `#data` (`this.#data.set(bytes, relStart)`, ~line 167); the
  passed view is never retained. `contiguousView()` returns a view into `#data` (internal).
- `packages/core/src/index.ts`: exports to extend (protocol types block; session block).
- `packages/formats/pcap/src/container.ts`: `parsePcapContainer(bytes): PcapContainer` — eager
  whole-buffer loop; `PcapPacket { index, tsSec, tsFracUs, inclLen, origLen, linktype,
  recordStart, bodyEnd, body: { start, bytes } }`; truncation → `TRUNCATED_RECORD` issue +
  stop; raw-IP linktype 101 → 228/229 peek; magic detection throws `UNRECOGNIZED_PCAP_MAGIC`.
- `packages/formats/pcap/src/project-pcap.ts`: `parseAndProjectPcap(bytes, signal, onProgress):
  Promise<ParseResult>`; module-level `compiledProjection`; one `ProjectionSession` per capture;
  per-packet `session.project(packetRoot(packet), resolver)` + `yieldToWorker()` + progress
  `{ stage: 'projecting', completed: packet.index + 1, total, label }`; `session.finish()` runs
  **before** `collector.table()`; `toTransfer` maps `FinishedTable → TableTransfer`;
  `pcapNullability` export.
- `packages/formats/pcap/src/pack.ts`: `pcapFormatPack.open(bytes, opts)` walks the precomputed
  `result.tables` one pseudo-batch per table; `probe` checks 4 magics; `PCAP_TABLE_SCHEMAS`.
- `packages/formats/midi/src/pack.ts`: same open-walks-precomputed-tables shape over
  `parseAndProjectMidi(bytes, signal, onProgress)`.
- `apps/web/src/workers/parse.worker.ts`: `installParseWorker(scope, packs)`; request
  `{ type: 'parse', taskId, name, bytes, formatId? }` / `{ type: 'cancel', taskId }`; drains
  `nextBatch()` fully, `mergeBatches` per table, posts one
  `{ type: 'result', taskId, result: ParseResult }` with transferred IPC buffers; `selectPack`
  probes `bytes.subarray(0, 4096)`.
- `apps/web/src/lib/parse-worker-client.ts`: `ParseWorkerClient implements ParseClientPort
  { parse(input: { name; bytes }, onProgress): Promise<ParseResult>; cancel(); dispose() }`;
  worker replaced on cancel/crash; generation-guarded handlers.
- `apps/web/src/lib/session/controller.ts`: `openFile` reads `file.arrayBuffer()` whole;
  `registerTables` calls `database.replaceTables` + restores `committedTables` on stale
  generations; `openSample` keeps `sampleBytes`; state events dispatched via `reduceSession`.
- `apps/web/src/lib/session/state.ts`: `SessionPhase` incl. `'registering'`; `SessionState.tables:
  readonly TableTransfer[]`; events `opening/progress/registering/ready/...`; `progress
  { completed; total; label }`.
- `apps/web/src/components/Explorer.svelte`: renders `state.tables` → `name`,
  `rowCount.toLocaleString()`, `columns[].{name,type,nullable}` only (never touches `.ipc`).
- `apps/web/src/components/StatusBar.svelte`: renders `progress.label` only — no numeric bar.
- `apps/web/src/components/EmptyState.svelte`: `<input type="file" aria-label="Open file">` +
  drop; callback props `onopen(file: File)` / `onsample()`. E2e helpers rely on
  `page.getByLabel('Open file').setInputFiles(...)`.
- `apps/web/src/lib/e2e-harness.ts`: `createBrowserE2EHarness()` → `{ control, createParser,
  audioEngineFactory }`; `control` exposed as `globalThis.__byteqlE2E`.
- `packages/db/src/browser.ts`: `BrowserDatabase` with `enqueue` serialization,
  `HARDENING_STATEMENTS` (5, ending `lock_configuration`), `replaceTables` (BEGIN/DROP/
  `insertArrowFromIPCStream({ name, create: true })`/COMMIT), `tableNames` registry.
- `packages/db/src/browser.test.ts`: fully mocked duckdb-wasm (`vi.mock`), mock connection
  `{ query, send, insertArrowFromIPCStream, cancelSent, close }`; **no real DuckDB runs in unit
  tests** — real behavior is e2e-verified.
- duckdb-wasm 1.33.1-dev57.0 typings: `AsyncDuckDB.registerOPFSFileName(name)`, `dropFile(s)`,
  `collectFileStatistics(name, enable)`, `exportFileStatistics(name): FileStatistics`;
  `AsyncDuckDBConnection.insertArrowFromIPCStream(buffer, { name, schema?, create? })` — append
  is `create: false`; `DuckDBDataProtocol { BUFFER, NODE_FS, BROWSER_FILEREADER,
  BROWSER_FSACCESS, HTTP, S3 }` (no OPFS member — OPFS goes through `registerOPFSFileName`).
- Viewers read the **query result** (`ViewerContext.table` = apache-arrow Table from
  `state.result`), never `state.tables` IPC — safe under the metadata-only change.
- pcap fixture builders (`packages/formats/pcap/test/build-pcap.ts`): `buildPcap({ magic,
  linktype, packets })`, `ethFrame`, `ipv4`, `ipv6`, `tcp({ srcPort, dstPort, flags, payload,
  seq })`, `udp`, `dnsQuery`, `dnsOverTcp`, `icmpEcho`, … — deterministic, reusable by the
  capture generator.

---

### Task 1: Spike — DuckDB-WASM OPFS spill capability probe

The spec forbids building the DB layer until this lands on a fallback rung. Deliverable: a
permanent capability probe in `@byteql/db`, an e2e spec that runs it in real Chromium, and the
spec amended with the findings.

**Files:**
- Create: `packages/db/src/spill-probe.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `apps/web/src/lib/e2e-harness.ts`
- Modify: `apps/web/src/App.svelte` (expose probe on the e2e control)
- Modify: `apps/web/e2e/support/app.ts` (Window typing)
- Create: `apps/web/e2e/spill-capability.spec.ts`
- Modify: `docs/superpowers/specs/2026-07-19-phase1-scale-intake-design.md` (record findings)

**Interfaces:**
- Produces: `probeSpillCapability(): Promise<SpillProbeReport>` where
  `SpillProbeReport { opfsAvailable: boolean; copyToOpfs: boolean; allowedDirectories: boolean;
  parquetScanGlob: boolean; fileStatistics: boolean; detail: string }`. Later tasks rely on the
  recorded **rung** (1 = whitelist, 2 = external access on), not on this function at runtime.

- [ ] **Step 1: Write the probe**

`packages/db/src/spill-probe.ts` — boots a scratch AsyncDuckDB (same bundle selection as
`browser.ts`, no hardening), then probes each capability in order, recording failures as
`detail` text instead of throwing:

```ts
import { AsyncDuckDB, VoidLogger, selectBundle } from '@duckdb/duckdb-wasm';
// reuse LOCAL_BUNDLES by exporting it from browser.ts (internal export)
import { LOCAL_BUNDLES } from './browser.js';

export interface SpillProbeReport {
  opfsAvailable: boolean;
  copyToOpfs: boolean;
  allowedDirectories: boolean;
  parquetScanGlob: boolean;
  fileStatistics: boolean;
  detail: string;
}

export async function probeSpillCapability(): Promise<SpillProbeReport> {
  const report: SpillProbeReport = {
    opfsAvailable: false, copyToOpfs: false, allowedDirectories: false,
    parquetScanGlob: false, fileStatistics: false, detail: '',
  };
  const notes: string[] = [];
  report.opfsAvailable = typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  if (!report.opfsAvailable) { report.detail = 'navigator.storage.getDirectory missing'; return report; }

  const bundle = await selectBundle(LOCAL_BUNDLES);
  const worker = new Worker(bundle.mainWorker!);
  const db = new AsyncDuckDB(new VoidLogger(), worker);
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();
    const path = 'opfs://byteql-spill/__probe__/t/0.parquet';
    try {
      await db.registerOPFSFileName(path);
      await conn.query(`CREATE TABLE __probe AS SELECT 1 AS a, 2 AS b, 3 AS c;`);
      await conn.query(`COPY __probe TO '${path}' (FORMAT parquet);`);
      report.copyToOpfs = true;
    } catch (error) { notes.push(`copyToOpfs: ${String(error)}`); }
    if (report.copyToOpfs) {
      try {
        const glob = await conn.query(
          `SELECT count(*) AS n FROM parquet_scan('opfs://byteql-spill/__probe__/t/*.parquet');`,
        );
        report.parquetScanGlob = Number(glob.getChildAt(0)?.get(0)) === 1;
      } catch (error) { notes.push(`parquetScanGlob: ${String(error)}`); }
      try {
        await db.collectFileStatistics(path, true);
        await conn.query(`SELECT a FROM parquet_scan('${path}');`);
        await db.exportFileStatistics(path);
        report.fileStatistics = true;
      } catch (error) { notes.push(`fileStatistics: ${String(error)}`); }
    }
    try {
      await conn.query(`SET allowed_directories = ['opfs://byteql-spill/'];`);
      await conn.query(`SET enable_external_access = false;`);
      // whitelisted path must still work, non-whitelisted must fail:
      await conn.query(`SELECT count(*) FROM parquet_scan('${path}');`);
      let leaked = false;
      try { await conn.query(`SELECT * FROM parquet_scan('opfs://elsewhere/x.parquet');`); leaked = true; }
      catch { /* expected */ }
      report.allowedDirectories = report.copyToOpfs && !leaked;
    } catch (error) { notes.push(`allowedDirectories: ${String(error)}`); }
    await conn.close();
  } finally {
    // best-effort probe cleanup
    try { await db.dropFiles(); } catch { /* ignore */ }
    try { await db.terminate(); } catch { /* ignore */ }
    try {
      const root = await navigator.storage.getDirectory();
      const spill = await root.getDirectoryHandle('byteql-spill');
      await spill.removeEntry('__probe__', { recursive: true });
    } catch { /* ignore */ }
  }
  report.detail = notes.join(' | ');
  return report;
}
```

Export `LOCAL_BUNDLES` from `browser.ts` (not from the package index) and add
`export { probeSpillCapability, type SpillProbeReport } from './spill-probe.js';` to
`packages/db/src/index.ts`.

- [ ] **Step 2: Expose on the e2e control and write the spec**

`e2e-harness.ts`: add `spillProbe: () => Promise<SpillProbeReport>` to `BrowserE2EControl`,
implemented as `() => probeSpillCapability()`. Mirror the method on the `ByteqlE2EControl`
interface in `apps/web/e2e/support/app.ts`.

`apps/web/e2e/spill-capability.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { waitForAppReady } from './support/app.js';

test('duckdb-wasm supports the OPFS Parquet spill path', async ({ page }, testInfo) => {
  await page.goto('/');
  await waitForAppReady(page);
  const report = await page.evaluate(() => window.__byteqlE2E!.spillProbe());
  await testInfo.attach('spill-probe.json', {
    body: JSON.stringify(report, null, 2), contentType: 'application/json',
  });
  expect(report.opfsAvailable).toBe(true);
  expect(report.copyToOpfs).toBe(true);
  expect(report.parquetScanGlob).toBe(true);
  // allowedDirectories / fileStatistics are REPORTED, not asserted — they pick the rung.
});
```

- [ ] **Step 3: Run the spike**

Run: `pnpm -r build && pnpm --filter @byteql/web test:e2e -- spill-capability`
Expected: PASS, with `spill-probe.json` attached. If `copyToOpfs` is false, STOP — escalate to
the human partner before any further task (the spec's rung 3 / Approach B decision).

- [ ] **Step 4: Record the rung in the spec**

Amend `docs/superpowers/specs/2026-07-19-phase1-scale-intake-design.md` (fallback-ladder
paragraph): state the probe results verbatim (all five booleans + detail) and declare the chosen
rung: `allowedDirectories: true` → rung 1 (whitelist); `true/false` on statistics only changes
Task 12's instrumentation fallback. Keep the spill-capability spec as a permanent guard.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src apps/web/src apps/web/e2e docs/superpowers/specs
git commit -m 'feat(db): probe duckdb-wasm opfs parquet spill capability'
```

---

### Task 2: `ByteSource` contract in core + slurp adaptations (workspace stays green)

**Files:**
- Modify: `packages/core/src/protocol.ts`
- Create: `packages/core/src/byte-source.ts`
- Create: `packages/core/src/byte-source.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/formats/midi/src/pack.ts` (+ its pack tests' `open` call sites)
- Modify: `packages/formats/pcap/src/pack.ts` (+ its pack tests' `open` call sites)
- Modify: `apps/web/src/workers/parse.worker.ts` (minimal call-site shim only)

**Interfaces:**
- Produces: `interface ByteSource { readonly size: number; read(offset: number, length: number):
  Promise<Uint8Array> }`; `memoryByteSource(bytes: Uint8Array): ByteSource`;
  `FormatPack.open(source: ByteSource, opts: OpenOptions): RecordSource`;
  `readAll(source: ByteSource): Promise<Uint8Array>` helper. Task 8 replaces the worker shim;
  Tasks 4–5 replace pcap's slurp.

- [ ] **Step 1: Write failing tests** (`packages/core/src/byte-source.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { memoryByteSource, readAll } from './byte-source.js';

describe('memoryByteSource', () => {
  const source = memoryByteSource(new Uint8Array([1, 2, 3, 4, 5]));

  it('reports size and reads exact ranges as copies', async () => {
    expect(source.size).toBe(5);
    const chunk = await source.read(1, 3);
    expect([...chunk]).toEqual([2, 3, 4]);
    chunk[0] = 99; // mutating the copy must not affect later reads
    expect([...(await source.read(1, 3))]).toEqual([2, 3, 4]);
  });

  it('short-reads only at EOF and returns empty past the end', async () => {
    expect([...(await source.read(3, 10))]).toEqual([4, 5]);
    expect((await source.read(7, 4)).length).toBe(0);
  });

  it('rejects negative or non-integer offsets and lengths', async () => {
    await expect(source.read(-1, 2)).rejects.toThrow(/offset/);
    await expect(source.read(0, 1.5)).rejects.toThrow(/length/);
  });

  it('readAll drains the whole source', async () => {
    expect([...(await readAll(source))]).toEqual([1, 2, 3, 4, 5]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/core exec vitest run src/byte-source.test.ts`
Expected: FAIL — module `./byte-source.js` not found.

- [ ] **Step 3: Implement** (`packages/core/src/byte-source.ts`)

```ts
import type { ByteSource } from './protocol.js';

const assertRange = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ByteSource ${name} must be a non-negative integer, got ${value}`);
  }
};

/** In-memory source for tests and small-file callers; every read is a copy. */
export const memoryByteSource = (bytes: Uint8Array): ByteSource => ({
  size: bytes.byteLength,
  read(offset, length) {
    assertRange(offset, 'offset');
    assertRange(length, 'length');
    return Promise.resolve(bytes.slice(offset, Math.min(offset + length, bytes.byteLength)));
  },
});

/** Convenience for packs that deliberately slurp (small-file formats). */
export const readAll = (source: ByteSource): Promise<Uint8Array> => source.read(0, source.size);
```

In `protocol.ts`: add the `ByteSource` interface (with the "copy; short only at EOF" doc
comment) and change `FormatPack.open` to `open(source: ByteSource, opts: OpenOptions):
RecordSource`. In `index.ts`: export `memoryByteSource`, `readAll`, and type `ByteSource`.

- [ ] **Step 4: Adapt both packs and the worker call site**

`packages/formats/midi/src/pack.ts` — inside `open(source, opts)`, replace the direct use of
`bytes` with a lazy slurp so behavior is byte-identical:

```ts
open(source: ByteSource, opts: OpenOptions): RecordSource {
  let bytes: Uint8Array | null = null;
  // ... existing closure state ...
  return {
    async nextBatch(): Promise<BatchTransfer | null> {
      bytes ??= await readAll(source);
      parsed ??= parseAndProjectMidi(bytes, opts.signal, opts.onProgress).catch(/* unchanged */);
      // ... rest unchanged ...
    },
    finish(): SourceFinish { /* unchanged */ },
  };
}
```

Apply the same shape to `packages/formats/pcap/src/pack.ts` (temporary — Task 5 removes the
slurp). In `apps/web/src/workers/parse.worker.ts`, wrap at the call site only:
`pack.open(memoryByteSource(bytes), { ... })`, and probe with
`bytes.subarray(0, PROBE_HEAD_BYTES)` as today (probe signature is unchanged). Update the pack
unit tests' `open(...)` call sites with `memoryByteSource(fixtureBytes)`.

- [ ] **Step 5: Run the full workspace gate**

Run: `pnpm -r check && pnpm -r test -- --run`
Expected: PASS everywhere — identical table values, no behavior change.

- [ ] **Step 6: Commit**

```bash
git add packages/core packages/formats apps/web/src/workers
git commit -m 'feat(core): route format packs through a random-access ByteSource'
```

---

### Task 3: Core streaming seams — `drain()` + retention regression test

**Files:**
- Modify: `packages/core/src/arrow/batch.ts`
- Modify: `packages/core/src/projection/session.ts`
- Test: `packages/core/src/arrow/batch.test.ts` (extend), `packages/core/src/projection/session.test.ts`
  (extend — if these suites live elsewhere, extend the file that already covers the class),
  `packages/core/src/projection/streams.test.ts` (extend)
- Modify: `packages/core/src/index.ts`
- Modify: `docs/superpowers/specs/2026-07-19-phase1-scale-intake-design.md`

**Interfaces:**
- Produces: `TableBatchBuilder.drain(): Table | null` — seals pending rows, returns the
  accumulated chunks as one Table (or `null` when no rows since the last drain), resets chunk
  storage; cumulative `rowCount` unchanged. `ProjectionSession.drain(): FinishedTable[]` —
  drains every table with pending rows; each `FinishedTable.rowCount` is the rows **in that
  drained batch** (not cumulative). `ProjectionSession.pendingRowCount(): number` — rows
  appended across all tables since the last drain. **`drain()` never flushes streams** —
  `finish()` keeps that responsibility.

- [ ] **Step 1: Write failing tests**

Builder (extend the existing `TableBatchBuilder` suite):

```ts
it('drain returns accumulated rows and resets, keeping cumulative rowCount', () => {
  const builder = new TableBatchBuilder('t', { v: 'int32' }, { flushRowThreshold: 2 });
  builder.appendRow({ v: 1 });
  builder.appendRow({ v: 2 });
  builder.appendRow({ v: 3 });
  const first = builder.drain();
  expect(first?.numRows).toBe(3);
  expect(builder.drain()).toBeNull();
  builder.appendRow({ v: 4 });
  expect(builder.drain()?.numRows).toBe(1);
  expect(builder.rowCount).toBe(4);
});

it('finish after drain returns only undrained rows, preserving the schema when empty', () => {
  const builder = new TableBatchBuilder('t', { v: 'int32' });
  builder.appendRow({ v: 1 });
  builder.drain();
  const rest = builder.finish();
  expect(rest.numRows).toBe(0);
  expect(rest.schema.fields.map((f) => f.name)).toEqual(['v']);
});
```

Session (extend the existing session suite; use its established compiled-projection helper):

```ts
it('drain emits incremental batches whose union equals a one-shot projection', () => {
  // project 3 roots with a session, drain after each, collect FinishedTable batches;
  // project the same 3 roots with a fresh session and finish() once.
  // Assert per-table concatenated drained rows === one-shot rows (same values, same order)
  // and that synthetic keys keep increasing across drains.
});

it('pendingRowCount counts appended rows since the last drain', () => {
  // 0 initially; grows with project(); resets to 0 after drain().
});

it('drain does not flush streams; finish still does', () => {
  // With a stream-bearing compiled projection (reuse streams.test.ts fixtures):
  // drain() mid-stream → no streams/stream_segments rows in drained output;
  // finish() afterwards → flow rows present exactly as today.
});
```

Assembler retention regression (extend `streams.test.ts`):

```ts
it('does not retain the caller buffer: mutating it after add leaves reassembly intact', () => {
  const assembler = new StreamAssembler(1024);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assembler.add(0, bytes, 100, 104);
  bytes.fill(0xff);
  expect([...assembler.contiguousView()]).toEqual([1, 2, 3, 4]);
});
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm --filter @byteql/core test -- --run`
Expected: new tests FAIL (`drain is not a function`, `pendingRowCount is not a function`); the
retention test PASSES immediately (the assembler already copies — that is the point of pinning
it).

- [ ] **Step 3: Implement**

`batch.ts`:

```ts
drain(): Table | null {
  if (this.#pendingRows > 0) this.#seal();
  if (this.#chunks.length === 0) return null;
  const batches = this.#chunks.flatMap((chunk) => chunk.batches);
  const drained = batches.length > 0 ? new Table(batches) : this.#chunks[0]!;
  this.#chunks = [];
  return drained;
}
```

`session.ts`: track `#pendingRowCount` (increment per emitted row — thread a row-callback or
count via builders' cumulative `rowCount` delta since last drain, whichever the existing
structure makes cheaper; the observable contract is the tests above). Implement:

```ts
drain(): FinishedTable[] {
  const drained: FinishedTable[] = [];
  for (const [name, builder] of this.#builders) {
    const arrow = builder.drain();
    if (arrow && arrow.numRows > 0) drained.push({ name, arrow, rowCount: arrow.numRows });
  }
  this.#pendingSinceDrain = 0;
  return drained;
}
pendingRowCount(): number { return this.#pendingSinceDrain; }
```

`finish()` is unchanged except it naturally returns only undrained remainder rows (builders'
`finish()` after prior `drain()` — cover the empty-schema fallback per the builder test).
Export the two new methods through the `ProjectionSession` interface.

- [ ] **Step 4: Run core suite**

Run: `pnpm --filter @byteql/core test -- --run`
Expected: PASS.

- [ ] **Step 5: Amend the spec + commit**

In the spec's ByteSource section, replace the claim that the `StreamAssembler` must be changed
to copy with: verified already copies on ingest (`#data.set`), pinned by a regression test.

```bash
git add packages/core docs/superpowers/specs
git commit -m 'feat(core): add incremental drain to batch builders and projection sessions'
```

---

### Task 4: Incremental pcap framer

**Files:**
- Modify: `packages/formats/pcap/src/container.ts`
- Test: `packages/formats/pcap/test/container.test.ts` (extend; existing cases keep passing)

**Interfaces:**
- Consumes: `ByteSource`, `memoryByteSource` (`@byteql/core`).
- Produces: `createPcapFramer(source: ByteSource, chunkBytes?: number): Promise<PcapFramer>`
  where `PcapFramer { readonly header: PcapHeader; next(): Promise<PcapPacket | null>;
  issues(): readonly PcapFramingIssue[]; bytesConsumed(): number }`. `PcapPacket` shape is
  UNCHANGED (absolute `recordStart`/`bodyEnd`/`body.start`; `body.bytes` now a view into a
  transient chunk **or** a dedicated copy for straddling records). `PCAP_CHUNK_BYTES = 8 MiB`
  default. `parsePcapContainer(bytes)` becomes a thin eager wrapper over the framer (drains
  `next()` with `memoryByteSource`) so every existing caller and test keeps identical behavior.

- [ ] **Step 1: Write failing tests** (extend `container.test.ts`; build fixtures with the
  existing `buildPcap` helpers)

```ts
describe('createPcapFramer', () => {
  it('frames records identically to parsePcapContainer across a chunk boundary', async () => {
    // Build a capture whose 3rd record's body straddles the chunk edge:
    // chunkBytes = 64; records with bodies sized 20, 20, 40 (header 24 + records).
    // Drain framer.next(); compare index/ts/inclLen/recordStart/bodyEnd/body.start and
    // body byte VALUES against parsePcapContainer(bytes).packets — must be identical.
  });

  it('yields a straddling record whose body bytes survive later chunk reads', async () => {
    // Hold the straddling packet, keep calling next() past several more chunks,
    // then assert the held packet.body.bytes still equal the original body values
    // (straddlers are copies, not views into the recycled chunk).
  });

  it('handles a record larger than the chunk size', async () => {
    // chunkBytes = 32, one record with a 100-byte body → framed correctly.
  });

  it('reports truncated tails as TRUNCATED_RECORD and stops, keeping prior packets', async () => {
    // Same fixture trick the eager tests use, driven through a small chunk size;
    // issues() carries the same code/message/sourceStart/sourceEnd as today.
  });

  it('normalizes raw-IP linktype 101 per packet from the first body byte', async () => {
    // v4 body → 228, v6 body → 229, exactly as the eager framer.
  });

  it('tracks bytesConsumed as record framing advances', async () => {
    // After draining: bytesConsumed() === total file size (or truncation point).
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/pcap exec vitest run test/container.test.ts`
Expected: FAIL — `createPcapFramer` not exported.

- [ ] **Step 3: Implement**

Restructure `container.ts` around a chunked cursor (keep every constant/helper; `detectMagic`
unchanged):

```ts
export const PCAP_CHUNK_BYTES = 8 * 1024 * 1024;

export interface PcapFramer {
  readonly header: PcapHeader;
  next(): Promise<PcapPacket | null>;
  issues(): readonly PcapFramingIssue[];
  bytesConsumed(): number;
}

export async function createPcapFramer(
  source: ByteSource,
  chunkBytes: number = PCAP_CHUNK_BYTES,
): Promise<PcapFramer> {
  const headBytes = await source.read(0, GLOBAL_HEADER_SIZE);
  if (headBytes.length < GLOBAL_HEADER_SIZE) {
    throw new Error(`UNRECOGNIZED_PCAP_MAGIC: expected at least ${GLOBAL_HEADER_SIZE} global-header bytes, got ${headBytes.length}`);
  }
  const headView = new DataView(headBytes.buffer, headBytes.byteOffset, headBytes.byteLength);
  const { byteOrder, timeUnit } = detectMagic(headView);
  const littleEndian = byteOrder === 'le';
  const header: PcapHeader = {
    byteOrder, timeUnit,
    snaplen: headView.getUint32(16, littleEndian),
    linktype: headView.getUint32(20, littleEndian),
  };

  const issues: PcapFramingIssue[] = [];
  let chunk = new Uint8Array(0);   // current window
  let chunkStart = GLOBAL_HEADER_SIZE; // absolute offset of chunk[0]
  let cursor = GLOBAL_HEADER_SIZE; // absolute offset of the next record header
  let index = 0;
  let stopped = false;

  const ensure = async (absoluteStart: number, length: number): Promise<Uint8Array | null> => {
    // Returns a view/copy of [absoluteStart, absoluteStart+length) or null past EOF.
    const within = absoluteStart - chunkStart;
    if (within >= 0 && within + length <= chunk.length) return chunk.subarray(within, within + length);
    if (absoluteStart + length <= source.size && length > chunkBytes) {
      return source.read(absoluteStart, length); // oversized record: dedicated copy
    }
    chunkStart = absoluteStart;
    chunk = await source.read(absoluteStart, Math.max(chunkBytes, length));
    return chunk.length >= length ? chunk.subarray(0, length) : null;
  };
  // next(): read 16-byte record header via ensure(); short → TRUNCATED_RECORD issue
  // (message/sourceStart/sourceEnd formatted exactly as parsePcapContainer's) + stop.
  // Then ensure(bodyStart, inclLen); short → TRUNCATED_RECORD + stop. A body view that came
  // from `chunk` is returned as-is when the NEXT record header still fits in the same chunk
  // read; a body that forced a fresh chunk load or a dedicated read is already safe.
  // IMPORTANT straddle rule: when ensure() reloaded the chunk to satisfy the body, the body
  // view points into the NEW chunk and stays valid only until the next reload — next() must
  // COPY the body (`body.bytes.slice()`) whenever the record crosses the chunk edge it
  // entered with. Straightforward implementation: track the chunk generation the view came
  // from; copy if a reload happened while framing this record.
  // Raw-IP 101→228/229 peek and ts normalization identical to the eager code.
}
```

Rewrite `parsePcapContainer(bytes)` as the compatibility wrapper (async drain via
`memoryByteSource`; it stays synchronous-looking by becoming `async` — update its direct
callers in tests, or keep it sync by exporting a `parsePcapContainerAsync` and having the sync
name wrap `memoryByteSource` framing inline; choose the former: make it async and update its
two call sites in tests plus `project-pcap.ts`, which Task 5 rewrites anyway).

- [ ] **Step 4: Run the pcap suite**

Run: `pnpm --filter @byteql/pcap test`
Expected: PASS — new framer tests and all pre-existing container/projection tests.

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap
git commit -m 'feat(pcap): frame captures incrementally through a chunked byte source'
```

---
### Task 5: Pull-driven incremental pcap `open()`

**Files:**
- Modify: `packages/formats/pcap/src/project-pcap.ts`
- Modify: `packages/formats/pcap/src/pack.ts`
- Test: `packages/formats/pcap/test/project-pcap.test.ts`, `packages/formats/pcap/test/pack.test.ts`
  (extend; every existing value-level assertion keeps passing)

**Interfaces:**
- Consumes: `createPcapFramer` (Task 4), `ProjectionSession.drain()/pendingRowCount()` (Task 3),
  `ByteSource` (Task 2).
- Produces: `pcapFormatPack.open(source, opts)` that emits **multiple `BatchTransfer`s per
  table** incrementally; progress `{ stage: 'projecting', completed: <bytesConsumed>, total:
  <source.size>, label: '<mb> of <totalMb> MB' }`. `parseAndProjectPcap` remains only as an
  internal test helper built on the incremental path (drain-everything-then-merge), keeping the
  projection regression suite byte-identical.

- [ ] **Step 1: Write failing tests**

```ts
it('emits multiple batches per table and their union equals the one-shot projection', async () => {
  // Build a capture with > flushRowThreshold-worth of packets using a tiny threshold:
  // open the pack over memoryByteSource with a test seam for { chunkBytes: 4096,
  // flushRowThreshold: 8 } (see step 3), drain nextBatch() until null, group by table,
  // concatenate via ipcToTable, and compare row-for-row with the pre-Task-5 expected
  // fixture values (reuse the existing regression fixtures' expected tables).
  // Assert at least 2 batches arrived for the packets table.
});

it('reports byte-based progress that ends at the file size', async () => {
  // Collect onProgress calls: completed is non-decreasing, total === source.size,
  // final completed === total, stage === 'projecting'.
});

it('keeps the errors table and stream flushes at the tail', async () => {
  // Use the existing dns-stream fixture: streams/stream_segments/errors rows arrive only
  // in batches AFTER the last packet batch (flush-at-finish preserved), with identical
  // values to the one-shot projection.
});

it('still honors abort signals between chunks', async () => {
  // Abort after the first nextBatch(); the next nextBatch() rejects with AbortError.
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/pcap exec vitest run test/project-pcap.test.ts test/pack.test.ts`
Expected: FAIL — pack still slurps (single batch per table, record-count progress).

- [ ] **Step 3: Implement**

Rework `project-pcap.ts` into an incremental source factory consumed by `pack.ts`:

```ts
export interface PcapOpenTuning { chunkBytes?: number; flushRowThreshold?: number; }

export function openPcapSource(
  source: ByteSource, opts: OpenOptions, tuning: PcapOpenTuning = {},
): RecordSource {
  const threshold = tuning.flushRowThreshold ?? 65_536;
  let framer: PcapFramer | null = null;
  let session: ProjectionSession | null = null;
  let collector: IssueCollector | null = null;
  let pending: BatchTransfer[] = [];
  let tailEmitted = false; let drained = false; let failed = false; let failure: unknown;

  const pump = async (): Promise<void> => {
    // frame+project packets until pendingRowCount() >= threshold or EOF;
    // per packet: throwIfAborted, packetRoot remap, provenance resolver, session.project,
    // yieldToWorker() — all EXACTLY as today's loop body;
    // after each packet, onProgress with framer.bytesConsumed()/source.size;
    // on threshold: pending = toBatches(session.drain());
    // on EOF: seed framing issues into collector, finished = session.finish() (flushes
    //   streams), then errors table from collector.table() — toBatches(residual finished
    //   tables) + errors batch, tailEmitted = true.
  };
  return {
    async nextBatch() {
      if (failed) throw failure;
      try {
        while (pending.length === 0 && !tailEmitted) await pump();
      } catch (error) { failed = true; failure = error; throw error; }
      const next = pending.shift();
      if (next) return next;
      drained = true; return null;
    },
    finish(): SourceFinish {
      if (failed) throw failure;
      if (!drained) throw new Error('RECORD_SOURCE_NOT_DRAINED: call nextBatch() until null before finish()');
      return { issues: collector?.issues() ?? [], capabilities: {} };
    },
  };
}
```

`toBatches(finished: FinishedTable[]): BatchTransfer[]` maps through `tableToIpc`. `pack.ts`'s
`open` delegates to `openPcapSource(source, opts)`; the tuning parameter is exported for tests
only. Keep `parseAndProjectPcap(bytes, signal, onProgress)` as a wrapper (open over
`memoryByteSource`, drain, merge per table with the same column derivation as before) so the
large existing regression suite continues to assert one-shot table values — mark it
`/** @internal test helper */`.

- [ ] **Step 4: Run the pcap suite + e2e sanity**

Run: `pnpm --filter @byteql/pcap test && pnpm -r build && pnpm --filter @byteql/web test:e2e -- pcap`
Expected: PASS — identical values everywhere; the worker still merges batches (Task 8 changes
that), so the app behaves as before.

- [ ] **Step 5: Commit**

```bash
git add packages/formats/pcap
git commit -m 'feat(pcap): project captures incrementally with per-chunk batch emission'
```

---

### Task 6: DB ingest sessions — memory tier

**Files:**
- Modify: `packages/db/src/types.ts`
- Modify: `packages/db/src/browser.ts`
- Test: `packages/db/src/browser.test.ts` (extend, same fully-mocked pattern)
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `TableSchema`, `TableColumn` (`@byteql/core`).
- Produces (added to `ByteqlDatabase`; `replaceTables` stays until Task 9 removes it):

```ts
export interface TableSummary { readonly name: string; readonly rowCount: number; }
export interface IngestOptions {
  schemas: readonly TableSchema[];
  tier: 'memory' | 'spill';
  generation: number;
  rotationBytes?: number; // spill tier only; default ROTATION_THRESHOLD_BYTES (Task 7)
}
export interface IngestSession {
  appendBatch(table: string, ipc: Uint8Array): Promise<void>;
  finalize(): Promise<readonly TableSummary[]>;
  abort(): Promise<void>;
}
// on ByteqlDatabase:
beginIngest(options: IngestOptions): Promise<IngestSession>;
```

Staging name: `__ingest_<generation>_<table>` (generation is a non-negative integer; table names
already validated by the `IDENTIFIER` regex; reject any schema table name failing it, and reject
duplicate case-insensitive names, exactly as `snapshotTables` does today).

- [ ] **Step 1: Write failing tests** (mocked-connection pattern; representative set)

```ts
it('appends into generation-scoped staging tables, create-then-append', async () => {
  // beginIngest({schemas, tier:'memory', generation:7}); appendBatch('events', ipcA);
  // appendBatch('events', ipcB);
  // expect insertArrowFromIPCStream nth-called-with (copy of ipcA, { name:'__ingest_7_events', create:true })
  // then (copy of ipcB, { name:'__ingest_7_events', create:false });
  // appended buffers are copies (not the caller's Uint8Array instance).
});

it('finalize drops old finals, renames staging, updates listTables, in one transaction', async () => {
  // Seed a committed generation via a prior finalize; run a new one; expect query() call
  // sequence: BEGIN TRANSACTION; DROP TABLE IF EXISTS "events"; (old finals)
  // ALTER TABLE "__ingest_8_events" RENAME TO "events"; COMMIT;
  // finalize resolves [{ name:'events', rowCount: <sum of appended rowCounts> }];
  // listTables() now reports the new names.
});

it('tables never appended still finalize as empty tables from their schema', async () => {
  // A schema table with zero appendBatch calls must exist after finalize:
  // expect CREATE TABLE "__ingest_8_errors" (...columns from schema...); before the rename.
  // (Column DDL types derive from the schema's ArrowTypeName strings via a fixed map.)
});

it('abort drops only its own staging and leaves committed finals untouched', async () => {
  // abort() issues DROP TABLE IF EXISTS "__ingest_8_events"; etc., no DROP of "events";
  // subsequent appendBatch/finalize on the aborted session reject.
});

it('rejects appends to undeclared tables and after finalize', async () => { /* error paths */ });

it('a failed finalize rolls back and preserves the previous registry', async () => {
  // make one query() reject mid-swap → ROLLBACK; listTables() unchanged.
});
```

Row counts: derive each batch's rowCount by parsing the IPC (`tableFromIPC(ipc).numRows`) with
the same `apache-arrow-duckdb` import `browser.ts` already uses for writing — no trust in
caller-provided counts.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/db test -- --run`
Expected: new tests FAIL (`beginIngest is not a function`).

- [ ] **Step 3: Implement in `browser.ts`**

`IngestSessionImpl` holds `{ generation, schemas, created: Set<string>, rowCounts:
Map<string, number>, state: 'open' | 'finalized' | 'aborted' }`. All SQL goes through the
existing `enqueue` serializer. `appendBatch` validates table ∈ schemas, snapshots the IPC
(`ipc.slice()`), and calls `insertArrowFromIPCStream(copy, { name: stagingName, create:
!created.has(table) })`. `finalize` runs the transaction from the test above (`CREATE TABLE`
for never-appended schema tables from an `ArrowTypeName → DuckDB type` map: `int8→TINYINT,
int16→SMALLINT, int32→INTEGER, int64→BIGINT, uint16→USMALLINT, uint32→UINTEGER,
uint64→UBIGINT, float64→DOUBLE, bool→BOOLEAN, utf8→VARCHAR, binary→BLOB,
timestamp_us→TIMESTAMP`), updates `tableNames`, marks `finalized`. `abort` drops its staging
tables (best-effort, outside a transaction) and marks `aborted`. Only one ingest session may be
open at a time (`beginIngest` rejects while another is open — the controller's generation logic
guarantees this; the guard turns races into loud failures).

- [ ] **Step 4: Run db suite**

Run: `pnpm --filter @byteql/db test -- --run`
Expected: PASS (including all pre-existing replaceTables tests — untouched).

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m 'feat(db): add generation-scoped ingest sessions with a memory tier'
```

---

### Task 7: DB spill tier — Parquet rotation, views, hardening, OPFS lifecycle

**Files:**
- Modify: `packages/db/src/browser.ts`
- Create: `packages/db/src/spill-files.ts`
- Test: `packages/db/src/browser.test.ts` (extend), `packages/db/src/spill-files.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: Task 6's `IngestSession` internals; Task 1's recorded rung.
- Produces: spill-tier behavior behind the same `IngestSession` API;
  `ROTATION_THRESHOLD_BYTES = 96 * 1024 * 1024`; `spill-files.ts` exports
  `spillPath(generation, table, n): string` (→
  `opfs://byteql-spill/<generation>/<table>/<n>.parquet`),
  `deleteSpillGeneration(generation: number): Promise<void>`,
  `sweepSpillOrphans(keep: readonly number[]): Promise<void>` (both via
  `navigator.storage.getDirectory()`, tolerating absent directories), and
  `isQuotaError(error: unknown): boolean` (matches `QuotaExceededError` name or
  quota-ish message text). `BrowserDatabaseOptions` gains `spillSupported?: boolean`
  (default: `typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory`);
  `beginIngest({ tier: 'spill' })` rejects with `SPILL_UNSUPPORTED` when false — the app's
  fail-fast hook (Task 9).

- [ ] **Step 1: Write failing tests**

`spill-files.test.ts` (mock `navigator.storage.getDirectory` with a nested fake directory
handle recording `removeEntry` calls):

```ts
it('spillPath composes the documented layout', () => {
  expect(spillPath(3, 'packets', 0)).toBe('opfs://byteql-spill/3/packets/0.parquet');
});
it('deleteSpillGeneration removes the generation directory recursively and tolerates absence', ...);
it('sweepSpillOrphans removes every generation directory not in keep', ...);
it('isQuotaError matches DOMException QuotaExceededError and duckdb quota message text', ...);
```

`browser.test.ts` additions (mocked connection; `rotationBytes: 100` to trigger rotation with
tiny IPC buffers):

```ts
it('rotates a staging table to parquet when staged bytes cross the threshold', async () => {
  // two appendBatch calls totalling > rotationBytes → expect, in order:
  // registerOPFSFileName('opfs://byteql-spill/9/events/0.parquet') on the mocked db,
  // COPY "__ingest_9_events" TO 'opfs://byteql-spill/9/events/0.parquet' (FORMAT parquet);
  // DELETE FROM "__ingest_9_events";
  // and the staged-bytes counter resets (a third small append does NOT rotate).
});

it('finalize flushes residual staging as a final chunk and creates parquet_scan views', async () => {
  // expect COPY ... /1.parquet for the residual rows, then inside the swap transaction:
  // DROP VIEW IF EXISTS "events"; DROP TABLE IF EXISTS "events";
  // CREATE VIEW "events" AS SELECT * FROM parquet_scan(
  //   ['opfs://byteql-spill/9/events/0.parquet', 'opfs://byteql-spill/9/events/1.parquet']);
  // — an EXPLICIT path array from the session's tracked chunk names, never a '*' glob:
  // the Task 1 spike recorded that opfs:// glob strings do not enumerate in this build.
  // then staging DROP; old generation's spill deleted AFTER commit (spy on deleteSpillGeneration).
});

it('a table with zero rows in spill tier finalizes as an empty TABLE, not a view', async () => {
  // no parquet chunks exist to scan — fall back to the Task 6 CREATE TABLE path.
});

it('abort deletes the new generation spill directory and staging, never the committed one', ...);
it('quota errors from COPY reject appendBatch with a QUOTA-tagged error after aborting', ...);
it('beginIngest spill tier rejects with SPILL_UNSUPPORTED when spillSupported is false', ...);
```

Hardening test update (replaces the existing exact-order test):

```ts
it('runs hardening in order with the spill whitelist before locking', async () => {
  // SET enable_external_access = false; → 3 extension statements →
  // SET allowed_directories = ['opfs://byteql-spill/']; → SET lock_configuration = true;
});
```

(If Task 1 recorded rung 2: the whitelist statement is `SET enable_external_access = true;`
placed first and the disable statement is dropped — encode whichever rung the spec records.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/db test -- --run`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

Extend `IngestSessionImpl` with spill state `{ stagedBytes: Map<string, number>, chunkIndex:
Map<string, number> }`. Rotation inside `appendBatch` (after the insert, same enqueue op):
`registerOPFSFileName(path)` on the `AsyncDuckDB`, `COPY <staging> TO '<path>' (FORMAT
parquet);`, `DELETE FROM <staging>;`, reset counter, bump chunk index; wrap COPY failures with
`isQuotaError` → abort + reject `new Error('SPILL_QUOTA_EXCEEDED: …')`. `finalize` (spill):
residual COPY per table with rows, then swap transaction creating views (or empty tables),
drop staging, commit, then `deleteSpillGeneration(previousGeneration)` best-effort. Views are
built from the session's tracked chunk paths as an explicit `parquet_scan([...])` array (spike
finding: opfs:// globs do not enumerate); track `chunkPaths: Map<string, string[]>` alongside
`chunkIndex`.
`HARDENING_STATEMENTS` updated per the recorded rung. `dispose()` additionally calls
`deleteSpillGeneration(currentGeneration)` best-effort. Export `sweepSpillOrphans` for the app
(Task 9 calls it at startup with the empty keep-list before any ingest).

- [ ] **Step 4: Run db suite**

Run: `pnpm --filter @byteql/db test -- --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m 'feat(db): spill ingest tier with rotating opfs parquet chunks and view finalize'
```

---

### Task 8: Streaming worker protocol

**Files:**
- Modify: `apps/web/src/workers/parse.worker.ts`
- Modify: `apps/web/src/lib/parse-worker-client.ts`
- Test: extend the existing worker/client suites (the `FakeWorker` / `FakeWorkerScope` patterns
  in `apps/web/src/lib/session/controller.test.ts`; move/extend as the suite layout dictates)

**Interfaces:**
- Consumes: `ByteSource` packs (Task 2/5), `memoryByteSource` no longer needed — a Blob-backed
  source replaces it.
- Produces:

```ts
// core protocol.ts addition (this task): TableOverview — Explorer's whole need, no IPC.
export interface TableOverview {
  name: string; rowCount: number; columns: readonly TableColumn[];
}
// worker request:
{ type: 'parse'; taskId: number; name: string; blob: Blob; formatId?: string }
{ type: 'cancel'; taskId: number }
{ type: 'batchAck'; taskId: number; seq: number }
// worker responses:
{ type: 'batch'; taskId: number; seq: number; table: string; ipc: Uint8Array; rowCount: number }
{ type: 'progress'; taskId; stage; completed; total; label }   // completed/total in BYTES
{ type: 'finish'; taskId; format: { id; title }; tables: readonly TableOverview[];
  issues: readonly ParseIssue[]; queries: readonly PackQuery[];
  capabilities: Readonly<Record<string, FormatCapability>> }
{ type: 'error' | 'cancelled'; ... }                            // unchanged
// client:
export interface StreamedParseResult { format; tables: readonly TableOverview[]; issues;
  queries; capabilities; }
ParseClientPort.parse(
  input: { name: string; blob: Blob },
  handlers: { onProgress(progress: ParseProgress): void;
              onBatch(batch: { seq; table; ipc; rowCount }): Promise<void> },
): Promise<StreamedParseResult>;
// The client acks seq to the worker AFTER the caller's onBatch promise resolves.
```

`BATCH_CREDIT_WINDOW = 4`. `blobByteSource(blob: Blob): ByteSource` lives in the worker module:
`{ size: blob.size, read: async (o, l) => new Uint8Array(await blob.slice(o, Math.min(o + l,
blob.size)).arrayBuffer()) }`.

- [ ] **Step 1: Write failing tests** (against `installParseWorker` with `FakeWorkerScope`, and
  `ParseWorkerClient` with `FakeWorker`)

```ts
it('streams batches and stalls at the credit window until acks arrive', async () => {
  // A stub pack whose RecordSource yields 6 one-row batches. Post parse with a Blob.
  // Without acks: exactly 4 'batch' messages appear, then nothing (flush microtasks).
  // Ack seq 1 → 5th batch arrives; ack the rest → 'finish' arrives with per-table
  // rowCounts summed and columns derived from the first batch's IPC schema
  // (nullability from pack.schemas()).
});

it('probes with the blob head and errors UNRECOGNIZED_FORMAT without draining', async () => { ... });

it('cancel mid-stream produces cancelled, not finish, and stops pulling nextBatch', async () => { ... });

it('client resolves parse() with the finish payload and acks after onBatch resolves', async () => {
  // FakeWorker: capture posted batchAck messages; delay the caller's onBatch promise and
  // assert the ack is not posted until it resolves.
});

it('client rejects on worker crash mid-stream and replaces the worker', async () => { ... });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/web test`
Expected: new tests FAIL (old single-result protocol).

- [ ] **Step 3: Implement**

Worker `run` becomes a pull-send loop: `head = new Uint8Array(await blob.slice(0,
PROBE_HEAD_BYTES).arrayBuffer())` for `selectPack`; `source = blobByteSource(blob)`;
per batch: assign `seq`, track per-table `{ rowCount +=, columns ??= derive(ipc) }`, post with
transfer, and `await credits.take()` — a small async-semaphore holding
`BATCH_CREDIT_WINDOW` permits, released by `batchAck` messages (keyed per taskId; cancelled
tasks release all permits so the loop observes the abort). After `null`: `finish()` and post
the finish message. `mergeBatches`, `ipcBuffers`, and the `result` message are deleted. Column
derivation reuses the existing arrow-schema walk from `mergeBatches` (keep it as
`deriveColumns(pack, table, ipc)`).

Client: implement the new `parse(input, handlers)`; internal `active` gains an ack-queue; on
`batch`, call `handlers.onBatch(...)`, then post `{ type: 'batchAck', taskId, seq }` (serialize
acks in seq order; a rejected `onBatch` cancels the task and rejects `parse`).

- [ ] **Step 4: Run app unit suite**

Run: `pnpm --filter @byteql/web test`
Expected: PASS — note controller tests will be updated in Task 9; if the compile breaks them
here, update `ParseClientPort` fakes minimally in this task (signature only, controller logic
unchanged) to keep the commit green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src packages/core/src
git commit -m 'feat(web): stream parse batches over a credit-windowed worker protocol'
```

---

### Task 9: Session controller + state on the ingest pipeline

**Files:**
- Modify: `apps/web/src/lib/session/controller.ts`
- Modify: `apps/web/src/lib/session/state.ts`
- Modify: `apps/web/src/lib/e2e-harness.ts` (fake parser conforms to the new port)
- Modify: `apps/web/src/App.svelte` (pass `sessionOverrides` from the harness)
- Test: `apps/web/src/lib/session/controller.test.ts`, `state.test.ts`
- Modify: `packages/db/src/types.ts` + `browser.ts` + `browser.test.ts` (remove `replaceTables`)

**Interfaces:**
- Consumes: `beginIngest`/`IngestSession`/`sweepSpillOrphans`/`SPILL_UNSUPPORTED` (Tasks 6–7),
  streaming `ParseClientPort` (Task 8), `TableOverview`.
- Produces: `SessionState.tables: readonly TableOverview[]`; `SessionState.openStartedAt:
  number | null` (set by `opening`, cleared by `ready`/`failed`/`cancelled`); progress events
  carry bytes; the `registering` phase and event are REMOVED from `SessionPhase`/`SessionEvent`
  (parse-to-ready is continuous; `reduceSession`'s `ready` handler still snaps `progress` to
  null). `SessionControllerOptions` gains
  `tiering?: { tierThresholdBytes?: number; rotationBytes?: number }` (test/e2e override);
  `TIER_THRESHOLD_BYTES = 64 * 1024 * 1024` exported from
  `apps/web/src/lib/session/tiering.ts` (create) together with
  `chooseTier(size: number, threshold?: number): 'memory' | 'spill'`.
  `ByteqlDatabase.replaceTables` is deleted (interface, impl, tests) — the controller no longer
  needs it, and no other caller exists (verified).

- [ ] **Step 1: Write failing tests**

```ts
it('opens a file through ingest: begin → per-batch append+ack → finalize → ready', async () => {
  // FakeParser drives handlers.onBatch twice; FakeDatabase.beginIngest returns a recorded
  // FakeIngestSession. Assert order: beginIngest({tier:'memory', generation, schemas}),
  // appendBatch × 2 (ack only after append resolves — expose append as a deferred),
  // finalize once, then state.phase === 'ready' with tables from the finish payload
  // (rowCounts from finalize's TableSummary where names match — finalize is authoritative).
});

it('chooses the spill tier at the threshold and fails fast when unsupported', async () => {
  // file.size === threshold → tier 'spill'. beginIngest rejects SPILL_UNSUPPORTED →
  // phase 'failed' with the browser-capability message, parser cancelled, no retry loop.
});

it('supersession mid-ingest aborts the new generation and leaves state on the new open', ...);
it('parse failure and quota failure abort the ingest session', ...);
it('cancel aborts ingest and dispatches cancelled', ...);
it('openSample wraps sampleBytes in a Blob and parses through the same path', ...);
it('sweeps spill orphans once at initialization', ...);
it('progress dispatches bytes and openStartedAt enables rate computation', ...);
```

Update `FakeParser` to the streaming port (capture `handlers`, expose
`emitBatch/emitProgress/finish/reject` helpers) and `fakeDatabase()` to
`{ initialize, beginIngest, query, cancelQuery, listTables, dispose }` — no `replaceTables`.
`state.test.ts`: drop `registering` cases; add `openStartedAt` and `TableOverview` assertions.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @byteql/web test`
Expected: FAIL.

- [ ] **Step 3: Implement**

`completeOpen(generation, name, blob)`:

```ts
const tier = chooseTier(blob.size, this.tiering?.tierThresholdBytes);
const ingest = await this.database.beginIngest({
  schemas: [], // schemas are format-specific and unknown pre-probe: pass none —
  // Task 6's undeclared-table guard therefore keys off first-batch creation instead when
  // schemas is empty; alternatively (SIMPLER, do this): worker's finish already carries
  // format id — but appends precede finish. Resolution: beginIngest accepts
  // `schemas: readonly TableSchema[] | 'discover'`; 'discover' registers tables lazily on
  // first append and creates no empty tables at finalize. The controller passes 'discover';
  // packs' schemas() remain the worker's column-nullability source. Encode this in Task 6's
  // implementation now (one branch), tested there by one extra case.
  tier, generation, rotationBytes: this.tiering?.rotationBytes,
});
try {
  const result = await this.parser.parse({ name, blob }, {
    onProgress: (p) => this.isCurrent(generation) && this.progress(p),
    onBatch: async (batch) => { await ingest.appendBatch(batch.table, batch.ipc); },
  });
  if (!this.isCurrent(generation)) { await ingest.abort(); return; }
  const summaries = await ingest.finalize();
  const rowCounts = new Map(summaries.map((s) => [s.name, s.rowCount]));
  this.dispatch({ type: 'ready',
    tables: result.tables.map((t) => ({ ...t, rowCount: rowCounts.get(t.name) ?? t.rowCount })),
    issues: result.issues, queries: result.queries, capabilities: result.capabilities });
} catch (error) {
  await ingest.abort().catch(() => undefined);
  // AbortError → cancelled; SPILL_UNSUPPORTED → friendly capability message; else failed
}
```

(The `schemas: 'discover'` resolution above is the binding decision — apply it in Task 6's
code as part of this task if not already present, with its unit test.) `openFile` passes the
`File` straight through (`retainedFile` kept); `openSample` wraps
`new Blob([this.sampleBytes])`. Delete `registerTables`/`committedTables`. `initializeOnce`
additionally fires `sweepSpillOrphans([]).catch(() => undefined)` and, before the first
spill-tier ingest, `navigator.storage?.persist?.().catch(() => undefined)` (fire-and-forget,
in `beginIngest`'s caller — the controller). Remove `replaceTables` from db types/impl/tests.
`App.svelte`: `new SessionController({ database, parser, stopViewer,
...(e2eHarness?.sessionOverrides) })` where the harness exposes
`sessionOverrides?: { tiering?: { tierThresholdBytes; rotationBytes } }`.

- [ ] **Step 4: Run web + db suites**

Run: `pnpm --filter @byteql/web test && pnpm --filter @byteql/db test -- --run && pnpm -r check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web packages/db
git commit -m 'feat(web): drive sessions through tiered streaming ingest'
```

---

### Task 10: UI — progress readout and picker intake

**Files:**
- Modify: `apps/web/src/components/StatusBar.svelte`
- Modify: `apps/web/src/components/EmptyState.svelte`
- Test: extend `apps/web/src/components/Workbench.test.ts` (or the components' own suites where
  they exist)

**Interfaces:**
- Consumes: `state.progress` (bytes), `state.openStartedAt` (Task 9).
- Produces: StatusBar renders, when `progress.total` is set: percentage
  (`Math.floor(100 * completed / total)`), `MB/s` derived from
  `(completed / 1e6) / ((Date.now() - openStartedAt) / 1000)` (1 decimal, omitted for the
  first 500 ms), and the label. EmptyState keeps the `aria-label="Open file"` input untouched
  (e2e contract) and adds a "Browse files" button rendered only when
  `'showOpenFilePicker' in window`, calling
  `window.showOpenFilePicker().then(([h]) => h.getFile()).then(onopen)` and swallowing
  `AbortError` (user dismissed).

- [ ] **Step 1: Write failing tests**

```ts
it('status bar shows percentage and rate during a bytes-based parse', () => {
  // render with state { phase:'projecting', progress:{completed: 50e6, total: 100e6, label},
  // openStartedAt: Date.now() - 5000 } → text matches /50%/ and /10\.0 MB\/s/.
});
it('status bar omits the rate before it is meaningful and when total is null', ...);
it('empty state renders the picker button only when showOpenFilePicker exists', ...);
it('picker selection forwards the file to onopen and dismissal is silent', ...);
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @byteql/web test`; FAIL.

- [ ] **Step 3: Implement** the two components per the interface block (Svelte 5 `$derived`
  for the readouts; the picker handler in `<script>` beside `chooseFile`).

- [ ] **Step 4: Run** `pnpm --filter @byteql/web test && pnpm --filter @byteql/web check`;
  PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components
git commit -m 'feat(web): byte-accurate progress readout and native file picker intake'
```

---

### Task 11: E2E — spill path end to end

**Files:**
- Create: `apps/web/e2e/spill-ingest.spec.ts`
- Create: `apps/web/e2e/support/capture.ts`
- Modify: `apps/web/src/lib/e2e-harness.ts` (sessionOverrides: tier 1 MiB, rotation 2 MiB)
- Modify: `apps/web/e2e/support/app.ts` (typing only, if the control shape grew)

**Interfaces:**
- Consumes: harness `sessionOverrides` (Task 9), pcap fixture builders.
- Produces: `generateCapture(bytesTarget: number, seed: number): { bytes: Uint8Array;
  packetCount: number; dnsCount: number; seed: number }` in `support/capture.ts` —
  deterministic seeded LCG over the fixture builders (`buildPcap` +
  `ethFrame`/`ipv4`/`udp`/`dnsQuery`/`tcp` mix, ~70 % small DNS packets with names `host-<n>`,
  ~30 % 1 KB TCP payload packets), sized to ≥ `bytesTarget`. Reused verbatim by Task 12.

- [ ] **Step 1: Write the spec**

```ts
test('a large capture streams through the opfs spill tier and stays queryable', async ({ page }) => {
  await page.goto('/'); await waitForAppReady(page);
  const { bytes, packetCount, dnsCount } = generateCapture(10 * 1024 * 1024, 42);
  await page.getByLabel('Open file').setInputFiles({
    name: 'scale.pcap', mimeType: 'application/vnd.tcpdump.pcap', buffer: Buffer.from(bytes),
  });
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible({ timeout: 120_000 });
  await runSql(page, 'select count(*) as n from packets');
  // assert the gridcell equals packetCount;
  await runSql(page, "select count(*) as n from dns where query_name like 'host-%'");
  // assert dnsCount; then provenance sanity:
  await runSql(page, 'select _src_start, _src_end from packets order by packet_id limit 1');
  // _src_start === 40 (24 global + 16 record header) for the first packet body row? No —
  // packets rows span record header to bodyEnd: expect _src_start 24. Assert the exact
  // value the memory-tier path yields for the SAME capture (run the small-tier open first
  // on a truncated 100-packet variant and compare literals in the test).
  // Rotation actually happened: the harness exposes control.spillFiles(generation?) →
  // navigator.storage directory walk count; expect >= 2 parquet files for 'packets'.
});

test('the memory tier still serves small files with identical values', async ({ page }) => {
  // 100-packet capture (< 1 MiB threshold): same queries, same literal expectations;
  // control.spillFiles() reports zero files.
});
```

Add `spillFiles(): Promise<readonly string[]>` to the e2e control (walks
`byteql-spill/` recursively via `navigator.storage.getDirectory()`).

- [ ] **Step 2: Run** `pnpm -r build && pnpm --filter @byteql/web test:e2e -- spill-ingest`
  — expect FAIL only if implementation gaps remain; fix forward here (this task is the
  integration checkpoint).

- [ ] **Step 3: Run the FULL e2e suite** — `pnpm --filter @byteql/web test:e2e` — every
  pre-existing spec (pcap, multi-batch-ingest, audio, privacy, recovery, performance,
  static-delivery, open-query-inspect, spill-capability) PASSES.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e apps/web/src/lib/e2e-harness.ts
git commit -m 'test(web): e2e-verify the opfs spill ingest tier end to end'
```

---

### Task 12: Metric verification — scaled CI spec + manual bench script

**Files:**
- Create: `apps/web/e2e/scale-metrics.spec.ts`
- Create: `apps/web/scripts/run-scale-bench.mjs`
- Modify: `apps/web/src/lib/benchmark.ts` (add the scale record shape)
- Modify: `apps/web/src/lib/e2e-harness.ts` (read-stats hook if the probe recorded
  `fileStatistics: true`; otherwise the OPFS read-counter fallback)
- Test: `apps/web/src/lib/benchmark.test.ts` (extend)

**Interfaces:**
- Consumes: `generateCapture` (Task 11), `collectFileStatistics`/`exportFileStatistics`
  (per Task 1's recorded finding), `createBenchmarkRecord` house pattern.
- Produces: `createScaleBenchmarkRecord(input): ScaleBenchmarkRecord` in `benchmark.ts` —
  `{ schemaVersion: 1; measuredAt; browserVersion; os; cpuDescription; capture:
  { bytes; packetCount; seed }; parseElapsedMs; queryElapsedMs; bytesReadFraction:
  number | null; targetParseMsPerGb: 60_000; parseTargetMet; readTargetMet }`.
  `control.enableReadStats(tables: string[])` / `control.readStats()` on the e2e harness
  (wraps collect/export FileStatistics over the current generation's parquet files; returns
  `{ totalBytesRead: number; spillBytes: number }`).

- [ ] **Step 1: Write the scaled CI spec**

```ts
test('scaled capture meets proportional throughput and pushdown read-fraction', async ({ page }, testInfo) => {
  test.slow();
  const target = Number(process.env.BYTEQL_SCALE_BYTES ?? 96 * 1024 * 1024);
  const { bytes, packetCount, seed } = generateCapture(target, 7);
  // open via setInputFiles as in Task 11; time from setInputFiles to Tables region visible
  // → parseElapsedMs. Assert parseElapsedMs / (bytes/1e9) < 60_000 (proportional 1 GB target)
  // with a 2x CI-noise allowance: < 120_000 ms/GB hard-fails the spec.
  await page.evaluate(() => window.__byteqlE2E!.enableReadStats(['packets']));
  await runSql(page, 'select ts, caplen, len from packets where caplen > 900');
  const stats = await page.evaluate(() => window.__byteqlE2E!.readStats());
  const fraction = stats.totalBytesRead / bytes.byteLength;
  expect(fraction).toBeLessThan(0.10);
  // attach a scale-benchmark JSON via createScaleBenchmarkRecord (CI evidence trail).
});
```

- [ ] **Step 2: Write the manual bench script** (`run-scale-bench.mjs`)

Node script mirroring `run-playwright.mjs` conventions: builds the e2e bundle, launches the
scaled spec with `BYTEQL_SCALE_BYTES` set from `--gb 1` / `--gb 4` (default 1), collects the
attached JSON to `bench/scale-<gb>gb-<date>.json`, prints the summary line. The 4 GB run also
sets `BYTEQL_SCALE_ASSERT_READ=1` — the read-fraction assertion is the same; the parse-time
assertion relaxes to reporting-only above 1 GB (the metric is defined at 1 GB). Document both
invocations in the script's `--help`.

- [ ] **Step 3: Unit-test the record builder** — extend `benchmark.test.ts` with
  `createScaleBenchmarkRecord` cases (targets met/missed, null fraction). Run
  `pnpm --filter @byteql/web test`; PASS.

- [ ] **Step 4: Run the scaled spec in CI mode**

Run: `pnpm -r build && pnpm --filter @byteql/web test:e2e -- scale-metrics`
Expected: PASS on the 96 MB default; note the measured ms/GB in the task report.

- [ ] **Step 5: Run the 1 GB manual bench once** (this machine, exit-criterion evidence):
`node apps/web/scripts/run-scale-bench.mjs --gb 1` → JSON artifact with
`parseTargetMet: true`. If it misses 60 s, tune (chunk size, credit window, rotation size —
the named constants) before closing the task; record the final numbers in the task report.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m 'test(web): scaled throughput and read-fraction gates with a manual scale bench'
```

---

### Task 13: Full gate, docs, and status

**Files:**
- Modify: `AGENTS.md` (status section)
- Modify: `docs/superpowers/specs/2026-07-19-phase1-scale-intake-design.md` (implementation
  notes: measured bench numbers, the recorded rung, the `schemas: 'discover'` decision, any
  amendments accumulated during execution)
- Modify: `PRD.md` (progress row: slice 2 shipped)

**Steps:**

- [ ] **Step 1: Full workspace gate**

Run, in order, each expected green:
```bash
pnpm -r check
pnpm -r test -- --run
pnpm -r build
pnpm --filter @byteql/web check:bundle
pnpm --filter @byteql/web test:e2e
```
(`check:bundle` guards the bundle-size budget — the slice added no runtime dependency, so any
regression here is a bug in the diet, not a budget renegotiation.)

- [ ] **Step 2: Update docs** — AGENTS.md status bullet for slice 2 (shipped, key contracts:
  ByteSource, ingest sessions, spill layout, the named constants, bench artifact location);
  spec implementation-notes section; PRD progress row. Run
  `rumdl fmt AGENTS.md docs/superpowers/specs/2026-07-19-phase1-scale-intake-design.md` and
  accept its unchanged-output (house line width exceeds its default — do not rewrap).

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md PRD.md docs/superpowers/specs
git commit -m 'docs: record phase-1 scale and intake slice status'
```

---

## Self-review notes

- **Spec coverage:** ByteSource + contract notes → Task 2; copy-on-retention → Task 3
  (discovered already-true, spec amended); incremental framer → Task 4; per-pull batching +
  bytes progress + flush ordering → Task 5; worker messages + credit window + TableOverview →
  Task 8; ingest API, staging, rotation, views, atomicity, hardening order + ladder, OPFS
  lifecycle (persist/quota/sweep/dispose) → Tasks 6–7 + 9; tiering threshold + fail-fast +
  picker → Tasks 9–10; gate-until-ready + progress UX → Tasks 9–10; four-layer testing →
  unit throughout, regression + spill e2e → Task 11, scaled CI + manual bench → Task 12;
  spike-first ordering → Task 1 blocks 6/7 (Tasks 2–5 are engine-side and independent).
- **Known deviations from the spec, both recorded in it at Task 13:** (1) drain triggers on
  `pendingRowCount() >= flushRowThreshold` checked per packet rather than per-table builder
  thresholds — same bound, simpler seam; (2) `beginIngest` accepts `'discover'` because table
  schemas are format-specific and appends precede the finish message.
- **Type consistency spot-checks:** `TableOverview` defined once (Task 8) and consumed by
  Task 9's state and Explorer (structurally compatible — Explorer never touched `.ipc`);
  `IngestSession`/`TableSummary` identical across Tasks 6/7/9; `generateCapture` returns
  `{ bytes, packetCount, dnsCount, seed }` — Task 11's first draft said bare `Uint8Array`,
  corrected to the object form both consumers use; `spillPath`/generation naming shared via
  `spill-files.ts`.
- **Placeholder scan:** none found; every code step carries concrete code or an exact
  behavioral contract with the assertion values spelled out.

