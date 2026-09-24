import { expect, test, type Page } from '@playwright/test';

import { openFixture, runSql, waitForAppReady } from './support/app.js';

interface StoredQuery {
  format: string;
  name: string;
  sql: string;
}

/**
 * Reads one object store of the app's query database. Only call after the app is ready: the app
 * creates the database at startup, and opening a missing database here would create it at
 * version 1 with no stores and break the app's own upgrade.
 */
async function readStore<T>(page: Page, store: 'saved' | 'history'): Promise<T[]> {
  return page.evaluate(
    (name) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open('byteql-queries');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction(name).objectStore(name).getAll();
          request.onsuccess = () => {
            resolve(request.result as T[]);
            db.close();
          };
          request.onerror = () => reject(request.error);
        };
      }),
    store,
  );
}

async function fillEditor(page: Page, sql: string): Promise<void> {
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill(sql);
}

async function saveQuery(page: Page, sql: string, name: string): Promise<void> {
  await fillEditor(page, sql);
  await page.getByRole('button', { name: 'Save query' }).click();
  await page.getByLabel('Query name').fill(name);
  // A second save in the same session still has the previous save loaded, so the popover offers
  // "Update"/"Save as new" instead of a plain "Save" — click whichever creates a new entry.
  const saveAsNew = page.getByRole('button', { name: 'Save as new' });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await save.or(saveAsNew).click();
  await expect(
    page.getByRole('region', { name: 'Saved queries' }).getByRole('button', { name, exact: true }),
  ).toBeVisible();
}

async function openRecent(page: Page): Promise<void> {
  const details = page.locator('details.recent-queries');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
}

test('a saved query survives a reload and runs on a different capture of the same format', async ({
  page,
}) => {
  await page.goto('/');
  await waitForAppReady(page);
  await openFixture(page, 'sample.pcap');
  await saveQuery(page, 'select count(*) as packet_total from packets', 'Packet count');

  await page.reload();
  await waitForAppReady(page);
  await openFixture(page, 'sample.pcapng');
  await page
    .getByRole('region', { name: 'Saved queries' })
    .getByRole('button', { name: 'Packet count', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText('packet_total');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('columnheader', { name: /packet_total/u })).toBeVisible();
});

test('history persists only while opted in, and opting out empties storage', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
  await openFixture(page, 'sample.pcap');

  await runSql(page, 'select 1 as not_kept');
  await expect(page.getByRole('columnheader', { name: /not_kept/u })).toBeVisible();
  expect(await readStore(page, 'history')).toEqual([]);

  await openRecent(page);
  await page.getByRole('checkbox', { name: 'Keep history after this tab closes' }).check();
  await runSql(page, 'select 2 as kept');
  await expect(page.getByRole('columnheader', { name: /\bkept\b/u })).toBeVisible();
  await expect
    .poll(async () => (await readStore<StoredQuery>(page, 'history')).map((entry) => entry.sql))
    .toContain('select 2 as kept');

  await page.reload();
  await waitForAppReady(page);
  await openFixture(page, 'sample.pcap');
  await openRecent(page);
  await expect(page.getByRole('region', { name: 'Recent' }).getByText('select 2 as kept')).toBeVisible();

  await page.getByRole('checkbox', { name: 'Keep history after this tab closes' }).uncheck();

  // The store's write queue is ordered: saving this query only resolves after everything queued
  // ahead of it (including any history write still in flight from before the uncheck) has
  // landed, so once it shows up in `saved`, `history` is already whatever it is going to be.
  await saveQuery(page, 'select 3 as after_off', 'After off');
  await expect
    .poll(async () => (await readStore<StoredQuery>(page, 'saved')).map((entry) => entry.name))
    .toContain('After off');
  expect(await readStore(page, 'history')).toEqual([]);
});

test('export then import into a fresh profile reproduces the library', async ({ browser }, testInfo) => {
  const source = await browser.newContext();
  const page = await source.newPage();
  await page.addInitScript(() => Reflect.deleteProperty(window, 'showSaveFilePicker'));
  await page.goto('/');
  await waitForAppReady(page);
  await openFixture(page, 'sample.pcap');
  await saveQuery(page, 'select src, count(*) from ip group by 1', 'Top talkers');
  await saveQuery(page, 'select 1\n-- name: tricky marker line', 'Tricky');

  const pending = page.waitForEvent('download');
  await page.getByRole('region', { name: 'Saved queries' }).getByRole('button', { name: 'Export' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('byteql-pcap-queries.sql');
  const path = testInfo.outputPath('byteql-pcap-queries.sql');
  await download.saveAs(path);
  const original = await readStore<StoredQuery>(page, 'saved');
  await source.close();

  const fresh = await browser.newContext();
  const next = await fresh.newPage();
  await next.goto('/');
  await waitForAppReady(next);
  await openFixture(next, 'sample.pcap');
  await next.getByLabel('Import queries file').setInputFiles(path);
  await expect(next.getByRole('status', { name: 'Query library notice' })).toContainText(
    'Imported 2 queries',
  );
  const imported = await readStore<StoredQuery>(next, 'saved');
  const shape = (queries: StoredQuery[]) => queries.map(({ format, name, sql }) => ({ format, name, sql }));
  expect(shape(imported)).toEqual(shape(original));
  await fresh.close();
});
