import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { expect, test } from '@playwright/test';

import { createScaleBenchmarkRecord } from '../src/lib/benchmark.js';
import { generateCapture } from './support/capture.js';
import { runSql, setSessionOverrides, waitForAppReady, type SessionOverrides } from './support/app.js';

// "GB" here means the decimal 1e9 bytes, matching createScaleBenchmarkRecord's own unit choice
// (see the comment there) and the run-scale-bench.mjs `--gb` flag — NOT the binary MiB/GiB used
// for storage-size constants below.
const BYTES_PER_GB = 1e9;
const DEFAULT_TARGET_BYTES = 96 * 1024 * 1024;
// Above a 1 GB (decimal) capture, the parse-time proportional budget becomes report-only — the
// throughput metric is only defined/tuned at the 1 GB baseline (see run-scale-bench.mjs's --gb
// 4 invocation). The read-fraction budget stays meaningful at any scale, so it keeps asserting
// by default; BYTEQL_SCALE_ASSERT_READ opts a >1 GB run back into a hard read-fraction assertion
// explicitly (set by run-scale-bench.mjs's --gb 4 invocation).
const PARSE_TARGET_SCALE_CEILING_BYTES = BYTES_PER_GB;
// 2x CI-noise allowance over the 60,000 ms/GB production target recorded via
// createScaleBenchmarkRecord (which is never loosened — only this spec's hard-fail gate is).
const HARD_FAIL_MS_PER_GB = 120_000;
const READ_FRACTION_TARGET = 0.1;
const CAPTURE_SEED = 7;

// Rotation sized for production-like spill behavior at this scale, not spill-ingest.spec.ts's
// deliberately tiny 256 KiB rotation (chosen there to force multiple chunks out of an 8 MiB
// capture). The pcap projection pipeline's 'packets' Arrow IPC bytes run about 1/10th of raw
// wire bytes (see spill-ingest.spec.ts's derivation of that ratio against the real pipeline), so
// an 8 MiB rotation threshold rolls a handful of realistically-sized parquet chunks across a
// 96 MiB-plus capture — production-like chunk counts and OPFS write overhead, not spill-ingest's
// deliberately pathological many-tiny-chunks case.
const SCALE_OVERRIDES: SessionOverrides = {
  tiering: { tierThresholdBytes: 1024 * 1024, rotationBytes: 8 * 1024 * 1024 },
};

test('scaled capture meets proportional throughput and pushdown read-fraction', async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  // test.slow() triples the 30s default/90s expect budget, which is not enough headroom for a
  // 96 MiB (or larger, per --gb 4) capture end to end; set an explicit budget instead, mirroring
  // spill-ingest.spec.ts's precedent for the same reason.
  test.setTimeout(600_000);

  const target = Number(process.env.BYTEQL_SCALE_BYTES ?? DEFAULT_TARGET_BYTES);
  const assertParseTarget = target <= PARSE_TARGET_SCALE_CEILING_BYTES;
  const assertReadTarget = assertParseTarget || process.env.BYTEQL_SCALE_ASSERT_READ === '1';

  const { bytes, packetCount, seed } = generateCapture(target, CAPTURE_SEED);

  // `setInputFiles`'s in-memory buffer form caps out at 50 MB ("Cannot set buffer larger than
  // 50Mb"); the 96 MiB default (and every --gb 1/4 manual run) exceeds that, so every scale
  // beyond spill-ingest.spec.ts's much smaller fixtures must go through a real file on disk.
  const captureDir = await mkdtemp(join(tmpdir(), 'byteql-scale-'));
  try {
    const capturePath = join(captureDir, 'scale.pcap');
    await writeFile(capturePath, bytes);

    await setSessionOverrides(page, SCALE_OVERRIDES);
    await page.goto('/');
    await waitForAppReady(page);

    const openStartedAt = performance.now();
    await page.getByLabel('Open file').setInputFiles(capturePath);
    await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible({ timeout: 570_000 });
    const parseElapsedMs = performance.now() - openStartedAt;

    await page.evaluate((tables) => window.__byteqlE2E!.enableReadStats(tables), ['packets']);
    const queryStartedAt = performance.now();
    await runSql(page, 'select ts, caplen, len from packets where caplen > 900');
    await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
    const queryElapsedMs = performance.now() - queryStartedAt;
    const stats = await page.evaluate(() => window.__byteqlE2E!.readStats());

    // Denominator is the ORIGINAL raw capture size, not the (much smaller) parquet spill size —
    // this measures how little of the source file's byte budget the pushdown query needed to
    // touch end to end, not just how efficiently it reads back its own spill chunks.
    const fraction = stats.totalBytesRead / bytes.byteLength;

    const cpu = cpus();
    const record = createScaleBenchmarkRecord({
      browserVersion: `Chromium ${browser.version()}`,
      os: `${platform()} ${release()} ${arch()}`,
      cpuDescription:
        process.env.BYTEQL_BENCHMARK_CPU ??
        `${cpu[0]?.model === 'unknown' ? `${arch()} runner (model unavailable to Node)` : (cpu[0]?.model ?? `${arch()} runner`)}; ${cpu.length} logical processors`,
      captureBytes: bytes.byteLength,
      packetCount,
      seed,
      parseElapsedMs,
      queryElapsedMs,
      bytesReadFraction: fraction,
    });

    await testInfo.attach('scale-benchmark.json', {
      body: Buffer.from(`${JSON.stringify(record, null, 2)}\n`),
      contentType: 'application/json',
    });
    const msPerGb = record.parseElapsedMs / (record.capture.bytes / BYTES_PER_GB);
    testInfo.annotations.push({
      type: 'performance-target',
      description:
        `${msPerGb.toFixed(1)} ms/GB parse (target ${record.targetParseMsPerGb}, ` +
        `parseTargetMet=${record.parseTargetMet}); read fraction ${fraction.toFixed(4)} ` +
        `(target < ${READ_FRACTION_TARGET}, readTargetMet=${record.readTargetMet}); ` +
        `spillBytes=${stats.spillBytes}`,
    });
    console.log(`BYTEQL_SCALE_BENCH ${JSON.stringify(record)}`);

    // Manual-bench-only: run-scale-bench.mjs sets this so it can collect the record without
    // parsing Playwright's reporter internals; unset (and this is a no-op) for every normal CI run.
    const outputPath = process.env.BYTEQL_SCALE_BENCH_OUTPUT;
    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    }

    expect(packetCount).toBeGreaterThan(0);
    expect(stats.spillBytes).toBeGreaterThan(0);

    if (assertParseTarget) {
      expect(msPerGb).toBeLessThan(HARD_FAIL_MS_PER_GB);
    }
    if (assertReadTarget) {
      expect(fraction).toBeLessThan(READ_FRACTION_TARGET);
    }
  } finally {
    await rm(captureDir, { recursive: true, force: true });
  }
});
