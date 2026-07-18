import { describe, expect, it } from 'vitest';

import { createBenchmarkRecord } from './benchmark.js';

describe('benchmark record', () => {
  it('reports the ten-second target without turning it into a pass/fail gate', () => {
    const record = createBenchmarkRecord({
      browserVersion: 'Chromium 140',
      os: 'Linux arm64',
      cpuDescription: 'Example CPU',
      fixtureName: 'demo.mid',
      fixtureSha256: 'a'.repeat(64),
      fixtureBytes: 98,
      elapsedMs: 10_250.125,
      measuredAt: '2026-07-18T12:00:00.000Z',
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      targetMs: 10_000,
      targetMet: false,
      elapsedMs: 10_250.125,
    });
  });
});
