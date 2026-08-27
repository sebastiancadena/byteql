import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { openMidiSample } from './support/app.js';

const pane = (page: Page) => page.locator('[data-hex-pane]');
const hexCanvas = (page: Page) => page.getByRole('application', { name: 'Hex viewer' });

async function gotoOffset(page: Page, offset: number): Promise<void> {
  await page.getByLabel('Go to offset').fill(String(offset));
  await page.getByLabel('Go to offset').press('Enter');
}

// A grid-row click drives the hex pane's `highlight` (scroll + flash + shade), exposed on
// `data-hex-highlight`; the separate `data-hex-selection` reflects the pane's OWN caret/selection
// from hex-side interaction. To observe the byte span a grid row lit up, read the highlight.
async function highlightedHexRange(page: Page): Promise<{ start: number; end: number }> {
  const raw = await pane(page).getAttribute('data-hex-highlight');
  const [start, end] = (raw ?? '').split('-').map(Number);
  expect(Number.isFinite(start) && Number.isFinite(end)).toBe(true);
  return { start: start as number, end: end as number };
}

test('midi: grid row lights up bytes and a byte click reveals the row back', async ({ page }) => {
  await openMidiSample(page);
  await page.getByRole('button', { name: 'Browse events' }).click();
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();

  await page.getByRole('row', { name: 'Row 3', exact: true }).click();
  const range = await highlightedHexRange(page); // grid→hex: highlight mirrors the row range
  expect(range.end).toBeGreaterThan(range.start);

  await page.getByRole('row', { name: 'Row 1', exact: true }).click(); // move selection away
  await gotoOffset(page, range.start); // hex→grid: land a caret in row 3's bytes…
  await hexCanvas(page).press('Enter'); // …and reveal
  await expect(page.getByRole('row', { name: 'Row 3', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Double-click selects the WHOLE covering record (rangeAt, unclipped), not one byte. The caret
  // sits on a covered byte after the reveal above, so dblclicking the canvas there records a span
  // wider than a single byte — the regression this guards against degenerated it to one byte.
  await page.locator('[data-hex-pane] canvas').dblclick();
  await expect
    .poll(async () => {
      const raw = (await pane(page).getAttribute('data-hex-selection')) ?? '';
      const [start, end] = raw.split('-').map(Number);
      return Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
    })
    .toBeGreaterThan(1);
});

test('pcap: browse, reveal, filter-to-selection, and hidden columns chip', async ({ page }) => {
  await page.goto('/');
  await page
    .getByLabel('Open file')
    .setInputFiles(fileURLToPath(new URL('./fixtures/sample.pcap', import.meta.url)));
  await page.getByRole('button', { name: 'Browse packets' }).click();
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();

  // packets now carries three `_`-prefixed provenance columns: `_src_start`, `_src_end`, and the
  // multi-file-session `_src_file` stamp appended to every batch (single-file or not).
  await expect(page.getByRole('button', { name: 'Toggle hidden columns' })).toHaveText('+3 hidden');
  await expect(page.getByRole('columnheader').filter({ hasText: '_src_start' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle hidden columns' }).click();
  await expect(page.getByRole('columnheader').filter({ hasText: '_src_start' })).toHaveCount(1);

  // sample.pcap is a single eth->ipv4->udp->dns packet, so `packets` browses to exactly one row.
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  const range = await highlightedHexRange(page);

  await gotoOffset(page, range.start);
  await hexCanvas(page).press('Shift+ArrowRight');
  await hexCanvas(page).press('Shift+ArrowRight');
  await page.getByRole('button', { name: 'Filter results to selection' }).click();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText('_src_start <');
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  const rowsText = await page
    .locator('.results-heading-meta')
    .getByText(/\d+ rows/u)
    .textContent();
  expect(Number.parseInt(rowsText ?? '0', 10)).toBeGreaterThanOrEqual(1);
});

test('drag-and-drop opens a file through the window overlay', async ({ page }) => {
  await page.goto('/');
  // The window drop handler lives on `.app-shell`, which only mounts once the local engine has
  // booted; dispatching before then would land on document.body, where nothing listens.
  await page.locator('[data-app-ready="true"]').waitFor();
  const bytes = Array.from(readFileSync(fileURLToPath(new URL('./fixtures/sample.pcap', import.meta.url))));
  await page.evaluate(async (fileBytes) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([new Uint8Array(fileBytes)], 'dropped.pcap'));
    const target = document.querySelector('.app-shell') ?? document.body;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, dataTransfer }));
    }
  }, bytes);
  await expect(page.getByRole('button', { name: 'Browse packets' })).toBeVisible({ timeout: 30_000 });
});
