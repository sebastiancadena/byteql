import KaitaiStream from 'kaitai-struct/KaitaiStream.js';

import {
  StandardMidiFile,
  type GeneratedTrack,
  type GeneratedTrackEventsDebug,
} from '../gen/StandardMidiFile.js';
import type { MidiHeader, NormalizedEventMap, NormalizedTrack, SourceRange } from './types.js';

const SYNTHETIC_TRACK_BODY_START = 22;

export interface SyntheticTrackFile {
  bytes: Uint8Array;
  events: NormalizedEventMap[];
}

interface CorrelatedTrackEventsDebug {
  event: {
    start: number;
    end: number;
    arr: SourceRange[];
  };
}

export interface ParsedTrackTree {
  track: GeneratedTrack;
  debug: CorrelatedTrackEventsDebug;
  events: NormalizedEventMap[];
}

function writeChunkId(bytes: Uint8Array, offset: number, id: string): void {
  for (let index = 0; index < id.length; index += 1) {
    bytes[offset + index] = id.charCodeAt(index);
  }
}

export function buildSyntheticTrackFile(header: MidiHeader, track: NormalizedTrack): SyntheticTrackFile {
  const bytes = new Uint8Array(SYNTHETIC_TRACK_BODY_START + track.bytes.length);
  const view = new DataView(bytes.buffer);

  writeChunkId(bytes, 0, 'MThd');
  view.setUint32(4, 6, false);
  view.setUint16(8, header.format, false);
  view.setUint16(10, 1, false);
  view.setUint16(12, header.division & 0xffff, false);
  writeChunkId(bytes, 14, 'MTrk');
  view.setUint32(18, track.bytes.length, false);
  bytes.set(track.bytes, SYNTHETIC_TRACK_BODY_START);

  return {
    bytes,
    events: track.events.map((event) => ({
      ...event,
      normalizedStart: event.normalizedStart + SYNTHETIC_TRACK_BODY_START,
      normalizedEnd: event.normalizedEnd + SYNTHETIC_TRACK_BODY_START,
    })),
  };
}

function correlateDebug(
  debug: GeneratedTrackEventsDebug,
  events: readonly NormalizedEventMap[],
): CorrelatedTrackEventsDebug {
  const ranges = debug.event.arr.map((range) => ({
    start: range.ioOffset + range.start,
    end: range.ioOffset + range.end,
  }));

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const range = ranges[index];
    if (
      event === undefined ||
      range === undefined ||
      event.normalizedStart !== range.start ||
      event.normalizedEnd !== range.end
    ) {
      throw new Error(`KAITAI_EVENT_OFFSETS: event ${index} does not match debug offsets`);
    }
  }

  return {
    event: {
      start: debug.event.ioOffset + debug.event.start,
      end: debug.event.ioOffset + debug.event.end,
      arr: ranges,
    },
  };
}

export function parseSyntheticTrack(file: SyntheticTrackFile): ParsedTrackTree {
  const stream = new KaitaiStream(
    new DataView(file.bytes.buffer as ArrayBuffer, file.bytes.byteOffset, file.bytes.byteLength),
  );
  const parsed = new StandardMidiFile(stream);
  parsed._read();
  if (parsed.tracks.length !== 1) {
    throw new Error('KAITAI_TRACK_COUNT: expected one synthetic track');
  }

  const track = parsed.tracks[0];
  if (track === undefined) {
    throw new Error('KAITAI_TRACK_COUNT: expected one synthetic track');
  }

  return {
    track,
    debug: correlateDebug(track.events._debug, file.events),
    events: file.events,
  };
}
