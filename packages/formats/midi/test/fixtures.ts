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
