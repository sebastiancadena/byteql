import {
  compileProjection,
  parseProjectionSpec,
  projectTree,
  projectedTableToArrow,
  tableToIpc,
  type ParseIssue,
  type ParseResult,
  type ProjectedTable,
  type TableTransfer,
} from '@byteql/core';

import type { GeneratedEventBody, GeneratedTrackEvent } from '../gen/StandardMidiFile.js';
import { parseMidiContainer } from './container.js';
import { MidiParseError } from './errors.js';
import { buildSyntheticTrackFile, parseSyntheticTrack } from './kaitai.js';
import tablesYaml from './midi-tables.generated.js';
import { normalizeTrack } from './normalize-track.js';
import type { MidiHeader, NormalizedEventMap, TrackChunk } from './types.js';

const compiledProjection = compileProjection(parseProjectionSpec(tablesYaml));

export interface MidiParseProgress {
  stage: 'normalizing' | 'parsing' | 'projecting';
  completed: number;
  total: number;
  label: string;
}

export type MidiProgressCallback = (progress: MidiParseProgress) => void;

const nullability: Readonly<Record<string, ReadonlySet<string>>> = {
  header: new Set(),
  events: new Set(['channel', 'note', 'velocity', 'controller', 'value', 'program', 'pressure', 'bend']),
  tempo: new Set(),
  errors: new Set(['track', '_src_start', '_src_end']),
};

interface MutableProjectedTable extends ProjectedTable {
  columns: Record<string, unknown[]>;
  rowCount: number;
}

interface ProjectionEventBody {
  note: number | null;
  velocity: number | null;
  pressure: number | null;
  controller: number | null;
  value: number | null;
  program: number | null;
  b1: number | null;
  b2: number | null;
}

interface ProjectionEvent {
  vTime: { value: number };
  eventHeader: number;
  eventBody: ProjectionEventBody | null;
  metaEventBody: { metaType: number; body: Uint8Array } | null;
  sysexBody: { data: Uint8Array } | null;
}

const copyEventBody = (body: GeneratedEventBody | undefined): ProjectionEventBody | null =>
  body
    ? {
        note: body.note ?? null,
        velocity: body.velocity ?? null,
        pressure: body.pressure ?? null,
        controller: body.controller ?? null,
        value: body.value ?? null,
        program: body.program ?? null,
        b1: body.b1 ?? null,
        b2: body.b2 ?? null,
      }
    : null;

const projectionEvent = (event: GeneratedTrackEvent, source: NormalizedEventMap): ProjectionEvent => ({
  vTime: { value: source.deltaTime },
  eventHeader: event.eventHeader,
  eventBody: copyEventBody(event.eventBody),
  metaEventBody: event.metaEventBody
    ? { metaType: event.metaEventBody.metaType, body: event.metaEventBody.body }
    : null,
  sysexBody: event.sysexBody ? { data: event.sysexBody.data } : null,
});

const headerNode = (header: MidiHeader) => ({
  format: header.format,
  numTracks: header.numTracks,
  division: header.division,
});

const mutableCopy = (table: ProjectedTable): MutableProjectedTable => ({
  name: table.name,
  columns: Object.fromEntries(
    Object.entries(table.columns).map(([name, values]) => [name, Array.from(values)]),
  ),
  types: { ...table.types },
  rowCount: table.rowCount,
});

const tableKey = (table: MutableProjectedTable): string => {
  const name = Object.keys(table.columns).find((column) => column.endsWith('_id'));
  if (!name) throw new Error(`PROJECTION_KEY_MISSING: table ${table.name} has no synthetic key`);
  return name;
};

const appendProjected = (target: MutableProjectedTable, source: ProjectedTable): void => {
  const key = tableKey(target);
  for (const [name, values] of Object.entries(source.columns)) {
    const output = target.columns[name];
    if (!output) throw new Error(`PROJECTION_SCHEMA_MISMATCH: ${target.name}.${name}`);
    if (name === key) {
      for (let index = 0; index < values.length; index += 1) {
        output.push(BigInt(target.rowCount + index + 1));
      }
    } else {
      output.push(...values);
    }
  }
  target.rowCount += source.rowCount;
};

const parseIssue = (stage: ParseIssue['stage'], track: TrackChunk, error: unknown): ParseIssue => {
  if (error instanceof MidiParseError) {
    return {
      stage,
      track: track.index,
      code: error.code,
      message: error.message,
      recoverable: true,
      sourceStart: error.offset,
      sourceEnd: error.offset < track.bodyEnd ? error.offset + 1 : error.offset,
    };
  }

  const code = stage === 'parsing' ? 'KAITAI_PARSE_FAILED' : 'PROJECTION_FAILED';
  return {
    stage,
    track: track.index,
    code,
    message:
      stage === 'parsing'
        ? 'Kaitai could not parse the normalized track prefix.'
        : 'The bundled MIDI projection could not project the parsed track.',
    recoverable: true,
    sourceStart: track.bodyStart,
    sourceEnd: track.bodyEnd,
  };
};

const errorsTable = (issues: readonly ParseIssue[]): MutableProjectedTable => ({
  name: 'errors',
  rowCount: issues.length,
  columns: {
    error_id: issues.map((_issue, index) => BigInt(index + 1)),
    stage: issues.map((issue) => issue.stage),
    track: issues.map((issue) => issue.track),
    code: issues.map((issue) => issue.code),
    message: issues.map((issue) => issue.message),
    recoverable: issues.map((issue) => issue.recoverable),
    _src_start: issues.map((issue) => (issue.sourceStart === null ? null : BigInt(issue.sourceStart))),
    _src_end: issues.map((issue) => (issue.sourceEnd === null ? null : BigInt(issue.sourceEnd))),
  },
  types: {
    error_id: 'int64',
    stage: 'utf8',
    track: 'int32',
    code: 'utf8',
    message: 'utf8',
    recoverable: 'bool',
    _src_start: 'uint64',
    _src_end: 'uint64',
  },
});

const toTransfer = (table: ProjectedTable): TableTransfer => {
  const arrow = projectedTableToArrow(table);
  const nullableColumns = nullability[table.name] ?? new Set<string>();
  return {
    name: table.name,
    ipc: tableToIpc(arrow),
    rowCount: table.rowCount,
    columns: arrow.schema.fields.map((field) => ({
      name: field.name,
      type: field.type.toString(),
      nullable: nullableColumns.has(field.name),
    })),
  };
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return;
  signal.throwIfAborted();
  throw new DOMException('The operation was aborted.', 'AbortError');
};

const yieldToWorker = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const stageLabel = (stage: MidiParseProgress['stage'], completed: number, total: number): string => {
  const present = { normalizing: 'Normalizing', parsing: 'Parsing', projecting: 'Projecting' }[stage];
  if (completed === 0) return `${present} MIDI tracks`;
  const past = stage === 'normalizing' ? 'Normalized' : 'Processed';
  return `${past} track ${completed} of ${total}`;
};

const reportProgress = (
  callback: MidiProgressCallback | undefined,
  stage: MidiParseProgress['stage'],
  completed: number,
  total: number,
): void => callback?.({ stage, completed, total, label: stageLabel(stage, completed, total) });

interface NormalizedTrackWork {
  track: TrackChunk;
  normalized: ReturnType<typeof normalizeTrack>;
}

interface ParsedTrackWork extends NormalizedTrackWork {
  safeEvents: ProjectionEvent[];
}

export async function parseAndProjectMidi(
  bytes: Uint8Array,
  signal: AbortSignal,
  onProgress?: MidiProgressCallback,
): Promise<ParseResult> {
  throwIfAborted(signal);
  const container = parseMidiContainer(bytes);
  if (container.header.format === 2) {
    throw new MidiParseError(
      'UNSUPPORTED_MIDI_TYPE',
      8,
      'Type 2 files contain independent sequences and are not supported in Phase 0',
    );
  }

  const issues: ParseIssue[] = [];
  const total = container.tracks.length;
  const normalizedTracks: NormalizedTrackWork[] = [];

  reportProgress(onProgress, 'normalizing', 0, total);
  for (const [index, track] of container.tracks.entries()) {
    throwIfAborted(signal);
    const normalized = normalizeTrack(track);
    if (normalized.error) issues.push(parseIssue('normalizing', track, normalized.error));
    normalizedTracks.push({ track, normalized });
    await yieldToWorker();
    throwIfAborted(signal);
    reportProgress(onProgress, 'normalizing', index + 1, total);
  }

  const parsedTracks: Array<ParsedTrackWork | null> = [];
  reportProgress(onProgress, 'parsing', 0, total);
  for (const [index, work] of normalizedTracks.entries()) {
    throwIfAborted(signal);
    const { track, normalized } = work;
    try {
      const parsed = parseSyntheticTrack(buildSyntheticTrackFile(container.header, normalized));
      const safeEvents = parsed.track.events.event.map((item, index) =>
        projectionEvent(item, normalized.events[index]!),
      );
      parsedTracks.push({ ...work, safeEvents });
    } catch (error) {
      issues.push(parseIssue('parsing', track, error));
      parsedTracks.push(null);
    }
    await yieldToWorker();
    throwIfAborted(signal);
    reportProgress(onProgress, 'parsing', index + 1, total);
  }

  reportProgress(onProgress, 'projecting', 0, total);
  const baseRoot = { hdr: headerNode(container.header), tracks: [] };
  const baseTables = projectTree(compiledProjection, baseRoot, {
    resolve: () => container.header.range,
  }).map(mutableCopy);
  const byName = new Map(baseTables.map((table) => [table.name, table]));

  for (const [index] of normalizedTracks.entries()) {
    throwIfAborted(signal);
    const parsed = parsedTracks[index];
    if (parsed) {
      const { track, normalized, safeEvents } = parsed;
      const tracks: unknown[] = new Array(track.index + 1);
      tracks[track.index] = { events: { event: safeEvents } };
      const root = { hdr: headerNode(container.header), tracks };

      try {
        const projected = projectTree(compiledProjection, root, {
          resolve(tableName, anchor) {
            if (tableName === 'header') return container.header.range;
            const eventIndex = anchor.indexes[1];
            const source = eventIndex === undefined ? undefined : normalized.events[eventIndex];
            if (!source) throw new Error(`PROVENANCE_EVENT_MISSING: ${track.index}:${eventIndex}`);
            return { start: source.sourceStart, end: source.sourceEnd };
          },
        });
        for (const table of projected) {
          if (table.name === 'header') continue;
          const target = byName.get(table.name);
          if (!target) throw new Error(`PROJECTION_TABLE_MISSING: ${table.name}`);
          appendProjected(target, table);
        }
      } catch (error) {
        issues.push(parseIssue('projecting', track, error));
      }
    }
    await yieldToWorker();
    throwIfAborted(signal);
    reportProgress(onProgress, 'projecting', index + 1, total);
  }

  throwIfAborted(signal);
  const tables = [...baseTables, errorsTable(issues)].map(toTransfer);
  const smpte = container.header.divisionMode === 'smpte';
  return {
    format: { id: 'standard_midi_file', title: 'Standard MIDI file' },
    tables,
    issues,
    capabilities: {
      audio: smpte
        ? {
            enabled: false,
            reason: 'SMPTE time division is not supported by the Phase 0 player.',
          }
        : { enabled: true, reason: null },
    },
  };
}
