import { describe, expect, it } from 'vitest';

import { buildSyntheticTrackFile, parseSyntheticTrack } from './kaitai.js';
import { normalizeTrack } from './normalize-track.js';
import type { MidiHeader, TrackChunk } from './types.js';

const header: MidiHeader = {
  format: 1,
  numTracks: 2,
  division: 480,
  divisionMode: 'ppqn',
  range: { start: 0, end: 14 },
};

describe('Kaitai MIDI adapter', () => {
  it('parses normalized running-status events with end-exclusive debug offsets', () => {
    const body = Uint8Array.from([0x00, 0x90, 0x3c, 0x40, 0x00, 0x3e, 0x41]);
    const track: TrackChunk = {
      index: 0,
      chunkStart: 14,
      bodyStart: 22,
      bodyEnd: 22 + body.length,
      body,
    };
    const normalized = normalizeTrack(track);

    expect(normalized.error).toBeUndefined();
    const synthetic = buildSyntheticTrackFile(header, normalized);
    const parsed = parseSyntheticTrack(synthetic);

    expect(parsed.track.events.event).toHaveLength(2);
    expect(
      parsed.track.events.event.map((event) => ({
        eventHeader: event.eventHeader,
        note: event.eventBody.note,
        velocity: event.eventBody.velocity,
      })),
    ).toEqual([
      { eventHeader: 0x90, note: 0x3c, velocity: 0x40 },
      { eventHeader: 0x90, note: 0x3e, velocity: 0x41 },
    ]);
    expect(parsed.debug.event.arr).toEqual([
      { start: 22, end: 26 },
      { start: 26, end: 30 },
    ]);
  });

  it('rejects extra generated debug ranges without normalized event mappings', () => {
    const body = Uint8Array.from([0x00, 0x90, 0x3c, 0x40, 0x00, 0x3e, 0x41]);
    const normalized = normalizeTrack({
      index: 0,
      chunkStart: 14,
      bodyStart: 22,
      bodyEnd: 22 + body.length,
      body,
    });
    const synthetic = buildSyntheticTrackFile(header, normalized);
    synthetic.events = synthetic.events.slice(0, 1);

    expect(() => parseSyntheticTrack(synthetic)).toThrowError(
      'KAITAI_EVENT_OFFSETS: expected 1 event map(s), received 2 debug range(s)',
    );
  });
});
