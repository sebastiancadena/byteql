import { expect, test } from '@playwright/test';

import { openMidiSample } from './support/app.js';

// Regression: the inspection divider used to overlap the chrome next to it, which swallowed the
// pointerdown and made drag-to-resize silently do nothing — the cursor changed on hover but the
// dock never moved. The divider now lives in the workspace, in a track of its own between
// Results and the dock; `.hex-resize` is kept as its compatibility class. It must still be the
// topmost element at its own centre, and must still not overlap either neighbour.
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

  // The grabber — not the chrome around it — must be topmost at its own center.
  const topmostClass = await page.evaluate(
    ({ px, py }) => (document.elementFromPoint(px, py) as HTMLElement | null)?.className ?? '',
    { px: x, py: y },
  );
  expect(topmostClass).toContain('hex-resize');

  const before = await dockBox(page);

  // Its track is its own: it sits under Results and over the dock, overlapping neither.
  const resultsBottom = await page
    .locator('.results-panel')
    .evaluate((el) => (el as HTMLElement).getBoundingClientRect().bottom);
  expect(box.y).toBeGreaterThanOrEqual(resultsBottom - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(before.top + 1);

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

/**
 * The grid tracks and the numeric solution are two descriptions of the same layout, and only a
 * real browser can tell whether they still agree. A track the solver does not charge for — a
 * missed gutter, a row that swallowed the notices, a header sized differently from its
 * measurement — shows up here and nowhere else in the suite.
 */
const solvedAgainstRendered = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const height = (selector: string) =>
      (document.querySelector(selector) as HTMLElement).getBoundingClientRect().height;
    const workspace = document.querySelector('.sql-workspace') as HTMLElement;
    const main = document.querySelector('.workbench-main') as HTMLElement;
    const token = (name: string) =>
      Number.parseFloat(globalThis.getComputedStyle(workspace).getPropertyValue(name));
    const query = token('--query-height');
    const dock = token('--dock-height');
    // Chrome as the SOLVER charges it: one measured divider track, counted once for the query
    // divider and once for the expanded dock's. Measuring the rendered inspection track instead
    // would make this sum self-consistent and blind to a track the grid forgot to lay out.
    const gutter = height('.query-resize-slot');
    const chrome =
      height('.editor-heading') + height('.query-notices') + height('.results-heading') + 2 * gutter;
    return {
      query: { solved: query, rendered: height('.sql-editor') },
      dock: { solved: dock, rendered: height('[data-trace-dock]') },
      results: { solved: main.clientHeight - chrome - query - dock, rendered: height('.results-panel') },
    };
  });

test('the rendered panes match the solved vertical budget, at rest and after a drag', async ({ page }) => {
  await openMidiSample(page);
  await page.getByRole('button', { name: 'Browse events' }).click();
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');

  const agrees = (panes: Awaited<ReturnType<typeof solvedAgainstRendered>>) => {
    for (const [name, pane] of Object.entries(panes)) {
      expect(Math.abs(pane.rendered - pane.solved), `${name} is off the solved budget`).toBeLessThanOrEqual(
        1,
      );
    }
  };

  const before = await solvedAgainstRendered(page);
  expect(before.results.rendered).toBeGreaterThanOrEqual(128);
  agrees(before);

  const handle = page.getByRole('separator', { name: 'Resize query', exact: true });
  const box = await handle.boundingBox();
  if (!box) throw new Error('query divider has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 60, { steps: 8 });
  await page.mouse.up();

  // Dragging the query divider down 60 px must take exactly those pixels from Results, leaving
  // the dock alone — and the grid must still render what the solver decided.
  await expect
    .poll(async () => Math.round((await solvedAgainstRendered(page)).query.rendered - before.query.rendered))
    .toBe(60);
  const after = await solvedAgainstRendered(page);
  agrees(after);
  expect(Math.abs(after.results.rendered - (before.results.rendered - 60))).toBeLessThanOrEqual(1);
  expect(Math.abs(after.dock.rendered - before.dock.rendered)).toBeLessThanOrEqual(1);
});
