import { describe, expect, it } from 'vitest';

import { createBenchmarkRecord, createScaleBenchmarkRecord } from './benchmark.js';

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

const GB = 1e9; // decimal GB, matching createScaleBenchmarkRecord's BYTES_PER_GB.

describe('scale benchmark record', () => {
  it('reports both targets met for a proportionally fast, low-read-fraction run', () => {
    const record = createScaleBenchmarkRecord({
      browserVersion: 'Chromium 140',
      os: 'Linux arm64',
      cpuDescription: 'Example CPU',
      captureBytes: GB / 10, // 0.1 GB
      packetCount: 12_345,
      seed: 7,
      parseElapsedMs: 5_000, // 50,000 ms/GB, under the 60,000 target
      queryElapsedMs: 40,
      bytesReadFraction: 0.05,
      measuredAt: '2026-07-19T12:00:00.000Z',
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      measuredAt: '2026-07-19T12:00:00.000Z',
      capture: { bytes: GB / 10, packetCount: 12_345, seed: 7 },
      parseElapsedMs: 5_000,
      queryElapsedMs: 40,
      bytesReadFraction: 0.05,
      targetParseMsPerGb: 60_000,
      parseTargetMet: true,
      readTargetMet: true,
    });
  });

  it('reports both targets missed for a proportionally slow, high-read-fraction run', () => {
    const record = createScaleBenchmarkRecord({
      browserVersion: 'Chromium 140',
      os: 'Linux arm64',
      cpuDescription: 'Example CPU',
      captureBytes: GB / 10, // 0.1 GB
      packetCount: 12_345,
      seed: 7,
      parseElapsedMs: 7_000, // 70,000 ms/GB, over the 60,000 target
      queryElapsedMs: 40,
      bytesReadFraction: 0.42,
      measuredAt: '2026-07-19T12:00:00.000Z',
    });

    expect(record.parseTargetMet).toBe(false);
    expect(record.readTargetMet).toBe(false);
  });

  it('treats a null read fraction as an unmet read target, not a pass', () => {
    const record = createScaleBenchmarkRecord({
      browserVersion: 'Chromium 140',
      os: 'Linux arm64',
      cpuDescription: 'Example CPU',
      captureBytes: GB / 10,
      packetCount: 12_345,
      seed: 7,
      parseElapsedMs: 5_000,
      queryElapsedMs: 40,
      bytesReadFraction: null,
      measuredAt: '2026-07-19T12:00:00.000Z',
    });

    expect(record.bytesReadFraction).toBeNull();
    expect(record.readTargetMet).toBe(false);
    expect(record.parseTargetMet).toBe(true);
  });
});
