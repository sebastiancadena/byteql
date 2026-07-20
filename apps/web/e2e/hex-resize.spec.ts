import { expect, test } from '@playwright/test';

// Regression: the hex pane's resize grabber overlaps the toolbar below it (via a
// negative margin). It must stay stacked above that toolbar, otherwise the toolbar
// swallows the pointerdown and drag-to-resize silently does nothing — the cursor
// changes on hover but the pane never moves.
// A taller viewport than the default: at 720p the workspace rows already sit at
// their minimums, so the pane honestly has no room to grow (it no longer fakes
// growth by extending into clipped overflow below the viewport).
test.use({ viewport: { width: 1280, height: 960 } });

test('hex pane resize grabber drags the pane taller', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try sample' }).click();
  await page.getByRole('button', { name: 'Browse events' }).click();
  // Let the grid finish loading so the workbench layout stops shifting under the grabber.
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');

  const pane = page.locator('[data-hex-pane]');
  const handle = page.locator('.hex-resize');
  await expect(handle).toBeVisible();

  // Read the grabber box only once the layout has settled (two identical reads).
  const first = await handle.boundingBox();
  await page.waitForTimeout(400);
  const box = await handle.boundingBox();
  if (!box || !first) throw new Error('resize grabber has no box');
  expect(Math.round(box.y)).toBe(Math.round(first.y));

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // The grabber — not the toolbar beneath it — must be topmost at its own center.
  const topmostClass = await page.evaluate(
    ({ px, py }) => (document.elementFromPoint(px, py) as HTMLElement | null)?.className ?? '',
    { px: x, py: y },
  );
  expect(topmostClass).toContain('hex-resize');

  const before = await pane.evaluate((el) => {
    const rect = (el as HTMLElement).getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  });

  // Drag the top grabber upward → the pane grows.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 50, { steps: 8 });
  await page.mouse.move(x, y - 100, { steps: 8 });
  await page.mouse.up();

  const after = await pane.evaluate((el) => {
    const rect = (el as HTMLElement).getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  });
  expect(after.height).toBeGreaterThan(before.height + 40);
  // The pane must grow UPWARD — its top edge follows the pointer while the results
  // panel above yields the space — not extend downward into clipped overflow.
  expect(after.top).toBeLessThan(before.top - 40);
  // And the grown pane must still fit the viewport (no clipped bottom edge).
  const paneBottom = after.top + after.height;
  const viewport = page.viewportSize();
  expect(paneBottom).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
});
