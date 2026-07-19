import { describe, expect, it } from 'vitest';
import { StreamAssembler } from './streams.js';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('StreamAssembler', () => {
  it('assembles in-order contributions into a contiguous view', () => {
    const a = new StreamAssembler(64);
    expect(a.add(100, bytes(1, 2), 10, 12)).toBe('added');
    expect(a.add(102, bytes(3), 20, 21)).toBe('added');
    expect(a.base).toBe(100);
    expect([...a.contiguousView()]).toEqual([1, 2, 3]);
    expect(a.byteCount).toBe(3);
    expect(a.segmentCount).toBe(2);
    expect(a.hasGap()).toBe(false);
  });

  it('reorders an out-of-order later segment', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1), 0, 1);
    expect(a.add(3, bytes(9), 30, 31)).toBe('added'); // gap 1..3
    expect(a.contiguousEnd).toBe(1);
    expect(a.hasGap()).toBe(true);
    expect(a.add(1, bytes(2, 3), 10, 12)).toBe('added'); // fills the gap
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 9]);
    expect(a.hasGap()).toBe(false);
  });

  it('rebases downward while nothing is consumed', () => {
    const a = new StreamAssembler(64);
    a.add(10, bytes(3, 4), 30, 32);
    expect(a.add(8, bytes(1, 2), 10, 12)).toBe('rebased');
    expect(a.base).toBe(8);
    expect([...a.contiguousView()]).toEqual([1, 2, 3, 4]);
  });

  it('rejects a below-base segment once consumed', () => {
    const a = new StreamAssembler(64);
    a.add(10, bytes(1, 2), 0, 2);
    a.consume(1);
    expect(a.add(8, bytes(9, 9), 0, 2)).toBe('below_base');
  });

  it('drops exact duplicates silently and flags partial overlaps', () => {
    const a = new StreamAssembler(64);
    a.add(0, bytes(1, 2, 3), 0, 3);
    expect(a.add(0, bytes(1, 2, 3), 50, 53)).toBe('duplicate');
    expect(a.byteCount).toBe(3);
    expect(a.add(2, bytes(9, 9), 60, 62)).toBe('overlap');
  });

  it('reports truncated when a segment would exceed the cap (including via rebase)', () => {
    const a = new StreamAssembler(4);
    expect(a.add(0, bytes(1, 2, 3, 4, 5), 0, 5)).toBe('truncated');
    const b = new StreamAssembler(4);
    b.add(4, bytes(1, 2), 0, 2);
    expect(b.add(0, bytes(9), 10, 11)).toBe('truncated'); // extent 0..6 after rebase
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
    expect(lastResult).toBe('added');
    expect(a.segmentCount).toBe(150_000);
    expect(a.byteCount).toBe(150_000);
    expect(a.highestEnd).toBe(299_999);
    expect(a.hasGap()).toBe(true);
    expect(a.contiguousEnd).toBe(1);
    expect(a.srcSpan).toEqual({ start: 0, end: 150_000 });
  });

  it('keeps duplicate and overlap detection correct after many appends and a rebase', () => {
    const a = new StreamAssembler(64);
    expect(a.add(10, bytes(1, 2), 0, 2)).toBe('added'); // [10,12)
    expect(a.add(14, bytes(3), 10, 11)).toBe('added'); // [14,15)
    expect(a.add(8, bytes(9, 8), 20, 22)).toBe('rebased'); // [8,10) — rebase, base becomes 8

    // Exact duplicate of the first segment (now stored as absolute [10,12)).
    expect(a.add(10, bytes(1, 2), 99, 99)).toBe('duplicate');
    // Partial overlap: starts inside [14,15) territory but extends past it.
    expect(a.add(13, bytes(5, 6), 30, 32)).toBe('overlap');

    // segmentsOverlapping returns ranges relative to the CURRENT base (8).
    expect(a.segmentsOverlapping(0, 100)).toEqual([
      { start: 0, end: 2, srcStart: 20, srcEnd: 22 }, // [8,10) - 8 = [0,2)
      { start: 2, end: 4, srcStart: 0, srcEnd: 2 }, // [10,12) - 8 = [2,4)
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
