import { describe, expect, it } from 'vitest';

import { chooseTier, TIER_THRESHOLD_BYTES } from './tiering.js';

describe('chooseTier', () => {
  it('picks memory below the default threshold', () => {
    expect(chooseTier(TIER_THRESHOLD_BYTES - 1)).toBe('memory');
  });

  it('spills at and above the default threshold', () => {
    expect(chooseTier(TIER_THRESHOLD_BYTES)).toBe('spill');
    expect(chooseTier(TIER_THRESHOLD_BYTES + 1)).toBe('spill');
  });

  it('honors a custom threshold override', () => {
    expect(chooseTier(1024, 2048)).toBe('memory');
    expect(chooseTier(2048, 2048)).toBe('spill');
  });
});
