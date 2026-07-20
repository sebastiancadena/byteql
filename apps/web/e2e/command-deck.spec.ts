import { expect, test } from '@playwright/test';

import { waitForAppReady } from './support/app.js';

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

test('presents the Command Deck identity from intake through the loaded workbench', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  await waitForAppReady(page);

  await expect(page.locator('[data-brand-mark]').first()).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Query the file. Prove the answer.' }),
  ).toBeVisible();
  await expect(page.getByText('No upload. No server.')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'Try sample' }).click();
  await expect(page.getByText('Capture map')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ask the capture' })).toBeVisible();
  await expect(page.getByText('Result set')).toBeVisible();
  await expect(page.getByText('Selected evidence')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('keeps the brand and local intake usable on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await waitForAppReady(page);

  await expect(page.locator('[data-brand-mark]').first()).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Query the file. Prove the answer.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Open file')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Try sample' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
