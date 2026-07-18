import { expect, test } from '@playwright/test';

import { openAudioViewer, openFixture, waitForAppReady } from './support/app.js';

test('loads and disposes the audio capability through the application boundary', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
  await page.getByRole('button', { name: 'Try sample' }).click();
  await page.getByRole('button', { name: 'Play all notes' }).click();
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('columnheader', { name: /seconds/u })).toBeVisible();

  await openAudioViewer(page);
  await expect.poll(() => page.evaluate(() => window.__byteqlE2E?.audioStats().loadCalls ?? -1)).toBe(1);
  expect(await page.evaluate(() => window.__byteqlE2E?.audioStats().loadedRows ?? -1)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Close audio viewer' }).click();
  await expect.poll(() => page.evaluate(() => window.__byteqlE2E?.audioStats().disposeCalls ?? -1)).toBe(1);
});

test('applies tempo events from every track to playback seconds', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
  await openFixture(page, 'tempo-second-track.mid');
  await page.getByRole('button', { name: 'Play all notes' }).click();
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('columnheader', { name: /seconds/u })).toBeVisible();

  // Track 1 declares 1,000,000 µs/quarter, so the 480-tick note-off ends at
  // exactly 1 second. 0.5 would mean the 500,000 µs default was used instead.
  await expect(page.getByRole('gridcell', { name: '1', exact: true })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: '0.5', exact: true })).toHaveCount(0);
});
