import { expect, test } from '@playwright/test';
import { openMidiSample } from './support/app.js';

test('physical scrolling reaches the last row of a 300-row result', async ({ page }) => {
  await openMidiSample(page);
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('select i from range(300) t(i)');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.locator('.results-heading-meta').getByText('300 rows', { exact: true })).toBeVisible();

  const scroll = page.locator('.grid-scroll');
  await scroll.hover();
  await page.mouse.wheel(0, 20_000);

  await expect(page.getByRole('row', { name: 'Row 300', exact: true })).toBeVisible();
});

test('seamless demand reaches row one million with bounded geometry', async ({ page }) => {
  await openMidiSample(page);
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('select i from range(1000000) t(i)');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(
    page.locator('.results-heading-meta').getByText('1,024 loaded · more available', { exact: true }),
  ).toBeVisible();

  const scroll = page.locator('.grid-scroll');
  await scroll.hover();
  await page.mouse.wheel(0, 1_000_000);
  await expect
    .poll(async () => {
      const text = await page.locator('.results-heading-meta').textContent();
      return Number((text?.replaceAll(',', '').match(/\d+/u) ?? ['0'])[0]);
    })
    .toBeGreaterThan(1_024);

  await page.evaluate(async () => window.__BYTEQL_E2E__!.drainQueryResult());

  await expect(page.locator('.results-heading-meta').getByText('1,000,000 rows', { exact: true })).toBeVisible();
  await page.evaluate(async () => window.__BYTEQL_E2E__!.loadResultWindow(999_999));
  await scroll.evaluate(async (node) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await expect(page.getByRole('row', { name: 'Row 1000000', exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: 'Row 1000000', exact: true }).getByRole('gridcell')).toHaveText(
    '999999',
  );

  const metrics = await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics());
  expect(metrics).toMatchObject({
    loadedRows: 1_000_000,
    complete: true,
    windowStart: 983_616,
    sendCount: 1,
  });
  expect(metrics.windowRows).toBeLessThanOrEqual(16_384);
  expect(metrics.decodedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  expect(await page.locator('.grid-virtual-space').evaluate((node) => node.scrollHeight)).toBeLessThanOrEqual(
    16_384 * 36,
  );

  expect(metrics.resultOpfsPaths).toHaveLength(123);
  expect(metrics.resultOpfsPaths.every((path) => /^byteql-results\/\d+\/\d+\.arrow$/u.test(path))).toBe(true);

  await page.evaluate(async () => window.__BYTEQL_E2E__!.loadResultWindow(0));
  await scroll.evaluate(async (node) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scroll'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: 'Row 1', exact: true }).getByRole('gridcell')).toHaveText('0');
  expect((await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics())).sendCount).toBe(1);
});

test('replacement removes every path from an incomplete result generation', async ({ page }) => {
  await openMidiSample(page);
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('select i from range(20000) t(i)');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(
    page.locator('.results-heading-meta').getByText('1,024 loaded · more available', { exact: true }),
  ).toBeVisible();

  const previousPaths = (await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics())).resultOpfsPaths;
  expect(previousPaths).toHaveLength(1);

  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('select i from range(2) t(i)');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.locator('.results-heading-meta').getByText('2 rows', { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics())).resultOpfsPaths.length)
    .toBe(1);
  const replacement = await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics());
  expect(replacement.resultOpfsPaths).toHaveLength(1);
  expect(replacement.resultOpfsPaths.some((path) => previousPaths.includes(path))).toBe(false);
  expect(replacement.sendCount).toBe(1);
});

test('startup sweeps a seeded result-page orphan but preserves unrelated OPFS entries', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-app-ready="true"]').waitFor();
  const seeded = await page.evaluate(() => window.__BYTEQL_E2E__!.seedResultPageOrphan());
  const beforeReload = await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics());
  expect(beforeReload.resultOpfsPaths).toEqual(expect.arrayContaining([seeded.orphanPath, seeded.unrelatedPath]));

  await page.reload();
  await page.locator('[data-app-ready="true"]').waitFor();
  await expect.poll(() => page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics())).toMatchObject({
    resultOpfsPaths: [seeded.unrelatedPath],
  });
});
