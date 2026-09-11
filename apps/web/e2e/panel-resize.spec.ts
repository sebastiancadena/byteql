import { expect, test, type Page } from '@playwright/test';

import { openMidiSample, runSql } from './support/app.js';

test.use({ viewport: { width: 1440, height: 960 } });

async function drag(page: Page, name: string, dx: number, dy: number) {
  const handle = page.getByRole('separator', { name, exact: true });
  const box = await handle.boundingBox();
  if (!box) throw new Error(`No rectangle for ${name}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  expect(
    await handle.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === node;
    }),
  ).toBe(true);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

test('query growth takes room from Results, preserving inspection', async ({ page }) => {
  await openMidiSample(page);
  await runSql(page, 'select i from range(300) t(i)');
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  const editor = page.locator('.sql-editor');
  const results = page.locator('.results-panel');
  const dock = page.locator('[data-trace-dock]');
  const q0 = (await editor.boundingBox())!.height;
  const r0 = (await results.boundingBox())!.height;
  const d0 = (await dock.boundingBox())!.height;
  await drag(page, 'Resize query', 0, 100);
  await expect.poll(async () => Math.round((await editor.boundingBox())!.height - q0)).toBe(100);
  expect(Math.round(r0 - (await results.boundingBox())!.height)).toBe(100);
  expect(Math.abs((await dock.boundingBox())!.height - d0)).toBeLessThanOrEqual(1);
});

const widthOf = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);

const heightOf = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);

test('sources growth takes room from the workspace, leaving the vertical budget alone', async ({ page }) => {
  await openMidiSample(page);
  await runSql(page, 'select i from range(300) t(i)');
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();

  const sources0 = await widthOf(page, '#source-pane');
  const workspace0 = await widthOf(page, '.sql-workspace');
  const query0 = await heightOf(page, '.sql-editor');
  const results0 = await heightOf(page, '.results-panel');

  await drag(page, 'Resize sources', 80, 0);

  await expect.poll(async () => Math.round((await widthOf(page, '#source-pane')) - sources0)).toBe(80);
  expect(Math.round(workspace0 - (await widthOf(page, '.sql-workspace')))).toBe(80);
  // A width change is not a height change: the vertical budget is untouched.
  expect(Math.abs((await heightOf(page, '.sql-editor')) - query0)).toBeLessThanOrEqual(1);
  expect(Math.abs((await heightOf(page, '.results-panel')) - results0)).toBeLessThanOrEqual(1);
});

test('values growth takes room from Bytes, leaving the vertical budget alone', async ({ page }) => {
  await openMidiSample(page);
  await runSql(page, 'select i from range(300) t(i)');
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();

  const values0 = await widthOf(page, '.trace-values');
  const bytes0 = await widthOf(page, '.trace-bytes');
  const query0 = await heightOf(page, '.sql-editor');
  const results0 = await heightOf(page, '.results-panel');
  const dock0 = await heightOf(page, '[data-trace-dock]');

  await drag(page, 'Resize values', 80, 0);

  await expect.poll(async () => Math.round((await widthOf(page, '.trace-values')) - values0)).toBe(80);
  expect(Math.round(bytes0 - (await widthOf(page, '.trace-bytes')))).toBe(80);
  expect(Math.abs((await heightOf(page, '.sql-editor')) - query0)).toBeLessThanOrEqual(1);
  expect(Math.abs((await heightOf(page, '.results-panel')) - results0)).toBeLessThanOrEqual(1);
  expect(Math.abs((await heightOf(page, '[data-trace-dock]')) - dock0)).toBeLessThanOrEqual(1);
});

test('both width separators stop at their published limits', async ({ page }) => {
  await openMidiSample(page);

  for (const { name, pane } of [
    { name: 'Resize sources', pane: '#source-pane' },
    { name: 'Resize values', pane: '.trace-values' },
  ]) {
    const separator = page.getByRole('separator', { name, exact: true });
    await separator.focus();

    await separator.press('End');
    const max = Number(await separator.getAttribute('aria-valuemax'));
    await expect.poll(async () => Math.round(await widthOf(page, pane))).toBe(max);
    expect(await separator.getAttribute('aria-valuenow')).toBe(String(max));

    await separator.press('Home');
    const min = Number(await separator.getAttribute('aria-valuemin'));
    await expect.poll(async () => Math.round(await widthOf(page, pane))).toBe(min);
    expect(await separator.getAttribute('aria-valuenow')).toBe(String(min));
  }
});

test('collapsing Sources removes its separator and restores the chosen width', async ({ page }) => {
  await openMidiSample(page);

  const separator = page.getByRole('separator', { name: 'Resize sources', exact: true });
  await separator.focus();
  await separator.press('Shift+ArrowRight');
  const chosen = Math.round(await widthOf(page, '#source-pane'));
  expect(chosen).toBeGreaterThan(224);

  await page.getByRole('button', { name: 'Hide sources', exact: true }).click();
  // Absent from the DOM, not merely invisible: a hidden separator must not stay tabbable.
  await expect(separator).toHaveCount(0);
  expect(Math.round(await widthOf(page, '#source-pane'))).toBe(0);

  await page.getByRole('button', { name: 'Show sources', exact: true }).click();
  await expect(separator).toHaveCount(1);
  await expect.poll(async () => Math.round(await widthOf(page, '#source-pane'))).toBe(chosen);
});

test('the narrow drawer keeps its fixed width and offers no separator', async ({ page }) => {
  await page.setViewportSize({ width: 959, height: 900 });
  await openMidiSample(page);

  await expect(page.getByRole('separator', { name: 'Resize sources', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show sources', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Sources' });
  await expect(drawer).toBeVisible();
  expect(Math.round(await widthOf(page, '#source-pane'))).toBe(280);
  await expect(page.getByRole('separator', { name: 'Resize sources', exact: true })).toHaveCount(0);
});

test('a wide Sources column tabs the dock, and reclaimed width restores the columns', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMidiSample(page);

  const tablist = page.getByRole('tablist', { name: 'Inspection views' });
  await expect(tablist).toHaveCount(0);

  const separator = page.getByRole('separator', { name: 'Resize sources', exact: true });
  await separator.focus();
  await separator.press('End');
  // The workspace is now too narrow to hold Values beside Bytes.
  await expect(tablist).toHaveCount(1);
  await expect(page.getByRole('separator', { name: 'Resize values', exact: true })).toHaveCount(0);

  const dockWidth = () => page.locator('.workbench-main').evaluate((el) => (el as HTMLElement).clientWidth);

  // Widen until the dock measures 912 px — inside the 900-923 band, where the previous mode wins.
  const banded = 1280 + (912 - (await dockWidth()));
  await page.setViewportSize({ width: banded, height: 900 });
  await expect.poll(dockWidth).toBe(912);
  await expect(tablist).toHaveCount(1);

  // 924 px is where the dock can hold its columns again.
  await page.setViewportSize({ width: banded + 12, height: 900 });
  await expect.poll(dockWidth).toBe(924);
  await expect(tablist).toHaveCount(0);
  await expect(page.getByRole('separator', { name: 'Resize values', exact: true })).toHaveCount(1);
});

test('a mode switch keeps focus on the panel it was in, and never remounts the audio viewer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMidiSample(page);
  await page.getByRole('button', { name: 'Play all notes' }).click();
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('columnheader', { name: /seconds/u })).toBeVisible();
  await page.getByRole('button', { name: 'Open in…' }).click();
  await page.getByRole('menuitem', { name: 'Audio playback' }).click();
  await expect(page.getByRole('heading', { name: 'Audio playback' })).toBeVisible();

  const viewer = page.getByRole('heading', { name: 'Audio playback' });
  const loads = () => page.evaluate(() => window.__byteqlE2E?.audioStats().loadCalls ?? -1);
  const before = await loads();

  // Focus lives inside Values when the dock becomes tabbed.
  const play = page.getByRole('button', { name: /^(Play|Pause)$/u }).first();
  await play.focus();
  await page.setViewportSize({ width: 1100, height: 900 });

  await expect(page.getByRole('tab', { name: 'Values' })).toHaveAttribute('aria-selected', 'true');
  await expect(play).toBeFocused();
  await expect(viewer).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('tablist', { name: 'Inspection views' })).toHaveCount(0);
  await expect(viewer).toBeVisible();
  // Same component throughout: no reload of the audio engine.
  expect(await loads()).toBe(before);
});

test('resetting panel sizes from the shortcuts dialog keeps the session as it was', async ({ page }) => {
  await openMidiSample(page);
  await page.getByRole('button', { name: 'Browse events' }).click();
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  await page.getByRole('row', { name: 'Row 3', exact: true }).click();
  await page.getByRole('button', { name: 'Use dark appearance' }).click();

  const defaults = {
    sources: Math.round(await widthOf(page, '#source-pane')),
    values: Math.round(await widthOf(page, '.trace-values')),
    query: Math.round(await heightOf(page, '.sql-editor')),
  };

  await drag(page, 'Resize sources', 60, 0);
  await drag(page, 'Resize values', 60, 0);
  await drag(page, 'Resize query', 0, 60);
  expect(Math.round(await widthOf(page, '#source-pane'))).not.toBe(defaults.sources);

  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Reset panel sizes', exact: true }).click();

  // The dialog stays put; only the sizes moved.
  await expect(dialog).toBeVisible();
  await expect.poll(async () => Math.round(await widthOf(page, '#source-pane'))).toBe(defaults.sources);
  expect(Math.round(await widthOf(page, '.trace-values'))).toBe(defaults.values);
  expect(Math.round(await heightOf(page, '.sql-editor'))).toBe(defaults.query);

  await dialog.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('[data-trace-dock]')).toHaveAttribute('data-dock-collapsed', 'false');
  await expect(page.getByRole('row', { name: 'Row 3', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('blocked storage still lets every divider move', async ({ page }) => {
  await page.addInitScript(() => {
    const blocked = {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage blocked');
      },
      removeItem: () => {
        throw new Error('storage blocked');
      },
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => blocked });
  });
  await openMidiSample(page);

  const sources0 = await widthOf(page, '#source-pane');
  await drag(page, 'Resize sources', 60, 0);
  await expect.poll(async () => Math.round((await widthOf(page, '#source-pane')) - sources0)).toBe(60);

  const values0 = await widthOf(page, '.trace-values');
  await drag(page, 'Resize values', 60, 0);
  await expect.poll(async () => Math.round((await widthOf(page, '.trace-values')) - values0)).toBe(60);
});
