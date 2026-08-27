import { describe, expect, it } from 'vitest';

import { resultDemand, scrollCompensation } from './result-scroll.js';

describe('resultDemand', () => {
  it('requests forward demand within eight rows of the window tail', () => {
    expect(
      resultDemand({
        firstVisible: 16_360,
        lastVisible: 16_380,
        windowStart: 0,
        windowRows: 16_384,
        loadedRows: 16_384,
        complete: false,
      }),
    ).toBe('forward');
  });

  it('requests backward demand near an evicted window head', () => {
    expect(
      resultDemand({
        firstVisible: 2,
        lastVisible: 20,
        windowStart: 20_000,
        windowRows: 16_384,
        loadedRows: 40_000,
        complete: false,
      }),
    ).toBe('backward');
  });

  it('does not request forward demand at EOF or away from either edge', () => {
    expect(
      resultDemand({
        firstVisible: 90,
        lastVisible: 99,
        windowStart: 0,
        windowRows: 100,
        loadedRows: 100,
        complete: true,
      }),
    ).toBeNull();
    expect(
      resultDemand({
        firstVisible: 100,
        lastVisible: 120,
        windowStart: 20_000,
        windowRows: 16_384,
        loadedRows: 40_000,
        complete: false,
      }),
    ).toBeNull();
  });
});

describe('scrollCompensation', () => {
  it('returns the signed pixel adjustment from window starts alone', () => {
    expect(scrollCompensation(0, 8_192, 36)).toBe(-294_912);
    expect(scrollCompensation(8_192, 0, 36)).toBe(294_912);
    expect(scrollCompensation(8_192, 8_192, 36)).toBe(0);
  });
});
