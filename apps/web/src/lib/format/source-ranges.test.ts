import { describe, expect, it } from 'vitest';

import { sourceRangesCsv, sourceRangesSummary } from './source-ranges.js';

const pieces = (...pairs: Array<[number, number]>) =>
  pairs.map(([s, e]) => ({ start: BigInt(s), end: BigInt(e) }));

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
});
