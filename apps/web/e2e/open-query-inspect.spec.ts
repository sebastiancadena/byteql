import { expect, test } from '@playwright/test';

import { openMidiSample, runSql } from './support/app.js';

test('opens the bundled sample, queries five events, and inspects provenance', async ({ page }) => {
  await openMidiSample(page);
  const explorerTables = page.getByRole('region', { name: 'Tables' });
  // MIDI's own 4 tables (header, events, tempo, errors) plus the multi-file-session `_files`
  // catalog table, which every batch session gets even at N=1.
  await expect(explorerTables.getByText('5', { exact: true })).toBeVisible();

  await runSql(page, 'select * from events limit 5');
  await expect(page.locator('.results-heading-meta').getByText('5 rows', { exact: true })).toBeVisible();

  await expect(page.getByRole('columnheader', { name: 'note Uint8' })).toBeVisible();
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  // Provenance is a single clickable byte-range button inside the Provenance section, sharing
  // the trace strip's formatter: lowercase hex, at least eight digits, last included byte.
  await expect(
    page
      .getByRole('region', { name: 'Provenance' })
      .getByRole('button', { name: /^0x[\da-f]{8,}–0x[\da-f]{8,} · \d+ bytes$/u }),
  ).toBeVisible();
});
