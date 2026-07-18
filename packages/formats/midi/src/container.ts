import { MidiParseError } from './errors.js';
import type { MidiContainer, MidiHeader, TrackChunk } from './types.js';

const HEADER_TAG = [0x4d, 0x54, 0x68, 0x64];
const TRACK_TAG = [0x4d, 0x54, 0x72, 0x6b];

function hasTag(bytes: Uint8Array, offset: number, tag: number[]): boolean {
  return tag.every((byte, index) => bytes[offset + index] === byte);
}

export function parseMidiContainer(bytes: Uint8Array): MidiContainer {
  if (bytes.length < 4) {
    throw new MidiParseError('TRUNCATED_HEADER', 0, 'expected an MThd chunk tag');
  }
  if (!hasTag(bytes, 0, HEADER_TAG)) {
    throw new MidiParseError('INVALID_MAGIC', 0, 'expected an MThd chunk tag');
  }
  if (bytes.length < 8) {
    throw new MidiParseError('TRUNCATED_HEADER', 0, 'expected an MThd chunk length');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4, false);
  if (headerLength < 6) {
    throw new MidiParseError(
      'UNSUPPORTED_HEADER_LENGTH',
      4,
      `expected at least 6 header bytes, received ${headerLength}`,
    );
  }

  const headerEnd = 8 + headerLength;
  if (headerEnd > bytes.length) {
    throw new MidiParseError(
      'TRUNCATED_HEADER',
      8,
      `declared ${headerLength} header bytes but only ${bytes.length - 8} remain`,
    );
  }

  const format = view.getUint16(8, false) as MidiHeader['format'];
  const numTracks = view.getUint16(10, false);
  const division = view.getInt16(12, false);
  const header: MidiHeader = {
    format,
    numTracks,
    division,
    divisionMode: division < 0 ? 'smpte' : 'ppqn',
    range: { start: 0, end: headerEnd },
  };

  const tracks: TrackChunk[] = [];
  let chunkStart = headerEnd;
  for (let index = 0; index < numTracks; index += 1) {
    if (bytes.length - chunkStart < 8 || !hasTag(bytes, chunkStart, TRACK_TAG)) {
      throw new MidiParseError(
        'MISSING_TRACK',
        chunkStart,
        `expected MTrk chunk ${index + 1} of ${numTracks}`,
      );
    }

    const bodyLength = view.getUint32(chunkStart + 4, false);
    const bodyStart = chunkStart + 8;
    const bodyEnd = bodyStart + bodyLength;
    if (bodyEnd > bytes.length) {
      throw new MidiParseError(
        'TRUNCATED_TRACK',
        bodyStart,
        `declared ${bodyLength} track bytes but only ${bytes.length - bodyStart} remain`,
      );
    }

    tracks.push({
      index,
      chunkStart,
      bodyStart,
      bodyEnd,
      body: bytes.slice(bodyStart, bodyEnd),
    });
    chunkStart = bodyEnd;
  }

  return { header, tracks };
}
