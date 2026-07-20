import { Buffer } from 'node:buffer';

import { expect, test } from '@playwright/test';

import { generateCapture } from './support/capture.js';
import { runSql, waitForAppReady } from './support/app.js';

// Small enough to keep the run fast — a few packets per file is plenty to exercise a real
// multi-file batch through the parser worker, DuckDB ingest, `_files` catalog, and hex pane.
const CAPTURE_BYTES = 4 * 1024;

const asFile = (name: string, bytes: Uint8Array) => ({
  name,
  mimeType: 'application/vnd.tcpdump.pcap',
  buffer: Buffer.from(bytes),
});

test('a two-file pcap session catalogs both files, groups per-file counts, and auto-switches the hex pane', async ({
  page,
}) => {
  await page.goto('/');
  await waitForAppReady(page);

  const fileA = generateCapture(CAPTURE_BYTES, 101);
  const fileB = generateCapture(CAPTURE_BYTES, 202);
  const nameA = 'multi-a.pcap';
  const nameB = 'multi-b.pcap';

  await page
    .getByLabel('Open file')
    .setInputFiles([asFile(nameA, fileA.bytes), asFile(nameB, fileB.bytes)]);

  // 1. Session opens ready; the Explorer lists `_files`.
  const tablesRegion = page.getByRole('region', { name: 'Tables' });
  await expect(tablesRegion).toBeVisible();
  await expect(tablesRegion.getByRole('button', { name: 'Browse _files' })).toBeVisible();

  // 2. Per-file packet counts, grouped by `_src_file` — two rows, one per capture.
  await runSql(page, 'select _src_file, count(*) as n from packets group by _src_file order by _src_file;');
  await expect(page.getByRole('columnheader', { name: /^n /u })).toBeVisible();
  await expect(page.getByRole('region', { name: 'SQL workspace' }).getByText('2 rows')).toBeVisible();
  // `_src_file` is provenance (`_`-prefixed) and hidden by default; reveal it to read the names.
  await page.getByRole('button', { name: 'Toggle hidden columns' }).click();
  await expect(page.getByRole('gridcell', { name: nameA, exact: true })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: nameB, exact: true })).toBeVisible();

  // 3. The `_files` catalog: both files ingested ok, in ingest order.
  await runSql(page, 'select file, status from _files order by ingest_order;');
  await expect(page.getByRole('columnheader', { name: 'status' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'SQL workspace' }).getByText('2 rows')).toBeVisible();
  const filesRow1 = page.getByRole('row', { name: 'Row 1', exact: true });
  const filesRow2 = page.getByRole('row', { name: 'Row 2', exact: true });
  await expect(filesRow1.getByRole('gridcell', { name: nameA, exact: true })).toBeVisible();
  await expect(filesRow1.getByRole('gridcell', { name: 'ok', exact: true })).toBeVisible();
  await expect(filesRow2.getByRole('gridcell', { name: nameB, exact: true })).toBeVisible();
  await expect(filesRow2.getByRole('gridcell', { name: 'ok', exact: true })).toBeVisible();

  // 4. The hex pane's file switcher is visible with both files, defaulting to the first.
  const hexFileSwitcher = page.getByLabel('Hex file');
  await expect(hexFileSwitcher).toBeVisible();
  await expect(hexFileSwitcher.getByRole('option')).toHaveCount(2);
  await expect(hexFileSwitcher.getByRole('option', { name: nameA, exact: true })).toHaveCount(1);
  await expect(hexFileSwitcher.getByRole('option', { name: nameB, exact: true })).toHaveCount(1);
  await expect(hexFileSwitcher).toHaveValue(nameA);

  // 5. Clicking a row provenanced to the SECOND file auto-switches the hex pane to it.
  await runSql(page, `select * from packets where _src_file = '${nameB}' limit 1;`);
  await expect(page.getByRole('region', { name: 'SQL workspace' }).getByText('1 rows')).toBeVisible();
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  await expect(hexFileSwitcher).toHaveValue(nameB);
});
