import {
  readAll,
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
    ['header_id', 'int64'],
    ['format', 'uint16'],
    ['num_tracks', 'uint16'],
    ['division', 'int16'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('events', [
    ['event_id', 'int64'],
    ['track', 'int32'],
    ['event_index', 'int32'],
    ['delta_time', 'int64'],
    ['tick', 'int64'],
    ['kind', 'utf8'],
    ['channel', 'uint8'],
    ['note', 'uint8'],
    ['velocity', 'uint8'],
    ['controller', 'uint8'],
    ['value', 'uint8'],
    ['program', 'uint8'],
    ['pressure', 'uint8'],
    ['bend', 'int16'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('tempo', [
    ['tempo_id', 'int64'],
    ['track', 'int32'],
    ['tick', 'int64'],
    ['us_per_quarter', 'uint32'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('errors', [
    ['error_id', 'int64'],
    ['stage', 'utf8'],
    ['track', 'int32'],
    ['code', 'utf8'],
    ['message', 'utf8'],
    ['recoverable', 'bool'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
];

// (`type` strings are the spec's `ArrowTypeName` values — informational at this boundary; the
// worker derives display types from the real Arrow schema.)

export const midiFormatPack: FormatPack = {
  id: 'standard_midi_file',
  title: 'Standard MIDI file',
  probe: (head) =>
    head.byteLength >= 4 && head[0] === 0x4d && head[1] === 0x54 && head[2] === 0x68 && head[3] === 0x64
      ? 1
      : null,
  schemas: () => MIDI_TABLE_SCHEMAS,
  queries: midiQueries,
  open(source: ByteSource, opts: OpenOptions): RecordSource {
    let bytes: Uint8Array | null = null;
    let parsed: Promise<ParseResult> | null = null;
    let cursor = 0;
    let result: ParseResult | null = null;
    let drained = false;
    let failure: unknown;
    let failed = false;
    return {
      async nextBatch(): Promise<BatchTransfer | null> {
        bytes ??= await readAll(source);
        parsed ??= parseAndProjectMidi(bytes, opts.signal, opts.onProgress).catch((error: unknown) => {
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
