import { PackFatalError, type Framer, type FramerIssue } from '@byteql/core';

import { parseMidiContainer } from './container.js';
import { MidiParseError } from './errors.js';
import { buildSyntheticTrackFile, parseSyntheticTrack } from './kaitai.js';
import { normalizeTrack } from './normalize-track.js';
import type { GeneratedEventBody, GeneratedTrackEvent } from '../gen/StandardMidiFile.js';
import type { MidiHeader, NormalizedEventMap, TrackChunk } from './types.js';

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

const issueReport = (stage: string, track: TrackChunk, error: unknown): FramerIssue => {
  if (error instanceof MidiParseError) {
    return {
      stage,
      ordinal: track.index,
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
    ordinal: track.index,
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

export interface MidiParseProgress {
  stage: 'normalizing' | 'parsing' | 'projecting';
  completed: number;
  total: number;
  label: string;
}

const stageLabel = (stage: MidiParseProgress['stage'], completed: number, total: number): string => {
  const present = { normalizing: 'Normalizing', parsing: 'Parsing', projecting: 'Projecting' }[stage];
  if (completed === 0) return `${present} MIDI tracks`;
  const past = stage === 'normalizing' ? 'Normalized' : 'Processed';
  return `${past} track ${completed} of ${total}`;
};

interface NormalizedTrackWork {
  track: TrackChunk;
  normalized: ReturnType<typeof normalizeTrack>;
}

interface ParsedTrackWork extends NormalizedTrackWork {
  safeEvents: ProjectionEvent[];
}

export const smfFramer: Framer = async function* (source, ctx) {
  const bytes = await source.read(0, source.size);
  let container;
  try {
    container = parseMidiContainer(bytes);
  } catch (error) {
    if (error instanceof MidiParseError) throw new PackFatalError(error.code, error.message);
    throw error;
  }
  if (container.header.format === 2) {
    // Built via MidiParseError so the fatal's user-visible message keeps the "CODE at offset N:"
    // wording the worker surfaces verbatim — not just the bare sentence.
    throw new PackFatalError(
      'UNSUPPORTED_MIDI_TYPE',
      new MidiParseError(
        'UNSUPPORTED_MIDI_TYPE',
        8,
        'Type 2 files contain independent sequences and are not supported in Phase 0',
      ).message,
    );
  }
  const total = container.tracks.length;
  const progress = (stage: MidiParseProgress['stage'], completed: number) =>
    ctx.progress({ stage, completed, total, label: stageLabel(stage, completed, total) });

  progress('normalizing', 0);
  const normalizedTracks: NormalizedTrackWork[] = container.tracks.map((track, index) => {
    const normalized = normalizeTrack(track);
    if (normalized.error) ctx.report(issueReport('normalizing', track, normalized.error));
    progress('normalizing', index + 1);
    return { track, normalized };
  });

  progress('parsing', 0);
  const parsedTracks: Array<ParsedTrackWork | null> = normalizedTracks.map((work, index) => {
    let parsed: ParsedTrackWork | null = null;
    try {
      const tree = parseSyntheticTrack(buildSyntheticTrackFile(container.header, work.normalized));
      parsed = {
        ...work,
        safeEvents: tree.track.events.event.map((item, i) =>
          projectionEvent(item, work.normalized.events[i]!),
        ),
      };
    } catch (error) {
      ctx.report(issueReport('parsing', work.track, error));
    }
    progress('parsing', index + 1);
    return parsed;
  });

  progress('projecting', 0);
  yield {
    root: { hdr: headerNode(container.header), tracks: [] },
    provenance: container.header.range,
    tables: ['header'],
  };
  for (const [index, parsed] of parsedTracks.entries()) {
    if (parsed) {
      const { track, normalized, safeEvents } = parsed;
      const tracks: unknown[] = new Array(track.index + 1);
      tracks[track.index] = { events: { event: safeEvents } };
      yield {
        root: { hdr: headerNode(container.header), tracks },
        tables: ['events', 'tempo'],
        ordinal: track.index,
        provenance: (_table, anchor) => {
          const eventIndex = anchor.indexes[1];
          const event = eventIndex === undefined ? undefined : normalized.events[eventIndex];
          if (!event) throw new Error(`PROVENANCE_EVENT_MISSING: ${track.index}:${eventIndex}`);
          return { start: event.sourceStart, end: event.sourceEnd };
        },
        onError: (error) => issueReport('projecting', track, error),
      };
    }
    progress('projecting', index + 1);
  }
  const smpte = container.header.divisionMode === 'smpte';
  return {
    capabilities: {
      audio: smpte
        ? { enabled: false, reason: 'SMPTE time division is not supported by the Phase 0 player.' }
        : { enabled: true, reason: null },
    },
  };
};
