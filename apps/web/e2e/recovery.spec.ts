import { expect, test } from '@playwright/test';

import { fixturePath, openFixture, runSql, waitForAppReady } from './support/app.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
});

test('keeps recoverable rows and exposes the malformed-track error to SQL', async ({ page }) => {
  await openFixture(page, 'malformed-then-valid.mid');
  await expect(page.getByRole('navigation', { name: 'Data explorer' })).toContainText('1 parse diagnostic');
  await expect(page.getByRole('region', { name: 'Tables' })).toContainText(/errors\s*1 rows/u);

  await runSql(page, 'select * from errors');
  await expect(page.locator('.results-heading-meta').getByText('1 rows', { exact: true })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'UNSUPPORTED_STATUS', exact: true })).toBeVisible();

  await runSql(page, 'select from');
  await expect(page.getByRole('alert')).toContainText('Query diagnostic');
  await expect(page.getByRole('gridcell', { name: 'UNSUPPORTED_STATUS', exact: true })).toBeVisible();
});

test('recreates a crashed parser worker and accepts an explicit file retry', async ({ page }) => {
  const initialWorkerCount = await page.evaluate(() => window.__byteqlE2E?.workerCount() ?? -1);
  expect(initialWorkerCount).toBe(1);

  await page.evaluate(() => window.__byteqlE2E?.armParserCrash());
  await page.getByLabel('Open file').setInputFiles(fixturePath('malformed-then-valid.mid'));
  await expect(page.getByRole('alert')).toContainText('worker stopped unexpectedly');
  await expect.poll(() => page.evaluate(() => window.__byteqlE2E?.workerCount() ?? -1)).toBe(2);

  await openFixture(page, 'malformed-then-valid.mid');
  await expect(page.getByRole('navigation', { name: 'Data explorer' })).toContainText('1 parse diagnostic');
});
