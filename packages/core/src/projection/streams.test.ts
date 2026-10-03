import { describe, expect, it } from 'vitest';
import { StreamAssembler, unwrapOffset } from './streams.js';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('StreamAssembler', () => {
  it('assembles in-order contributions into a contiguous view', () => {
    const a = new StreamAssembler(64);
    expect(a.add(100, bytes(1, 2), 10).status).toBe('added');
    expect(a.add(102, bytes(3), 20).status).toBe('added');
    expect(a.base).toBe(100);
    expect([...a.contiguousView()]).toEqual([1, 2, 3]);
    expect(a.byteCount).toBe(3);
    expect(a.segmentCount).toBe(2);
    expect(a.hasGap()).toBe(false);
  });

  it('reorders an out-of-order later segment', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1), 0);
    expect(a.add(3, bytes(9), 30).status).toBe('added'); // gap 1..3
    expect(a.contiguousEnd).toBe(1);
    expect(a.hasGap()).toBe(true);
    expect(a.add(1, bytes(2, 3), 10).status).toBe('added'); // fills the gap
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 9]);
    expect(a.hasGap()).toBe(false);
  });

  it('rebases downward while nothing is consumed', () => {
    const a = new StreamAssembler(64);
    a.add(10, bytes(3, 4), 30);
    expect(a.add(8, bytes(1, 2), 10).status).toBe('rebased');
    expect(a.base).toBe(8);
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 4]);
  });

  it('trims a below-base prefix once consumed instead of failing', () => {
    const a = new StreamAssembler(64);
    a.add(10, bytes(1, 2), 0);
    a.consume(1);
    expect(a.add(8, bytes(9, 9, 1, 2, 3), 20)).toEqual({
      status: 'added',
      conflicted: false,
      trimmedBelowBase: true,
    });
    expect([...a.contiguousView()]).toEqual([2, 3]);
    expect(a.add(4, bytes(7, 7), 30).status).toBe('dropped');
  });

  it('drops exact and subsumed duplicates, and keeps first bytes on a partial conflict', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1, 2, 3), 0);
    expect(a.add(0, bytes(1, 2, 3), 50)).toEqual({
      status: 'duplicate',
      conflicted: false,
      trimmedBelowBase: false,
    });
    expect(a.add(1, bytes(2), 60).status).toBe('duplicate'); // subsumed
    expect(a.byteCount).toBe(3);
    expect(a.add(2, bytes(9, 4), 70)).toEqual({
      status: 'added',
      conflicted: true,
      trimmedBelowBase: false,
    });
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 4]); // 3 kept, only the new tail stored
    expect(a.segmentsOverlapping(3, 4)).toEqual([{ start: 3, end: 4, srcStart: 71, srcEnd: 72 }]);
  });

  it('stores only the fresh parts of a segment bridging two stored segments', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1), 0);
    a.add(2, bytes(3), 10);
    expect(a.add(0, bytes(1, 2, 3, 4), 20).status).toBe('added');
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
    a.add(0, bytes(1, 2), 0);
    expect(a.add(0, bytes(1, 9), 5)).toEqual({
      status: 'conflict',
      conflicted: true,
      trimmedBelowBase: false,
    });
    expect([...a.contiguousView()]).toEqual([1, 2]);
  });

  it('checks the cap against fresh parts only', () => {
    const a = new StreamAssembler(4);
    a.add(0, bytes(1, 2, 3, 4), 0);
    expect(a.add(0, bytes(1, 2, 3, 4), 9).status).toBe('duplicate'); // no growth, no truncation
    expect(a.add(2, bytes(3, 4, 5), 20).status).toBe('truncated');
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
        );
        const segs = a.segmentsOverlapping(-1e9, 1e9);
        for (let k = 1; k < segs.length; k += 1)
          expect(segs[k]!.start).toBeGreaterThanOrEqual(segs[k - 1]!.end);
      }
    }
  });

  it('reports truncated when a segment would exceed the cap (including via rebase)', () => {
    const a = new StreamAssembler(4);
    expect(a.add(0, bytes(1, 2, 3, 4, 5), 0).status).toBe('truncated');
    const b = new StreamAssembler(4);
    b.add(4, bytes(1, 2), 0);
    expect(b.add(0, bytes(9), 10).status).toBe('truncated'); // extent 0..6 after rebase
  });

  it('consume advances the framing watermark and pendingBytes tracks the remainder', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1, 2, 3, 4), 0);
    a.consume(3);
    expect(a.consumed).toBe(3);
    expect([...a.contiguousView()]).toEqual([4]);
    expect(a.pendingBytes()).toBe(1);
  });

  it('maps a relative range back to its contributing segments and exact source ranges', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1, 2), 100);
    a.add(2, bytes(3, 4), 200);
    a.add(4, bytes(5), 300);
    expect(a.segmentsOverlapping(1, 3).map((s) => s.srcStart)).toEqual([100, 200]);
    expect(a.segmentsOverlapping(0, 5).map((s) => [s.srcStart, s.srcEnd])).toEqual([
      [100, 102],
      [200, 202],
      [300, 301],
    ]);
  });

  it('survives and stays correct with 150k ascending sparse segments', () => {
    const a = new StreamAssembler(1_048_576);
    let lastResult: ReturnType<typeof a.add> | undefined;
    for (let i = 0; i < 150_000; i++) {
      lastResult = a.add(i * 2, bytes(1), i);
    }
    expect(lastResult?.status).toBe('added');
    expect(a.segmentCount).toBe(150_000);
    expect(a.byteCount).toBe(150_000);
    expect(a.highestEnd).toBe(299_999);
    expect(a.hasGap()).toBe(true);
    expect(a.contiguousEnd).toBe(1);
  });

  it('keeps duplicate and overlap detection correct after many appends and a rebase', () => {
    const a = new StreamAssembler(64);
    expect(a.add(10, bytes(1, 2), 0).status).toBe('added'); // [10,12)
    expect(a.add(14, bytes(3), 10).status).toBe('added'); // [14,15)
    expect(a.add(8, bytes(9, 8), 20).status).toBe('rebased'); // [8,10) — rebase, base becomes 8

    // Exact duplicate of the first segment (now stored as absolute [10,12)).
    expect(a.add(10, bytes(1, 2), 99).status).toBe('duplicate');
    // Starts inside [14,15) territory (mismatched, kept) but has a fresh byte at 13.
    expect(a.add(13, bytes(5, 6), 30)).toEqual({
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
    a.add(0, buf, 100);
    buf.fill(0xff);
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 4]);
  });
});

describe('StreamAssembler releases consumed bytes', () => {
  const MIB = 1_048_576;
  const chunk = (index: number, size: number) => {
    const out = new Uint8Array(size);
    out.fill(index & 0xff);
    return out;
  };

  it('reassembles a 3 MiB in-order flow under a 1 MiB cap when every message is consumed', () => {
    const a = new StreamAssembler(MIB);
    const size = 4096;
    const count = (3 * MIB) / size;
    for (let i = 0; i < count; i++) {
      const outcome = a.add(1000 + i * size, chunk(i, size), 50_000 + i * (size + 60));
      expect(outcome.status).toBe('added');
      const view = a.contiguousView();
      expect(view.length).toBe(size);
      expect(view[0]).toBe(i & 0xff);
      const start = a.consumed;
      // Offsets stay relative to the stream origin, not to wherever the buffer was compacted to.
      expect(start).toBe(i * size);
      // The engine's order: consume first, then read the message's provenance.
      a.consume(size);
      expect(a.segmentsOverlapping(start, start + size)).toEqual([
        {
          start,
          end: start + size,
          srcStart: 50_000 + i * (size + 60),
          srcEnd: 50_000 + i * (size + 60) + size,
        },
      ]);
    }
    expect(a.base).toBe(1000);
    expect(a.consumed).toBe(3 * MIB);
    expect(a.contiguousEnd).toBe(3 * MIB);
    expect(a.byteCount).toBe(3 * MIB);
    expect(a.segmentCount).toBe(count);
    expect(a.pendingBytes()).toBe(0);
    expect(a.hasGap()).toBe(false);
  });

  it('still truncates when the unconsumed backlog exceeds the cap after compaction', () => {
    const a = new StreamAssembler(MIB);
    const size = 65_536;
    for (let i = 0; i < 32; i++) {
      expect(a.add(i * size, chunk(i, size), i * size).status).toBe('added');
      a.consume(size);
    }
    // 2 MiB consumed; now a backlog that is never consumed.
    const backlogStart = 32 * size;
    for (let i = 0; i < 16; i++) {
      expect(a.add(backlogStart + i * size, chunk(i, size), 0).status).toBe('added');
    }
    expect(a.pendingBytes()).toBe(MIB);
    expect(a.add(backlogStart + MIB, chunk(0, 1), 0).status).toBe('truncated');
    // A sparse segment far ahead of the consumed point counts against the cap too.
    const b = new StreamAssembler(MIB);
    b.add(0, chunk(0, size), 0);
    b.consume(size);
    expect(b.add(size + MIB - 1, chunk(0, 1), 0).status).toBe('added');
    expect(b.add(size + MIB, chunk(0, 1), 0).status).toBe('truncated');
  });

  it('keeps provenance, overlap reconciliation, and gap tracking identical across compaction', () => {
    // Odd-sized out-of-order segments; the compacted assembler must answer exactly as the
    // stream-relative arithmetic says an uncompacted one would.
    const a = new StreamAssembler(200_000);
    const sizes = [7000, 13_001, 9999, 25_000, 4321, 30_000, 17_777, 8888];
    const starts: number[] = [];
    let cursor = 0;
    for (const size of sizes) {
      starts.push(cursor);
      cursor += size;
    }
    const src = (i: number) => 1_000_000 - i * 40_000; // later stream bytes sit at earlier file offsets
    const add = (i: number) => a.add(500 + starts[i]!, chunk(i, sizes[i]!), src(i));
    // Deliver 0, 2, 1 (out of order), then consume a message that straddles segments 1 and 2.
    add(0);
    add(2);
    expect(a.hasGap()).toBe(true);
    add(1);
    expect(a.hasGap()).toBe(false);
    const message = 7000 + 13_001 + 5000; // ends 5000 bytes into segment 2
    a.consume(message);
    // Segments 3..7, consuming in message-sized steps that never align with segment edges.
    for (let i = 3; i < sizes.length; i++) add(i);
    let consumed = message;
    const step = 11_111;
    while (consumed + step <= cursor) {
      const expected = [] as { start: number; end: number; srcStart: number; srcEnd: number }[];
      for (let i = 0; i < sizes.length; i++) {
        if (starts[i]! < consumed + step && consumed < starts[i]! + sizes[i]!) {
          expected.push({
            start: starts[i]!,
            end: starts[i]! + sizes[i]!,
            srcStart: src(i),
            srcEnd: src(i) + sizes[i]!,
          });
        }
      }
      expect(a.segmentsOverlapping(consumed, consumed + step)).toEqual(expected);
      const view = a.contiguousView();
      const owner = starts.findLastIndex((s) => s <= consumed);
      expect(view[0]).toBe(owner & 0xff);
      a.consume(step);
      consumed += step;
    }
    expect(a.base).toBe(500);
    expect(a.contiguousEnd).toBe(cursor);
    expect(a.pendingBytes()).toBe(cursor - consumed);
    expect(a.segmentCount).toBe(sizes.length);

    // Everything consumed is still inside the maxBuffer history window: a retransmission of
    // early consumed bytes is still compared — identical is a duplicate, different a conflict.
    expect(a.add(500 + starts[1]!, chunk(1, sizes[1]!), 1).status).toBe('duplicate');
    expect(a.add(500 + starts[1]!, chunk(0xee, 10), 1)).toEqual({
      status: 'conflict',
      conflicted: true,
      trimmedBelowBase: false,
    });
    // Bytes below the stream origin are still trimmed and reported as below-base.
    expect(a.add(400, chunk(0, 100), 0)).toEqual({
      status: 'dropped',
      conflicted: false,
      trimmedBelowBase: true,
    });
    // Overlap with retained, unconsumed bytes still reconciles first-bytes-win.
    const tail = 500 + cursor - 4;
    const retransmit = Uint8Array.of(0xee, 0xee, 0xee, 0xee, 1, 2);
    expect(a.add(tail, retransmit, 9)).toEqual({
      status: 'added',
      conflicted: true,
      trimmedBelowBase: false,
    });
    expect(a.contiguousEnd).toBe(cursor + 2);
    expect(a.segmentsOverlapping(cursor, cursor + 2)).toEqual([
      { start: cursor, end: cursor + 2, srcStart: 13, srcEnd: 15 },
    ]);
  });
});

describe('StreamAssembler consumed-history window', () => {
  const window = 32_768;
  const size = 4096;
  const fill = (value: number, length: number) => new Uint8Array(length).fill(value);
  // 400 KiB through a 32 KiB cap, one message per segment, consumed as it arrives.
  const streamThrough = () => {
    const a = new StreamAssembler(window);
    for (let i = 0; i < 100; i++) {
      expect(a.add(i * size, fill(i, size), 1000 + i * size).status).toBe('added');
      a.consume(size);
    }
    return a;
  };
  const total = 100 * size;

  it('keeps the just-consumed message segments for provenance even when compaction is due', () => {
    const a = new StreamAssembler(window);
    for (let i = 0; i < 100; i++) {
      a.add(i * size, fill(i, size), 1000 + i * size);
      const start = a.consumed;
      a.consume(size);
      expect(a.segmentsOverlapping(start, start + size)).toEqual([
        { start, end: start + size, srcStart: 1000 + start, srcEnd: 1000 + start + size },
      ]);
    }
  });

  it('still detects a conflicting retransmission of consumed bytes within the window', () => {
    const a = streamThrough();
    const inWindow = total - window + 8; // consumed, but within maxBuffer of the consumed point
    expect(a.add(inWindow, fill(0xee, 16), 0)).toEqual({
      status: 'conflict',
      conflicted: true,
      trimmedBelowBase: false,
    });
    const owner = Math.floor(inWindow / size);
    expect(a.add(inWindow, fill(owner, 16), 0).status).toBe('duplicate');
  });

  it('reports a retransmission of released bytes beyond the window as below-base, not a duplicate', () => {
    const a = streamThrough();
    a.add(total, fill(1, 1), 0); // compaction is lazy: the next add releases old history
    expect(a.add(0, fill(0, 16), 0)).toEqual({
      status: 'dropped',
      conflicted: false,
      trimmedBelowBase: true,
    });
    expect(a.add(size, fill(0xee, 16), 0)).toEqual({
      status: 'dropped',
      conflicted: false,
      trimmedBelowBase: true,
    });
    // A retransmission straddling the release floor keeps its comparable part.
    // (The floor trails the consumed point by at least the window; it starts above 0.)
    const straddle = a.add(0, fill(0xee, total - window + size), 0);
    expect(straddle.trimmedBelowBase).toBe(true);
    expect(straddle.conflicted).toBe(true);
  });
});

describe('StreamAssembler.anchor', () => {
  it('sets the base without storing bytes', () => {
    const a = new StreamAssembler(64);
    expect(a.anchor(100)).toBe('anchored');
    expect(a.base).toBe(100);
    expect(a.segmentCount).toBe(0);
    expect(a.hasGap()).toBe(false);
  });

  it('makes a missing first segment a gap', () => {
    const a = new StreamAssembler(64);
    a.anchor(100);
    expect(a.add(105, bytes(9), 0).status).toBe('added');
    expect(a.contiguousEnd).toBe(0);
    expect(a.hasGap()).toBe(true);
  });

  it('rebases below unconsumed data, and ignores at-or-above-base and consumed cases', () => {
    const a = new StreamAssembler(64);
    a.add(10, bytes(3, 4), 30);
    expect(a.anchor(8)).toBe('rebased');
    expect(a.base).toBe(8);
    expect(a.hasGap()).toBe(true); // bytes 8..10 never arrived
    expect(a.anchor(12)).toBe('ignored');
    const b = new StreamAssembler(64);
    b.add(10, bytes(1, 2), 0);
    b.consume(1);
    expect(b.anchor(5)).toBe('ignored');
    expect(b.base).toBe(10);
  });

  it('ignores an anchor whose rebase would exceed the cap', () => {
    const a = new StreamAssembler(4);
    a.add(10, bytes(1, 2), 0);
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
