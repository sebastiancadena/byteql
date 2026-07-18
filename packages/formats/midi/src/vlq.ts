import { MidiParseError } from './errors.js';

export interface DecodedVlq {
  value: number;
  next: number;
}

export function decodeVlq(bytes: Uint8Array, offset: number): DecodedVlq {
  const start = offset;
  let value = 0;

  for (let length = 0; length < 4; length += 1) {
    const byte = bytes[offset];
    if (byte === undefined) {
      throw new MidiParseError('VLQ_TRUNCATED', start, 'expected another VLQ byte');
    }

    value = (value << 7) | (byte & 0x7f);
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { value, next: offset };
    }
  }

  throw new MidiParseError('VLQ_TOO_LONG', start, 'MIDI VLQs may contain at most four bytes');
}
