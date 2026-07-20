import { expect, test } from '@playwright/test';

test('opens the bundled sample, queries five events, and inspects provenance', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try sample' }).click();
  const explorerTables = page.getByRole('region', { name: 'Tables' });
  // MIDI's own 4 tables (header, events, tempo, errors) plus the multi-file-session `_files`
  // catalog table, which every batch session gets even at N=1.
  await expect(explorerTables.getByText('5', { exact: true })).toBeVisible();

  await page.getByRole('textbox', { name: 'SQL query' }).fill('select * from events limit 5');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('region', { name: 'SQL workspace' }).getByText('5 rows')).toBeVisible();

  await expect(page.getByRole('gridcell', { name: /note_/u }).first()).toBeVisible();
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  // The Inspector's provenance is now a single clickable byte-range button (e.g. "0x1c – 0x29")
  // inside the Provenance section, replacing the old raw `_src_start` text.
  await expect(
    page
      .getByRole('region', { name: 'Provenance' })
      .getByRole('button', { name: /0x[0-9a-f]+ – 0x[0-9a-f]+/u }),
  ).toBeVisible();
});
