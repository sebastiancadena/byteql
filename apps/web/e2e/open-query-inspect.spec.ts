import { expect, test } from '@playwright/test';

test('opens the bundled sample, queries five events, and inspects provenance', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try sample' }).click();
  const explorerTables = page.getByRole('region', { name: 'Tables' });
  await expect(explorerTables.getByText('4', { exact: true })).toBeVisible();

  await page.getByRole('textbox', { name: 'SQL query' }).fill('select * from events limit 5');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('region', { name: 'SQL workspace' }).getByText('5 rows')).toBeVisible();

  await expect(page.getByRole('gridcell', { name: /note_/u }).first()).toBeVisible();
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Provenance' }).getByText('_src_start')).toBeVisible();
});
