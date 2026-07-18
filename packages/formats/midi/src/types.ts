import type { MidiParseError } from './errors.js';

export interface SourceRange {
  start: number;
  end: number;
}

export interface MidiHeader {
  format: 0 | 1 | 2;
  numTracks: number;
  division: number;
  divisionMode: 'ppqn' | 'smpte';
  range: SourceRange;
}

export interface TrackChunk {
  index: number;
  chunkStart: number;
  bodyStart: number;
  bodyEnd: number;
  body: Uint8Array;
}

export interface MidiContainer {
  header: MidiHeader;
  tracks: TrackChunk[];
}

export interface NormalizedEventMap {
  index: number;
  normalizedStart: number;
  normalizedEnd: number;
  sourceStart: number;
  sourceEnd: number;
  deltaTime: number;
}

export interface NormalizedTrack {
  bytes: Uint8Array;
  events: NormalizedEventMap[];
  error?: MidiParseError;
}
