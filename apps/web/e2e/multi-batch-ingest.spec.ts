import { Buffer } from 'node:buffer';

import { expect, test } from '@playwright/test';

import { largeMidiFixture } from '../../../packages/formats/midi/test/fixtures.js';
import { runSql, waitForAppReady } from './support/app.js';

// Proves real DuckDB (duckdb-wasm) ingests genuinely multi-batch Arrow IPC end to end: the fixture
// crosses the 65_536-row flush threshold in packages/core/src/arrow/batch.ts, so the parser worker
// hands the `events` table to the browser as >=2 Arrow record batches (see project-midi.test.ts for
// the pack-boundary proof of that). This test proves DuckDB counts every row across those batches
// correctly once ingested through the normal upload path.
test('ingests a multi-batch events table and counts every row via DuckDB', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);

  const { bytes, eventRowCount } = largeMidiFixture(33_000);
  expect(eventRowCount).toBe(66_001);

  await page.getByLabel('Open file').setInputFiles({
    name: 'multi-batch.mid',
    mimeType: 'audio/midi',
    buffer: Buffer.from(bytes),
  });
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();

  await runSql(page, 'select count(*) as n from events');
  await expect(page.locator('.results-heading-meta').getByText('1 rows', { exact: true })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: String(eventRowCount), exact: true })).toBeVisible();
});
