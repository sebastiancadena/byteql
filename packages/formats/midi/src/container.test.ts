import { describe, expect, it } from 'vitest';
import { chunk, midiFile, vlq } from '../test/fixtures.js';
import { decodeVlq, MidiParseError, parseMidiContainer } from './index.js';

const u8 = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

describe('parseMidiContainer', () => {
  it('frames two tracks with absolute source offsets', () => {
    const bytes = midiFile({
      format: 1,
      division: 480,
      tracks: [u8(0, 0xff, 0x2f, 0), u8(0, 0xff, 0x2f, 0)],
    });

    const parsed = parseMidiContainer(bytes);

    expect(parsed.header).toEqual({
      format: 1,
      numTracks: 2,
      division: 480,
      divisionMode: 'ppqn',
      range: { start: 0, end: 14 },
    });
    expect(parsed.tracks.map((track) => [track.bodyStart, track.bodyEnd])).toEqual([
      [22, 26],
      [34, 38],
    ]);
    expect(parsed.tracks[1]).toMatchObject({ index: 1, chunkStart: 26 });
    expect([...parsed.tracks[0]!.body]).toEqual([0, 0xff, 0x2f, 0]);
  });

  it('retains a signed SMPTE division', () => {
    const parsed = parseMidiContainer(
      midiFile({ format: 0, division: -6360, tracks: [u8(0, 0xff, 0x2f, 0)] }),
    );

    expect(parsed.header).toMatchObject({ division: -6360, divisionMode: 'smpte' });
  });

  it('accepts a header body longer than six bytes', () => {
    const headerBody = u8(0, 0, 0, 1, 1, 224, 0, 0);
    const bytes = new Uint8Array([...chunk('MThd', headerBody), ...chunk('MTrk', u8(0, 0xff, 0x2f, 0))]);

    const parsed = parseMidiContainer(bytes);

    expect(parsed.header.range).toEqual({ start: 0, end: 16 });
    expect(parsed.tracks[0]).toMatchObject({ chunkStart: 16, bodyStart: 24, bodyEnd: 28 });
  });

  it.each([
    ['an invalid header tag', chunk('NOPE', u8(0, 0, 0, 0, 0, 0)), 'INVALID_MAGIC', 0],
    ['a truncated header prefix', u8(0x4d, 0x54, 0x68), 'TRUNCATED_HEADER', 0],
    [
      'a header body shorter than six bytes',
      chunk('MThd', u8(0, 0, 0, 0, 0)),
      'UNSUPPORTED_HEADER_LENGTH',
      4,
    ],
  ])('rejects %s', (_label, bytes, code, offset) => {
    expect(() => parseMidiContainer(bytes)).toThrowError(new RegExp(`${code}.*offset ${offset}`));
  });

  it('rejects a header whose declared body is truncated', () => {
    const bytes = chunk('MThd', u8(0, 0, 0, 1, 1, 224)).slice(0, 12);

    expect(() => parseMidiContainer(bytes)).toThrowError(/TRUNCATED_HEADER.*offset 8/);
  });

  it('rejects a missing declared track', () => {
    const headerBody = u8(0, 1, 0, 2, 1, 224);
    const bytes = new Uint8Array([...chunk('MThd', headerBody), ...chunk('MTrk', u8(0, 0xff, 0x2f, 0))]);

    expect(() => parseMidiContainer(bytes)).toThrowError(/MISSING_TRACK.*offset 26/);
  });

  it('rejects a non-track chunk where a declared track is expected', () => {
    const bytes = new Uint8Array([...chunk('MThd', u8(0, 0, 0, 1, 1, 224)), ...chunk('JUNK', u8())]);

    expect(() => parseMidiContainer(bytes)).toThrowError(/MISSING_TRACK.*offset 14/);
  });

  it('rejects a track whose declared body is truncated', () => {
    const bytes = midiFile({ format: 0, division: 480, tracks: [u8(0, 0xff, 0x2f, 0)] });
    new DataView(bytes.buffer).setUint32(18, 5, false);

    expect(() => parseMidiContainer(bytes)).toThrowError(/TRUNCATED_TRACK.*offset 22/);
  });

  it('throws structured parse errors', () => {
    try {
      parseMidiContainer(u8());
      expect.unreachable('expected parsing to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(MidiParseError);
      expect(error).toMatchObject({ code: 'TRUNCATED_HEADER', offset: 0 });
    }
  });
});

describe('decodeVlq', () => {
  it.each([
    [0, [0]],
    [127, [0x7f]],
    [128, [0x81, 0]],
    [0x0fffffff, [0xff, 0xff, 0xff, 0x7f]],
  ])('decodes %i', (value, encoded) => {
    const bytes = u8(0xee, ...encoded, 0xee);

    expect(decodeVlq(bytes, 1)).toEqual({ value, next: encoded.length + 1 });
    expect([...vlq(value)]).toEqual(encoded);
  });

  it('rejects a truncated MIDI VLQ at its first byte', () => {
    expect(() => decodeVlq(u8(0, 0x81), 1)).toThrowError(/VLQ_TRUNCATED.*offset 1/);
  });

  it('rejects a five-byte MIDI VLQ at its first byte', () => {
    expect(() => decodeVlq(u8(0x81, 0x80, 0x80, 0x80, 0), 0)).toThrowError(/VLQ_TOO_LONG.*offset 0/);
  });
});
