import { describe, expect, it } from 'vitest';

import { sourceRangesCsv, sourceRangesSummary } from './source-ranges.js';

const pieces = (...pairs: Array<[number, number]>) =>
  pairs.map(([s, e]) => ({ start: BigInt(s), end: BigInt(e) }));

/**
 * A `.length`-bearing iterable, like the `Vector` a list column's `.get(row)` returns, that
 * counts how many pieces are actually iterated so we can prove the summary does not format the
 * whole list.
 */
function countingPieces(count: number) {
  let iterated = 0;
  const source = Array.from({ length: count }, (_, i) => ({ start: BigInt(i), end: BigInt(i + 1) }));
  return {
    value: {
      length: count,
      [Symbol.iterator]() {
        const iterator = source[Symbol.iterator]();
        return {
          next: () => {
            iterated += 1;
            return iterator.next();
          },
        };
      },
    },
    iteratedCount: () => iterated,
  };
}

describe('source range text', () => {
  it('renders CSV as start-end pairs joined by semicolons', () => {
    expect(sourceRangesCsv(pieces([10, 20], [50, 60]))).toBe('10-20;50-60');
  });
  it('summarizes up to three pieces and counts the rest', () => {
    expect(sourceRangesSummary(pieces([1, 2], [3, 4]))).toBe('2 ranges · 1-2; 3-4');
    expect(sourceRangesSummary(pieces([1, 2], [3, 4], [5, 6], [7, 8], [9, 10]))).toBe(
      '5 ranges · 1-2; 3-4; 5-6; … +2 more',
    );
  });

  it('formats only the first maxPieces and takes the total from .length when available', () => {
    const { value, iteratedCount } = countingPieces(1_000_000);
    expect(sourceRangesSummary(value)).toBe('1000000 ranges · 0-1; 1-2; 2-3; … +999997 more');
    expect(iteratedCount()).toBeLessThanOrEqual(3);
  });
});
