import { expect, test } from '@playwright/test';

import { spillProbe, waitForAppReady } from './support/app.js';

test('duckdb-wasm supports the OPFS Parquet spill path', async ({ page }, testInfo) => {
  await page.goto('/');
  await waitForAppReady(page);
  const report = await spillProbe(page);
  await testInfo.attach('spill-probe.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(report.opfsAvailable).toBe(true);
  expect(report.copyToOpfs).toBe(true);
  expect(report.parquetScanGlob).toBe(true);
  // allowedDirectories / fileStatistics are REPORTED, not asserted — they pick the rung.
});
