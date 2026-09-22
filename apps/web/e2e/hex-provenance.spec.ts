import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import {
  beginDownload,
  openMidiSample,
  runSql,
  saveDownload,
  setSessionOverrides,
  sortBy,
} from './support/app.js';

const pane = (page: Page) => page.locator('[data-hex-pane]');
const hexCanvas = (page: Page) => page.getByRole('application', { name: 'Hex viewer' });
const interleavedPcapPath = fileURLToPath(new URL('./fixtures/interleaved-stream.pcap', import.meta.url));

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
    .getByLabel('Open file input')
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

// The fixture bytes are a committed, crafted `.pcap`: a two-segment DNS-over-TCP query for
// "interleaved.example" (same construction as dns-stream.pcap) with one unrelated UDP DNS query
// for "noise.example" sandwiched between the two TCP segments, generated once from the Task 3
// builders via packages/formats/pcap/test/generate-e2e-fixture.test.ts. The interleaving means the
// reassembled message's bounding span (`_src_start`..`_src_end`) covers bytes that belong to
// neither of its own two exact pieces — the noise packet sits right in that gap — which is exactly
// what these tests need to tell "highlights the exact pieces" apart from "highlights the whole
// span".

/** The exact byte pieces the hex pane highlights for a multi-range row, read off its own DOM. */
async function highlightedRanges(page: Page): Promise<Array<[number, number]>> {
  const value = await pane(page).getAttribute('data-hex-highlight-ranges');
  const parsed = (value ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split('-').map(Number) as [number, number]);
  expect(parsed.every(([start, end]) => Number.isFinite(start) && Number.isFinite(end))).toBe(true);
  return parsed;
}

for (const tier of ['memory', 'spill'] as const) {
  test(`pcap: reassembled DNS highlights only its payload bytes (${tier} tier)`, async ({ page }) => {
    if (tier === 'spill') {
      await setSessionOverrides(page, { tiering: { tierThresholdBytes: 1, rotationBytes: 256 * 1024 } });
    }
    await page.goto('/');
    await page.getByLabel('Open file input').setInputFiles(interleavedPcapPath);
    await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();

    await runSql(page, "select * from dns where query_name = 'interleaved.example'");
    await page.getByRole('row', { name: 'Row 1', exact: true }).click();

    // 1. Only the two exact pieces are highlighted; the bounding span is wider than their sum.
    const ranges = await highlightedRanges(page);
    expect(ranges).toHaveLength(2);
    const span = await highlightedHexRange(page);
    expect(span.start).toBe(ranges[0]![0]);
    expect(span.end).toBe(ranges[1]![1]);
    await expect(page.getByText(/Range 1 of 2 ·/u)).toBeVisible();

    // 2. `]` moves the readout to the second piece.
    await hexCanvas(page).press(']');
    await expect(pane(page)).toHaveAttribute('data-hex-range-index', '1');

    // 3. A gap byte — inside the bounding span, outside both pieces (the interleaved UDP packet
    // sits there) — does not filter the reassembled DNS row back in.
    const gapByte = ranges[0]![1] + 20;
    expect(gapByte).toBeGreaterThanOrEqual(span.start);
    expect(gapByte).toBeLessThan(span.end);
    expect(gapByte).toBeLessThan(ranges[1]![0]);
    await gotoOffset(page, gapByte);
    await page.getByRole('button', { name: 'Filter results to selection' }).click();
    await expect(page.locator('.results-heading-meta').getByText('0 rows', { exact: true })).toBeVisible();

    // 4. A byte inside a piece does filter it back in.
    await runSql(page, "select * from dns where query_name = 'interleaved.example'");
    await gotoOffset(page, ranges[1]![0] + 1);
    await page.getByRole('button', { name: 'Filter results to selection' }).click();
    await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  });
}

test('pcap: sorting and exporting a result with source ranges', async ({ page }, testInfo) => {
  // Chromium's real `showSaveFilePicker` needs a picker Playwright cannot drive; removing it
  // (mirroring the "fallback" download tests) forces the app's Blob + `<a download>` fallback,
  // which surfaces a "Save file" button and a normal `download` event.
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });
  await page.goto('/');
  await page.getByLabel('Open file input').setInputFiles(interleavedPcapPath);
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();

  await runSql(page, 'select * from dns');
  await expect(page.locator('.results-heading-meta').getByText('2 rows', { exact: true })).toBeVisible();

  await sortBy(page, 'Sort query_name ascending');
  await page
    .getByRole('row', { name: /Row \d+/u })
    .filter({ hasText: 'interleaved.example' })
    .click();
  expect(await highlightedRanges(page)).toHaveLength(2);

  // `_src_ranges` rides along in the sorted/exported result, but it cannot itself be a sort key.
  await page.getByRole('button', { name: 'Toggle hidden columns' }).click();
  await expect(page.getByRole('button', { name: 'Sort _src_ranges ascending' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  await beginDownload(page, 'csv');
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();
  let pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  const csvPath = await saveDownload(await pending, testInfo, 'interleaved-dns.csv');
  const csvBody = new TextDecoder().decode((await readFile(csvPath)).subarray(3)); // strip the UTF-8 BOM
  // Two exact pieces, rendered as `start-end` pairs joined by `;` (apps/web/src/lib/export/csv.ts).
  expect(csvBody).toMatch(/\d+-\d+;\d+-\d+/u);

  await page.getByRole('button', { name: 'Dismiss' }).click();
  await beginDownload(page, 'parquet');
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();
  pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await saveDownload(await pending, testInfo, 'interleaved-dns.parquet');
});
