import { expect, test } from '@playwright/test';

import { openMidiSample } from './support/app.js';

// Regression: the inspection dock's resize grabber overlaps the trace strip below it. It must
// stay stacked above that strip, otherwise the strip swallows the pointerdown and
// drag-to-resize silently does nothing — the cursor changes on hover but the dock never moves.
// The dock owns this separator now; `.hex-resize` is kept as its compatibility class.
// A taller viewport than the default: at 720p the workspace rows already sit at their minimums,
// so the dock honestly has no room to grow (it never fakes growth into clipped overflow).
test.use({ viewport: { width: 1280, height: 960 } });

async function settledHandleBox(page: import('@playwright/test').Page) {
  const handle = page.locator('.hex-resize');
  await expect(handle).toBeVisible();
  // Read the grabber box only once the layout has settled (two identical reads).
  const first = await handle.boundingBox();
  await page.waitForTimeout(400);
  const box = await handle.boundingBox();
  if (!box || !first) throw new Error('resize grabber has no box');
  expect(Math.round(box.y)).toBe(Math.round(first.y));
  return box;
}

const dockBox = (page: import('@playwright/test').Page) =>
  page.locator('[data-trace-dock]').evaluate((el) => {
    const rect = (el as HTMLElement).getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  });

test('dock resize grabber drags the inspection dock taller', async ({ page }) => {
  await openMidiSample(page);
  await page.getByRole('button', { name: 'Browse events' }).click();
  // Let the grid finish loading so the workbench layout stops shifting under the grabber.
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');

  const box = await settledHandleBox(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // The grabber — not the strip beneath it — must be topmost at its own center.
  const topmostClass = await page.evaluate(
    ({ px, py }) => (document.elementFromPoint(px, py) as HTMLElement | null)?.className ?? '',
    { px: x, py: y },
  );
  expect(topmostClass).toContain('hex-resize');

  const before = await dockBox(page);

  // Drag the top grabber upward → the dock grows.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 50, { steps: 8 });
  await page.mouse.move(x, y - 100, { steps: 8 });
  await page.mouse.up();

  const after = await dockBox(page);
  expect(after.height).toBeGreaterThan(before.height + 40);
  // The dock must grow UPWARD — its top edge follows the pointer while the results panel above
  // yields the space — not extend downward into clipped overflow.
  expect(after.top).toBeLessThan(before.top - 40);
  // And the grown dock must still fit the viewport (no clipped bottom edge).
  const viewport = page.viewportSize();
  expect(after.top + after.height).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
});

test('dock separator resizes by keyboard, honours its limits, and persists the height', async ({ page }) => {
  await openMidiSample(page);
  await page.getByRole('button', { name: 'Browse events' }).click();
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');

  const separator = page.getByRole('separator', { name: 'Resize inspection' });
  await separator.focus();

  const start = await dockBox(page);
  await separator.press('ArrowUp');
  await separator.press('ArrowUp');
  const grown = await dockBox(page);
  expect(grown.height).toBeGreaterThan(start.height);

  await separator.press('Home');
  const min = await dockBox(page);
  expect(Math.round(min.height)).toBe(Number(await separator.getAttribute('aria-valuemin')));

  await separator.press('End');
  const max = await dockBox(page);
  expect(max.height).toBeGreaterThan(min.height);
  // Results keep their 128 px minimum: the dock never grows past what is above it.
  const resultsHeight = await page
    .locator('.results-panel')
    .evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
  expect(resultsHeight).toBeGreaterThanOrEqual(127);

  // The chosen height survives a reload.
  const chosen = Math.round(max.height);
  await page.reload();
  await openMidiSample(page, { navigate: false });
  expect(Math.round((await dockBox(page)).height)).toBe(chosen);
});

test('collapsing and reopening the dock keeps the row selection and byte caret', async ({ page }) => {
  await openMidiSample(page);
  await page.getByRole('button', { name: 'Browse events' }).click();
  const row = page.getByRole('row', { name: 'Row 3', exact: true });
  await row.click();

  await page.getByLabel('Go to offset').fill('0x10');
  await page.getByLabel('Go to offset').press('Enter');
  const pane = page.locator('[data-hex-pane]');
  await expect(pane).toHaveAttribute('data-hex-caret', '16');
  const highlight = await pane.getAttribute('data-hex-highlight');

  await page.getByRole('button', { name: 'Hide inspection' }).click();
  await expect(page.locator('[data-trace-dock]')).toHaveAttribute('data-dock-collapsed', 'true');
  // The trace strip stays readable while the dock below it is closed.
  await expect(page.getByRole('region', { name: 'Source trace' })).toBeVisible();
  await expect(row).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Show inspection' }).click();
  await expect(page.locator('[data-trace-dock]')).toHaveAttribute('data-dock-collapsed', 'false');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(pane).toHaveAttribute('data-hex-caret', '16');
  await expect(pane).toHaveAttribute('data-hex-highlight', highlight!);
});
