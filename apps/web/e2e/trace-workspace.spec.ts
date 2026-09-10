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
