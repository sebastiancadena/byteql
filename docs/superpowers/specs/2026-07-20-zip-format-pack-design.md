# ZIP Format Pack — Design

Date: 2026-07-20
Status: Approved

## Problem

ByteQL has format packs for pcap and MIDI, and multi-file sessions can ingest a same-format
batch. It has no support for ZIP archives. A ZIP is the canonical "container of files" format,
and its structure — a series of local file headers at the front, an authoritative central
directory at the end, and an End Of Central Directory (EOCD) record — is exactly the kind of
byte-addressable layout ByteQL's hex-provenance UI is built to explore. This design adds a ZIP
format pack that projects the **archive's own structure** into SQL tables. It does **not**
decompress member bytes or recurse into member files — querying member *contents* is out of
scope.

Because a format pack is same-format-batch-compatible for free, this also delivers "multi ZIP"
support: dropping 2–10 `.zip` files in one gesture rides the existing multi-file batch
machinery with no changes to that layer.

## Requirements (from brainstorm)

- **Structural parse only**: project the ZIP container per the Kaitai ZIP layout
  (<https://formats.kaitai.io/zip/>). No decompression, no recursion into members.
- **Core 3 tables**: `local_files`, `central_dir_entries`, `end_of_central_dir`. Extra-field
  records are not their own table in v1.
- **Raw + light labels**: keep raw numeric fields, and add two convenience columns —
  `compression` (text label) and `mod_time` (decoded `timestamp_us`).
- **Sequential + CD fallback**: robust on real-world/streamed archives. When a local header
  carries the data-descriptor flag with zeroed sizes, the central directory is authoritative
  for that entry's sizes.
- **Multi-ZIP**: dropping several `.zip` files uses the existing same-format multi-file batch
  path; no new work in that layer.

## Approach

**Approach A — hand-written random-access reader.** A new `@byteql/zip` package mirrors the
MIDI pack: a hand-written `container.ts` walks the archive through the random-access
`ByteSource`, produces plain JS row objects, and a bundled `zip.tables.yaml` projection spec
maps those objects to the three tables. Member compressed bodies are never read into memory, so
peak memory is bounded by *entry count*, not archive size.

Alternatives considered:

- *Compile the upstream `zip.ksy` and parse whole-file* (Approach B): closest to the Kaitai
  reference, but Kaitai's zip parse is a forward scan that materializes every compressed member
  body in RAM and mis-frames streamed (data-descriptor) archives whose local-header sizes are
  zero. Fails the project's scale posture (Phase 1 slice 2 targets 1–4 GB inputs). Rejected.
- *Pure forward local-header scan* (Approach C): simplest, but cannot advance past a
  data-descriptor body without the central directory, so it breaks on exactly the streamed
  archives called out in the requirements. Kept only as a best-effort fallback when an archive
  has no readable EOCD.

The pack follows the established pcap/MIDI conventions: `probe()` sniffer, `schemas()`,
`open()` returning a pull-driven `RecordSource`, bundled `queries`, and generated TS for the
tables/queries YAML. It is added to `REGISTERED_PACKS` in `apps/web/src/lib/packs.ts` (probe
ties break toward earlier entries; ZIP's magic does not collide with pcap or MIDI).

## Package layout

`packages/formats/zip/`, mirroring `packages/formats/midi/`:

- `zip.tables.yaml` — projection spec (v0.3), three tables.
- `queries.yaml` — a few starter saved queries (e.g. largest members, non-`stored` entries,
  compression-ratio ranking, entries whose local vs. CD compressed size disagree).
- `reference/zip.ksy` + `reference/PROVENANCE.md` — the upstream Kaitai ZIP definition committed
  as **field-layout provenance only**. `PROVENANCE.md` states plainly that the reader is
  hand-written and authoritative; the `.ksy` is not compiled or imported. (Mirrors the pcap
  `PROVENANCE.md` convention.)
- `src/container.ts` — the random-access structural reader (see below).
- `src/project-zip.ts` — wires the reader + compiled projection into a `RecordSource`
  (`openZipSource`) plus a `parseAndProjectZip` test helper, mirroring `project-midi.ts` /
  `openPcapSource`.
- `src/pack.ts` — `zipFormatPack` (`id: 'zip'`, `title: 'ZIP archive'`): `probe`, `schemas`,
  `open`, `queries`.
- `src/zip-tables.generated.ts`, `src/zip-queries.generated.ts` — produced by
  `scripts/generate-pack.mjs`.
- `src/index.ts` — `export { zipFormatPack } from './pack.js'`.
- `package.json` / `tsconfig.json` — no `compile:ksy` step (no Kaitai parse); `build` is
  `generate:pack && tsc`. Depends on `@byteql/core`, `apache-arrow`, `yaml`.

## Tables

Column order = key, then parent key (n/a here — the three tables are siblings, not
parent/child), then spec columns in YAML order, then `_src_start`/`_src_end`. All three carry
per-row provenance.

### `local_files` (one row per local file header)

| column | type | notes |
| --- | --- | --- |
| `local_file_id` | int64 | key |
| `version_needed` | uint16 | raw |
| `flags` | uint16 | raw bitfield (bit 3 = data descriptor) |
| `compression_method` | uint16 | raw |
| `compression` | utf8 | label (see decoding) |
| `crc32` | uint32 | raw |
| `compressed_size` | uint32 | CD-reconciled when data-descriptor + zeroed |
| `uncompressed_size` | uint32 | CD-reconciled when data-descriptor + zeroed |
| `mod_time` | timestamp_us | decoded (see decoding) |
| `file_name` | utf8 | |
| `extra_len` | uint16 | length of the extra field (not decoded) |
| `_src_start` / `_src_end` | uint64 | header byte extent |

### `central_dir_entries` (one row per central-directory record)

Superset of `local_files`, plus:

| column | type | notes |
| --- | --- | --- |
| `central_dir_id` | int64 | key |
| `version_made_by` | uint16 | raw |
| `disk_start` | uint16 | raw |
| `internal_attrs` | uint16 | raw |
| `external_attrs` | uint32 | raw |
| `ofs_local_header` | uint32 | offset used to read the local header |
| `comment` | utf8 | per-entry comment |

(Shared columns: `version_needed`, `flags`, `compression_method`, `compression`, `crc32`,
`compressed_size`, `uncompressed_size`, `mod_time`, `file_name`, `extra_len`, plus provenance.)

### `end_of_central_dir` (single row)

| column | type | notes |
| --- | --- | --- |
| `eocd_id` | int64 | key |
| `num_entries` | uint16 | total central-directory records |
| `central_dir_size` | uint32 | |
| `ofs_central_dir` | uint32 | |
| `comment` | utf8 | archive comment |
| `_src_start` / `_src_end` | uint64 | EOCD record extent |

## Parse flow (`container.ts`)

Primary path (CD-anchored, robust):

1. **Locate EOCD.** Scan backward from end of source over the last `22 + up to 65535` bytes for
   the `PK\x05\x06` signature; take the last match. Read `num_entries`, `central_dir_size`,
   `ofs_central_dir`, and the trailing comment.
2. **Read the central directory.** From `ofs_central_dir`, read `num_entries` `PK\x01\x02`
   records sequentially (each = fixed 46-byte head + `file_name` + `extra` + `comment`). Each
   record → one `central_dir_entries` row and carries the authoritative `compressed_size`,
   `uncompressed_size`, and `ofs_local_header`.
3. **Read local headers by offset.** For each CD entry, read the `PK\x03\x04` local header at
   `ofs_local_header` (fixed 30-byte head + `file_name` + `extra`) → one `local_files` row.
   When the local header's data-descriptor flag (bit 3) is set and its `compressed_size` /
   `uncompressed_size` are zero, fall back to the CD entry's authoritative sizes for those
   columns. Provenance is the local header's own byte extent.
4. **Emit the EOCD row.**

Fallback path: if no EOCD can be located (missing/corrupt), forward-scan `PK\x03\x04` local
headers from offset 0 as a best-effort `local_files` population, report a recoverable issue, and
emit no `central_dir_entries` / `end_of_central_dir` rows.

Each record is projected individually through one `ProjectionSession`, with a
`ProvenanceResolver` returning that record's byte extent — the same per-record projection
pattern MIDI (`session.project(root, { resolve: () => range })`) and pcap use. `openZipSource`
pumps the reader incrementally and drains batches at a pending-row threshold, exactly like
`openPcapSource`.

## Field decoding (Raw + light labels)

- **`compression`** — projection-spec nested ternary on `compression_method`:
  `0→"stored"`, `8→"deflate"`, `9→"deflate64"`, `12→"bzip2"`, `14→"lzma"`, `93→"zstd"`,
  `95→"xz"`, `98→"ppmd"`, else `"other"`. Raw `compression_method` is retained for exact
  queries.
- **`mod_time`** — one new **single-argument** core builtin `dos_dttm(packed)` in
  `packages/core/src/projection/expression.ts`, added to `builtinNames` and `builtins`. DOS
  date/time are two u2 fields; the spec passes a single packed value
  `_.mod_date * 65536 + _.mod_time` (both in-range for JS-number arithmetic, matching pcap's
  `_.ts_sec * 1000000 + _.ts_frac_us`). `dos_dttm` unpacks year (1980-based), month, day,
  hour, minute, second×2 and returns **naive-UTC epoch microseconds** (no timezone data exists
  in the format). Invalid/zero dates → `null`. A core unit test covers it.

## Probe

Read the first 4 bytes of `PROBE_HEAD_BYTES`:

- `PK\x03\x04` (`50 4b 03 04`, local file header) → `0.9`
- `PK\x05\x06` (`50 4b 05 06`, empty archive: EOCD only) → `0.9`
- `PK\x07\x08` (`50 4b 07 08`, spanned/split marker) → `0.5`
- otherwise → `null`

Self-extracting archives (an executable stub precedes the ZIP payload, so offset 0 is not a PK
signature) will not sniff — accepted limitation.

## Multi-ZIP

No new work. ZIP is a same-format pack, so the existing multi-file session path (2–10 files,
`_src_file` stamped at the DB append boundary, `_files` catalog, per-file boundary rotation on
failure) applies unchanged. Registering `zipFormatPack` in `REGISTERED_PACKS` is the only wiring.

## Known limitations (documented, deferred)

- **ZIP64** (members > 4 GB, or > 65 535 entries): the raw u4 size/offset columns surface
  `0xFFFFFFFF` / `0xFFFF` sentinels; the real values live in ZIP64 extra fields / a ZIP64 EOCD,
  which are out of scope with "Core 3, no extras". Documented, not decoded.
- **Encrypted entries**: structure still parses; member contents are never inspected anyway.
- **Self-extracting stubs**: not detected (see Probe).
- **Extra fields**: surfaced only as `extra_len`; individual extra records are not a table.
- **Filename encoding**: `file_name` / `comment` are decoded as UTF-8. Legacy archives that
  store names in CP437 without the UTF-8 flag (bit 11) may show replacement characters for
  non-ASCII bytes. CP437 decoding is out of scope for v1.

## Testing

- **Core**: unit test for `dos_dttm` (known DOS values → expected epoch µs; zero/invalid →
  null; arity enforcement already covered by existing call-validation tests).
- **Pack** (`packages/formats/zip/test/`): `container` (EOCD location, CD read, local-header
  read, data-descriptor CD fallback, EOCD-comment handling, missing-EOCD fallback path),
  `project-zip` (row/column values, per-row provenance extents, `compression` labels,
  `mod_time` decoding), `pack` (probe confidences, `schemas()` shape, `open()` end-to-end),
  against small committed fixtures: a stored + a deflated entry, a streamed/data-descriptor
  archive, an empty archive, and one with an archive comment.
- **E2E** (`apps/web/e2e/`): a multi-zip ingest + `_files` catalog spec mirroring the existing
  multi-file spec, asserting `local_files` is queryable and hex↔grid provenance round-trips on
  a `local_files` row.

## Out of scope

- Decompressing or recursing into member files (querying member contents).
- ZIP64 and extra-field decoding.
- An `extras` table.
- Any change to `@byteql/core`'s multi-file / provenance / stream machinery beyond the single
  additive `dos_dttm` builtin.
