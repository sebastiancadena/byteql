import { expect, test } from '@playwright/test';

import { waitForAppReady } from './support/app.js';

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
}

async function expectBrandLockupProminent(lockup: import('@playwright/test').Locator): Promise<void> {
  const painted = await lockup.evaluate((element) => {
    const image = element.querySelector('img');
    if (!image) throw new Error('Brand lockup image is missing');
    const rect = image.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });

  // The homepage lockup is a hero element, not a cropped favicon — it should render
  // large and square (byteql.svg is a 1024² viewBox shown uncropped).
  expect(painted.width).toBeGreaterThanOrEqual(64);
  expect(Math.abs(painted.width - painted.height)).toBeLessThanOrEqual(2);
}

test('presents the Command Deck identity from intake through the loaded workbench', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  await waitForAppReady(page);

  await expect(page.locator('[data-brand-lockup]').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Query the file. Prove the answer.' })).toBeVisible();
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

  await expect(page.locator('[data-brand-lockup]').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Query the file. Prove the answer.' })).toBeVisible();
  await expect(page.getByLabel('Open file')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Try sample' })).toBeVisible();
  for (const lockup of await page.locator('[data-brand-lockup]').all()) {
    await expectBrandLockupProminent(lockup);
  }
  await expectNoHorizontalOverflow(page);
});

test('keeps the mobile Explorer surface opaque over the loaded workbench', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await waitForAppReady(page);

  await page.getByRole('button', { name: 'Try sample' }).click();
  await expect(page.getByText('Capture map')).toBeVisible();

  await expect(page.getByRole('navigation', { name: 'Data explorer' })).toHaveCSS(
    'background-color',
    'rgb(13, 20, 36)',
  );
});
