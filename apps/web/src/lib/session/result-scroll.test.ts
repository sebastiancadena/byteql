import { describe, expect, it } from 'vitest';

import { resultDemand, scrollCompensation, visibleResultRange } from './result-scroll.js';

describe('visibleResultRange', () => {
  it('uses physical scroll geometry when the virtualizer range is stale', () => {
    expect(visibleResultRange(589_747, 77, 16_384)).toEqual({ firstVisible: 16_381, lastVisible: 16_383 });
  });

  it('clamps an empty or zero-height viewport to the available rows', () => {
    expect(visibleResultRange(10, 0, 4)).toEqual({ firstVisible: 0, lastVisible: 3 });
  });
});

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

  it('requests forward demand when a complete result has later stored rows', () => {
    // A sorted result is complete from the moment it exists, so "complete" can no longer mean
    // "there is nothing after this window".
    expect(
      resultDemand({
        firstVisible: 16_370,
        lastVisible: 16_383,
        windowStart: 0,
        windowRows: 16_384,
        loadedRows: 50_000,
        complete: true,
      }),
    ).toBe('forward');
  });

  it('requests forward demand from an earlier window of an incomplete result', () => {
    expect(
      resultDemand({
        firstVisible: 16_370,
        lastVisible: 16_383,
        windowStart: 0,
        windowRows: 16_384,
        loadedRows: 40_000,
        complete: false,
      }),
    ).toBe('forward');
  });

  it('requests forward demand at the loaded tail of an incomplete result', () => {
    expect(
      resultDemand({
        firstVisible: 16_370,
        lastVisible: 16_383,
        windowStart: 23_616,
        windowRows: 16_384,
        loadedRows: 40_000,
        complete: false,
      }),
    ).toBe('forward');
  });

  it('stops at the final window of a complete result', () => {
    expect(
      resultDemand({
        firstVisible: 16_370,
        lastVisible: 16_383,
        windowStart: 33_616,
        windowRows: 16_384,
        loadedRows: 50_000,
        complete: true,
      }),
    ).toBeNull();
  });

  it('gives the backward edge precedence over the forward edge', () => {
    expect(
      resultDemand({
        firstVisible: 0,
        lastVisible: 16_383,
        windowStart: 20_000,
        windowRows: 16_384,
        loadedRows: 50_000,
        complete: true,
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
