import { expect, test } from '@playwright/test';
import { openMidiSample } from './support/app.js';

test('physical scrolling reaches the last row of a 300-row result', async ({ page }) => {
  await openMidiSample(page);
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('select i from range(300) t(i)');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('main', { name: 'Results' }).getByText('300 rows')).toBeVisible();

  const scroll = page.locator('.grid-scroll');
  await scroll.hover();
  await page.mouse.wheel(0, 20_000);

  await expect(page.getByRole('row', { name: 'Row 300', exact: true })).toBeVisible();
});
