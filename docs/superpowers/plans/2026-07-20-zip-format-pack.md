# ZIP Format Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `@byteql/zip` format pack that projects a ZIP archive's *structure* (local file headers, central directory, EOCD) into SQL tables, so dropping one or several `.zip` files exposes their layout to ByteQL's query + hex-provenance UI.

**Architecture:** A hand-written random-access reader (`container.ts`) walks the archive through the `ByteSource` — locates the End Of Central Directory at the tail, reads the authoritative central directory, then reads each local header by offset (reconciling data-descriptor sizes from the central directory). It emits plain snake_case JS records that a bundled `zip.tables.yaml` projection spec maps to three tables. Member compressed bodies are never read, so peak memory is bounded by entry count. ZIP is a same-format pack, so multi-file (2–10 `.zip`) support comes free from the existing multi-file batch path.

**Tech Stack:** TypeScript, the `@byteql/core` projection engine, `apache-arrow`, `yaml`; Vitest for unit tests, Playwright for e2e. No Kaitai compile step (the reader is hand-written).

## Global Constraints

- **Node engine floor:** `>=22.12.0` (root `package.json`).
- **Projection root fields are snake_case**, matching the spec's `_.field` references exactly. `readMember` tries the exact key first, so snake_case records resolve directly (camelCase would also alias, but do not rely on it).
- **`_src_end` is EXCLUSIVE** engine-side; every record `_range` is `{ start, end }` end-exclusive.
- **Reserved projection names:** `_src_start`, `_src_end`, `_src_file`, and each table's `key` — never used as a spec column.
- **No `Co-Authored-By` trailers or AI-assistant branding** in commits (user global rule). Conventional-commit messages.
- **Pack conventions** mirror `packages/formats/midi`: `probe()`, `schemas()`, `open()` returning a `RecordSource`, bundled `queries`, generated TS from YAML via `scripts/generate-pack.mjs`.
- **No `CHANGELOG.md`** exists — skip changelog updates.

---

## File Structure

- `packages/core/src/projection/expression.ts` — **modify**: add the `dos_dttm` builtin.
- `packages/core/src/projection/expression.test.ts` — **modify**: test `dos_dttm`.
- `packages/formats/zip/package.json`, `tsconfig.json` — **create**: package config.
- `packages/formats/zip/zip.tables.yaml` — **create**: projection spec (3 tables).
- `packages/formats/zip/queries.yaml` — **create**: starter grid queries.
- `packages/formats/zip/scripts/generate-pack.mjs` — **create**: YAML→generated TS.
- `packages/formats/zip/reference/zip.ksy`, `reference/PROVENANCE.md` — **create**: field-layout provenance (documentation only; not compiled).
- `packages/formats/zip/src/container.ts` — **create**: random-access structural reader.
- `packages/formats/zip/src/project-zip.ts` — **create**: `parseAndProjectZip` + `zipNullability`.
- `packages/formats/zip/src/pack.ts` — **create**: `zipFormatPack`.
- `packages/formats/zip/src/index.ts` — **create**: `export { zipFormatPack }`.
- `packages/formats/zip/src/{zip-tables,zip-queries}.generated.ts` — **generated** (not hand-edited).
- `packages/formats/zip/test/build-zip.ts` — **create**: deterministic in-memory zip builder for tests.
- `packages/formats/zip/test/{container,project-zip,pack}.test.ts` — **create**: unit tests.
- `apps/web/package.json` — **modify**: add `@byteql/zip` dependency.
- `apps/web/src/lib/packs.ts` — **modify**: register `zipFormatPack`.
- `apps/web/e2e/support/zip.ts` — **create**: e2e zip builder.
- `apps/web/e2e/zip.spec.ts` — **create**: multi-zip e2e.

---

## Task 1: `dos_dttm` core builtin

Decodes a packed DOS date/time (`date << 16 | time`) into naive-UTC epoch microseconds, for the `mod_time` timestamp column. Single-argument (builtins are arity-1); the spec passes `_.mod_date * 65536 + _.mod_time`.

**Files:**

- Modify: `packages/core/src/projection/expression.ts` (`builtinNames` ~line 85; `builtins` ~line 627)
- Test: `packages/core/src/projection/expression.test.ts`

**Interfaces:**

- Produces: builtin `dos_dttm(packed: number) => number | null` callable from projection expressions. Returns epoch microseconds (UTC), or `null` for a zero/invalid date or non-numeric input.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/projection/expression.test.ts`, inside the `describe('projection expressions', ...)` block (after the `ip4_str` tests):

```ts
it('dos_dttm decodes a packed DOS date/time to epoch microseconds', () => {
  // 2021-06-15 12:30:44 UTC.
  const date = (41 << 9) | (6 << 5) | 15; // year-1980=41, month=6, day=15
  const time = (12 << 11) | (30 << 5) | 22; // hour=12, minute=30, second/2=22
  const packed = date * 65536 + time;
  expect(evaluate('dos_dttm(_.p)', { _: { p: packed } })).toBe(
    Date.UTC(2021, 5, 15, 12, 30, 44) * 1000,
  );
});

it('dos_dttm returns null for a zero or invalid date', () => {
  expect(evaluate('dos_dttm(_.p)', { _: { p: 0 } })).toBeNull();
  expect(evaluate('dos_dttm(_.p)', { _: { p: null } })).toBeNull();
  // month 0 is invalid (DOS months are 1-12).
  expect(evaluate('dos_dttm(_.p)', { _: { p: (41 << 9) * 65536 } })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/expression.test.ts -t dos_dttm`
Expected: FAIL — `dos_dttm` is not an available call / builtin not defined.

- [ ] **Step 3: Add `dos_dttm` to the builtin name set**

In `packages/core/src/projection/expression.ts`, add `'dos_dttm'` to the `builtinNames` set:

```ts
const builtinNames = new Set(['enum_str', 'to_i', 'len', 'u24be', 'ip4_str', 'ip6_str', 'dos_dttm']);
```

- [ ] **Step 4: Implement the builtin**

In the same file, add to the `builtins` object (after `ip6_str: formatIpv6,`):

```ts
  dos_dttm: (value: unknown): unknown => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const packed = value >>> 0;
    const date = (packed >>> 16) & 0xffff;
    const time = packed & 0xffff;
    const day = date & 0x1f;
    const month = (date >> 5) & 0x0f;
    const year = 1980 + ((date >> 9) & 0x7f);
    const second = (time & 0x1f) * 2;
    const minute = (time >> 5) & 0x3f;
    const hour = (time >> 11) & 0x1f;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return Date.UTC(year, month - 1, day, hour, minute, second) * 1000;
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/expression.test.ts -t dos_dttm`
Expected: PASS (both tests).

- [ ] **Step 6: Run the full core projection suite (guard the reserved-name list)**

Run: `pnpm --filter @byteql/core exec vitest run src/projection/expression.test.ts`
Expected: PASS. (The "rejects evaluator-reserved state name" `it.each` uses a fixed list and does not need `dos_dttm` added.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/projection/expression.ts packages/core/src/projection/expression.test.ts
git commit -m "feat(core): add dos_dttm projection builtin for DOS date/time"
```

---

## Task 2: ZIP package scaffold + structural reader

Creates the package and the hand-written `container.ts` reader — the heart of the pack. Includes a deterministic in-memory zip builder for tests.

**Files:**

- Create: `packages/formats/zip/package.json`, `packages/formats/zip/tsconfig.json`
- Create: `packages/formats/zip/zip.tables.yaml`, `packages/formats/zip/queries.yaml`
- Create: `packages/formats/zip/scripts/generate-pack.mjs`
- Create: `packages/formats/zip/reference/zip.ksy`, `packages/formats/zip/reference/PROVENANCE.md`
- Create: `packages/formats/zip/src/container.ts`, `packages/formats/zip/src/index.ts`
- Create: `packages/formats/zip/test/build-zip.ts`, `packages/formats/zip/test/container.test.ts`

**Interfaces:**

- Produces: `readZipContainer(source: ByteSource): Promise<ZipContainer>` and the record/`ZipContainer`/`ZipIssue`/`ZipRange` types. Each record carries snake_case fields plus `_range: ZipRange` (end-exclusive).
- Produces (test helper): `buildZip(entries: ZipEntrySpec[], opts?: { comment?: string }): Uint8Array`.
- [ ] **Step 1: Create `package.json`**

`packages/formats/zip/package.json`:

```json
{
  "name": "@byteql/zip",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "generate:pack": "node scripts/generate-pack.mjs",
    "build": "pnpm generate:pack && tsc -p tsconfig.json",
    "check": "pnpm --filter @byteql/core build && pnpm generate:pack && tsc -p tsconfig.json --noEmit",
    "test": "pnpm --filter @byteql/core build && pnpm generate:pack && vitest"
  },
  "dependencies": {
    "@byteql/core": "workspace:*",
    "apache-arrow": "^21.1.0",
    "yaml": "^2.9.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

`packages/formats/zip/tsconfig.json` (identical to `packages/formats/midi/tsconfig.json`):

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create the projection spec `zip.tables.yaml`**

`packages/formats/zip/zip.tables.yaml`:

```yaml
version: '0.3'
format: zip
tables:
  - name: local_files
    rows: $.local_files[*]
    key: local_file_id
    columns:
      version_needed: { expr: _.version_needed, type: uint16 }
      flags: { expr: _.flags, type: uint16 }
      compression_method: { expr: _.compression_method, type: uint16 }
      compression:
        type: utf8
        expr: >-
          _.compression_method == 0 ? "stored" :
          _.compression_method == 8 ? "deflate" :
          _.compression_method == 9 ? "deflate64" :
          _.compression_method == 12 ? "bzip2" :
          _.compression_method == 14 ? "lzma" :
          _.compression_method == 93 ? "zstd" :
          _.compression_method == 95 ? "xz" :
          _.compression_method == 98 ? "ppmd" : "other"
      crc32: { expr: _.crc32, type: uint32 }
      compressed_size: { expr: _.compressed_size, type: uint32 }
      uncompressed_size: { expr: _.uncompressed_size, type: uint32 }
      mod_time: { expr: 'dos_dttm(_.mod_date * 65536 + _.mod_time)', type: timestamp_us }
      file_name: { expr: _.file_name, type: utf8 }
      extra_len: { expr: _.extra_len, type: uint16 }
  - name: central_dir_entries
    rows: $.central_dir_entries[*]
    key: central_dir_id
    columns:
      version_made_by: { expr: _.version_made_by, type: uint16 }
      version_needed: { expr: _.version_needed, type: uint16 }
      flags: { expr: _.flags, type: uint16 }
      compression_method: { expr: _.compression_method, type: uint16 }
      compression:
        type: utf8
        expr: >-
          _.compression_method == 0 ? "stored" :
          _.compression_method == 8 ? "deflate" :
          _.compression_method == 9 ? "deflate64" :
          _.compression_method == 12 ? "bzip2" :
          _.compression_method == 14 ? "lzma" :
          _.compression_method == 93 ? "zstd" :
          _.compression_method == 95 ? "xz" :
          _.compression_method == 98 ? "ppmd" : "other"
      crc32: { expr: _.crc32, type: uint32 }
      compressed_size: { expr: _.compressed_size, type: uint32 }
      uncompressed_size: { expr: _.uncompressed_size, type: uint32 }
      mod_time: { expr: 'dos_dttm(_.mod_date * 65536 + _.mod_time)', type: timestamp_us }
      file_name: { expr: _.file_name, type: utf8 }
      extra_len: { expr: _.extra_len, type: uint16 }
      disk_start: { expr: _.disk_start, type: uint16 }
      internal_attrs: { expr: _.internal_attrs, type: uint16 }
      external_attrs: { expr: _.external_attrs, type: uint32 }
      ofs_local_header: { expr: _.ofs_local_header, type: uint32 }
      comment: { expr: _.comment, type: utf8 }
  - name: end_of_central_dir
    rows: $.end_of_central_dir
    key: eocd_id
    columns:
      num_entries: { expr: _.num_entries, type: uint16 }
      central_dir_size: { expr: _.central_dir_size, type: uint32 }
      ofs_central_dir: { expr: _.ofs_central_dir, type: uint32 }
      comment: { expr: _.comment, type: utf8 }
```

- [ ] **Step 4: Create the starter `queries.yaml`**

`packages/formats/zip/queries.yaml`:

```yaml
version: '0.1'
format: zip
queries:
  - id: overview
    title: Table overview
    kind: grid
    sql: |
      select 'local_files' as table_name, count(*) as row_count from local_files
      union all select 'central_dir_entries', count(*) from central_dir_entries
      union all select 'end_of_central_dir', count(*) from end_of_central_dir
      order by table_name
      limit 100;

  - id: largest_members
    title: Largest members
    kind: grid
    sql: |
      select file_name, compression, uncompressed_size, compressed_size
      from central_dir_entries
      order by uncompressed_size desc, file_name
      limit 100;

  - id: compression_breakdown
    title: Compression breakdown
    kind: grid
    sql: |
      select compression, count(*) as members,
             sum(uncompressed_size) as total_uncompressed,
             sum(compressed_size) as total_compressed
      from central_dir_entries
      group by compression
      order by members desc
      limit 100;

  - id: size_disagreements
    title: Local vs central size mismatches
    kind: grid
    sql: |
      select c.file_name, l.compressed_size as local_size, c.compressed_size as central_size
      from central_dir_entries c
      join local_files l on l.file_name = c.file_name
      where l.compressed_size <> c.compressed_size
      order by c.file_name
      limit 100;
```

- [ ] **Step 5: Create `scripts/generate-pack.mjs`**

`packages/formats/zip/scripts/generate-pack.mjs` (adapted from the midi generator; validates `format: zip`, query kind `grid`):

```js
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(packageDirectory, 'zip.tables.yaml'), 'utf8');
const generated = `// Generated by scripts/generate-pack.mjs from zip.tables.yaml. Do not edit.\nexport default ${JSON.stringify(source)};\n`;
const querySource = await readFile(resolve(packageDirectory, 'queries.yaml'), 'utf8');
const queryPack = parseYaml(querySource);

if (
  !queryPack ||
  queryPack.version !== '0.1' ||
  queryPack.format !== 'zip' ||
  !Array.isArray(queryPack.queries)
) {
  throw new Error('queries.yaml must declare the ZIP 0.1 query pack');
}

for (const [index, query] of queryPack.queries.entries()) {
  if (
    !query ||
    typeof query.id !== 'string' ||
    typeof query.title !== 'string' ||
    !['grid', 'playback'].includes(query.kind) ||
    typeof query.sql !== 'string'
  ) {
    throw new Error(`queries.yaml query ${index} is invalid`);
  }
}

const generatedQueries = `// Generated by scripts/generate-pack.mjs from queries.yaml. Do not edit.\nimport type { PackQuery } from '@byteql/core';\n\n// prettier-ignore\nconst queries = ${JSON.stringify(queryPack.queries, null, 2)} as const satisfies readonly PackQuery[];\n\nexport default queries;\n`;

await writeFile(resolve(packageDirectory, 'src/zip-tables.generated.ts'), generated);
await writeFile(resolve(packageDirectory, 'src/zip-queries.generated.ts'), generatedQueries);
```

- [ ] **Step 6: Create the reference provenance files**

`packages/formats/zip/reference/PROVENANCE.md`:

```markdown
# ZIP structural reference

`zip.ksy` is the upstream Kaitai Struct definition of the ZIP container
(<https://formats.kaitai.io/zip/>), committed here as **field-layout provenance only**.

It is NOT compiled or imported. The authoritative reader is the hand-written
`src/container.ts`, which walks the archive via random access (End Of Central
Directory → central directory → local headers by offset) rather than the
sequential, whole-file scan Kaitai generates. Keep this file in sync with the
byte offsets in `container.ts` when either changes.
```

`packages/formats/zip/reference/zip.ksy`: paste the upstream ZIP `.ksy` from <https://formats.kaitai.io/zip/> (the `zip.ksy` source). It is documentation; its exact content is not asserted by any test.

- [ ] **Step 7: Create the test builder `test/build-zip.ts`**

`packages/formats/zip/test/build-zip.ts`:

```ts
import { deflateRawSync } from 'node:zlib';

export interface ZipEntrySpec {
  name: string;
  data: Uint8Array;
  /** 0 = stored, 8 = deflate. Default 0. */
  method?: 0 | 8;
  /** When true, zero the sizes/crc in the local header, set flag bit 3, and append a data descriptor. */
  dataDescriptor?: boolean;
  modDate?: number;
  modTime?: number;
  comment?: string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

interface Built {
  name: Uint8Array;
  comment: Uint8Array;
  method: number;
  flags: number;
  crc: number;
  compressed: Uint8Array;
  uncompressedSize: number;
  modDate: number;
  modTime: number;
  dataDescriptor: boolean;
  localOffset: number;
}

export const buildZip = (entries: ZipEntrySpec[], opts: { comment?: string } = {}): Uint8Array => {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const u16 = (v: number): Uint8Array => Uint8Array.from([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number): Uint8Array =>
    Uint8Array.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  const built: Built[] = entries.map((entry) => {
    const method = entry.method ?? 0;
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const dataDescriptor = entry.dataDescriptor ?? false;
    return {
      name: utf8(entry.name),
      comment: utf8(entry.comment ?? ''),
      method,
      flags: dataDescriptor ? 0x08 : 0,
      crc: crc32(entry.data),
      compressed,
      uncompressedSize: entry.data.length,
      modDate: entry.modDate ?? 0x52cf, // 2021-06-15
      modTime: entry.modTime ?? 0x63d6, // 12:30:44
      dataDescriptor,
      localOffset: 0,
    };
  });

  // Local file records.
  for (const b of built) {
    b.localOffset = offset;
    push(u32(0x04034b50));
    push(u16(20)); // version needed
    push(u16(b.flags));
    push(u16(b.method));
    push(u16(b.modTime));
    push(u16(b.modDate));
    push(u32(b.dataDescriptor ? 0 : b.crc));
    push(u32(b.dataDescriptor ? 0 : b.compressed.length));
    push(u32(b.dataDescriptor ? 0 : b.uncompressedSize));
    push(u16(b.name.length));
    push(u16(0)); // extra len
    push(b.name);
    push(b.compressed);
    if (b.dataDescriptor) {
      push(u32(0x08074b50));
      push(u32(b.crc));
      push(u32(b.compressed.length));
      push(u32(b.uncompressedSize));
    }
  }

  // Central directory.
  const centralStart = offset;
  for (const b of built) {
    push(u32(0x02014b50));
    push(u16(20)); // version made by
    push(u16(20)); // version needed
    push(u16(b.flags));
    push(u16(b.method));
    push(u16(b.modTime));
    push(u16(b.modDate));
    push(u32(b.crc));
    push(u32(b.compressed.length));
    push(u32(b.uncompressedSize));
    push(u16(b.name.length));
    push(u16(0)); // extra len
    push(u16(b.comment.length));
    push(u16(0)); // disk start
    push(u16(0)); // internal attrs
    push(u32(0)); // external attrs
    push(u32(b.localOffset));
    push(b.name);
    push(b.comment);
  }
  const centralSize = offset - centralStart;

  // End of central directory.
  const archiveComment = utf8(opts.comment ?? '');
  push(u32(0x06054b50));
  push(u16(0)); // disk num
  push(u16(0)); // cd start disk
  push(u16(built.length));
  push(u16(built.length));
  push(u32(centralSize));
  push(u32(centralStart));
  push(u16(archiveComment.length));
  push(archiveComment);

  const total = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    total.set(chunk, cursor);
    cursor += chunk.length;
  }
  return total;
};
```

- [ ] **Step 8: Write the failing container test**

`packages/formats/zip/test/container.test.ts`:

```ts
import { memoryByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { readZipContainer } from '../src/container.js';
import { buildZip } from './build-zip.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('readZipContainer', () => {
  it('reads local files, central directory, and EOCD for a stored + deflated archive', async () => {
    const bytes = buildZip(
      [
        { name: 'a.txt', data: text('hello'), method: 0 },
        { name: 'b.txt', data: text('the quick brown fox '.repeat(8)), method: 8 },
      ],
      { comment: 'archive note' },
    );
    const container = await readZipContainer(memoryByteSource(bytes));

    expect(container.issues).toEqual([]);
    expect(container.localFiles.map((f) => f.file_name)).toEqual(['a.txt', 'b.txt']);
    expect(container.centralDirEntries.map((f) => f.file_name)).toEqual(['a.txt', 'b.txt']);
    expect(container.localFiles[0]!.compression_method).toBe(0);
    expect(container.localFiles[1]!.compression_method).toBe(8);
    expect(container.centralDirEntries[0]!.uncompressed_size).toBe(5);
    expect(container.endOfCentralDir?.num_entries).toBe(2);
    expect(container.endOfCentralDir?.comment).toBe('archive note');
    // Provenance: the first local header starts at offset 0, end-exclusive extent covers the header only.
    expect(container.localFiles[0]!._range.start).toBe(0);
    expect(container.localFiles[0]!._range.end).toBe(30 + 'a.txt'.length);
  });

  it('reconciles data-descriptor entries from the central directory', async () => {
    const payload = text('streamed payload');
    const bytes = buildZip([{ name: 's.bin', data: payload, method: 0, dataDescriptor: true }]);
    const container = await readZipContainer(memoryByteSource(bytes));

    // Local header sizes were zeroed (data-descriptor); the reader falls back to the CD sizes.
    expect(container.localFiles[0]!.compressed_size).toBe(payload.length);
    expect(container.localFiles[0]!.uncompressed_size).toBe(payload.length);
    expect(container.centralDirEntries[0]!.compressed_size).toBe(payload.length);
  });

  it('reads an empty archive (EOCD only)', async () => {
    const bytes = buildZip([]);
    const container = await readZipContainer(memoryByteSource(bytes));
    expect(container.localFiles).toEqual([]);
    expect(container.centralDirEntries).toEqual([]);
    expect(container.endOfCentralDir?.num_entries).toBe(0);
  });

  it('falls back to a forward local-header scan when no EOCD is present', async () => {
    const full = buildZip([{ name: 'a.txt', data: text('hello'), method: 0 }]);
    // Truncate off the central directory + EOCD, leaving only the local file record.
    const truncated = full.slice(0, 30 + 'a.txt'.length + 'hello'.length);
    const container = await readZipContainer(memoryByteSource(truncated));

    expect(container.endOfCentralDir).toBeNull();
    expect(container.centralDirEntries).toEqual([]);
    expect(container.localFiles.map((f) => f.file_name)).toEqual(['a.txt']);
    expect(container.issues.some((i) => i.code === 'EOCD_NOT_FOUND')).toBe(true);
  });
});
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `pnpm --filter @byteql/zip exec vitest run test/container.test.ts`
Expected: FAIL — `../src/container.js` does not exist.

- [ ] **Step 10: Implement `src/container.ts`**

`packages/formats/zip/src/container.ts`:

```ts
import type { ByteSource } from '@byteql/core';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_DATA_DESCRIPTOR = 0x08;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

export interface ZipRange {
  readonly start: number;
  readonly end: number;
}

export interface LocalFileRecord {
  version_needed: number;
  flags: number;
  compression_method: number;
  crc32: number;
  compressed_size: number;
  uncompressed_size: number;
  mod_date: number;
  mod_time: number;
  file_name: string;
  extra_len: number;
  _range: ZipRange;
}

export interface CentralDirRecord {
  version_made_by: number;
  version_needed: number;
  flags: number;
  compression_method: number;
  crc32: number;
  compressed_size: number;
  uncompressed_size: number;
  mod_date: number;
  mod_time: number;
  file_name: string;
  extra_len: number;
  disk_start: number;
  internal_attrs: number;
  external_attrs: number;
  ofs_local_header: number;
  comment: string;
  _range: ZipRange;
}

export interface EndOfCentralDirRecord {
  num_entries: number;
  central_dir_size: number;
  ofs_central_dir: number;
  comment: string;
  _range: ZipRange;
}

export interface ZipIssue {
  code: string;
  message: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface ZipContainer {
  localFiles: LocalFileRecord[];
  centralDirEntries: CentralDirRecord[];
  endOfCentralDir: EndOfCentralDirRecord | null;
  issues: ZipIssue[];
}

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const decodeText = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);

/** Reads the whole central directory + tail into memory; member bodies are never read. */
export async function readZipContainer(source: ByteSource): Promise<ZipContainer> {
  const issues: ZipIssue[] = [];
  const size = source.size;

  // 1. Locate the EOCD by scanning the tail for its signature (last match wins).
  const tailLen = Math.min(size, EOCD_MIN + MAX_COMMENT);
  const tailStart = size - tailLen;
  const tail = await source.read(tailStart, tailLen);
  const tailView = viewOf(tail);
  let eocdRel = -1;
  for (let i = tail.length - EOCD_MIN; i >= 0; i -= 1) {
    if (tailView.getUint32(i, true) === SIG_EOCD) {
      eocdRel = i;
      break;
    }
  }

  if (eocdRel < 0) {
    issues.push({
      code: 'EOCD_NOT_FOUND',
      message: 'No End Of Central Directory record found; falling back to a forward local-header scan.',
      sourceStart: tailStart,
      sourceEnd: size,
    });
    return { ...(await forwardScan(source, issues)), issues };
  }

  const eocdOffset = tailStart + eocdRel;
  const commentLen = tailView.getUint16(eocdRel + 20, true);
  const eocd: EndOfCentralDirRecord = {
    num_entries: tailView.getUint16(eocdRel + 10, true),
    central_dir_size: tailView.getUint32(eocdRel + 12, true),
    ofs_central_dir: tailView.getUint32(eocdRel + 16, true),
    comment: decodeText(tail.subarray(eocdRel + 22, eocdRel + 22 + commentLen)),
    _range: { start: eocdOffset, end: eocdOffset + EOCD_MIN + commentLen },
  };

  // 2. Read the central directory in one contiguous range.
  const centralDirEntries: CentralDirRecord[] = [];
  const cd = await source.read(eocd.ofs_central_dir, eocd.central_dir_size);
  const cdView = viewOf(cd);
  let p = 0;
  while (p + 46 <= cd.length && cdView.getUint32(p, true) === SIG_CENTRAL) {
    const nameLen = cdView.getUint16(p + 28, true);
    const extraLen = cdView.getUint16(p + 30, true);
    const commentLength = cdView.getUint16(p + 32, true);
    const nameStart = p + 46;
    const absStart = eocd.ofs_central_dir + p;
    const recEnd = nameStart + nameLen + extraLen + commentLength;
    centralDirEntries.push({
      version_made_by: cdView.getUint16(p + 4, true),
      version_needed: cdView.getUint16(p + 6, true),
      flags: cdView.getUint16(p + 8, true),
      compression_method: cdView.getUint16(p + 10, true),
      mod_time: cdView.getUint16(p + 12, true),
      mod_date: cdView.getUint16(p + 14, true),
      crc32: cdView.getUint32(p + 16, true),
      compressed_size: cdView.getUint32(p + 20, true),
      uncompressed_size: cdView.getUint32(p + 24, true),
      extra_len: extraLen,
      disk_start: cdView.getUint16(p + 34, true),
      internal_attrs: cdView.getUint16(p + 36, true),
      external_attrs: cdView.getUint32(p + 38, true),
      ofs_local_header: cdView.getUint32(p + 42, true),
      file_name: decodeText(cd.subarray(nameStart, nameStart + nameLen)),
      comment: decodeText(cd.subarray(nameStart + nameLen + extraLen, recEnd)),
      _range: { start: absStart, end: eocd.ofs_central_dir + recEnd },
    });
    p = recEnd;
  }

  // 3. Read each local header by offset, reconciling data-descriptor sizes from the CD.
  const localFiles: LocalFileRecord[] = [];
  for (const entry of centralDirEntries) {
    const head = await source.read(entry.ofs_local_header, 30);
    const hv = viewOf(head);
    if (head.length < 30 || hv.getUint32(0, true) !== SIG_LOCAL) {
      issues.push({
        code: 'LOCAL_HEADER_INVALID',
        message: `Local header for ${JSON.stringify(entry.file_name)} is missing or malformed.`,
        sourceStart: entry.ofs_local_header,
        sourceEnd: entry.ofs_local_header + 30,
      });
      continue;
    }
    const flags = hv.getUint16(6, true);
    const nameLen = hv.getUint16(26, true);
    const extraLen = hv.getUint16(28, true);
    const dataDescriptor = (flags & FLAG_DATA_DESCRIPTOR) !== 0;
    let compressed = hv.getUint32(18, true);
    let uncompressed = hv.getUint32(22, true);
    let crc = hv.getUint32(14, true);
    if (dataDescriptor && compressed === 0 && uncompressed === 0) {
      compressed = entry.compressed_size;
      uncompressed = entry.uncompressed_size;
      crc = entry.crc32;
    }
    const nameBytes = await source.read(entry.ofs_local_header + 30, nameLen);
    localFiles.push({
      version_needed: hv.getUint16(4, true),
      flags,
      compression_method: hv.getUint16(8, true),
      mod_time: hv.getUint16(10, true),
      mod_date: hv.getUint16(12, true),
      crc32: crc,
      compressed_size: compressed,
      uncompressed_size: uncompressed,
      extra_len: extraLen,
      file_name: decodeText(nameBytes),
      _range: {
        start: entry.ofs_local_header,
        end: entry.ofs_local_header + 30 + nameLen + extraLen,
      },
    });
  }

  return { localFiles, centralDirEntries, endOfCentralDir: eocd, issues };
}

/** Best-effort forward scan of local headers when the central directory is unavailable. */
async function forwardScan(
  source: ByteSource,
  issues: ZipIssue[],
): Promise<Omit<ZipContainer, 'issues'>> {
  const localFiles: LocalFileRecord[] = [];
  let offset = 0;
  const size = source.size;
  while (offset + 30 <= size) {
    const head = await source.read(offset, 30);
    const hv = viewOf(head);
    if (head.length < 30 || hv.getUint32(0, true) !== SIG_LOCAL) break;
    const flags = hv.getUint16(6, true);
    const compressed = hv.getUint32(18, true);
    const nameLen = hv.getUint16(26, true);
    const extraLen = hv.getUint16(28, true);
    const nameBytes = await source.read(offset + 30, nameLen);
    localFiles.push({
      version_needed: hv.getUint16(4, true),
      flags,
      compression_method: hv.getUint16(8, true),
      mod_time: hv.getUint16(10, true),
      mod_date: hv.getUint16(12, true),
      crc32: hv.getUint32(14, true),
      compressed_size: compressed,
      uncompressed_size: hv.getUint32(22, true),
      extra_len: extraLen,
      file_name: decodeText(nameBytes),
      _range: { start: offset, end: offset + 30 + nameLen + extraLen },
    });
    if ((flags & FLAG_DATA_DESCRIPTOR) !== 0 && compressed === 0) {
      issues.push({
        code: 'STREAMED_ENTRY_UNSIZED',
        message: 'A data-descriptor entry has no central directory to size its body; stopping the scan.',
        sourceStart: offset,
        sourceEnd: offset + 30,
      });
      break;
    }
    offset += 30 + nameLen + extraLen + compressed;
  }
  return { localFiles, centralDirEntries: [], endOfCentralDir: null };
}
```

- [ ] **Step 11: Create a minimal `src/index.ts`**

`packages/formats/zip/src/index.ts` (temporary; replaced in Task 4):

```ts
export { readZipContainer } from './container.js';
export type { ZipContainer, LocalFileRecord, CentralDirRecord, EndOfCentralDirRecord } from './container.js';
```

- [ ] **Step 12: Install the new workspace package**

Run: `pnpm install`
Expected: `@byteql/zip` is linked into the workspace (it matches `packages/formats/*`).

- [ ] **Step 13: Run the container test to verify it passes**

Run: `pnpm --filter @byteql/zip exec vitest run test/container.test.ts`
Expected: PASS (all four tests).

- [ ] **Step 14: Typecheck the package**

Run: `pnpm --filter @byteql/zip check`
Expected: PASS (generates the TS from YAML, then `tsc --noEmit` clean).

- [ ] **Step 15: Commit**

```bash
git add packages/formats/zip pnpm-lock.yaml
git commit -m "feat(zip): scaffold pack and hand-written structural reader"
```

---

## Task 3: Projection wiring (`project-zip.ts`)

Turns a parsed `ZipContainer` into Arrow tables via the projection engine, with per-row provenance from each record's `_range`. Produces a `ParseResult` mirroring `parseAndProjectMidi`.

**Files:**

- Create: `packages/formats/zip/src/project-zip.ts`
- Test: `packages/formats/zip/test/project-zip.test.ts`

**Interfaces:**

- Consumes: `readZipContainer` (Task 2); `dos_dttm` (Task 1); generated `zip-tables.generated.ts`, `zip-queries.generated.ts` (Task 2 scaffold).
- Produces: `parseAndProjectZip(source: ByteSource, signal: AbortSignal, onProgress?: (p: ParseProgress) => void): Promise<ParseResult>` and `zipNullability: Readonly<Record<string, ReadonlySet<string>>>`.
- [ ] **Step 1: Write the failing test**

`packages/formats/zip/test/project-zip.test.ts`:

```ts
import { ipcToTable, memoryByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { parseAndProjectZip } from '../src/project-zip.js';
import { buildZip } from './build-zip.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const rows = (result: Awaited<ReturnType<typeof parseAndProjectZip>>, name: string) => {
  const table = result.tables.find((t) => t.name === name);
  if (!table) throw new Error(`missing table ${name}`);
  return ipcToTable(table.ipc);
};

describe('parseAndProjectZip', () => {
  it('projects local_files with labels, provenance, and a decoded mod_time', async () => {
    const bytes = buildZip([
      { name: 'a.txt', data: text('hello'), method: 0, modDate: 0x52cf, modTime: 0x63d6 },
      { name: 'b.txt', data: text('xyz'.repeat(20)), method: 8 },
    ]);
    const result = await parseAndProjectZip(memoryByteSource(bytes), new AbortController().signal);

    expect(result.format.id).toBe('zip');
    const local = rows(result, 'local_files');
    expect(local.numRows).toBe(2);
    const compression = local.getChild('compression')!.toArray();
    expect([...compression]).toEqual(['stored', 'deflate']);
    // 2021-06-15 12:30:44 UTC in microseconds.
    const modTime = local.getChild('mod_time')!.get(0);
    expect(Number(modTime)).toBe(Date.UTC(2021, 5, 15, 12, 30, 44) * 1000);
    // Provenance is present on the first row.
    expect(Number(local.getChild('_src_start')!.get(0))).toBe(0);
    expect(Number(local.getChild('_src_end')!.get(0))).toBe(30 + 'a.txt'.length);
  });

  it('emits an end_of_central_dir row and central_dir_entries', async () => {
    const bytes = buildZip([{ name: 'a.txt', data: text('hi'), method: 0 }], { comment: 'note' });
    const result = await parseAndProjectZip(memoryByteSource(bytes), new AbortController().signal);
    expect(rows(result, 'central_dir_entries').numRows).toBe(1);
    const eocd = rows(result, 'end_of_central_dir');
    expect(eocd.numRows).toBe(1);
    expect(eocd.getChild('num_entries')!.get(0)).toBe(1);
    expect(eocd.getChild('comment')!.get(0)).toBe('note');
  });

  it('reports a recoverable issue when the EOCD is missing', async () => {
    const full = buildZip([{ name: 'a.txt', data: text('hello'), method: 0 }]);
    const truncated = full.slice(0, 30 + 'a.txt'.length + 'hello'.length);
    const result = await parseAndProjectZip(memoryByteSource(truncated), new AbortController().signal);
    expect(result.issues.some((i) => i.code === 'EOCD_NOT_FOUND')).toBe(true);
    expect(rows(result, 'local_files').numRows).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @byteql/zip exec vitest run test/project-zip.test.ts`
Expected: FAIL — `../src/project-zip.js` does not exist.

- [ ] **Step 3: Implement `src/project-zip.ts`**

`packages/formats/zip/src/project-zip.ts`:

```ts
import {
  IssueCollector,
  compileProjection,
  createProjectionSession,
  parseProjectionSpec,
  projectedTableToArrow,
  tableToIpc,
  type ByteSource,
  type FinishedTable,
  type ParseProgress,
  type ParseResult,
  type ProvenanceResolver,
  type TableTransfer,
} from '@byteql/core';

import { readZipContainer, type ZipRange } from './container.js';
import zipQueries from './zip-queries.generated.js';
import tablesYaml from './zip-tables.generated.js';

const compiledProjection = compileProjection(parseProjectionSpec(tablesYaml));

export type ZipProgressCallback = (progress: ParseProgress) => void;

export const zipNullability: Readonly<Record<string, ReadonlySet<string>>> = {
  local_files: new Set(['_src_start', '_src_end', 'mod_time']),
  central_dir_entries: new Set(['_src_start', '_src_end', 'mod_time']),
  end_of_central_dir: new Set(['_src_start', '_src_end']),
  errors: new Set(['record', '_src_start', '_src_end']),
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return;
  signal.throwIfAborted();
  throw new DOMException('The operation was aborted.', 'AbortError');
};

const toTransfer = (finished: FinishedTable): TableTransfer => {
  const nullableColumns = zipNullability[finished.name] ?? new Set<string>();
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

/** Each projected node carries `_range`; the resolver returns it for per-row provenance. */
const provenance: ProvenanceResolver = {
  resolve: (_table, match) => (match.node as { _range: ZipRange })._range,
};

export async function parseAndProjectZip(
  source: ByteSource,
  signal: AbortSignal,
  onProgress?: ZipProgressCallback,
): Promise<ParseResult> {
  throwIfAborted(signal);
  onProgress?.({ stage: 'projecting', completed: 0, total: source.size, label: 'Reading ZIP structure' });

  const container = await readZipContainer(source);
  throwIfAborted(signal);

  const collector = new IssueCollector({ ordinalColumn: 'record' });
  for (const issue of container.issues) {
    collector.report({
      stage: 'framing',
      code: issue.code,
      message: issue.message,
      recoverable: true,
      sourceStart: issue.sourceStart,
      sourceEnd: issue.sourceEnd,
    });
  }

  const session = createProjectionSession(compiledProjection, { issues: collector });
  session.project(
    {
      local_files: container.localFiles,
      central_dir_entries: container.centralDirEntries,
      end_of_central_dir: container.endOfCentralDir,
    },
    provenance,
  );
  const finished = session.finish();

  const errors = collector.table();
  const tables: TableTransfer[] = finished.map(toTransfer);
  tables.push(
    toTransfer({ name: errors.name, arrow: projectedTableToArrow(errors), rowCount: errors.rowCount }),
  );

  onProgress?.({
    stage: 'projecting',
    completed: source.size,
    total: source.size,
    label: 'Projected ZIP structure',
  });

  return {
    format: { id: 'zip', title: 'ZIP archive' },
    tables,
    issues: collector.issues(),
    queries: zipQueries,
    capabilities: {},
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @byteql/zip exec vitest run test/project-zip.test.ts`
Expected: PASS (all three tests).

Note: if the `end_of_central_dir` table does not appear because `finished` omits a zero-row table, that only affects the empty-archive path (the tests here always have an EOCD, so they pass). Cross-check against the `pack.test.ts` empty-archive assertion in Task 4; the pack's `schemas()` declares all tables regardless.

- [ ] **Step 5: Commit**

```bash
git add packages/formats/zip/src/project-zip.ts packages/formats/zip/test/project-zip.test.ts
git commit -m "feat(zip): project archive structure into Arrow tables"
```

---

## Task 4: `zipFormatPack` + web registration

Exposes the pack (`probe`/`schemas`/`open`) and registers it so the app selects it for `.zip` files and dropping several rides the multi-file batch path.

**Files:**

- Create: `packages/formats/zip/src/pack.ts`
- Modify: `packages/formats/zip/src/index.ts`
- Test: `packages/formats/zip/test/pack.test.ts`
- Modify: `apps/web/package.json` (add dependency), `apps/web/src/lib/packs.ts` (register)

**Interfaces:**

- Consumes: `parseAndProjectZip`, `zipNullability` (Task 3); `selectPack`, `REGISTERED_PACKS` (existing).
- Produces: `zipFormatPack: FormatPack` (`id: 'zip'`, `title: 'ZIP archive'`), re-exported from `index.ts`.
- [ ] **Step 1: Write the failing pack test**

`packages/formats/zip/test/pack.test.ts`:

```ts
import { memoryByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { zipFormatPack } from '../src/pack.js';
import { buildZip } from './build-zip.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const drain = async (bytes: Uint8Array) => {
  const source = zipFormatPack.open(memoryByteSource(bytes), { signal: new AbortController().signal });
  const seen = new Map<string, number>();
  for (let batch = await source.nextBatch(); batch !== null; batch = await source.nextBatch()) {
    seen.set(batch.table, (seen.get(batch.table) ?? 0) + batch.rowCount);
  }
  source.finish();
  return seen;
};

describe('zipFormatPack', () => {
  it('probes ZIP local-file and empty-archive magic, rejects others', () => {
    expect(zipFormatPack.probe(Uint8Array.of(0x50, 0x4b, 0x03, 0x04))).toBeGreaterThan(0.5);
    expect(zipFormatPack.probe(Uint8Array.of(0x50, 0x4b, 0x05, 0x06))).toBeGreaterThan(0.5);
    expect(zipFormatPack.probe(Uint8Array.of(0x4d, 0x54, 0x68, 0x64))).toBeNull();
    expect(zipFormatPack.probe(Uint8Array.of(0x50))).toBeNull();
  });

  it('declares local_files, central_dir_entries, end_of_central_dir, and errors', () => {
    expect(zipFormatPack.schemas().map((s) => s.name).sort()).toEqual([
      'central_dir_entries',
      'end_of_central_dir',
      'errors',
      'local_files',
    ]);
  });

  it('opens an archive and emits per-table batches', async () => {
    const bytes = buildZip([{ name: 'a.txt', data: text('hi'), method: 0 }]);
    const seen = await drain(bytes);
    expect(seen.get('local_files')).toBe(1);
    expect(seen.get('central_dir_entries')).toBe(1);
    expect(seen.get('end_of_central_dir')).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @byteql/zip exec vitest run test/pack.test.ts`
Expected: FAIL — `../src/pack.js` does not exist.

- [ ] **Step 3: Implement `src/pack.ts`**

`packages/formats/zip/src/pack.ts`:

```ts
import {
  type BatchTransfer,
  type ByteSource,
  type FormatPack,
  type OpenOptions,
  type ParseResult,
  type RecordSource,
  type SourceFinish,
  type TableColumn,
  type TableSchema,
} from '@byteql/core';

import { parseAndProjectZip, zipNullability } from './project-zip.js';
import zipQueries from './zip-queries.generated.js';

const column = (table: string, name: string, type: string): TableColumn => ({
  name,
  type,
  nullable: (zipNullability[table] ?? new Set<string>()).has(name),
});

const columns = (table: string, entries: readonly (readonly [string, string])[]): TableSchema => ({
  name: table,
  columns: entries.map(([name, type]) => column(table, name, type)),
});

// Column order mirrors the projection engine's output: key, spec columns, provenance.
const ZIP_TABLE_SCHEMAS: readonly TableSchema[] = [
  columns('local_files', [
    ['local_file_id', 'int64'],
    ['version_needed', 'uint16'],
    ['flags', 'uint16'],
    ['compression_method', 'uint16'],
    ['compression', 'utf8'],
    ['crc32', 'uint32'],
    ['compressed_size', 'uint32'],
    ['uncompressed_size', 'uint32'],
    ['mod_time', 'timestamp_us'],
    ['file_name', 'utf8'],
    ['extra_len', 'uint16'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('central_dir_entries', [
    ['central_dir_id', 'int64'],
    ['version_made_by', 'uint16'],
    ['version_needed', 'uint16'],
    ['flags', 'uint16'],
    ['compression_method', 'uint16'],
    ['compression', 'utf8'],
    ['crc32', 'uint32'],
    ['compressed_size', 'uint32'],
    ['uncompressed_size', 'uint32'],
    ['mod_time', 'timestamp_us'],
    ['file_name', 'utf8'],
    ['extra_len', 'uint16'],
    ['disk_start', 'uint16'],
    ['internal_attrs', 'uint16'],
    ['external_attrs', 'uint32'],
    ['ofs_local_header', 'uint32'],
    ['comment', 'utf8'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('end_of_central_dir', [
    ['eocd_id', 'int64'],
    ['num_entries', 'uint16'],
    ['central_dir_size', 'uint32'],
    ['ofs_central_dir', 'uint32'],
    ['comment', 'utf8'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('errors', [
    ['error_id', 'int64'],
    ['stage', 'utf8'],
    ['record', 'int32'],
    ['code', 'utf8'],
    ['message', 'utf8'],
    ['recoverable', 'bool'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
];

export const zipFormatPack: FormatPack = {
  id: 'zip',
  title: 'ZIP archive',
  probe: (head) => {
    if (head.byteLength < 4 || head[0] !== 0x50 || head[1] !== 0x4b) return null;
    if (head[2] === 0x03 && head[3] === 0x04) return 0.9; // local file header
    if (head[2] === 0x05 && head[3] === 0x06) return 0.9; // empty archive (EOCD)
    if (head[2] === 0x07 && head[3] === 0x08) return 0.5; // spanned marker
    return null;
  },
  schemas: () => ZIP_TABLE_SCHEMAS,
  queries: zipQueries,
  open(source: ByteSource, opts: OpenOptions): RecordSource {
    let parsed: Promise<ParseResult> | null = null;
    let result: ParseResult | null = null;
    let cursor = 0;
    let drained = false;
    let failed = false;
    let failure: unknown;
    return {
      async nextBatch(): Promise<BatchTransfer | null> {
        parsed ??= parseAndProjectZip(source, opts.signal, opts.onProgress).catch((error: unknown) => {
          failed = true;
          failure = error;
          throw error;
        });
        result ??= await parsed;
        if (cursor >= result.tables.length) {
          drained = true;
          return null;
        }
        const table = result.tables[cursor]!;
        cursor += 1;
        return { table: table.name, ipc: table.ipc, rowCount: table.rowCount };
      },
      finish(): SourceFinish {
        if (failed) throw failure;
        if (!drained || !result)
          throw new Error('RECORD_SOURCE_NOT_DRAINED: call nextBatch() until null before finish()');
        return { issues: result.issues, capabilities: result.capabilities };
      },
    };
  },
};
```

- [ ] **Step 4: Point `src/index.ts` at the pack**

Replace `packages/formats/zip/src/index.ts` with:

```ts
export { zipFormatPack } from './pack.js';
```

- [ ] **Step 5: Run the pack test to verify it passes**

Run: `pnpm --filter @byteql/zip exec vitest run test/pack.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 6: Add the web dependency**

In `apps/web/package.json`, add to `dependencies` (keep alphabetical with the other `@byteql/*` entries):

```json
    "@byteql/zip": "workspace:*",
```

Run: `pnpm install`
Expected: `@byteql/web` now depends on `@byteql/zip`.

- [ ] **Step 7: Register the pack in the web app**

Edit `apps/web/src/lib/packs.ts`:

```ts
import type { FormatPack } from '@byteql/core';
import { midiFormatPack } from '@byteql/midi';
import { pcapFormatPack } from '@byteql/pcap';
import { zipFormatPack } from '@byteql/zip';

/** Canonical pack registration order — probing ties break toward the earlier entry. */
export const REGISTERED_PACKS: readonly FormatPack[] = [midiFormatPack, pcapFormatPack, zipFormatPack];
```

(Leave `PROBE_HEAD_BYTES` and `selectPack` unchanged. ZIP magic does not collide with MIDI/pcap, so order relative to them is not sensitive.)

- [ ] **Step 8: Build the zip package and typecheck the web app**

Run: `pnpm --filter @byteql/zip build && pnpm --filter @byteql/web check`
Expected: PASS — the web app compiles with `zipFormatPack` registered.

- [ ] **Step 9: Commit**

```bash
git add packages/formats/zip/src/pack.ts packages/formats/zip/src/index.ts packages/formats/zip/test/pack.test.ts apps/web/package.json apps/web/src/lib/packs.ts pnpm-lock.yaml
git commit -m "feat(zip): expose zipFormatPack and register it in the web app"
```

---

## Task 5: Multi-zip e2e

Verifies end-to-end that dropping two `.zip` files opens a same-format multi-file session, catalogs both in `_files`, makes `local_files` queryable, and round-trips hex provenance — the "multi zip" deliverable.

**Files:**

- Create: `apps/web/e2e/support/zip.ts`
- Create: `apps/web/e2e/zip.spec.ts`

**Interfaces:**

- Consumes: `waitForAppReady`, `runSql` (existing `apps/web/e2e/support/app.ts`).
- Produces: `makeZip(entries: { name: string; data: string }[], comment?: string): Uint8Array` for e2e fixtures.
- [ ] **Step 1: Create the e2e zip builder**

`apps/web/e2e/support/zip.ts` — a store-only builder (no Node `zlib` dependency needed; structure is what matters):

```ts
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Builds a minimal store-only ZIP archive from string entries. */
export const makeZip = (entries: { name: string; data: string }[], comment = ''): Uint8Array => {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (b: Uint8Array): void => {
    chunks.push(b);
    offset += b.length;
  };
  const u16 = (v: number): Uint8Array => Uint8Array.from([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number): Uint8Array =>
    Uint8Array.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  const meta = entries.map((e) => ({
    name: enc.encode(e.name),
    data: enc.encode(e.data),
    crc: crc32(enc.encode(e.data)),
    offset: 0,
  }));

  for (const m of meta) {
    m.offset = offset;
    push(u32(0x04034b50));
    push(u16(20));
    push(u16(0));
    push(u16(0)); // stored
    push(u16(0x63d6)); // mod time 12:30:44
    push(u16(0x52cf)); // mod date 2021-06-15
    push(u32(m.crc));
    push(u32(m.data.length));
    push(u32(m.data.length));
    push(u16(m.name.length));
    push(u16(0));
    push(m.name);
    push(m.data);
  }

  const centralStart = offset;
  for (const m of meta) {
    push(u32(0x02014b50));
    push(u16(20));
    push(u16(20));
    push(u16(0));
    push(u16(0));
    push(u16(0x63d6));
    push(u16(0x52cf));
    push(u32(m.crc));
    push(u32(m.data.length));
    push(u32(m.data.length));
    push(u16(m.name.length));
    push(u16(0));
    push(u16(0));
    push(u16(0));
    push(u16(0));
    push(u32(0));
    push(u32(m.offset));
    push(m.name);
  }
  const centralSize = offset - centralStart;

  const commentBytes = enc.encode(comment);
  push(u32(0x06054b50));
  push(u16(0));
  push(u16(0));
  push(u16(meta.length));
  push(u16(meta.length));
  push(u32(centralSize));
  push(u32(centralStart));
  push(u16(commentBytes.length));
  push(commentBytes);

  const total = new Uint8Array(offset);
  let cursor = 0;
  for (const c of chunks) {
    total.set(c, cursor);
    cursor += c.length;
  }
  return total;
};
```

- [ ] **Step 2: Create the e2e spec**

`apps/web/e2e/zip.spec.ts`:

```ts
import { Buffer } from 'node:buffer';

import { expect, test } from '@playwright/test';

import { runSql, waitForAppReady } from './support/app.js';
import { makeZip } from './support/zip.js';

const asFile = (name: string, bytes: Uint8Array) => ({
  name,
  mimeType: 'application/zip',
  buffer: Buffer.from(bytes),
});

test('a two-zip session catalogs both archives and exposes local_files', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);

  const zipA = makeZip([
    { name: 'alpha.txt', data: 'alpha contents' },
    { name: 'notes/readme.md', data: '# hello' },
  ]);
  const zipB = makeZip([{ name: 'beta.bin', data: 'beta payload here' }]);
  const nameA = 'first.zip';
  const nameB = 'second.zip';

  await page
    .getByLabel('Open file')
    .setInputFiles([asFile(nameA, zipA), asFile(nameB, zipB)]);

  // 1. The Explorer lists the `_files` catalog.
  const tablesRegion = page.getByRole('region', { name: 'Tables' });
  await expect(tablesRegion).toBeVisible();
  await expect(tablesRegion.getByRole('button', { name: 'Browse _files' })).toBeVisible();

  // 2. `local_files` is queryable and spans both archives (3 members total).
  await runSql(page, 'select count(*) as n from local_files;');
  await expect(page.getByRole('region', { name: 'SQL workspace' }).getByText('1 rows')).toBeVisible();
  await expect(page.getByRole('gridcell', { name: '3', exact: true })).toBeVisible();

  // 3. The `_files` catalog shows both archives ingested ok.
  await runSql(page, 'select file, status from _files order by ingest_order;');
  await expect(page.getByRole('region', { name: 'SQL workspace' }).getByText('2 rows')).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'ok', exact: true }).first()).toBeVisible();

  // 4. A member row provenanced to the second archive auto-switches the hex pane.
  await runSql(page, `select * from local_files where _src_file = '${nameB}' limit 1;`);
  await expect(page.getByRole('region', { name: 'SQL workspace' }).getByText('1 rows')).toBeVisible();
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  await expect(page.getByLabel('Hex file')).toHaveValue(nameB);
});
```

- [ ] **Step 3: Run the e2e spec**

Run: `pnpm --filter @byteql/web test:e2e -- zip.spec.ts`
Expected: PASS. (If the runner does not accept a file filter argument, run `pnpm --filter @byteql/web exec playwright test e2e/zip.spec.ts`.)

If an assertion's role/name does not match the live DOM (labels may have shifted since this plan was written), open `apps/web/e2e/multi-file.spec.ts` and mirror its exact selectors — it exercises the same `_files` catalog and hex file switcher.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/support/zip.ts apps/web/e2e/zip.spec.ts
git commit -m "test(zip): multi-zip e2e for _files catalog and local_files"
```

---

## Task 6: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Build everything**

Run: `pnpm build`
Expected: PASS — all packages, including `@byteql/zip`, build.

- [ ] **Step 2: Run the full test + check gate**

Run: `pnpm test && pnpm check`
Expected: PASS. `pnpm check` runs `pnpm build && pnpm -r check && pnpm format:check`. If `format:check` flags the new files, run `pnpm format` and amend the most recent commit.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: PASS. Fix any ESLint findings in the new files and amend.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Start the dev server (`pnpm --filter @byteql/web dev`), open the app, drag in a real `.zip`, and confirm `select * from central_dir_entries` returns rows and clicking a `local_files` row highlights the header bytes in the hex pane.

---

## Self-Review

**1. Spec coverage:**

- Structural parse only, no decompression → Tasks 2–4 (reader reads headers/CD/EOCD, never member bodies). ✓
- Core 3 tables (`local_files`, `central_dir_entries`, `end_of_central_dir`) → `zip.tables.yaml` (Task 2), schemas (Task 4). ✓
- Raw + light labels (`compression` label, `mod_time` timestamp) → `compression` ternary + `dos_dttm` (Tasks 1, 3). ✓
- Sequential + CD fallback → `readZipContainer` reconciles data-descriptor sizes from the CD; `forwardScan` fallback when no EOCD (Task 2, tested). ✓
- Multi-ZIP via existing batch path → registration only (Task 4) + e2e (Task 5). ✓
- Probe confidences → Task 4 test. ✓
- Known limitations (ZIP64 sentinels, self-extracting, extras as `extra_len`) → surfaced as raw fields / documented in `PROVENANCE.md`; no task needed beyond what exists. ✓
- Testing (core builtin, container, project, pack, e2e) → Tasks 1–5. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — every code step shows complete content. The only deferred bits are the upstream `zip.ksy` paste (documentation, explicitly non-asserted) and copying `midi/tsconfig.json` (exact source named). ✓

**3. Type consistency:** `readZipContainer`/`ZipContainer`/`ZipRange` defined in Task 2 are consumed with matching names in Task 3; snake_case record fields match the `_.field` references in `zip.tables.yaml`; `parseAndProjectZip(source, signal, onProgress)` signature is identical across Tasks 3–4; `zipNullability` keys match the table names in `zip.tables.yaml` and the schemas in `pack.ts`; the `errors` ordinal column is `record` in both `zipNullability` and `ZIP_TABLE_SCHEMAS`. ✓

**One risk flagged for execution:** `parseAndProjectZip` relies on `session.finish()` returning a zero-row `end_of_central_dir` table for the empty-archive case. If it does not, the empty-archive pack path would omit that table; `pack.ts`'s `schemas()` still declares it, so downstream schema reads are safe, but if the Task 4 empty-archive expectation fails, add a backfill for missing declared tables in `parseAndProjectZip` (mirror pcap's `emptyProjectionTables`). Verify against the projection engine's actual finish() behavior during Task 3.
