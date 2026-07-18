import { describe, expect, it } from 'vitest';
import { normalizeTrack } from './index.js';
import type { TrackChunk } from './index.js';

const u8 = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

function trackChunk(bodyStart: number, body: Uint8Array): TrackChunk {
  return {
    index: 0,
    chunkStart: bodyStart - 8,
    bodyStart,
    bodyEnd: bodyStart + body.length,
    body,
  };
}

describe('normalizeTrack', () => {
  it('expands running status and maps both events to original bytes', () => {
    const track = trackChunk(22, u8(0x00, 0x90, 60, 100, 0x81, 0x00, 62, 90));

    const result = normalizeTrack(track);

    expect([...result.bytes]).toEqual([0x00, 0x90, 60, 100, 0x81, 0x00, 0x90, 62, 90]);
    expect(result.events).toEqual([
      {
        index: 0,
        deltaTime: 0,
        normalizedStart: 0,
        normalizedEnd: 4,
        sourceStart: 22,
        sourceEnd: 26,
      },
      {
        index: 1,
        deltaTime: 128,
        normalizedStart: 4,
        normalizedEnd: 9,
        sourceStart: 26,
        sourceEnd: 30,
      },
    ]);
  });

  it('clears running status after a meta event', () => {
    const track = trackChunk(0, u8(0, 0x90, 60, 1, 0, 0xff, 0x01, 0, 0, 61, 1));

    const result = normalizeTrack(track);

    expect(result.error).toMatchObject({ code: 'RUNNING_STATUS_MISSING', offset: 9 });
    expect(result.events).toHaveLength(2);
    expect([...result.bytes]).toEqual([0, 0x90, 60, 1, 0, 0xff, 0x01, 0]);
  });

  it('uses the channel-specific payload lengths for program change and pitch bend', () => {
    const track = trackChunk(40, u8(0, 0xc2, 5, 0, 6, 0, 0xe2, 0x7f, 0x01));

    const result = normalizeTrack(track);

    expect(result.error).toBeUndefined();
    expect([...result.bytes]).toEqual([0, 0xc2, 5, 0, 0xc2, 6, 0, 0xe2, 0x7f, 0x01]);
    expect(result.events).toEqual([
      {
        index: 0,
        deltaTime: 0,
        normalizedStart: 0,
        normalizedEnd: 3,
        sourceStart: 40,
        sourceEnd: 43,
      },
      {
        index: 1,
        deltaTime: 0,
        normalizedStart: 3,
        normalizedEnd: 6,
        sourceStart: 43,
        sourceEnd: 45,
      },
      {
        index: 2,
        deltaTime: 0,
        normalizedStart: 6,
        normalizedEnd: 10,
        sourceStart: 45,
        sourceEnd: 49,
      },
    ]);
  });

  it('preserves a multi-byte meta length and its end-exclusive source range', () => {
    const payload = Uint8Array.from({ length: 128 }, (_, index) => index & 0x7f);
    const body = new Uint8Array([0, 0xff, 0x01, 0x81, 0, ...payload]);

    const result = normalizeTrack(trackChunk(100, body));

    expect(result.error).toBeUndefined();
    expect(result.bytes).toEqual(body);
    expect(result.events).toEqual([
      {
        index: 0,
        deltaTime: 0,
        normalizedStart: 0,
        normalizedEnd: 133,
        sourceStart: 100,
        sourceEnd: 233,
      },
    ]);
  });

  it('preserves SysEx bytes and clears running status', () => {
    const body = u8(0, 0x90, 60, 1, 0, 0xf0, 2, 0x7d, 1, 0, 61, 1);

    const result = normalizeTrack(trackChunk(200, body));

    expect(result.error).toMatchObject({ code: 'RUNNING_STATUS_MISSING', offset: 210 });
    expect([...result.bytes]).toEqual([0, 0x90, 60, 1, 0, 0xf0, 2, 0x7d, 1]);
    expect(result.events[1]).toEqual({
      index: 1,
      deltaTime: 0,
      normalizedStart: 4,
      normalizedEnd: 9,
      sourceStart: 204,
      sourceEnd: 209,
    });
  });

  it('returns a valid prefix when an event payload is truncated', () => {
    const body = u8(0, 0xc0, 5, 0, 0x90, 60);

    const result = normalizeTrack(trackChunk(300, body));

    expect(result.error).toMatchObject({ code: 'TRUNCATED_EVENT', offset: 306 });
    expect([...result.bytes]).toEqual([0, 0xc0, 5]);
    expect(result.events).toEqual([
      {
        index: 0,
        deltaTime: 0,
        normalizedStart: 0,
        normalizedEnd: 3,
        sourceStart: 300,
        sourceEnd: 303,
      },
    ]);
  });

  it('rejects a status-valued channel data byte without retaining the unsafe event', () => {
    const result = normalizeTrack(trackChunk(400, u8(0, 0xc0, 5, 0, 0x90, 60, 0x80)));

    expect(result.error).toMatchObject({ code: 'INVALID_DATA_BYTE', offset: 406 });
    expect([...result.bytes]).toEqual([0, 0xc0, 5]);
    expect(result.events).toHaveLength(1);
  });

  it('rejects unsupported system statuses after the valid normalized prefix', () => {
    const result = normalizeTrack(trackChunk(500, u8(0, 0x90, 60, 1, 0, 0xf1, 2)));

    expect(result.error).toMatchObject({ code: 'UNSUPPORTED_STATUS', offset: 505 });
    expect([...result.bytes]).toEqual([0, 0x90, 60, 1]);
    expect(result.events).toHaveLength(1);
  });
});
