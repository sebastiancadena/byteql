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

export interface ScaleBenchmarkInput {
  browserVersion: string;
  os: string;
  cpuDescription: string;
  captureBytes: number;
  packetCount: number;
  seed: number;
  parseElapsedMs: number;
  queryElapsedMs: number;
  /** `null` when read-stats collection was unavailable/skipped for this run (report, don't fake a pass). */
  bytesReadFraction: number | null;
  measuredAt?: string;
}

export interface ScaleBenchmarkRecord {
  schemaVersion: 1;
  measuredAt: string;
  browserVersion: string;
  os: string;
  cpuDescription: string;
  capture: {
    bytes: number;
    packetCount: number;
    seed: number;
  };
  parseElapsedMs: number;
  queryElapsedMs: number;
  bytesReadFraction: number | null;
  targetParseMsPerGb: 60_000;
  parseTargetMet: boolean;
  readTargetMet: boolean;
}

// "GB" here means the decimal 1e9 bytes, matching the Task 12 brief's literal throughput formula
// (`parseElapsedMs / (bytes / 1e9)`) and the scale spec's/run-scale-bench.mjs's `--gb` flag —
// distinct from the binary MiB/GiB units used for storage-size constants elsewhere in this
// codebase (tierThresholdBytes, rotationBytes, the 96 MiB scale-spec default byte count, etc.).
const BYTES_PER_GB = 1e9;
const TARGET_PARSE_MS_PER_GB = 60_000 as const;
// Matches the scale spec's `expect(fraction).toBeLessThan(0.10)` pushdown assertion.
const READ_FRACTION_TARGET = 0.1;

export function createScaleBenchmarkRecord(input: ScaleBenchmarkInput): ScaleBenchmarkRecord {
  const gb = input.captureBytes / BYTES_PER_GB;
  const parseMsPerGb = gb > 0 ? input.parseElapsedMs / gb : input.parseElapsedMs;
  return {
    schemaVersion: 1,
    measuredAt: input.measuredAt ?? new Date().toISOString(),
    browserVersion: input.browserVersion,
    os: input.os,
    cpuDescription: input.cpuDescription,
    capture: {
      bytes: input.captureBytes,
      packetCount: input.packetCount,
      seed: input.seed,
    },
    parseElapsedMs: input.parseElapsedMs,
    queryElapsedMs: input.queryElapsedMs,
    bytesReadFraction: input.bytesReadFraction,
    targetParseMsPerGb: TARGET_PARSE_MS_PER_GB,
    parseTargetMet: parseMsPerGb < TARGET_PARSE_MS_PER_GB,
    // A null fraction means "not measured" — that is never a pass, only a measured value under
    // the target counts as met.
    readTargetMet: input.bytesReadFraction !== null && input.bytesReadFraction < READ_FRACTION_TARGET,
  };
}
