import { readFile } from 'node:fs/promises';

import { expect, test, type Page, type Request } from '@playwright/test';

import { fixturePath, openAudioViewer, runSql, waitForAppReady } from './support/app.js';

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

const recordRequest = (request: Request): RecordedRequest => ({
  url: request.url(),
  headers: request.headers(),
  body: request.postData(),
});

async function fallbackExport(page: Page, format: 'csv' | 'parquet'): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Download results' });
  if (!(await dialog.isVisible())) {
    await page.getByRole('button', { name: 'Download results', exact: true }).click();
  }
  await page.getByLabel('Format').selectOption(format);
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  expect(await (await pending).failure()).toBeNull();
  await page.getByRole('button', { name: 'Dismiss' }).click();
}

test('emits zero network events or local-data sentinels after application readiness', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });
  await page.goto('/');
  await waitForAppReady(page);

  const requests: RecordedRequest[] = [];
  page.on('request', (request) => requests.push(recordRequest(request)));

  // Presentation changes must not fetch anything either: appearance is CSS tokens, the fonts
  // are already registered, and the icons are inline SVG.
  await page.getByRole('button', { name: 'Use dark appearance' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Use light appearance' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: /Try sample/u }).click();
  await expect(page.getByRole('menu', { name: 'Sample files' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await page.keyboard.press('Escape');

  const privateFileName = 'private-local-fixture-7b684d.mid';
  const sqlSentinel = 'BYTEQL_PRIVATE_SQL_4d20f8';
  await page.getByLabel('Open file input').setInputFiles({
    name: privateFileName,
    mimeType: 'audio/midi',
    buffer: await readFile(fixturePath('demo.mid')),
  });
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();

  await runSql(page, `select * from events limit 1 -- ${sqlSentinel}`);
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Provenance' })).toBeVisible();

  // Saved queries and opted-in history are local storage only: saving, persisting history,
  // exporting and importing must not produce a request or carry the SQL sentinel anywhere.
  await page.locator('details.recent-queries summary').click();
  await page.getByRole('checkbox', { name: 'Keep history after this tab closes' }).check();
  await page.getByRole('button', { name: 'Save query' }).click();
  await page.getByLabel('Query name').fill('Private sentinel query');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const queriesExport = page.waitForEvent('download');
  await page.getByRole('region', { name: 'Saved queries' }).getByRole('button', { name: 'Export' }).click();
  const queriesPath = testInfo.outputPath('privacy-queries.sql');
  await (await queriesExport).saveAs(queriesPath);
  await page.getByLabel('Import queries file').setInputFiles(queriesPath);
  await expect(page.getByRole('status', { name: 'Query library notice' })).toContainText(
    'skipped 1 duplicate',
  );

  // Collapsing and reopening the inspection dock is presentation only.
  await page.getByRole('button', { name: 'Hide inspection' }).click();
  await page.getByRole('button', { name: 'Show inspection' }).click();
  await expect(page.getByRole('region', { name: 'Source trace' })).toBeVisible();

  await runSql(page, 'select i from range(20000) t(i)');
  await expect(
    page.locator('.results-heading-meta').getByText('1,024 loaded · more available', { exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => window.__BYTEQL_E2E__!.drainQueryResult());
  await expect(page.locator('.results-heading-meta').getByText('20,000 rows', { exact: true })).toBeVisible();
  const resultPaths = (await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics()))
    .resultOpfsPaths;
  expect(resultPaths.length).toBeGreaterThan(1);
  expect(resultPaths.every((path) => /^byteql-results\/\d+\/\d+\.arrow$/u.test(path))).toBe(true);

  await fallbackExport(page, 'csv');
  await fallbackExport(page, 'parquet');

  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      showSaveFilePicker?: () => Promise<FileSystemFileHandle>;
    };
    scope.showSaveFilePicker = async () =>
      ({
        kind: 'file',
        name: 'privacy-failure.csv',
        async createWritable() {
          return {
            async write() {
              throw new DOMException('Privacy test quota exhausted.', 'QuotaExceededError');
            },
            async close() {},
            async abort() {},
          } as FileSystemWritableFileStream;
        },
      }) as FileSystemFileHandle;
  });
  await page.getByLabel('Format').selectOption('csv');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('quota');
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'));
  await fallbackExport(page, 'csv');

  await page.getByRole('button', { name: 'Play all notes' }).click();
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('columnheader', { name: /seconds/u })).toBeVisible();
  await openAudioViewer(page);
  await page.waitForTimeout(150);

  expect(requests).toEqual([]);
  const serializedRequests = JSON.stringify(requests);
  expect(serializedRequests).not.toContain(privateFileName);
  expect(serializedRequests).not.toContain(sqlSentinel);
});
