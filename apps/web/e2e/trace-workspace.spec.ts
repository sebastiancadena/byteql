import { expect, test } from '@playwright/test';

import { openMidiSample, runSql, waitForAppReady } from './support/app.js';

test.use({ viewport: { width: 1440, height: 900 } });

test('results span the workspace and the dock sits beneath them', async ({ page }) => {
  await openMidiSample(page);
  await page.getByRole('button', { name: 'Browse events' }).click();
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();

  const workspace = await page
    .locator('.sql-workspace')
    .evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
  const grid = await page
    .locator('.grid-scroll')
    .evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);

  // No inspector column stealing width: the grid fills the workspace.
  expect(grid).toBeGreaterThan(workspace - 2);

  const results = await page
    .locator('.results-panel')
    .evaluate((el) => (el as HTMLElement).getBoundingClientRect());
  const dock = await page
    .locator('[data-trace-dock]')
    .evaluate((el) => (el as HTMLElement).getBoundingClientRect());
  expect(dock.top).toBeGreaterThanOrEqual(results.bottom - 1);

  // Values sit beside Bytes inside the dock, not in a separate column.
  const values = await page
    .locator('.trace-values')
    .evaluate((el) => (el as HTMLElement).getBoundingClientRect());
  const bytes = await page
    .locator('.trace-bytes')
    .evaluate((el) => (el as HTMLElement).getBoundingClientRect());
  expect(values.left).toBeGreaterThanOrEqual(dock.left - 1);
  expect(bytes.left).toBeGreaterThanOrEqual(values.right - 1);
  expect(Math.round(values.width)).toBe(256);
});

test('long source names truncate instead of giving the catalog its own scrollbar', async ({ page }) => {
  await openMidiSample(page);

  const catalog = await page.locator('.explorer').evaluate((el) => ({
    scrollWidth: (el as HTMLElement).scrollWidth,
    clientWidth: (el as HTMLElement).clientWidth,
  }));
  expect(catalog.scrollWidth).toBeLessThanOrEqual(catalog.clientWidth);

  // The "Viewing bytes" marker stays inside the row rather than being pushed out of view.
  const row = page.locator('.source-row').first();
  await expect(row).toContainText('Viewing bytes');
  const fits = await row.evaluate((el) => {
    const marker = el.querySelector('.source-current')!.getBoundingClientRect();
    return marker.right <= el.getBoundingClientRect().right + 1;
  });
  expect(fits).toBe(true);
});

test('the trace strip states the row, file and inclusive range, and inspects the source', async ({
  page,
}) => {
  await openMidiSample(page);
  await page.getByRole('button', { name: 'Browse events' }).click();

  const strip = page.getByRole('region', { name: 'Source trace' });
  await expect(strip).toHaveAttribute('data-trace-state', 'unselected');
  await expect(strip).toContainText('Select a row to trace its source bytes.');

  await page.getByRole('row', { name: 'Row 3', exact: true }).click();
  await expect(strip).toHaveAttribute('data-trace-state', 'linked');
  await expect(strip).toContainText('Row 3');
  await expect(strip).toContainText('fur_Elise_opening.mid');

  const label = (await strip.locator('.trace-range').textContent())!;
  // Lowercase hex, at least eight digits, and the byte count.
  expect(label).toMatch(/^0x[\da-f]{8,}–0x[\da-f]{8,} · \d+ bytes$/u);

  // The range shown is the last included byte, one before the exclusive end.
  const highlight = (await page.locator('[data-hex-pane]').getAttribute('data-hex-highlight'))!;
  const [start, end] = highlight.split('-').map(Number);
  expect(label.startsWith(`0x${start!.toString(16).padStart(8, '0')}`)).toBe(true);
  expect(label).toContain(`0x${(end! - 1).toString(16).padStart(8, '0')}`);
  expect(label).toContain(`· ${end! - start!} bytes`);

  await page.getByRole('button', { name: 'Inspect source' }).click();
  // Inspecting focuses the byte viewport, so the bytes can be navigated straight away.
  await expect(page.getByRole('application', { name: 'Hex viewer' })).toBeFocused();
});

test('an aggregate row states it has no source range and offers no reveal', async ({ page }) => {
  await openMidiSample(page);
  await runSql(page, 'select count(*) as n from events');
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();

  const strip = page.getByRole('region', { name: 'Source trace' });
  await expect(strip).toHaveAttribute('data-trace-state', 'unlinked');
  await expect(strip).toContainText('This row has no source byte range.');
  await expect(page.getByRole('button', { name: 'Inspect source' })).toHaveCount(0);
  // No stale highlight borrowed from the previous result.
  await expect(page.locator('[data-hex-pane]')).toHaveAttribute('data-hex-highlight', '');
});

test.describe('responsive composition', () => {
  test('narrow source drawer returns focus and does not cover results by default', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMidiSample(page);

    const opener = page.getByRole('button', { name: 'Show sources', exact: true });
    // Never cover the work surface with a drawer nobody asked for.
    await expect(page.getByRole('dialog', { name: 'Sources' })).toBeHidden();
    await expect(page.getByRole('grid', { name: 'Query results' })).toBeVisible();

    await opener.click();
    const drawer = page.getByRole('dialog', { name: 'Sources' });
    await expect(drawer).toBeVisible();
    // Focus moves inside and the workspace beneath is inert.
    await expect(drawer.locator(':focus')).toHaveCount(1);
    await expect(page.locator('.workbench-main')).toHaveAttribute('inert', '');

    await drawer.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.locator('.workbench-main')).not.toHaveAttribute('inert', '');
  });

  test('browsing from the narrow drawer closes it and shows the result', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMidiSample(page);

    await page.getByRole('button', { name: 'Show sources', exact: true }).click();
    await page.getByRole('button', { name: 'Browse events' }).click();

    await expect(page.getByRole('dialog', { name: 'Sources' })).toBeHidden();
    await expect(page.getByRole('grid', { name: 'Query results' })).toBeVisible();
  });

  for (const { width, tabs } of [
    { width: 1280, tabs: false },
    { width: 1279, tabs: true },
    { width: 960, tabs: true },
    { width: 959, tabs: true },
  ]) {
    test(`the dock ${tabs ? 'tabs' : 'shows'} its panels at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openMidiSample(page);

      const tablist = page.getByRole('tablist', { name: 'Inspection views' });
      await expect(tablist).toHaveCount(tabs ? 1 : 0);
      if (!tabs) {
        // Side by side: both panels are on screen at once.
        await expect(page.locator('.trace-values')).toBeVisible();
        await expect(page.locator('.trace-bytes')).toBeVisible();
      }
    });
  }

  test('crossing a breakpoint keeps the row selection, the byte caret and the user choices', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openMidiSample(page);
    await page.getByRole('button', { name: 'Browse events' }).click();

    const row = page.getByRole('row', { name: 'Row 3', exact: true });
    await row.click();
    await page.getByLabel('Go to offset').fill('0x10');
    await page.getByLabel('Go to offset').press('Enter');
    const pane = page.locator('[data-hex-pane]');
    await expect(pane).toHaveAttribute('data-hex-caret', '16');

    for (const width of [1279, 959, 699, 960, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(row).toHaveAttribute('aria-selected', 'true');
      await expect(pane).toHaveAttribute('data-hex-caret', '16');
      // A breakpoint crossing never reopens a dock the user has open, nor opens the drawer.
      await expect(page.locator('[data-trace-dock]')).toHaveAttribute('data-dock-collapsed', 'false');
      if (width < 960) await expect(page.getByRole('dialog', { name: 'Sources' })).toBeHidden();
    }
  });

  test('only the active dock panel is keyboard reachable when tabbed', async ({ page }) => {
    // 1024 px tabs the dock but keeps the catalog as an ordinary column.
    await page.setViewportSize({ width: 1024, height: 768 });
    await openMidiSample(page);
    await page.getByRole('button', { name: 'Browse events' }).click();

    await expect(page.getByRole('tab', { name: 'Bytes' })).toHaveAttribute('aria-selected', 'true');
    // The hidden panel keeps its component mounted but takes nothing out of the tab order.
    await expect(page.locator('.trace-values')).toBeHidden();
    await expect(page.locator('.trace-values .inspector')).toHaveCount(1);
    await expect(page.getByRole('application', { name: 'Hex viewer' })).toBeVisible();

    await page.getByRole('tab', { name: 'Bytes' }).press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'Values' })).toBeFocused();
    await expect(page.locator('.trace-values')).toBeVisible();
    await expect(page.locator('.trace-bytes')).toBeHidden();
  });
});

test('selecting a source switches which bytes are shown without rerunning the query', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
  await page.getByRole('button', { name: /Try sample/u }).click();
  await page.getByRole('menuitem', { name: 'Network capture (pcap)' }).click();
  await expect(page.getByRole('button', { name: 'Browse packets' })).toBeVisible();

  await runSql(page, 'select * from packets limit 5');
  const sql = await page.getByRole('textbox', { name: 'SQL query' }).textContent();

  const navigation = page.getByRole('navigation', { name: 'Data explorer' });
  const second = navigation.getByRole('button', { name: /v6\.pcap/u });
  await second.click();

  await expect(second).toHaveAttribute('aria-current', 'true');
  await expect(second).toContainText('Viewing bytes');
  await expect(page.getByLabel('Hex file')).toHaveValue('v6.pcap');
  // The query is untouched.
  expect(await page.getByRole('textbox', { name: 'SQL query' }).textContent()).toBe(sql);
});
