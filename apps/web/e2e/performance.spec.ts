import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

import { expect, test } from '@playwright/test';

import { createBenchmarkRecord } from '../src/lib/benchmark.js';
import { fixturePath, openMidiSample, waitForAppReady } from './support/app.js';

test('reports fresh-context sample time to first result-grid paint', async ({ browser, page }, testInfo) => {
  await page.goto('/');
  await waitForAppReady(page);

  const fixture = await readFile(fixturePath('demo.mid'));
  const startedAt = performance.now();
  await openMidiSample(page, { navigate: false });
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  const elapsedMs = performance.now() - startedAt;

  const cpu = cpus();
  const record = createBenchmarkRecord({
    browserVersion: `Chromium ${browser.version()}`,
    os: `${platform()} ${release()} ${arch()}`,
    cpuDescription:
      process.env.BYTEQL_BENCHMARK_CPU ??
      `${cpu[0]?.model === 'unknown' ? `${arch()} runner (model unavailable to Node)` : (cpu[0]?.model ?? `${arch()} runner`)}; ${cpu.length} logical processors`,
    fixtureName: 'demo.mid',
    fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
    fixtureBytes: fixture.byteLength,
    elapsedMs,
  });

  await testInfo.attach('byteql-phase-0-benchmark.json', {
    body: Buffer.from(`${JSON.stringify(record, null, 2)}\n`),
    contentType: 'application/json',
  });
  testInfo.annotations.push({
    type: 'performance-target',
    description: `${record.elapsedMs.toFixed(1)} ms observed; 10000 ms target; targetMet=${record.targetMet}`,
  });
  console.log(`BYTEQL_BENCHMARK ${JSON.stringify(record)}`);

  expect(record.fixture.sha256).toBe('487018c42a265f4a32aeff9ccc0d32295c73ef28eb446f45b5f6c288821d7eea');
  expect(record.elapsedMs).toBeGreaterThan(0);
  expect(record.targetMs).toBe(10_000);
});
