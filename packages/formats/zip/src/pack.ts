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
