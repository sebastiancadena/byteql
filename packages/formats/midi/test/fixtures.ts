function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

export function chunk(id: string, body: Uint8Array): Uint8Array {
  if (id.length !== 4) {
    throw new RangeError('MIDI chunk IDs must contain exactly four characters');
  }

  const bytes = new Uint8Array(8 + body.length);
  for (let index = 0; index < id.length; index += 1) {
    bytes[index] = id.charCodeAt(index);
  }
  new DataView(bytes.buffer).setUint32(4, body.length, false);
  bytes.set(body, 8);
  return bytes;
}

export function midiFile({
  format,
  division,
  tracks,
}: {
  format: number;
  division: number;
  tracks: Uint8Array[];
}): Uint8Array {
  const header = new Uint8Array(6);
  const view = new DataView(header.buffer);
  view.setUint16(0, format, false);
  view.setUint16(2, tracks.length, false);
  view.setUint16(4, division & 0xffff, false);

  return concat([chunk('MThd', header), ...tracks.map((track) => chunk('MTrk', track))]);
}

export interface LargeMidiFixture {
  bytes: Uint8Array;
  eventRowCount: number;
}

// The events table flushes an Arrow record batch every 65_536 rows (see
// packages/core/src/arrow/batch.ts). `pairCount` note_on/note_off pairs (delta 1 tick each) plus one
// end-of-track meta event all land on a single type-0 track; every event, including the end-of-track
// meta, projects to exactly one `events` row, so `eventRowCount` is the exact expected row count.
export function largeMidiFixture(pairCount: number): LargeMidiFixture {
  const noteOn = Uint8Array.of(0x01, 0x90, 60, 100);
  const noteOff = Uint8Array.of(0x01, 0x80, 60, 0);
  const endOfTrack = Uint8Array.of(0x00, 0xff, 0x2f, 0x00);

  const body = new Uint8Array(pairCount * (noteOn.length + noteOff.length) + endOfTrack.length);
  let offset = 0;
  for (let index = 0; index < pairCount; index += 1) {
    body.set(noteOn, offset);
    offset += noteOn.length;
    body.set(noteOff, offset);
    offset += noteOff.length;
  }
  body.set(endOfTrack, offset);

  return { bytes: midiFile({ format: 0, division: 480, tracks: [body] }), eventRowCount: pairCount * 2 + 1 };
}

export function vlq(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new RangeError('MIDI VLQ values must be integers from 0 to 0x0fffffff');
  }

  const bytes = [value & 0x7f];
  let remaining = value >>> 7;
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }

  return Uint8Array.from(bytes);
}
