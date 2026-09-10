import { expect, test } from '@playwright/test';

import { openMidiSample, runSql, waitForAppReady } from './support/app.js';
import { makeZip } from './support/zip.js';

/**
 * The spec's screenshot matrix, captured from real fixtures and real results. Images go to the
 * run's output directory, so a routine test run never leaves a committed artifact behind.
 * Each case records the fixture, the SQL and the appearance it was taken under.
 */

type Appearance = 'light' | 'dark';

async function setAppearance(page: import('@playwright/test').Page, appearance: Appearance) {
  if (appearance === 'light') return;
  await page.getByRole('button', { name: 'Use dark appearance' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
}

async function shoot(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  name: string,
) {
  // Wait for the real content, and disable only nonessential animation. Error states and real
  // results are never hidden or replaced.
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important}' });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

for (const appearance of ['light', 'dark'] as const) {
  for (const { width, height } of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    test(`idle intake ${width}x${height} ${appearance}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await waitForAppReady(page);
      await setAppearance(page, appearance);
      await shoot(page, testInfo, `intake-${width}x${height}-${appearance}`);
    });

    test(`loaded midi ${width}x${height} ${appearance}`, async ({ page }, testInfo) => {
      // Fixture: bundled MIDI sample. SQL: select * from "events" (Browse events).
      await page.setViewportSize({ width, height });
      await openMidiSample(page);
      await page.getByRole('button', { name: 'Browse events' }).click();
      await page.getByRole('row', { name: 'Row 3', exact: true }).click();
      await setAppearance(page, appearance);
      await shoot(page, testInfo, `midi-selected-${width}x${height}-${appearance}`);
    });
  }

  test(`loaded pcap 1024x768 ${appearance}`, async ({ page }, testInfo) => {
    // Fixture: bundled pcap sample. SQL: select * from packets limit 200.
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    await waitForAppReady(page);
    await page.getByRole('button', { name: /Try sample/u }).click();
    await page.getByRole('menuitem', { name: 'Network capture (pcap)' }).click();
    await expect(page.getByRole('button', { name: 'Browse packets' })).toBeVisible();
    await runSql(page, 'select * from packets limit 200');
    await page.getByRole('row', { name: 'Row 2', exact: true }).click();
    await setAppearance(page, appearance);
    await shoot(page, testInfo, `pcap-selected-1024x768-${appearance}`);
  });
}

test('zip entry provenance 1440x900 light', async ({ page }, testInfo) => {
  // Fixture: two-member ZIP built by makeZip. SQL: select * from local_files.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await waitForAppReady(page);
  await page.getByLabel('Open file input').setInputFiles([
    {
      name: 'members.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(
        makeZip([
          { name: 'alpha.txt', data: 'alpha contents' },
          { name: 'notes/readme.md', data: '# hello' },
        ]),
      ),
    },
  ]);
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();
  await runSql(page, 'select * from local_files');
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  await shoot(page, testInfo, 'zip-provenance-1440x900-light');
});

test('aggregate without provenance 1440x900 light', async ({ page }, testInfo) => {
  // Fixture: bundled MIDI sample. SQL: select count(*) as n from events.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMidiSample(page);
  await runSql(page, 'select count(*) as n from events');
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  await shoot(page, testInfo, 'aggregate-1440x900-light');
});

test('sql failure 1440x900 dark', async ({ page }, testInfo) => {
  // Fixture: bundled MIDI sample. SQL: select * from not_a_table.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMidiSample(page);
  await setAppearance(page, 'dark');
  await runSql(page, 'select * from not_a_table');
  await expect(page.getByRole('alert')).toBeVisible();
  await shoot(page, testInfo, 'sql-failure-1440x900-dark');
});

test('download options 1440x900 light', async ({ page }, testInfo) => {
  // Fixture: bundled MIDI sample. SQL: select * from "events" (Browse events).
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMidiSample(page);
  await page.getByRole('button', { name: 'Browse events' }).click();
  await page.getByRole('button', { name: 'Download results', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Download results' })).toBeVisible();
  await shoot(page, testInfo, 'download-options-1440x900-light');
});

for (const appearance of ['light', 'dark'] as const) {
  test(`narrow 390x844 ${appearance}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMidiSample(page);
    await setAppearance(page, appearance);
    await shoot(page, testInfo, `narrow-loaded-${appearance}`);

    await page.getByRole('button', { name: 'Show sources', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Sources' })).toBeVisible();
    await shoot(page, testInfo, `narrow-drawer-${appearance}`);

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show inspection' }).click();
    await expect(page.locator('[data-trace-dock]')).toHaveAttribute('data-dock-collapsed', 'false');
    await shoot(page, testInfo, `narrow-dock-open-${appearance}`);
  });
}
