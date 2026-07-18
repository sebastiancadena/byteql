export interface BenchmarkInput {
  browserVersion: string;
  os: string;
  cpuDescription: string;
  fixtureName: string;
  fixtureSha256: string;
  fixtureBytes: number;
  elapsedMs: number;
  measuredAt?: string;
}

export interface BenchmarkRecord {
  schemaVersion: 1;
  measuredAt: string;
  browserVersion: string;
  os: string;
  cpuDescription: string;
  fixture: {
    name: string;
    sha256: string;
    uncompressedBytes: number;
  };
  elapsedMs: number;
  targetMs: 10_000;
  targetMet: boolean;
}

export function createBenchmarkRecord(input: BenchmarkInput): BenchmarkRecord {
  const targetMs = 10_000 as const;
  return {
    schemaVersion: 1,
    measuredAt: input.measuredAt ?? new Date().toISOString(),
    browserVersion: input.browserVersion,
    os: input.os,
    cpuDescription: input.cpuDescription,
    fixture: {
      name: input.fixtureName,
      sha256: input.fixtureSha256,
      uncompressedBytes: input.fixtureBytes,
    },
    elapsedMs: input.elapsedMs,
    targetMs,
    targetMet: input.elapsedMs < targetMs,
  };
}
