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
