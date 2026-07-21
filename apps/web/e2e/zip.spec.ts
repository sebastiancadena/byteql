import { Buffer } from 'node:buffer';

import { expect, test } from '@playwright/test';

import { runSql, waitForAppReady } from './support/app.js';
import { makeZip } from './support/zip.js';

const asFile = (name: string, bytes: Uint8Array) => ({
  name,
  mimeType: 'application/zip',
  buffer: Buffer.from(bytes),
});

test('a two-zip session catalogs both archives and exposes local_files', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);

  const zipA = makeZip([
    { name: 'alpha.txt', data: 'alpha contents' },
    { name: 'notes/readme.md', data: '# hello' },
  ]);
  const zipB = makeZip([{ name: 'beta.bin', data: 'beta payload here' }]);
  const nameA = 'first.zip';
  const nameB = 'second.zip';

  await page.getByLabel('Open file').setInputFiles([asFile(nameA, zipA), asFile(nameB, zipB)]);

  // 1. Session opens ready; the Explorer lists the `_files` catalog.
  const tablesRegion = page.getByRole('region', { name: 'Tables' });
  await expect(tablesRegion).toBeVisible();
  await expect(tablesRegion.getByRole('button', { name: 'Browse _files' })).toBeVisible();

  // 2. `local_files` is queryable and spans both archives (3 members total: 2 from zipA, 1 from zipB).
  await runSql(page, 'select count(*) as n from local_files;');
  await expect(page.getByRole('region', { name: 'SQL workspace' }).getByText('1 rows')).toBeVisible();
  await expect(page.getByRole('gridcell', { name: '3', exact: true })).toBeVisible();

  // 3. The `_files` catalog: both archives ingested ok, in ingest order.
  await runSql(page, 'select file, status from _files order by ingest_order;');
  await expect(page.getByRole('region', { name: 'SQL workspace' }).getByText('2 rows')).toBeVisible();
  const filesRow1 = page.getByRole('row', { name: 'Row 1', exact: true });
  const filesRow2 = page.getByRole('row', { name: 'Row 2', exact: true });
  await expect(filesRow1.getByRole('gridcell', { name: nameA, exact: true })).toBeVisible();
  await expect(filesRow1.getByRole('gridcell', { name: 'ok', exact: true })).toBeVisible();
  await expect(filesRow2.getByRole('gridcell', { name: nameB, exact: true })).toBeVisible();
  await expect(filesRow2.getByRole('gridcell', { name: 'ok', exact: true })).toBeVisible();

  // 4. The hex pane's file switcher is visible with both archives, defaulting to the first.
  const hexFileSwitcher = page.getByLabel('Hex file');
  await expect(hexFileSwitcher).toBeVisible();
  await expect(hexFileSwitcher.getByRole('option')).toHaveCount(2);
  await expect(hexFileSwitcher.getByRole('option', { name: nameA, exact: true })).toHaveCount(1);
  await expect(hexFileSwitcher.getByRole('option', { name: nameB, exact: true })).toHaveCount(1);
  await expect(hexFileSwitcher).toHaveValue(nameA);

  // 5. A member row provenanced to the SECOND archive auto-switches the hex pane to it.
  await runSql(page, `select * from local_files where _src_file = '${nameB}' limit 1;`);
  await expect(page.getByRole('region', { name: 'SQL workspace' }).getByText('1 rows')).toBeVisible();
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  await expect(hexFileSwitcher).toHaveValue(nameB);
});
