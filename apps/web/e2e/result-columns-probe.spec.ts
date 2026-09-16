import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { ResultColumnsProbeReport } from '@byteql/db';

import type { BrowserE2EControl } from '../src/lib/e2e-harness.js';

import { openMidiSample, runSql, waitForAppReady } from './support/app.js';

for (const variant of ['mvp', 'eh'] as const) {
  test(`duplicate result columns in the ${variant} bundle`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    // This independent database probe must not depend on consumers migrated in later tasks.
    await page.goto('/');
    await waitForAppReady(page);
    const report = await page.evaluate(
      (bundle) =>
        (
          window.__byteqlE2E as unknown as {
            probeResultColumns(variant: 'mvp' | 'eh'): Promise<ResultColumnsProbeReport>;
          }
        ).probeResultColumns(bundle),
      variant,
    );
    const path = testInfo.outputPath(`result-columns-${variant}.json`);
    await writeFile(path, JSON.stringify(report, null, 2));
    await testInfo.attach(`result-columns-${variant}.json`, { path, contentType: 'application/json' });
    expect(report.errors).toEqual([]);
    expect(report.checks).toEqual({
      mixed: true,
      sameType: true,
      empty: true,
      sliced: true,
      ipc: true,
      exactValues: true,
    });
  });
}

test('production query sessions preserve mixed duplicate columns and empty result types', async ({
  page,
}) => {
  await openMidiSample(page);
  const sql = "select 10::integer as dup, 'ten'::varchar as dup";
  await runSql(page, sql);
  await expect(page.getByRole('row', { name: 'Row 1', exact: true }).getByRole('gridcell')).toHaveText([
    '10',
    'ten',
  ]);
  for (const [index, type] of ['Int32', 'Utf8'].entries()) {
    await expect(
      page.getByRole('columnheader', { name: `dup, column ${index + 1}, ${type}`, exact: true }),
    ).toBeVisible();
  }
  const storedResult = () =>
    page.evaluate(() => (window.__byteqlE2E as unknown as BrowserE2EControl).storedResult());
  expect(await storedResult()).toMatchObject({ types: ['Int32', 'Utf8'], rows: [[10, 'ten']] });
  expect(await page.evaluate(() => window.__byteqlE2E!.queryResultMetrics())).toMatchObject({
    loadedRows: 1,
    complete: true,
    sendCount: 1,
  });

  await runSql(page, `${sql} where false`);
  await expect(page.getByText('No rows returned. Adjust the query and run again.')).toBeVisible();
  for (const [index, type] of ['Int32', 'Utf8'].entries()) {
    await expect(
      page.getByRole('columnheader', { name: `dup, column ${index + 1}, ${type}`, exact: true }),
    ).toBeVisible();
  }
  expect(await storedResult()).toMatchObject({ types: ['Int32', 'Utf8'], rows: [] });
  expect(await page.evaluate(() => window.__byteqlE2E!.queryResultMetrics())).toMatchObject({
    loadedRows: 0,
    complete: true,
    sendCount: 1,
  });
  await expect(page.locator('.query-diagnostic')).toHaveCount(0);
});
