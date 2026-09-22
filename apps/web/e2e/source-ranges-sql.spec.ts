import { expect, test } from '@playwright/test';

import { expectRows, openMidiSample, runSql } from './support/app.js';

// Pins the DuckDB SQL the hex filter relies on: the lambda syntax and the quoted "end" field.
test('list_filter with lambda syntax over source ranges', async ({ page }) => {
  await openMidiSample(page);
  await runSql(
    page,
    'select len(list_filter(r, lambda p: p.start < 15 and p."end" > 12)) as hits from ' +
      "(select [{'start': 10::UBIGINT, 'end': 20::UBIGINT}, {'start': 30::UBIGINT, 'end': 40::UBIGINT}] as r)",
  );
  // The sample's own auto-run "overview" query briefly occupies the same grid with unrelated
  // rows, so wait for our query's own result (exactly one row) before reading its cell.
  await expectRows(page, 1);
  await expect(page.getByRole('row', { name: 'Row 1', exact: true }).getByRole('gridcell')).toHaveText('1');
});
