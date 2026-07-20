# Multi-File Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest a same-format batch of 2–10 files as one atomic session with union tables, a `_src_file` provenance column, a `_files` catalog table, and a per-file hex pane that auto-switches to the selected row's source file.

**Architecture:** App-level composition per the approved spec (`docs/superpowers/specs/2026-07-20-multi-file-sessions-design.md`). `@byteql/core` stays single-file except for reserving the `_src_file` column name. The parse worker stamps `_src_file` onto every batch off the main thread; the session controller loops files sequentially through the one parse worker into a single ingest session; the DB layer gains a per-file boundary API (`beginFile`/`discardCurrentFile`) so a failed file's rows can be removed on both tiers (spill chunks never mix files thanks to boundary rotation).

**Tech Stack:** TypeScript, Svelte 5 (runes), apache-arrow JS, duckdb-wasm, vitest (+ @testing-library/svelte, jsdom for components), pnpm workspaces.

## Global Constraints

- Scale target: 2–10 files per batch; batch open only (no incremental add); same-format only.
- Failure mode: skip-and-report per file; whole-open failure only when zero files survive or on spill quota/support errors (`SPILL_QUOTA_EXCEEDED` / `SPILL_UNSUPPORTED`).
- The ONLY `@byteql/core` change is adding `'_src_file'` to `reservedOutputNames` (Task 1). No pack, projection, or streams behavior changes.
- Reserved provenance columns: `_src_start` (uint64), `_src_end` (uint64, exclusive), `_src_file` (VARCHAR display name).
- Display names: basename, deduplicated with `(2)`-style suffixes before the extension.
- `_files` catalog columns exactly: `file`, `original_name`, `size` (UBIGINT), `ingest_order` (INTEGER, 0-based), `status` (`'ok'`/`'skipped'`), `error` (NULL when ok).
- N=1 uniformity: single-file sessions produce the same schema (`_src_file` present, `_files` with one row). No "multi-file mode" branches.
- File names reaching SQL text MUST go through an escaping helper (`sqlStringLiteral` in the web app, `quoteStringLiteral` in `@byteql/db`) — never ad-hoc concatenation.
- No new dependencies. No `Co-Authored-By` lines in commits. Conventional-commit messages.
- The web app consumes package `dist/` output: after editing `packages/*`, run that package's build before running `apps/web` tests (`pnpm --filter @byteql/core build`, `pnpm --filter @byteql/db build`).
- Final gate (repo gotcha): `pnpm check` does NOT run eslint; run `pnpm lint` and `pnpm format:check` explicitly.

---

### Task 1: Reserve `_src_file` in core projection validation

**Files:**

- Modify: `packages/core/src/projection/project.ts:110`
- Test: `packages/core/src/projection/project.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: packs can no longer declare a `_src_file` output column; error code `PROJECTION_SPEC_INVALID`, message `column "_src_file" is reserved for automatic provenance`. Later tasks rely on `_src_file` being safe to add app-side.
- [ ] **Step 1: Write the failing test**

In `packages/core/src/projection/project.test.ts`, find the existing test that asserts `_src_start` is rejected as a column name (search for `reserved for automatic provenance`) and add a sibling case in the same `describe` block:

```ts
it('rejects a declared _src_file column as reserved provenance', () => {
  const spec = specWithColumn('_src_file');
  expect(() => compileProjection(spec)).toThrowError(/reserved for automatic provenance/u);
});
```

Mirror EXACTLY how the neighboring `_src_start`/`_src_end` reserved-name test builds its spec and invokes compilation (same helper names, same assertion style) — copy that test and change the column name to `_src_file`. The snippet above is the shape; the local helper names in that file are authoritative.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/project.test.ts`
Expected: the new case FAILS (no error thrown — `_src_file` is currently allowed).

- [ ] **Step 3: Implement**

In `packages/core/src/projection/project.ts` line 110:

```ts
const reservedOutputNames = new Set(['_src_start', '_src_end', '_src_file']);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @byteql/core test`
Expected: PASS (all core tests — confirms no pack spec in-tree already uses `_src_file`).

- [ ] **Step 5: Build core and commit**

```bash
pnpm --filter @byteql/core build
git add packages/core/src/projection/project.ts packages/core/src/projection/project.test.ts
git commit -m "feat(core): reserve _src_file as an automatic provenance column"
```

---

### Task 2: Shared pack registry and `selectPack` extraction

**Files:**

- Create: `apps/web/src/lib/packs.ts`
- Create: `apps/web/src/lib/packs.test.ts`
- Modify: `apps/web/src/workers/parse.worker.ts` (remove local `selectPack` + `PROBE_HEAD_BYTES`, import them)

**Interfaces:**

- Consumes: `FormatPack` from `@byteql/core`; `midiFormatPack`, `pcapFormatPack`.
- Produces (used by Tasks 3, 4, 6):
  - `REGISTERED_PACKS: readonly FormatPack[]` — canonical ordered pack list `[midiFormatPack, pcapFormatPack]`.
  - `PROBE_HEAD_BYTES = 4096`.
  - `selectPack(packs: readonly FormatPack[], head: Uint8Array, formatId?: string): FormatPack | null` — moved VERBATIM from `parse.worker.ts:65` (highest confidence wins, strict `>` so first-registered wins ties and 0-confidence never selects; `formatId` bypasses probing).
- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/packs.test.ts`:

```ts
import type { FormatPack } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { PROBE_HEAD_BYTES, REGISTERED_PACKS, selectPack } from './packs.js';

const fakePack = (id: string, confidence: number | null): FormatPack => ({
  id,
  title: id,
  probe: () => confidence,
  schemas: () => [],
  open: () => {
    throw new Error('not used');
  },
  queries: [],
});

describe('selectPack', () => {
  const head = new Uint8Array(0);

  it('selects the highest-confidence pack', () => {
    const packs = [fakePack('a', 0.4), fakePack('b', 0.9)];
    expect(selectPack(packs, head)?.id).toBe('b');
  });

  it('first-registered pack wins ties and zero confidence never selects', () => {
    expect(selectPack([fakePack('a', 0.5), fakePack('b', 0.5)], head)?.id).toBe('a');
    expect(selectPack([fakePack('a', 0), fakePack('b', null)], head)).toBeNull();
  });

  it('formatId bypasses probing and misses return null', () => {
    const packs = [fakePack('a', null)];
    expect(selectPack(packs, head, 'a')?.id).toBe('a');
    expect(selectPack(packs, head, 'zzz')).toBeNull();
  });

  it('registry lists midi then pcap and exposes the probe head size', () => {
    expect(REGISTERED_PACKS.map((pack) => pack.id)).toEqual(['standard_midi_file', 'pcap']);
    expect(PROBE_HEAD_BYTES).toBe(4096);
  });
});
```

Note: if the registry-ids assertion fails on exact id strings, read `pack.id` from `packages/formats/midi` / `packages/formats/pcap` sources and use the real ids — do not change the packs.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/packs.test.ts`
Expected: FAIL — `./packs.js` does not exist.

- [ ] **Step 3: Implement**

Create `apps/web/src/lib/packs.ts`:

```ts
import type { FormatPack } from '@byteql/core';
import { midiFormatPack } from '@byteql/midi';
import { pcapFormatPack } from '@byteql/pcap';

/** Canonical pack registration order — probing ties break toward the earlier entry. */
export const REGISTERED_PACKS: readonly FormatPack[] = [midiFormatPack, pcapFormatPack];

export const PROBE_HEAD_BYTES = 4096;

export const selectPack = (
  packs: readonly FormatPack[],
  head: Uint8Array,
  formatId?: string,
): FormatPack | null => {
  if (formatId !== undefined) return packs.find((pack) => pack.id === formatId) ?? null;
  let best: FormatPack | null = null;
  let bestConfidence = 0;
  // Strict `>`: the first-registered pack wins ties, and a confidence of 0 is never selected.
  for (const pack of packs) {
    const confidence = pack.probe(head);
    if (confidence !== null && confidence > bestConfidence) {
      best = pack;
      bestConfidence = confidence;
    }
  }
  return best;
};
```

In `apps/web/src/workers/parse.worker.ts`: delete the local `PROBE_HEAD_BYTES` const (line 16) and `selectPack` (lines 65–78); delete the now-unused `midiFormatPack`/`pcapFormatPack` imports; add:

```ts
import { PROBE_HEAD_BYTES, REGISTERED_PACKS, selectPack } from '../lib/packs.js';
```

and change `installParseWorker`'s default: `packs: readonly FormatPack[] = REGISTERED_PACKS`.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/packs.test.ts src/lib/session/controller.test.ts`
Expected: PASS (controller.test.ts exercises `installParseWorker` and must still pass).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/packs.ts apps/web/src/lib/packs.test.ts apps/web/src/workers/parse.worker.ts
git commit -m "refactor(web): extract shared pack registry and selectPack"
```

---

### Task 3: Worker stamps `_src_file` on every batch; client forwards `formatId`

**Files:**

- Create: `apps/web/src/workers/stamp-source-file.ts`
- Create: `apps/web/src/workers/stamp-source-file.test.ts`
- Modify: `apps/web/src/workers/parse.worker.ts`
- Modify: `apps/web/src/lib/parse-worker-client.ts`

**Interfaces:**

- Consumes: `ipcToTable`, `tableToIpc` from `@byteql/core`; `TableSchema`.
- Produces (used by Tasks 5, 6):
  - `stampSourceFile(ipc: Uint8Array, file: string): Uint8Array` — returns new IPC with `_src_file` (Utf8) appended as the LAST column, one copy of `file` per row.
  - `withSourceFileColumn(schemas: readonly TableSchema[]): TableSchema[]` — appends `{ name: '_src_file', type: 'utf8', nullable: false }` to every schema's columns.
  - Worker behavior: every `batch` message's `ipc` is stamped with the parse request's `name`; `finish.schemas` are `withSourceFileColumn(pack.schemas())`; batch `columns` overviews (via `deriveColumns`) include `_src_file` because they are derived from the stamped IPC.
  - Client: `ParseClientPort.parse` input becomes `{ name: string; blob: Blob; formatId?: string }`; `formatId` is forwarded in the `parse` postMessage (worker already honors it).
- [ ] **Step 1: Write the failing test**

Create `apps/web/src/workers/stamp-source-file.test.ts`:

```ts
import { ipcToTable, tableToIpc } from '@byteql/core';
import { Table, Uint32, vectorFromArray } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { stampSourceFile, withSourceFileColumn } from './stamp-source-file.js';

const sampleIpc = (): Uint8Array =>
  tableToIpc(new Table({ value: vectorFromArray([1, 2, 3], new Uint32()) }));

describe('stampSourceFile', () => {
  it('appends _src_file as the last column with the file name on every row', () => {
    const stamped = ipcToTable(stampSourceFile(sampleIpc(), 'capture (2).pcap'));
    expect(stamped.schema.fields.map((field) => field.name)).toEqual(['value', '_src_file']);
    expect(stamped.numRows).toBe(3);
    const column = stamped.getChild('_src_file')!;
    expect([column.get(0), column.get(2)]).toEqual(['capture (2).pcap', 'capture (2).pcap']);
    // Original data is intact.
    expect(Number(stamped.getChild('value')!.get(1))).toBe(2);
  });

  it('stamps an empty batch without error', () => {
    const empty = tableToIpc(new Table({ value: vectorFromArray([], new Uint32()) }));
    const stamped = ipcToTable(stampSourceFile(empty, 'a.mid'));
    expect(stamped.numRows).toBe(0);
    expect(stamped.schema.fields.at(-1)?.name).toBe('_src_file');
  });
});

describe('withSourceFileColumn', () => {
  it('appends the utf8 _src_file column to every schema', () => {
    const extended = withSourceFileColumn([
      { name: 'packets', columns: [{ name: 'ts', type: 'uint64', nullable: false }] },
    ]);
    expect(extended[0]!.columns.at(-1)).toEqual({ name: '_src_file', type: 'utf8', nullable: false });
    expect(extended[0]!.columns).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @byteql/web exec vitest run src/workers/stamp-source-file.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

Create `apps/web/src/workers/stamp-source-file.ts`:

```ts
import { ipcToTable, tableToIpc, type TableSchema } from '@byteql/core';
import { Table, Utf8, vectorFromArray, type Vector } from 'apache-arrow';

const SRC_FILE_COLUMN = { name: '_src_file', type: 'utf8', nullable: false } as const;

/** Appends `_src_file` (the batch's source display name) as the last column of an IPC batch. */
export const stampSourceFile = (ipc: Uint8Array, file: string): Uint8Array => {
  const table = ipcToTable(ipc);
  const children: Record<string, Vector> = {};
  for (const field of table.schema.fields) {
    children[field.name] = table.getChild(field.name) as Vector;
  }
  children[SRC_FILE_COLUMN.name] = vectorFromArray(
    new Array<string>(table.numRows).fill(file),
    new Utf8(),
  );
  return tableToIpc(new Table(children));
};

/** Extends every pack schema with the `_src_file` column the stamped batches carry. */
export const withSourceFileColumn = (schemas: readonly TableSchema[]): TableSchema[] =>
  schemas.map((schema) => ({ ...schema, columns: [...schema.columns, SRC_FILE_COLUMN] }));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @byteql/web exec vitest run src/workers/stamp-source-file.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the worker and client**

In `apps/web/src/workers/parse.worker.ts`:

```ts
import { stampSourceFile, withSourceFileColumn } from './stamp-source-file.js';
```

Inside `runParse`'s pull loop, immediately after `if (batch === null) break;` and BEFORE the overview accounting, stamp the batch — then use the stamped bytes for `deriveColumns` and the postMessage (replacing `batch.ipc` in both):

```ts
        const stamped = stampSourceFile(batch.ipc, name);

        seq += 1;
        let position = index.get(batch.table);
        if (position === undefined) {
          position = overview.length;
          index.set(batch.table, position);
          overview.push({
            name: batch.table,
            rowCount: 0,
            columns: deriveColumns(pack, batch.table, stamped),
          });
        }
        const current = overview[position]!;
        overview[position] = { ...current, rowCount: current.rowCount + batch.rowCount };

        scope.postMessage(
          { type: 'batch', taskId, seq, table: batch.table, ipc: stamped, rowCount: batch.rowCount },
          [stamped.buffer],
        );
```

In the `finish` postMessage, change `schemas: pack.schemas(),` to `schemas: withSourceFileColumn(pack.schemas()),` (keep the existing comment).

In `apps/web/src/lib/parse-worker-client.ts`:

- `ParseClientPort.parse` signature: `parse(input: { name: string; blob: Blob; formatId?: string }, handlers: ParseHandlers): Promise<StreamedParseResult>;`
- `ParseWorkerClient.parse` same input type; forward it:

```ts
      this.worker.postMessage({
        type: 'parse',
        taskId,
        name: input.name,
        blob: input.blob,
        ...(input.formatId !== undefined ? { formatId: input.formatId } : {}),
      });
```

- [ ] **Step 6: Extend the worker round-trip test**

In `apps/web/src/lib/session/controller.test.ts`, locate the `describe` block that drives `installParseWorker` through a fake scope (it imports `installParseWorker` and `BATCH_CREDIT_WINDOW`). Add one test asserting a posted `batch` message's IPC now contains `_src_file` with the request's `name`, and that `finish.schemas[i].columns` ends with the `_src_file` column. Follow that block's existing fake-scope idioms exactly (post a `parse` request with a real MIDI or pcap fixture blob the block already uses, collect `postMessage` calls, `ipcToTable` the batch payload).

- [ ] **Step 7: Run tests and commit**

Run: `pnpm --filter @byteql/web test`
Expected: PASS.

```bash
git add apps/web/src/workers/stamp-source-file.ts apps/web/src/workers/stamp-source-file.test.ts \
  apps/web/src/workers/parse.worker.ts apps/web/src/lib/parse-worker-client.ts \
  apps/web/src/lib/session/controller.test.ts
git commit -m "feat(web): stamp _src_file provenance onto every parsed batch"
```

---

### Task 4: Batch planning module (`batch.ts`)

**Files:**

- Create: `apps/web/src/lib/session/batch.ts`
- Create: `apps/web/src/lib/session/batch.test.ts`

**Interfaces:**

- Consumes: `selectPack`, `PROBE_HEAD_BYTES` from `../packs.js`; `tableToIpc`, `TableOverview`, `FormatPack` from `@byteql/core`; apache-arrow.
- Produces (used by Task 6):

```ts
export interface BatchEntry { name: string; size: number; blob: Blob }
export interface PlannedFile {
  displayName: string;
  originalName: string;
  size: number;
  blob: Blob;
  status: 'ok' | 'skipped';
  error: string | null;
}
export interface BatchPlan {
  formatId: string | null;      // null when NO file is recognized
  formatTitle: string | null;
  files: readonly PlannedFile[]; // same order as input
  totalSize: number;             // sum of ok files' sizes
}
export function dedupeDisplayNames(names: readonly string[]): string[];
export async function planBatch(entries: readonly BatchEntry[], packs: readonly FormatPack[]): Promise<BatchPlan>;
export interface FilesRow {
  file: string; originalName: string; size: number; ingestOrder: number;
  status: 'ok' | 'skipped'; error: string | null;
}
export function buildFilesTableIpc(rows: readonly FilesRow[]): Uint8Array;
export function mergeTableOverviews(perFile: readonly (readonly TableOverview[])[]): TableOverview[];
```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/session/batch.test.ts`:

```ts
import { ipcToTable } from '@byteql/core';
import type { FormatPack } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import {
  buildFilesTableIpc,
  dedupeDisplayNames,
  mergeTableOverviews,
  planBatch,
  type BatchEntry,
} from './batch.js';

const fakePack = (id: string, magic: number): FormatPack => ({
  id,
  title: `${id} title`,
  probe: (head) => (head[0] === magic ? 1 : null),
  schemas: () => [],
  open: () => {
    throw new Error('not used');
  },
  queries: [],
});

const entry = (name: string, firstByte: number): BatchEntry => {
  const blob = new Blob([new Uint8Array([firstByte, 0, 0, 0])]);
  return { name, size: blob.size, blob };
};

const PACKS = [fakePack('midi', 0x4d), fakePack('pcap', 0xd4)];

describe('dedupeDisplayNames', () => {
  it('suffixes duplicates before the extension and avoids re-collisions', () => {
    expect(dedupeDisplayNames(['a.pcap', 'a.pcap', 'a (2).pcap', 'a.pcap'])).toEqual([
      'a.pcap',
      'a (2).pcap',
      'a (2).pcap (2)',
      'a (3).pcap',
    ]);
  });

  it('handles extensionless names', () => {
    expect(dedupeDisplayNames(['dump', 'dump'])).toEqual(['dump', 'dump (2)']);
  });
});

describe('planBatch', () => {
  it('elects the first recognized format and skips mismatches and unknowns', async () => {
    const plan = await planBatch(
      [entry('junk.bin', 0x00), entry('a.pcap', 0xd4), entry('b.mid', 0x4d), entry('c.pcap', 0xd4)],
      PACKS,
    );
    expect(plan.formatId).toBe('pcap');
    expect(plan.formatTitle).toBe('pcap title');
    expect(plan.files.map((file) => file.status)).toEqual(['skipped', 'ok', 'skipped', 'ok']);
    expect(plan.files[0]!.error).toMatch(/No registered format/u);
    expect(plan.files[2]!.error).toMatch(/batch is pcap title/u);
    expect(plan.totalSize).toBe(8);
  });

  it('returns a null format when nothing is recognized', async () => {
    const plan = await planBatch([entry('x.bin', 0x00)], PACKS);
    expect(plan.formatId).toBeNull();
    expect(plan.files[0]!.status).toBe('skipped');
    expect(plan.totalSize).toBe(0);
  });

  it('skips a zero-byte file as unrecognized without failing the batch', async () => {
    const empty: BatchEntry = { name: 'empty.pcap', size: 0, blob: new Blob([]) };
    const plan = await planBatch([empty, entry('a.pcap', 0xd4)], PACKS);
    expect(plan.files[0]!.status).toBe('skipped');
    expect(plan.formatId).toBe('pcap');
  });
});

describe('buildFilesTableIpc', () => {
  it('builds the _files batch with the documented columns and types', () => {
    const table = ipcToTable(
      buildFilesTableIpc([
        { file: 'a.pcap', originalName: 'a.pcap', size: 4, ingestOrder: 0, status: 'ok', error: null },
        {
          file: 'b.pcap',
          originalName: 'b.pcap',
          size: 9,
          ingestOrder: 1,
          status: 'skipped',
          error: 'boom',
        },
      ]),
    );
    expect(table.schema.fields.map((field) => field.name)).toEqual([
      'file',
      'original_name',
      'size',
      'ingest_order',
      'status',
      'error',
    ]);
    expect(table.numRows).toBe(2);
    expect(table.getChild('status')!.get(1)).toBe('skipped');
    expect(Number(table.getChild('size')!.get(1))).toBe(9);
    expect(table.getChild('error')!.get(0)).toBeNull();
  });
});

describe('mergeTableOverviews', () => {
  it('sums row counts by table name, keeping first-seen order and columns', () => {
    const columns = [{ name: 'ts', type: 'Uint64', nullable: false }];
    const merged = mergeTableOverviews([
      [{ name: 'packets', rowCount: 2, columns }],
      [
        { name: 'packets', rowCount: 3, columns },
        { name: 'dns', rowCount: 1, columns },
      ],
    ]);
    expect(merged).toEqual([
      { name: 'packets', rowCount: 5, columns },
      { name: 'dns', rowCount: 1, columns },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/session/batch.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `apps/web/src/lib/session/batch.ts`:

```ts
import { tableToIpc, type FormatPack, type TableOverview } from '@byteql/core';
import { Int32, Table, Uint64, Utf8, vectorFromArray } from 'apache-arrow';

import { PROBE_HEAD_BYTES, selectPack } from '../packs.js';

export interface BatchEntry {
  name: string;
  size: number;
  blob: Blob;
}

export interface PlannedFile {
  displayName: string;
  originalName: string;
  size: number;
  blob: Blob;
  status: 'ok' | 'skipped';
  error: string | null;
}

export interface BatchPlan {
  formatId: string | null;
  formatTitle: string | null;
  files: readonly PlannedFile[];
  totalSize: number;
}

/** Dedupes display names with ` (n)` suffixes inserted before the extension. */
export function dedupeDisplayNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  const counts = new Map<string, number>();
  return names.map((name) => {
    let candidate = name;
    let count = counts.get(name) ?? 1;
    while (taken.has(candidate)) {
      count += 1;
      const dot = name.lastIndexOf('.');
      candidate = dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
    }
    counts.set(name, count);
    taken.add(candidate);
    return candidate;
  });
}

/**
 * Probes every entry's head bytes, elects the batch format from the first recognized file, and
 * marks mismatching or unrecognized files skipped. Pure planning — nothing is parsed yet.
 */
export async function planBatch(
  entries: readonly BatchEntry[],
  packs: readonly FormatPack[],
): Promise<BatchPlan> {
  const displayNames = dedupeDisplayNames(entries.map((entry) => entry.name));
  let elected: FormatPack | null = null;
  const files: PlannedFile[] = [];
  for (const [index, entry] of entries.entries()) {
    const head = new Uint8Array(await entry.blob.slice(0, PROBE_HEAD_BYTES).arrayBuffer());
    const pack = selectPack(packs, head);
    const base = {
      displayName: displayNames[index]!,
      originalName: entry.name,
      size: entry.size,
      blob: entry.blob,
    };
    if (!pack) {
      files.push({ ...base, status: 'skipped', error: 'No registered format recognizes this file.' });
    } else if (elected === null || pack.id === elected.id) {
      elected ??= pack;
      files.push({ ...base, status: 'ok', error: null });
    } else {
      files.push({
        ...base,
        status: 'skipped',
        error: `Format mismatch — this batch is ${elected.title}.`,
      });
    }
  }
  const totalSize = files.reduce((sum, file) => (file.status === 'ok' ? sum + file.size : sum), 0);
  return { formatId: elected?.id ?? null, formatTitle: elected?.title ?? null, files, totalSize };
}

export interface FilesRow {
  file: string;
  originalName: string;
  size: number;
  ingestOrder: number;
  status: 'ok' | 'skipped';
  error: string | null;
}

/** Builds the `_files` catalog batch (spec: file/original_name/size/ingest_order/status/error). */
export function buildFilesTableIpc(rows: readonly FilesRow[]): Uint8Array {
  return tableToIpc(
    new Table({
      file: vectorFromArray(rows.map((row) => row.file), new Utf8()),
      original_name: vectorFromArray(rows.map((row) => row.originalName), new Utf8()),
      size: vectorFromArray(rows.map((row) => BigInt(row.size)), new Uint64()),
      ingest_order: vectorFromArray(rows.map((row) => row.ingestOrder), new Int32()),
      status: vectorFromArray(rows.map((row) => row.status), new Utf8()),
      error: vectorFromArray(rows.map((row) => row.error), new Utf8()),
    }),
  );
}

/** Unions per-file parse overviews: row counts sum by name; first-seen order and columns win. */
export function mergeTableOverviews(
  perFile: readonly (readonly TableOverview[])[],
): TableOverview[] {
  const merged: TableOverview[] = [];
  const index = new Map<string, number>();
  for (const overviews of perFile) {
    for (const overview of overviews) {
      const position = index.get(overview.name);
      if (position === undefined) {
        index.set(overview.name, merged.length);
        merged.push({ ...overview });
      } else {
        const current = merged[position]!;
        merged[position] = { ...current, rowCount: current.rowCount + overview.rowCount };
      }
    }
  }
  return merged;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/session/batch.test.ts`
Expected: PASS. If `vectorFromArray(..., new Utf8())` rejects `null` entries for `error`, switch that one column to `vectorFromArray(rows.map((row) => row.error))` (arrow infers a nullable Utf8) and keep the test's null assertion authoritative.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/session/batch.ts apps/web/src/lib/session/batch.test.ts
git commit -m "feat(web): add batch planning, _files builder, and overview merging"
```

---

### Task 5: DB per-file ingest API — `beginFile` / `discardCurrentFile`

**Files:**

- Modify: `packages/db/src/types.ts`
- Modify: `packages/db/src/browser.ts`
- Modify: `packages/db/src/spill-files.ts`
- Test: `packages/db/src/browser.test.ts`, `packages/db/src/spill-files.test.ts`
- Modify: `apps/web/src/lib/session/controller.test.ts` (FakeIngestSession gains the two methods so the interface still compiles)

**Interfaces:**

- Consumes: existing `IngestSessionImpl` staging/rotation machinery.
- Produces (used by Task 6):
  - `IngestSession.beginFile(file: string): Promise<void>` — marks a file boundary. Spill tier: first rotates every created table's residual staged rows into chunks (so chunks never mix files); both tiers: resets per-file tracking to `file`.
  - `IngestSession.discardCurrentFile(): Promise<void>` — removes the current file's rows. Memory tier: `DELETE FROM <staging> WHERE _src_file = '<file>'` per created table. Spill tier: `DELETE FROM <staging>` per created table (post-boundary staging only ever holds current-file rows), forgets and best-effort-deletes the chunks rotated since `beginFile`. Both: subtracts the current file's row counts. No-op when no `beginFile` is active.
  - `deleteSpillChunks(paths: readonly string[]): Promise<void>` in `spill-files.ts` — best-effort OPFS removal of individual chunk files (paths shaped `opfs://byteql-spill/<generation>/<table>/<n>.parquet`).
- [ ] **Step 1: Write failing spill-files test**

In `packages/db/src/spill-files.test.ts`, add (following the file's existing OPFS-mock idiom — it already fakes `navigator.storage.getDirectory`):

```ts
it('deleteSpillChunks removes the named chunk files and tolerates absences', async () => {
  // Arrange the fake OPFS tree byteql-spill/7/packets/{0,1}.parquet via the file's existing helpers.
  await deleteSpillChunks([
    'opfs://byteql-spill/7/packets/0.parquet',
    'opfs://byteql-spill/7/packets/99.parquet', // absent — must not throw
  ]);
  // Assert 0.parquet is gone and 1.parquet survives, using the file's existing tree-inspection helper.
});
```

Adapt arrangement/assertion lines to the mock helpers that file actually defines; the behavioral contract above is what must hold.

- [ ] **Step 2: Implement `deleteSpillChunks`**

In `packages/db/src/spill-files.ts`:

```ts
/** Parses `opfs://byteql-spill/<generation>/<table>/<file>` into its path segments, or null. */
const parseChunkPath = (path: string): { generation: string; table: string; file: string } | null => {
  const match = /^opfs:\/\/byteql-spill\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(path);
  return match ? { generation: match[1]!, table: match[2]!, file: match[3]! } : null;
};

/** Best-effort removal of individual spill chunk files (a discarded file's rotated chunks). */
export const deleteSpillChunks = async (paths: readonly string[]): Promise<void> => {
  const spillRoot = await getSpillRoot();
  if (!spillRoot) {
    return;
  }
  for (const path of paths) {
    const parsed = parseChunkPath(path);
    if (!parsed) {
      continue;
    }
    try {
      const generationDir = await spillRoot.getDirectoryHandle(parsed.generation, { create: false });
      const tableDir = await generationDir.getDirectoryHandle(parsed.table, { create: false });
      await tableDir.removeEntry(parsed.file);
    } catch {
      // Already absent, or removed concurrently; deletion is best-effort.
    }
  }
};
```

Run: `pnpm --filter @byteql/db exec vitest run src/spill-files.test.ts` — expected PASS.

- [ ] **Step 3: Extend the `IngestSession` interface**

In `packages/db/src/types.ts`, add to `IngestSession` (above `finalize`):

```ts
  /**
   * Marks a file boundary in a multi-file ingest. Spill tier: rotates every table's residual
   * staged rows into chunks first, so no parquet chunk ever mixes files. Subsequent appends and
   * rotations are attributed to `file` until the next `beginFile` or `discardCurrentFile`.
   */
  beginFile(file: string): Promise<void>;
  /**
   * Removes every row appended since the active `beginFile` (the failed file's partial rows):
   * memory tier deletes by `_src_file`, spill tier truncates staging and drops the chunks
   * rotated for this file. No-op when no file boundary is active.
   */
  discardCurrentFile(): Promise<void>;
```

- [ ] **Step 4: Write failing browser tests**

In `packages/db/src/browser.test.ts`, add a `describe('per-file ingest boundaries', ...)` using the file's existing `duckdbMocks` harness and its existing helpers for building IPC batches (the file already builds Arrow IPC via `apache-arrow-duckdb`). Cases:

```ts
it('beginFile on the spill tier rotates residual staged rows before switching files', async () => {
  // begin spill-tier ingest (existing harness idiom), appendBatch('packets', ipc) once,
  // then: await session.beginFile('b.pcap');
  // Assert connection.query saw `COPY "__ingest_<gen>_packets" TO 'opfs://byteql-spill/...'`
  // followed by `DELETE FROM "__ingest_<gen>_packets";` — the same statements rotateChunk issues.
});

it('discardCurrentFile on the memory tier deletes by _src_file with an escaped literal', async () => {
  // memory-tier ingest; await session.beginFile("it's.pcap"); appendBatch('packets', ipc);
  // await session.discardCurrentFile();
  // Assert a query `DELETE FROM "__ingest_<gen>_packets" WHERE _src_file = 'it''s.pcap';` ran,
  // and that finalize()'s summaries report rowCount 0 for 'packets'.
});

it('discardCurrentFile on the spill tier truncates staging and forgets this file's chunks', async () => {
  // spill-tier ingest with a tiny rotationBytes so the appended batch rotates into a chunk;
  // beginFile('a.pcap'); appendBatch → rotation; await session.discardCurrentFile();
  // Assert `DELETE FROM "__ingest_<gen>_packets";` ran, deleteSpillChunks was called with the
  // rotated chunk path (spy via the existing vi.mock of ./spill-files.js — add deleteSpillChunks
  // to that mock), and a subsequent finalize() creates NO parquet_scan view for 'packets'
  // (falls back to the empty-staging rename branch).
});

it('discardCurrentFile without beginFile is a no-op', async () => {
  // memory-tier ingest; appendBatch; await session.discardCurrentFile();
  // Assert no DELETE statement was issued and finalize rowCount is unchanged.
});
```

Flesh these out with the harness's real helper names (batch construction, `beginIngest` defaults, query-log inspection) — the assertions above are the contract. Extend the file's existing `vi.mock('./spill-files.js', ...)` factory with `deleteSpillChunks: vi.fn().mockResolvedValue(undefined)`.

Run: `pnpm --filter @byteql/db exec vitest run src/browser.test.ts`
Expected: new cases FAIL (methods missing).

- [ ] **Step 5: Implement in `browser.ts`**

Import `deleteSpillChunks` alongside the existing spill-files imports. Add a string-literal helper near `quoteIdentifier`:

```ts
const quoteStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
```

In `IngestSessionImpl`, add fields:

```ts
  // Per-file boundary tracking (multi-file batches): the display name of the file currently
  // being appended, the chunks rotated for it, and its per-table appended row counts.
  private currentFile: string | null = null;
  private readonly currentFileChunks = new Map<string, string[]>();
  private readonly currentFileRows = new Map<string, number>();
```

In `rotateChunk`, after `this.chunkPaths.set(...)`, attribute the chunk to the current file:

```ts
    if (this.currentFile !== null) {
      this.currentFileChunks.set(table, [...(this.currentFileChunks.get(table) ?? []), path]);
    }
```

In `appendBatch`, right after `this.rowCounts.set(...)`:

```ts
        if (this.currentFile !== null) {
          this.currentFileRows.set(table, (this.currentFileRows.get(table) ?? 0) + rowCount);
        }
```

Add the two methods (before `finalize`):

```ts
  async beginFile(file: string): Promise<void> {
    if (this.state !== 'open') {
      throw new Error(`Ingest session is ${this.state}; cannot begin a file.`);
    }
    if (this.tier === 'spill') {
      // File-boundary flush: chunks must never mix files, so the previous file's residual
      // staged rows rotate out before this file's first append. Quota failures get the same
      // SPILL_QUOTA_EXCEEDED tagging as appendBatch so the controller's messaging applies.
      await this.enqueue(async (connection) => {
        for (const table of this.sessionTables()) {
          if (this.created.has(table) && (this.stagedBytes.get(table) ?? 0) > 0) {
            try {
              await this.rotateChunk(connection, table);
            } catch (error) {
              if (!isQuotaError(error)) {
                throw error;
              }
              throw new Error(`SPILL_QUOTA_EXCEEDED: failed to spill ${JSON.stringify(table)} to OPFS.`, {
                cause: error,
              });
            }
          }
        }
      });
    }
    this.currentFile = file;
    this.currentFileChunks.clear();
    this.currentFileRows.clear();
  }

  async discardCurrentFile(): Promise<void> {
    if (this.state !== 'open' || this.currentFile === null) {
      return;
    }
    const file = this.currentFile;
    await this.enqueue(async (connection) => {
      for (const table of this.created) {
        const stagingName = stagingTableName(this.generation, table);
        if (this.tier === 'spill') {
          // Post-boundary staging only ever holds the current file's rows (see beginFile).
          await connection.query(`DELETE FROM ${quoteIdentifier(stagingName)};`);
          this.stagedBytes.set(table, 0);
        } else {
          await connection.query(
            `DELETE FROM ${quoteIdentifier(stagingName)} WHERE _src_file = ${quoteStringLiteral(file)};`,
          );
        }
      }
    });
    const discardedChunks = [...this.currentFileChunks.entries()];
    for (const [table, chunks] of discardedChunks) {
      const kept = (this.chunkPaths.get(table) ?? []).filter((path) => !chunks.includes(path));
      if (kept.length > 0) this.chunkPaths.set(table, kept);
      else this.chunkPaths.delete(table);
    }
    await deleteSpillChunks(discardedChunks.flatMap(([, chunks]) => chunks));
    for (const [table, rows] of this.currentFileRows) {
      this.rowCounts.set(table, Math.max(0, (this.rowCounts.get(table) ?? 0) - rows));
    }
    this.currentFile = null;
    this.currentFileChunks.clear();
    this.currentFileRows.clear();
  }
```

- [ ] **Step 6: Run DB tests**

Run: `pnpm --filter @byteql/db test`
Expected: PASS.

- [ ] **Step 7: Keep the controller-test fake compiling**

In `apps/web/src/lib/session/controller.test.ts`, `FakeIngestSession implements IngestSession` — add recorded stubs:

```ts
  readonly beginFileCalls: string[] = [];
  discardCalls = 0;
  beginFile = vi.fn(async (file: string) => {
    this.beginFileCalls.push(file);
  });
  discardCurrentFile = vi.fn(async () => {
    this.discardCalls += 1;
  });
```

Run: `pnpm --filter @byteql/db build && pnpm --filter @byteql/web exec vitest run src/lib/session/controller.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/types.ts packages/db/src/browser.ts packages/db/src/spill-files.ts \
  packages/db/src/browser.test.ts packages/db/src/spill-files.test.ts \
  apps/web/src/lib/session/controller.test.ts
git commit -m "feat(db): per-file ingest boundaries with discard on both tiers"
```

---

### Task 6: Session state and controller batch loop (+ compile-adapting the UI)

**Files:**

- Modify: `apps/web/src/lib/session/state.ts`
- Modify: `apps/web/src/lib/session/controller.ts`
- Modify: `apps/web/src/components/Workbench.svelte` (compile adaptation only — multi-file hex UX lands in Task 8)
- Modify: `apps/web/src/components/Explorer.svelte`, `apps/web/src/components/StatusBar.svelte`
- Test: `apps/web/src/lib/session/controller.test.ts`, `apps/web/src/components/StatusBar.test.ts`, `apps/web/src/components/Workbench.test.ts`

**Interfaces:**

- Consumes: Task 4's `planBatch`/`buildFilesTableIpc`/`mergeTableOverviews`, `REGISTERED_PACKS`, Task 5's `beginFile`/`discardCurrentFile`, Task 3's `formatId` parse input.
- Produces (used by Tasks 7–8):

```ts
// state.ts
export interface SourceFile { name: string; size: number }
// SessionState changes:
//   source: { files: readonly SourceFile[]; totalSize: number } | null
//   byteSelection: { file: string; start: number; end: number } | null
//   SessionProgress gains: fileIndex: number; fileCount: number
// SessionEvent changes:
//   opening: { source: { files: readonly SourceFile[]; totalSize: number } }
//   progress: gains fileIndex/fileCount
//   ready: gains files: readonly SourceFile[]
//   byteRangeSelected: { range: { file: string; start: number; end: number } | null }

// controller.ts
//   openFiles(files: readonly File[]): Promise<void>
//   openFile(file: File): Promise<void>            // = openFiles([file])
//   selectByteRange(range: { file: string; start: number; end: number } | null): void
//   getSourceBlob(file: string): Blob | null       // keyed by display name
```

- [ ] **Step 1: Update `state.ts`**

Apply exactly:

```ts
export interface SourceFile {
  name: string;
  size: number;
}

export interface SessionProgress {
  completed: number;
  total: number | null;
  label: string;
  /** Cumulative bytes ingested (streamed batch IPC) so far this open, for a throughput readout. */
  bytes: number;
  /** 1-based position of the file currently being ingested, and the batch's ok-file count. */
  fileIndex: number;
  fileCount: number;
}
```

`SessionState`: `source: { files: readonly SourceFile[]; totalSize: number } | null;` and `byteSelection: { file: string; start: number; end: number } | null;` (update the doc comment: "Active hex-pane byte selection: display-name-qualified absolute offsets, end exclusive.").

`SessionEvent`: `opening` carries the new source shape; `progress` gains `fileIndex: number; fileCount: number;`; `ready` gains `files: readonly SourceFile[];`; `byteRangeSelected` carries `range: { file: string; start: number; end: number } | null`.

Reducer: `opening` unchanged structurally; `progress` copies the two new fields into `SessionProgress`; `ready` additionally sets

```ts
        source: {
          files: event.files,
          totalSize: event.files.reduce((sum, file) => sum + file.size, 0),
        },
```

- [ ] **Step 2: Rewrite the controller open path**

In `apps/web/src/lib/session/controller.ts`:

Add imports:

```ts
import {
  buildFilesTableIpc,
  mergeTableOverviews,
  planBatch,
  type BatchEntry,
  type FilesRow,
  type PlannedFile,
} from './batch.js';
import { REGISTERED_PACKS } from '../packs.js';
import type { SourceFile } from './state.js';
import type { ParseIssue, TableOverview } from '@byteql/core';
```

Replace fields `retainedFile`/`retainedBlob` with:

```ts
  private retainedBlobs = new Map<string, Blob>();
  private batchFileIndex = 0;
  private batchFileCount = 0;
```

Public API:

```ts
  openFiles(files: readonly File[]): Promise<void> {
    this.assertUsable();
    const entries: BatchEntry[] = files.map((file) => ({
      name: basename(file.name),
      size: file.size,
      blob: file,
    }));
    return this.openBatch(entries);
  }

  openFile(file: File): Promise<void> {
    return this.openFiles([file]);
  }

  openSample(): Promise<void> {
    this.assertUsable();
    if (!this.sampleBytes) {
      return this.initialize().then(() => this.openSample());
    }
    const retained = this.sampleBytes;
    const blob = new Blob([retained as BlobPart]);
    return this.openBatch([{ name: 'demo.mid', size: blob.size, blob }]);
  }

  getSourceBlob(file: string): Blob | null {
    return this.retainedBlobs.get(file) ?? null;
  }

  selectByteRange(range: { file: string; start: number; end: number } | null): void {
    this.assertUsable();
    this.dispatch({ type: 'byteRangeSelected', range });
  }
```

Replace `private open(...)` and `private completeOpen(...)` with the batch pipeline:

```ts
  private async openBatch(entries: readonly BatchEntry[]): Promise<void> {
    const generation = ++this.sessionGeneration;
    ++this.queryGeneration;
    this.cancelParser();
    this.stopActiveViewer();
    const queryCancellation = this.cancelDatabaseQuery();
    this.bytesIngested = 0;
    this.lastProgress = null;

    const plan = await planBatch(entries, REGISTERED_PACKS);
    if (!this.isCurrent(generation)) return;
    const okFiles = plan.files.filter((file) => file.status === 'ok');
    if (plan.formatId === null || okFiles.length === 0) {
      this.dispatch({ type: 'failed', message: 'No registered format recognizes the selected files.' });
      return;
    }

    this.retainedBlobs = new Map(okFiles.map((file) => [file.displayName, file.blob]));
    this.batchFileIndex = 1;
    this.batchFileCount = okFiles.length;
    this.dispatch({
      type: 'opening',
      source: {
        files: okFiles.map((file) => ({ name: file.displayName, size: file.size })),
        totalSize: plan.totalSize,
      },
    });
    return this.completeBatchOpen(generation, plan.formatId, plan.files, queryCancellation);
  }

  private async completeBatchOpen(
    generation: number,
    formatId: string,
    planned: readonly PlannedFile[],
    queryCancellation: Promise<boolean>,
  ): Promise<void> {
    await queryCancellation;
    if (!this.isCurrent(generation)) return;

    const tierThresholdBytes = this.tiering?.tierThresholdBytes ?? TIER_THRESHOLD_BYTES;
    const okPlanned = planned.filter((file) => file.status === 'ok');
    const totalSize = okPlanned.reduce((sum, file) => sum + file.size, 0);
    const tier = chooseTier(totalSize, tierThresholdBytes);
    if (tier === 'spill') {
      void navigator.storage?.persist?.().catch(() => undefined);
    }

    const rotationBytes = this.tiering?.rotationBytes;
    await this.ingestSettlement;
    if (!this.isCurrent(generation)) return;

    let ingest: IngestSession;
    try {
      ingest = await this.database.beginIngest({
        schemas: 'discover',
        tier,
        generation,
        ...(rotationBytes !== undefined ? { rotationBytes } : {}),
      });
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.dispatch({ type: 'failed', message: this.openFailureMessage(error, tierThresholdBytes) });
      }
      return;
    }

    let settleIngest!: () => void;
    this.ingestSettlement = new Promise<void>((resolve) => {
      settleIngest = resolve;
    });

    try {
      if (!this.isCurrent(generation)) {
        await ingest.abort().catch(() => undefined);
        return;
      }

      // Batch-skip bookkeeping: planner skips carry over; mid-parse failures join them.
      const skipped = new Map<string, string>(
        planned.filter((file) => file.status === 'skipped').map((f) => [f.displayName, f.error ?? '']),
      );
      const results: StreamedParseResult[] = [];
      const succeededFiles: SourceFile[] = [];
      const issues: ParseIssue[] = [];

      try {
        for (const [index, file] of okPlanned.entries()) {
          if (!this.isCurrent(generation)) {
            await ingest.abort().catch(() => undefined);
            return;
          }
          this.batchFileIndex = index + 1;
          this.lastProgress = null;
          await ingest.beginFile(file.displayName);

          const pendingAppends: Promise<void>[] = [];
          try {
            const result = await this.parser.parse(
              { name: file.displayName, blob: file.blob, formatId },
              {
                onProgress: (progress) => {
                  if (this.isCurrent(generation)) this.progress(generation, progress);
                },
                onBatch: async (batch) => {
                  if (!this.isCurrent(generation)) return;
                  this.bytesIngested += batch.ipc.byteLength;
                  this.progressBytes(generation);
                  const append = ingest.appendBatch(batch.table, batch.ipc);
                  pendingAppends.push(append);
                  await append;
                },
              },
            );
            await Promise.all(pendingAppends);
            if (!this.isCurrent(generation)) {
              await ingest.abort().catch(() => undefined);
              return;
            }
            results.push(result);
            succeededFiles.push({ name: file.displayName, size: file.size });
            issues.push(...result.issues);
          } catch (error) {
            await Promise.allSettled(pendingAppends);
            if (isAbortError(error)) throw error;
            const message = errorMessage(error, 'The local file could not be parsed.');
            // Environment-level failures (quota, unsupported spill) doom the whole batch.
            if (message.includes('SPILL_QUOTA_EXCEEDED') || message.includes('SPILL_UNSUPPORTED')) {
              throw error;
            }
            if (!this.isCurrent(generation)) {
              await ingest.abort().catch(() => undefined);
              return;
            }
            await ingest.discardCurrentFile();
            this.retainedBlobs.delete(file.displayName);
            skipped.set(file.displayName, message);
          }
        }

        if (!this.isCurrent(generation)) {
          await ingest.abort().catch(() => undefined);
          return;
        }
        if (results.length === 0) {
          const reasons = [...skipped.values()].filter(Boolean);
          throw new Error(reasons[0] ?? 'None of the selected files could be ingested.');
        }

        for (const [displayName, reason] of skipped) {
          issues.push({
            stage: 'framing',
            track: null,
            code: 'FILE_SKIPPED',
            message: `${displayName} was skipped: ${reason}`,
          });
        }

        const filesRows: FilesRow[] = planned.map((file, order) => ({
          file: file.displayName,
          originalName: file.originalName,
          size: file.size,
          ingestOrder: order,
          status: skipped.has(file.displayName) || file.status === 'skipped' ? 'skipped' : 'ok',
          error: skipped.get(file.displayName) ?? file.error,
        }));
        await ingest.appendBatch('_files', buildFilesTableIpc(filesRows));

        const first = results[0]!;
        const summaries = await ingest.finalize(first.schemas);
        if (!this.isCurrent(generation)) return;

        const rowCounts = new Map(summaries.map((summary) => [summary.name, summary.rowCount]));
        const mergedTables = mergeTableOverviews(results.map((result) => result.tables));
        const populatedNames = new Set(mergedTables.map((table) => table.name));
        const backfilledTables = first.schemas
          .filter((schema) => !populatedNames.has(schema.name))
          .map((schema) => ({ name: schema.name, rowCount: 0, columns: schema.columns }));
        const filesOverview: TableOverview = {
          name: '_files',
          rowCount: filesRows.length,
          columns: [
            { name: 'file', type: 'Utf8', nullable: false },
            { name: 'original_name', type: 'Utf8', nullable: false },
            { name: 'size', type: 'Uint64', nullable: false },
            { name: 'ingest_order', type: 'Int32', nullable: false },
            { name: 'status', type: 'Utf8', nullable: false },
            { name: 'error', type: 'Utf8', nullable: true },
          ],
        };
        this.dispatch({
          type: 'ready',
          format: first.format,
          files: succeededFiles,
          tables: [...mergedTables, ...backfilledTables, filesOverview].map((table) => ({
            ...table,
            rowCount: rowCounts.get(table.name) ?? table.rowCount,
          })),
          issues,
          queries: first.queries,
          capabilities: first.capabilities,
        });
      } catch (error) {
        await ingest.abort().catch(() => undefined);
        if (!this.isCurrent(generation)) return;
        if (isAbortError(error)) {
          this.dispatch({ type: 'cancelled' });
          return;
        }
        this.dispatch({ type: 'failed', message: this.openFailureMessage(error, tierThresholdBytes) });
      }
    } finally {
      settleIngest();
    }
  }
```

Also: `progress()` and `progressBytes()` dispatch `fileIndex: this.batchFileIndex, fileCount: this.batchFileCount` in their `progress` events; `dispose()` clears `this.retainedBlobs` (replace the two old `retainedFile`/`retainedBlob` lines with `this.retainedBlobs = new Map();`); import `StreamedParseResult` type from the parse client. Remove the now-unused `openSample` blob retention comment.

- [ ] **Step 3: Compile-adapt the Svelte components (N=1-equivalent behavior)**

`Workbench.svelte`:

- `ControllerPort`: `openFile(file: File): Promise<void>; openFiles(files: readonly File[]): Promise<void>; selectByteRange(range: { file: string; start: number; end: number } | null): void; getSourceBlob(file: string): Blob | null;`
- First-file helpers (Task 8 replaces these with a real switcher):

```ts
  const primaryFile = $derived(session.source?.files[0] ?? null);
  const sourceBlob = $derived(primaryFile ? controller.getSourceBlob(primaryFile.name) : null);
```

- `sourceKey` for the overview auto-run: `next.source ? next.source.files.map((file) => `${file.name}:${file.size}`).join('|') : null`.
- `AppHeader` props: `sourceName={session.source ? (session.source.files.length === 1 ? session.source.files[0]!.name : `${session.source.files.length} files`) : null}` and `sourceSize={session.source?.totalSize ?? null}`.
- `HexPane`: `fileSize={primaryFile?.size ?? 0}`; `onselectionchange={(range) => controller.selectByteRange(range && primaryFile ? { file: primaryFile.name, ...range } : null)}`. Leave `onfilter` calling `wrapFilterSql(draftSql || session.sql, range)` — Task 7 changes that signature and updates this call site.

`Explorer.svelte` lines 30–37 — list every file:

```svelte
  {#if state.source}
    ...
    {#each state.source.files as file (file.name)}
      <div class="source-file">
        <strong class="truncate">{file.name}</strong>
        <span>{file.size.toLocaleString()} bytes</span>
      </div>
    {/each}
```

(match the existing wrapper markup/classes around lines 30–37; keep the existing styling hooks).

`StatusBar.svelte` — batch-position marker in the busy label (near line 19):

```ts
  const fileMarker = $derived(
    state.progress && state.progress.fileCount > 1
      ? ` (${state.progress.fileIndex}/${state.progress.fileCount})`
      : '',
  );
```

and append `{fileMarker}` where the progress label renders. Also add the ready-state batch summary the spec requires (`5 files · 2.3 GB`, plus skipped count when nonzero) where the bar currently shows the ready/source status:

```ts
  const skippedCount = $derived(state.issues.filter((issue) => issue.code === 'FILE_SKIPPED').length);
  const batchSummary = $derived.by(() => {
    if (!state.source || state.source.files.length <= 1) return null;
    const megabytes = (state.source.totalSize / 1e6).toFixed(1);
    const base = `${state.source.files.length} files · ${megabytes} MB`;
    return skippedCount > 0 ? `${base} · ${skippedCount} skipped` : base;
  });
```

Render `{batchSummary}` in the ready segment when it is non-null (single-file sessions keep today's rendering).

- [ ] **Step 4: Extend controller tests**

In `apps/web/src/lib/session/controller.test.ts` — the harness's `FakeParser.calls` now receive `{name, blob}`; parse-call inputs also carry `formatId` (assert where relevant). Update every existing test that constructed single-file opens ONLY where compilation forces it (e.g. `byteSelection` assertions gain `file`). `streamedResult()` already returns `schemas: []`; where a test needs backfill, it passes schemas explicitly — unchanged.

Note on plumbing: `openFiles` probes head bytes via `planBatch`, so test files must carry recognizable magic. Build a real MIDI head (`MThd`) or reuse whatever fixture bytes the worker round-trip tests already use. Add helper:

```ts
const midiBlob = (): Blob => new Blob([new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6])]);
```

If `midiFormatPack.probe` requires more than these 8 bytes, lift the exact head bytes from an existing MIDI fixture in `packages/formats/midi/test/fixtures.ts`.

New cases:

```ts
it('batch happy path: two files parse sequentially into one ingest with a _files batch', async () => {
  // openFiles([fileA, fileB]) with two midi-magic Files named a.mid / b.mid
  // — parser.calls[0].name === 'a.mid'; finish it (emitBatch + finish(streamedResult('notes')));
  // — parser.calls[1] appears only after the first finishes; finish it too.
  // Assert ingest.beginFileCalls === ['a.mid', 'b.mid'];
  // assert an appendCalls entry with table '_files' whose IPC decodes to 2 ok rows;
  // assert state.phase 'ready', state.source.files.map(f => f.name) === ['a.mid', 'b.mid'],
  // and tables contain the merged overview plus '_files'.
});

it('mid-parse failure discards the file and continues with the rest', async () => {
  // File A's parse rejects with new Error('truncated'); File B succeeds.
  // Assert ingest.discardCalls === 1, state.phase 'ready',
  // state.source.files === [{name: 'b.mid', ...}],
  // issues contain code 'FILE_SKIPPED' with message matching /a\.mid was skipped: truncated/,
  // and the '_files' append IPC rows mark a.mid 'skipped' with error 'truncated'.
});

it('all files failing rejects the open with abort, not finalize', async () => {
  // Both parses reject; assert state.phase 'failed', ingest.abortCalls === 1, finalizeCalls === 0.
});

it('a second openFiles supersedes an in-flight batch', async () => {
  // Start batch 1; before finishing, call openFiles(batch2). Assert batch 1's ingest aborts and
  // batch 2 proceeds under a new generation (existing supersession test idioms apply).
});

it('cancel() mid-batch abandons the whole batch', async () => {
  // Start a 2-file batch; finish file A; while file B's parse is outstanding, await
  // controller.cancel(). Assert state.phase is 'idle' (cancelled → initialSessionState),
  // ingest.abortCalls === 1, finalizeCalls === 0, and no parse call for a third file appears.
});

it('unrecognized-only batches fail without touching the database', async () => {
  // openFiles([new File([new Uint8Array([0, 0, 0, 0])], 'junk.bin')]);
  // Assert state.phase 'failed' and database.beginIngest was never called.
});

it('progress events carry the batch position', async () => {
  // During file 2 of 2, emitProgress; assert state.progress.fileIndex === 2 && fileCount === 2.
});
```

Write these against the existing harness helpers (`flush()`, `FakeParser`, `FakeIngestSession`, fake database) exactly as neighboring tests do.

- [ ] **Step 5: Extend StatusBar test**

In `apps/web/src/components/StatusBar.test.ts`, add: a state with `progress: { completed: 50, total: 100, label: 'Parsing', bytes: 0, fileIndex: 2, fileCount: 5 }` renders text matching `/\(2\/5\)/u`, and `fileCount: 1` renders no marker.

- [ ] **Step 6: Run the web suite**

Run: `pnpm --filter @byteql/web test`
Expected: PASS. `Workbench.test.ts` compile changes (ControllerPort fakes gain `openFiles`/keyed `getSourceBlob`) are part of this step.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/session/state.ts apps/web/src/lib/session/controller.ts \
  apps/web/src/components/Workbench.svelte apps/web/src/components/Explorer.svelte \
  apps/web/src/components/StatusBar.svelte apps/web/src/lib/session/controller.test.ts \
  apps/web/src/components/StatusBar.test.ts apps/web/src/components/Workbench.test.ts
git commit -m "feat(web): batch multi-file session pipeline with _files catalog"
```

---

### Task 7: File-aware hex libraries (coverage, filter SQL, literal escaping)

**Files:**

- Create: `apps/web/src/lib/sql-literal.ts`
- Create: `apps/web/src/lib/sql-literal.test.ts`
- Modify: `apps/web/src/lib/hex/filter-sql.ts`
- Modify: `apps/web/src/lib/hex/coverage.ts`
- Modify: `apps/web/src/components/Workbench.svelte` (call sites)
- Test: `apps/web/src/lib/hex/filter-sql.test.ts`, `apps/web/src/lib/hex/coverage.test.ts` (extend the existing files; create only if absent)

**Interfaces:**

- Consumes: `_src_file` column present in query results (Tasks 3/6).
- Produces (used by Task 8):
  - `sqlStringLiteral(value: string): string` — single-quoted, quote-doubled.
  - `wrapFilterSql(sql: string, selection: { file: string; start: number; end: number }): string` — adds `_src_file = <literal> and` before the byte-overlap predicate.
  - `provenanceOfRow(table: Table, row: number): { file: string; start: number; end: number } | null` — null when ANY of `_src_file`/`_src_start`/`_src_end` is missing or null-valued (uniform no-provenance).
  - `buildCoverage(table: Table, file: string): CoverageResult` — indexes only rows whose `_src_file === file`; missing `_src_file` column → `{ index: null, reason: 'no-provenance' }`.
  - `createCoverageMemo(): (table: Table | null, file: string | null) => CoverageResult` — memoizes on the (table, file) pair.
- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/sql-literal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { sqlStringLiteral } from './sql-literal.js';

describe('sqlStringLiteral', () => {
  it('quotes and doubles embedded single quotes', () => {
    expect(sqlStringLiteral('plain.pcap')).toBe("'plain.pcap'");
    expect(sqlStringLiteral("it's here.pcap")).toBe("'it''s here.pcap'");
  });
});
```

Extend the hex tests (create the file mirroring sibling test style if it does not exist):

`apps/web/src/lib/hex/filter-sql.test.ts`:

```ts
it('scopes the byte filter to the selection file with an escaped literal', () => {
  const wrapped = wrapFilterSql('select * from packets;', { file: "a'b.pcap", start: 10, end: 20 });
  expect(wrapped).toBe(
    "select * from (\nselect * from packets\n) where _src_file = 'a''b.pcap' and _src_start < 20 and _src_end > 10;",
  );
});
```

`apps/web/src/lib/hex/coverage.test.ts` — build tables with `tableFromArrays`-style helpers matching the file's idiom (columns `_src_start`, `_src_end` as BigInt/number arrays plus `_src_file` strings):

```ts
it('provenanceOfRow returns the file-qualified range and null without _src_file', () => {
  // table rows: [{_src_file: 'a.pcap', _src_start: 0n, _src_end: 4n}, ...]
  expect(provenanceOfRow(table, 0)).toEqual({ file: 'a.pcap', start: 0, end: 4 });
  expect(provenanceOfRow(tableWithoutSrcFile, 0)).toBeNull();
});

it('buildCoverage indexes only the requested file', () => {
  // rows: a.pcap [0,4), b.pcap [0,8)
  const coverage = buildCoverage(table, 'b.pcap');
  expect(coverage.reason).toBe('ok');
  expect(coverage.index!.rowsAt(6)).toEqual([1]); // only b.pcap's row covers offset 6
  expect(coverage.index!.rowsAt(1)).toEqual([1]); // a.pcap's [0,4) row is excluded from this view
});

it('buildCoverage without a _src_file column reports no-provenance', () => {
  expect(buildCoverage(tableWithoutSrcFile, 'a.pcap').reason).toBe('no-provenance');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/sql-literal.test.ts src/lib/hex/filter-sql.test.ts src/lib/hex/coverage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/lib/sql-literal.ts`:

```ts
/** Renders a SQL single-quoted string literal with embedded quotes doubled. */
export const sqlStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
```

`apps/web/src/lib/hex/filter-sql.ts`:

```ts
import { sqlStringLiteral } from '../sql-literal.js';

/**
 * Wraps the current query with the file-scoped byte-overlap predicate for selection
 * [start, end) in `file`. `_src_end` is exclusive engine-side, hence strict/strict comparisons.
 */
export function wrapFilterSql(
  sql: string,
  selection: { file: string; start: number; end: number },
): string {
  const inner = sql.trim().replace(/;\s*$/u, '');
  return `select * from (\n${inner}\n) where _src_file = ${sqlStringLiteral(selection.file)} and _src_start < ${selection.end} and _src_end > ${selection.start};`;
}
```

`apps/web/src/lib/hex/coverage.ts`:

```ts
export function provenanceOfRow(
  table: Table,
  row: number,
): { file: string; start: number; end: number } | null {
  const fileColumn = table.getChild('_src_file');
  const startColumn = table.getChild('_src_start');
  const endColumn = table.getChild('_src_end');
  if (!fileColumn || !startColumn || !endColumn) return null;
  const file = fileColumn.get(row);
  const range = toRange(startColumn.get(row), endColumn.get(row));
  if (typeof file !== 'string' || !range) return null;
  return { file, ...range };
}
```

`buildCoverage(table: Table, file: string)`: add `const fileColumn = table.getChild('_src_file');` to the initial guard (`if (!fileColumn || !startColumn || !endColumn) return { index: null, reason: 'no-provenance' };`) and skip non-matching rows in the fill loop:

```ts
  for (let row = 0; row < capacity; row += 1) {
    if (fileColumn.get(row) !== file) continue;
    const range = toRange(startColumn.get(row), endColumn.get(row));
    ...
```

`createCoverageMemo`:

```ts
export function createCoverageMemo(): (table: Table | null, file: string | null) => CoverageResult {
  let cache: { table: Table; file: string; value: CoverageResult } | null = null;
  return (table, file) => {
    if (!table || file === null) return { index: null, reason: 'no-provenance' };
    if (cache && cache.table === table && cache.file === file) return cache.value;
    const value = buildCoverage(table, file);
    cache = { table, file, value };
    return value;
  };
}
```

Update `Workbench.svelte` call sites (still first-file-only until Task 8): `coverageMemo(session.result, primaryFile?.name ?? null)`; `rowHighlight` memo value type becomes `{ file: string; start: number; end: number } | null`; the `HexPane` `highlight` prop gets `rowHighlight ? { start: rowHighlight.start, end: rowHighlight.end } : null`; `onfilter={(range) => primaryFile && run(wrapFilterSql(draftSql || session.sql, { file: primaryFile.name, ...range }))}`.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @byteql/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/sql-literal.ts apps/web/src/lib/sql-literal.test.ts \
  apps/web/src/lib/hex/filter-sql.ts apps/web/src/lib/hex/filter-sql.test.ts \
  apps/web/src/lib/hex/coverage.ts apps/web/src/lib/hex/coverage.test.ts \
  apps/web/src/components/Workbench.svelte
git commit -m "feat(web): file-qualified provenance in hex coverage and byte filters"
```

---

### Task 8: Multi-file intake UI and hex pane file switcher

**Files:**

- Modify: `apps/web/src/components/EmptyState.svelte`
- Modify: `apps/web/src/components/Workbench.svelte`
- Modify: `apps/web/src/components/HexPane.svelte`
- Test: `apps/web/src/components/EmptyState.test.ts`, `apps/web/src/components/Workbench.test.ts`, `apps/web/src/components/HexPane.test.ts`

**Interfaces:**

- Consumes: `openFiles`, keyed `getSourceBlob`, file-qualified selection (Task 6); per-file coverage + provenance (Task 7).
- Produces:
  - `EmptyState` prop change: `onopen: (files: File[]) => void`; its `<input type="file">` gains `multiple`; drops and `showOpenFilePicker({ multiple: true })` pass ALL files.
  - `HexPane` new props: `files: readonly { name: string; size: number }[]`, `currentFile: string | null`, `onfilechange: (file: string) => void`. A `<select aria-label="Hex file">` renders in the pane header only when `files.length > 1`.
  - Workbench behavior: hex pane follows `hexFile` (default: first source file; auto-switches to a selected row's provenance file; manual switch clears the byte selection).
  - Viewers require NO change: `Inspector`/`AudioViewer` render from the query result table only and never touch the source blob (verified — no `Blob`/`getSourceBlob` references in `Inspector.svelte`, `AudioViewer.svelte`, `ViewerMenu.svelte`), so the spec's "viewers follow provenance file" holds automatically.
- [ ] **Step 1: Write failing component tests**

`EmptyState.test.ts` additions:

```ts
it('forwards every picked file and marks the input multiple', async () => {
  const onopen = vi.fn();
  render(EmptyState, { onopen, onsample: vi.fn() });
  const input = screen.getByLabelText<HTMLInputElement>('Open file');
  expect(input.multiple).toBe(true);
  const files = [
    new File([new Uint8Array([1])], 'a.pcap'),
    new File([new Uint8Array([2])], 'b.pcap'),
  ];
  await fireEvent.change(input, { target: { files } });
  expect(onopen).toHaveBeenCalledWith(files);
});
```

Also update the existing picker test: `showOpenFilePicker` is now called with `{ multiple: true }` and `onopen` receives `[file]` (an array).

`HexPane.test.ts` additions (follow the file's existing render/props idiom):

```ts
it('renders a file switcher only for multi-file sessions and emits changes', async () => {
  const onfilechange = vi.fn();
  // render with files: [{name: 'a.pcap', size: 8}, {name: 'b.pcap', size: 8}], currentFile: 'a.pcap'
  const select = screen.getByLabelText<HTMLSelectElement>('Hex file');
  expect([...select.options].map((option) => option.value)).toEqual(['a.pcap', 'b.pcap']);
  await fireEvent.change(select, { target: { value: 'b.pcap' } });
  expect(onfilechange).toHaveBeenCalledWith('b.pcap');
});

it('hides the switcher for single-file sessions', () => {
  // render with files: [{name: 'a.pcap', size: 8}], currentFile: 'a.pcap'
  expect(screen.queryByLabelText('Hex file')).toBeNull();
});
```

`Workbench.test.ts` additions (using its existing fake controller + session-publishing harness):

```ts
it('dropping multiple files opens them as one batch', async () => {
  // fire a drop event with dataTransfer.files = [fileA, fileB] on the app shell
  expect(fakeController.openFiles).toHaveBeenCalledWith([fileA, fileB]);
});

it('selecting a row auto-switches the hex pane to that row's source file', async () => {
  // publish a ready state with source.files = [a, b] and a result whose row 0 has
  // _src_file 'b.pcap' — select row 0, assert the HexPane receives currentFile 'b.pcap'
  // (assert via the rendered switcher's value).
});

it('manually switching the hex file clears the byte selection', async () => {
  // with an active byteSelection on 'a.pcap', change the switcher to 'b.pcap';
  // assert controller.selectByteRange was called with null.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @byteql/web exec vitest run src/components/EmptyState.test.ts src/components/HexPane.test.ts src/components/Workbench.test.ts`
Expected: new cases FAIL.

- [ ] **Step 3: Implement `EmptyState.svelte`**

```ts
  interface Props {
    busy?: boolean;
    error?: string | null;
    onopen: (files: File[]) => void;
    onsample: () => void;
  }

  function chooseFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length > 0) onopen(files);
    input.value = '';
  }

  function dropFile(event: DragEvent): void {
    event.preventDefault();
    dragging = false;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) onopen(files);
  }

  function browseFiles(): void {
    if (!window.showOpenFilePicker) return;
    window
      .showOpenFilePicker({ multiple: true })
      .then((handles) => {
        if (handles.length === 0) throw new DOMException('No file was selected.', 'AbortError');
        return Promise.all(handles.map((handle) => handle.getFile()));
      })
      .then(onopen)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        throw err;
      });
  }
```

Template: `<input type="file" multiple aria-label="Open file" ... />`; update the drop hint copy to `Drop binary files anywhere in this panel`. If the `showOpenFilePicker` ambient type lacks the options argument, extend the existing local declaration where it is declared (search `showOpenFilePicker` in `apps/web/src`).

- [ ] **Step 4: Implement `HexPane.svelte` switcher**

Props additions:

```ts
    files?: readonly { name: string; size: number }[];
    currentFile?: string | null;
    onfilechange?: (file: string) => void;
```

(defaults: `files = []`, `currentFile = null`, `onfilechange = () => undefined`). In the pane's header toolbar markup (next to the existing goto input), add:

```svelte
  {#if files.length > 1}
    <select
      class="hex-file-switcher"
      aria-label="Hex file"
      value={currentFile ?? ''}
      onchange={(event) => onfilechange((event.currentTarget as HTMLSelectElement).value)}
    >
      {#each files as file (file.name)}
        <option value={file.name}>{file.name}</option>
      {/each}
    </select>
  {/if}
```

Style `.hex-file-switcher` consistently with the pane's existing toolbar controls (reuse its input styling variables).

- [ ] **Step 5: Implement Workbench wiring**

Replace the Task 6 `primaryFile` stopgap:

```ts
  let hexFile = $state<string | null>(null);
  const sourceFiles = $derived(session.source?.files ?? []);
  // Default / repair: first file of the session, and never a file that left the session.
  $effect(() => {
    if (sourceFiles.length === 0) {
      hexFile = null;
    } else if (hexFile === null || !sourceFiles.some((file) => file.name === hexFile)) {
      hexFile = sourceFiles[0]!.name;
    }
  });
  // Auto-switch: follow the selected row's provenance file.
  $effect(() => {
    const file = rowHighlight?.file;
    if (file && file !== hexFile && sourceFiles.some((candidate) => candidate.name === file)) {
      hexFile = file;
    }
  });
  const hexFileSize = $derived(sourceFiles.find((file) => file.name === hexFile)?.size ?? 0);
  const sourceBlob = $derived(hexFile ? controller.getSourceBlob(hexFile) : null);
  const coverageResult = $derived(coverageMemo(session.result, hexFile));
  const hexResetKey = $derived({ result: session.result, file: hexFile });

  function switchHexFile(file: string): void {
    controller.selectByteRange(null);
    hexFile = file;
  }
```

`HexPane` invocation: `fileSize={hexFileSize}`, `files={sourceFiles}`, `currentFile={hexFile}`, `onfilechange={switchHexFile}`, `resetKey={hexResetKey}`, `highlight={rowHighlight && rowHighlight.file === hexFile ? { start: rowHighlight.start, end: rowHighlight.end } : null}`, `onselectionchange={(range) => controller.selectByteRange(range && hexFile ? { file: hexFile, ...range } : null)}`, `onfilter={(range) => hexFile && run(wrapFilterSql(draftSql || session.sql, { file: hexFile, ...range }))}`. The `{#if session.source !== null}` guard stays.

Intake: `choosePickedFile`/`onDrop` collect `Array.from(...)` and call `perform(() => controller.openFiles(files))`; `EmptyState`'s `onopen={(files) => perform(() => controller.openFiles(files))}`.

- [ ] **Step 6: Run the web suite**

Run: `pnpm --filter @byteql/web test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/EmptyState.svelte apps/web/src/components/HexPane.svelte \
  apps/web/src/components/Workbench.svelte apps/web/src/components/EmptyState.test.ts \
  apps/web/src/components/HexPane.test.ts apps/web/src/components/Workbench.test.ts
git commit -m "feat(web): multi-file intake and per-file hex pane with auto-switch"
```

---

### Task 9: Full verification sweep

**Files:**

- Possibly modify: whatever the sweep flags (e2e selectors, formatting).

**Interfaces:** none — this is the release gate.

- [ ] **Step 1: Full build + tests**

Run: `pnpm check` (builds everything, type-checks, prettier-checks)
Expected: PASS. Fix anything it flags.

- [ ] **Step 2: Lint and format (NOT covered by `pnpm check` — repo gotcha)**

Run: `pnpm lint && pnpm format:check`
Expected: PASS (run `pnpm format` first if prettier complains, then re-check).

- [ ] **Step 3: Full unit suites**

Run: `pnpm test`
Expected: PASS across core, db, formats, web.

- [ ] **Step 4: E2E and bundle gates**

Run: `pnpm test:e2e`
Expected: PASS. If an e2e spec drives the old single-file intake selectors or asserts result-grid columns, update it to the new reality (`_src_file` column present; input is `multiple`). Then:

Run: `pnpm check:bundle`
Expected: PASS (stamping adds no new dependencies; the worker already bundles apache-arrow).

- [ ] **Step 5: Regression-bar spot check**

Open the dev app (`pnpm --filter @byteql/web dev`), load the bundled sample (single MIDI): verify the overview auto-runs, results show a `_src_file` column valued `demo.mid`, the Explorer lists `_files` with one row, and hex highlight/reveal still round-trips. Then open two pcap fixtures together (fixtures live under `packages/formats/pcap`): verify union `packets` counts, `GROUP BY _src_file`, hex auto-switch on row selection, and the hex byte-filter producing file-scoped SQL.

- [ ] **Step 6: Commit any sweep fixes**

```bash
git add -A
git commit -m "test(web): align e2e and gates with multi-file sessions"
```

(Skip the commit if the sweep changed nothing.)
