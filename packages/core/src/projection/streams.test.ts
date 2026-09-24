import { describe, expect, it } from 'vitest';
import { StreamAssembler, unwrapOffset } from './streams.js';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('StreamAssembler', () => {
  it('assembles in-order contributions into a contiguous view', () => {
    const a = new StreamAssembler(64);
    expect(a.add(100, bytes(1, 2), 10, 12).status).toBe('added');
    expect(a.add(102, bytes(3), 20, 21).status).toBe('added');
    expect(a.base).toBe(100);
    expect([...a.contiguousView()]).toEqual([1, 2, 3]);
    expect(a.byteCount).toBe(3);
    expect(a.segmentCount).toBe(2);
    expect(a.hasGap()).toBe(false);
  });

  it('reorders an out-of-order later segment', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1), 0, 1);
    expect(a.add(3, bytes(9), 30, 31).status).toBe('added'); // gap 1..3
    expect(a.contiguousEnd).toBe(1);
    expect(a.hasGap()).toBe(true);
    expect(a.add(1, bytes(2, 3), 10, 12).status).toBe('added'); // fills the gap
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 9]);
    expect(a.hasGap()).toBe(false);
  });

  it('rebases downward while nothing is consumed', () => {
    const a = new StreamAssembler(64);
    a.add(10, bytes(3, 4), 30, 32);
    expect(a.add(8, bytes(1, 2), 10, 12).status).toBe('rebased');
    expect(a.base).toBe(8);
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 4]);
  });

  it('trims a below-base prefix once consumed instead of failing', () => {
    const a = new StreamAssembler(64);
    a.add(10, bytes(1, 2), 0, 2);
    a.consume(1);
    expect(a.add(8, bytes(9, 9, 1, 2, 3), 20, 25)).toEqual({
      status: 'added',
      conflicted: false,
      trimmedBelowBase: true,
    });
    expect([...a.contiguousView()]).toEqual([2, 3]);
    expect(a.add(4, bytes(7, 7), 30, 32).status).toBe('dropped');
  });

  it('drops exact and subsumed duplicates, and keeps first bytes on a partial conflict', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1, 2, 3), 0, 3);
    expect(a.add(0, bytes(1, 2, 3), 50, 53)).toEqual({
      status: 'duplicate',
      conflicted: false,
      trimmedBelowBase: false,
    });
    expect(a.add(1, bytes(2), 60, 61).status).toBe('duplicate'); // subsumed
    expect(a.byteCount).toBe(3);
    expect(a.add(2, bytes(9, 4), 70, 72)).toEqual({
      status: 'added',
      conflicted: true,
      trimmedBelowBase: false,
    });
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 4]); // 3 kept, only the new tail stored
    expect(a.segmentsOverlapping(3, 4)).toEqual([{ start: 3, end: 4, srcStart: 71, srcEnd: 72 }]);
  });

  it('stores only the fresh parts of a segment bridging two stored segments', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1), 0, 1);
    a.add(2, bytes(3), 10, 11);
    expect(a.add(0, bytes(1, 2, 3, 4), 20, 24).status).toBe('added');
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 4]);
    expect(a.segmentsOverlapping(0, 4).map((s) => [s.start, s.end, s.srcStart, s.srcEnd])).toEqual([
      [0, 1, 0, 1],
      [1, 2, 21, 22],
      [2, 3, 10, 11],
      [3, 4, 23, 24],
    ]);
  });

  it('reports a fully covered, different retransmission as a conflict', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1, 2), 0, 2);
    expect(a.add(0, bytes(1, 9), 5, 7)).toEqual({
      status: 'conflict',
      conflicted: true,
      trimmedBelowBase: false,
    });
    expect([...a.contiguousView()]).toEqual([1, 2]);
  });

  it('checks the cap against fresh parts only', () => {
    const a = new StreamAssembler(4);
    a.add(0, bytes(1, 2, 3, 4), 0, 4);
    expect(a.add(0, bytes(1, 2, 3, 4), 9, 13).status).toBe('duplicate'); // no growth, no truncation
    expect(a.add(2, bytes(3, 4, 5), 20, 23).status).toBe('truncated');
  });

  it('never stores overlapping segments (randomized)', () => {
    let seed = 7;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let round = 0; round < 200; round += 1) {
      const a = new StreamAssembler(256);
      for (let i = 0; i < 20; i += 1) {
        const start = rand(64);
        const length = 1 + rand(16);
        a.add(
          start,
          Uint8Array.from({ length }, () => rand(3)),
          1000 + i * 100,
          1000 + i * 100 + length,
        );
        const segs = a.segmentsOverlapping(-1e9, 1e9);
        for (let k = 1; k < segs.length; k += 1)
          expect(segs[k]!.start).toBeGreaterThanOrEqual(segs[k - 1]!.end);
      }
    }
  });

  it('reports truncated when a segment would exceed the cap (including via rebase)', () => {
    const a = new StreamAssembler(4);
    expect(a.add(0, bytes(1, 2, 3, 4, 5), 0, 5).status).toBe('truncated');
    const b = new StreamAssembler(4);
    b.add(4, bytes(1, 2), 0, 2);
    expect(b.add(0, bytes(9), 10, 11).status).toBe('truncated'); // extent 0..6 after rebase
  });

  it('consume advances the framing watermark and pendingBytes tracks the remainder', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1, 2, 3, 4), 0, 4);
    a.consume(3);
    expect(a.consumed).toBe(3);
    expect([...a.contiguousView()]).toEqual([4]);
    expect(a.pendingBytes()).toBe(1);
  });

  it('maps a relative range back to its contributing segments and overall srcSpan', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1, 2), 100, 102);
    a.add(2, bytes(3, 4), 200, 202);
    a.add(4, bytes(5), 300, 301);
    expect(a.segmentsOverlapping(1, 3).map((s) => s.srcStart)).toEqual([100, 200]);
    expect(a.srcSpan).toEqual({ start: 100, end: 301 });
  });

  it('survives and stays correct with 150k ascending sparse segments', () => {
    const a = new StreamAssembler(1_048_576);
    let lastResult: ReturnType<typeof a.add> | undefined;
    for (let i = 0; i < 150_000; i++) {
      lastResult = a.add(i * 2, bytes(1), i, i + 1);
    }
    expect(lastResult?.status).toBe('added');
    expect(a.segmentCount).toBe(150_000);
    expect(a.byteCount).toBe(150_000);
    expect(a.highestEnd).toBe(299_999);
    expect(a.hasGap()).toBe(true);
    expect(a.contiguousEnd).toBe(1);
    expect(a.srcSpan).toEqual({ start: 0, end: 150_000 });
  });

  it('keeps duplicate and overlap detection correct after many appends and a rebase', () => {
    const a = new StreamAssembler(64);
    expect(a.add(10, bytes(1, 2), 0, 2).status).toBe('added'); // [10,12)
    expect(a.add(14, bytes(3), 10, 11).status).toBe('added'); // [14,15)
    expect(a.add(8, bytes(9, 8), 20, 22).status).toBe('rebased'); // [8,10) — rebase, base becomes 8

    // Exact duplicate of the first segment (now stored as absolute [10,12)).
    expect(a.add(10, bytes(1, 2), 99, 99).status).toBe('duplicate');
    // Starts inside [14,15) territory (mismatched, kept) but has a fresh byte at 13.
    expect(a.add(13, bytes(5, 6), 30, 32)).toEqual({
      status: 'added',
      conflicted: true,
      trimmedBelowBase: false,
    });

    // segmentsOverlapping returns ranges relative to the CURRENT base (8).
    expect(a.segmentsOverlapping(0, 100)).toEqual([
      { start: 0, end: 2, srcStart: 20, srcEnd: 22 }, // [8,10) - 8 = [0,2)
      { start: 2, end: 4, srcStart: 0, srcEnd: 2 }, // [10,12) - 8 = [2,4)
      { start: 5, end: 6, srcStart: 30, srcEnd: 31 }, // [13,14) - 8 = [5,6) — the fresh byte, first bytes at 14 kept
      { start: 6, end: 7, srcStart: 10, srcEnd: 11 }, // [14,15) - 8 = [6,7)
    ]);
  });

  it('does not retain the caller buffer: mutating it after add leaves reassembly intact', () => {
    const a = new StreamAssembler(1024);
    const buf = bytes(1, 2, 3, 4);
    a.add(0, buf, 100, 104);
    buf.fill(0xff);
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 4]);
  });
});

describe('StreamAssembler.anchor', () => {
  it('sets the base without storing bytes', () => {
    const a = new StreamAssembler(64);
    expect(a.anchor(100)).toBe('anchored');
    expect(a.base).toBe(100);
    expect(a.segmentCount).toBe(0);
    expect(a.srcSpan).toBeNull();
    expect(a.hasGap()).toBe(false);
  });

  it('makes a missing first segment a gap', () => {
    const a = new StreamAssembler(64);
    a.anchor(100);
    expect(a.add(105, bytes(9), 0, 1).status).toBe('added');
    expect(a.contiguousEnd).toBe(0);
    expect(a.hasGap()).toBe(true);
  });

  it('rebases below unconsumed data, and ignores at-or-above-base and consumed cases', () => {
    const a = new StreamAssembler(64);
    a.add(10, bytes(3, 4), 30, 32);
    expect(a.anchor(8)).toBe('rebased');
    expect(a.base).toBe(8);
    expect(a.hasGap()).toBe(true); // bytes 8..10 never arrived
    expect(a.anchor(12)).toBe('ignored');
    const b = new StreamAssembler(64);
    b.add(10, bytes(1, 2), 0, 2);
    b.consume(1);
    expect(b.anchor(5)).toBe('ignored');
    expect(b.base).toBe(10);
  });

  it('ignores an anchor whose rebase would exceed the cap', () => {
    const a = new StreamAssembler(4);
    a.add(10, bytes(1, 2), 0, 2);
    expect(a.anchor(0)).toBe('ignored');
    expect(a.base).toBe(10);
  });
});

describe('unwrapOffset', () => {
  it('biases the first offset by the modulus', () => {
    expect(unwrapOffset(5, 8, null)).toBe(261);
  });
  it('reduces raw values modulo 2^bits first', () => {
    expect(unwrapOffset(256, 8, null)).toBe(256); // 256 % 256 = 0, + 256
  });
  it('moves forward across a wrap', () => {
    expect(unwrapOffset(2, 8, 256 + 250)).toBe(512 + 2);
  });
  it('moves backward for a pre-wrap retransmission', () => {
    expect(unwrapOffset(250, 8, 512 + 3)).toBe(256 + 250);
  });
  it('stays in the same epoch for nearby offsets', () => {
    expect(unwrapOffset(100, 8, 256 + 90)).toBe(356);
  });
  it('wraps forward at a realistic 32-bit width', () => {
    // reference sits just below a 2^32 epoch boundary (epoch base 2^32, offset 0xffffff00 into
    // it); a raw offset of 0x10 reduces to itself and is far closer to the NEXT epoch
    // (2^32 + 0x10, only 0x110 ahead) than staying in the reference's epoch (0xfffffef0 behind).
    expect(unwrapOffset(0x10, 32, 2 ** 32 + 0xffffff00)).toBe(2 ** 33 + 0x10);
  });
});

import { normalizeRanges } from './streams.js';

describe('normalizeRanges', () => {
  it('sorts by start and keeps gapped pieces', () => {
    expect(
      normalizeRanges([
        { start: 50, end: 60 },
        { start: 10, end: 20 },
      ]),
    ).toEqual([
      { start: 10, end: 20 },
      { start: 50, end: 60 },
    ]);
  });
  it('merges touching and overlapping pieces', () => {
    expect(
      normalizeRanges([
        { start: 10, end: 20 },
        { start: 20, end: 25 },
        { start: 22, end: 30 },
        { start: 40, end: 41 },
      ]),
    ).toEqual([
      { start: 10, end: 30 },
      { start: 40, end: 41 },
    ]);
  });
  it('returns null for a single piece, after merging, and for empty input', () => {
    expect(normalizeRanges([{ start: 1, end: 5 }])).toBeNull();
    expect(
      normalizeRanges([
        { start: 1, end: 5 },
        { start: 5, end: 9 },
      ]),
    ).toBeNull();
    expect(normalizeRanges([])).toBeNull();
  });
  it('drops empty pieces', () => {
    expect(
      normalizeRanges([
        { start: 3, end: 3 },
        { start: 1, end: 2 },
        { start: 5, end: 6 },
      ]),
    ).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ]);
  });
  it('does not mutate its input', () => {
    const input = [
      { start: 20, end: 30 },
      { start: 10, end: 20 },
    ];
    normalizeRanges(input);
    expect(input).toEqual([
      { start: 20, end: 30 },
      { start: 10, end: 20 },
    ]);
  });
});
