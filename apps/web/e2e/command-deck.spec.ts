import { expect, test } from '@playwright/test';

import { openMidiSample, waitForAppReady } from './support/app.js';

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
}

async function expectBrandLockupComplete(lockup: import('@playwright/test').Locator): Promise<void> {
  const painted = await lockup.evaluate((element) => {
    const image = element.querySelector('img');
    if (!image) throw new Error('Brand lockup image is missing');
    const rect = image.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });

  // The full card uses a square viewBox with its unused outer canvas trimmed, so the painted
  // image must stay square at the spec's 80 px desktop / 64 px narrow placement.
  expect(painted.width).toBeGreaterThanOrEqual(64);
  expect(Math.abs(painted.width - painted.height)).toBeLessThanOrEqual(2);
}

test('presents the Trace Workspace identity from intake through the loaded workbench', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  await waitForAppReady(page);

  await expect(page.locator('[data-brand-lockup]').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open a binary file.' })).toBeVisible();
  await expect(
    page.getByText('Query its tables with SQL. Select a row to inspect its source bytes.'),
  ).toBeVisible();
  await expect(page.getByText('Files are processed in this browser. Nothing is uploaded.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Explore a sample' })).toBeVisible();

  // The Command Deck slogans and proof cards are gone.
  await expect(page.getByText('Query the file.')).toHaveCount(0);
  await expect(page.getByText('No upload. No server.')).toHaveCount(0);
  await expect(page.getByText('Browser-native binary intelligence')).toHaveCount(0);

  // Exactly one visible file action on the intake screen.
  await expect(page.getByRole('button', { name: 'Open file', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Browse files' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await openMidiSample(page, { navigate: false });
  await expect(page.getByText('Binary file workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide sources' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide values' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('switches appearance from the header and keeps the choice on the root element', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  await waitForAppReady(page);

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Use dark appearance' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await waitForAppReady(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Use light appearance' })).toBeVisible();
});

test('keeps the brand and local intake usable on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await waitForAppReady(page);

  await expect(page.locator('[data-brand-lockup]').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open a binary file.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open file', exact: true })).toBeVisible();
  await expect(page.getByLabel('Open file input')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Try sample' })).toBeVisible();
  for (const lockup of await page.locator('[data-brand-lockup]').all()) {
    await expectBrandLockupComplete(lockup);
  }
  await expectNoHorizontalOverflow(page);
});

test('keeps the narrow source surface opaque over the loaded workbench', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await waitForAppReady(page);

  await openMidiSample(page, { navigate: false });
  // The catalog is a closed drawer at this width; open it before inspecting the surface.
  await page.getByRole('button', { name: 'Show sources', exact: true }).click();

  const surface = page.getByRole('dialog', { name: 'Sources' });
  await expect(surface).toBeVisible();
  const background = await surface.evaluate((element) => getComputedStyle(element).backgroundColor);
  // Opaque: nothing from the workspace beneath may show through.
  expect(background).not.toContain('rgba');
  expect(background).toBe(
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.background = 'var(--color-surface)';
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    }),
  );
});
