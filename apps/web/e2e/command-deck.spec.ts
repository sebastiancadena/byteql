import { expect, test } from '@playwright/test';

import { waitForAppReady } from './support/app.js';

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

async function expectBrandArtworkContained(mark: import('@playwright/test').Locator): Promise<void> {
  const paintedBounds = await mark.evaluate((element) => {
    const image = element.querySelector('img');
    if (!image) throw new Error('Brand mark image is missing');

    const box = element.getBoundingClientRect();
    const renderedImage = image.getBoundingClientRect();
    // `byteql.svg` has a 1024-square viewBox and painted artwork at x=216..810, y=172..759.
    const scale = renderedImage.width / 1024;
    return {
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      artwork: {
        left: renderedImage.left + 216 * scale,
        top: renderedImage.top + 172 * scale,
        right: renderedImage.left + 810 * scale,
        bottom: renderedImage.top + 759 * scale,
      },
    };
  });

  expect(paintedBounds.artwork.left).toBeGreaterThanOrEqual(paintedBounds.box.left - 0.5);
  expect(paintedBounds.artwork.top).toBeGreaterThanOrEqual(paintedBounds.box.top - 0.5);
  expect(paintedBounds.artwork.right).toBeLessThanOrEqual(paintedBounds.box.right + 0.5);
  expect(paintedBounds.artwork.bottom).toBeLessThanOrEqual(paintedBounds.box.bottom + 0.5);
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
  for (const mark of await page.locator('[data-brand-mark]').all()) {
    await expectBrandArtworkContained(mark);
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
