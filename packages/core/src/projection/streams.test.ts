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
});
