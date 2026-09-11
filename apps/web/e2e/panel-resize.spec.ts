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

/**
 * Hex column geometry, derived from the pane's OWN rendered `--font-mono` advance width and the
 * shared 16-byte layout rules — never from screenshot pixels. Mirrors `columnLayout`/`hexByteX`
 * in `src/lib/hex/layout.ts`, the way `hex-provenance.spec.ts` and `trace-workspace.spec.ts`
 * already derive their click targets.
 */
interface HexGeometry {
  charWidth: number;
  hexX: number;
  asciiX: number;
  width: number;
}

async function hexGeometry(page: Page): Promise<HexGeometry> {
  return page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('[data-hex-pane]')!;
    const family = getComputedStyle(pane).getPropertyValue('--font-mono').trim();
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `12px ${family}`;
    const charWidth = context.measureText('0').width || 7.2;
    const padding = 12;
    const gutterDigits = 8;
    const hexX = padding + (gutterDigits + 2) * charWidth;
    const asciiX = hexX + (16 * 3 + 1) * charWidth + 2 * charWidth;
    return { charWidth, hexX, asciiX, width: asciiX + 16 * charWidth + padding };
  });
}

/** hexByteX: byte i sits at hexX + (i*3 + (i >= 8 ? 1 : 0)) * charWidth. */
const hexByteX = (geometry: HexGeometry, index: number): number =>
  geometry.hexX + (index * 3 + (index >= 8 ? 1 : 0)) * geometry.charWidth;
const asciiByteX = (geometry: HexGeometry, index: number): number =>
  geometry.asciiX + index * geometry.charWidth;

const hexViewport = (page: Page) => page.locator('.hex-viewport');
const scrollLeftOf = (page: Page) => hexViewport(page).evaluate((node) => node.scrollLeft);

async function scrollBytesTo(page: Page, value: number): Promise<number> {
  return hexViewport(page).evaluate((node, target) => {
    node.scrollLeft = target;
    return node.scrollLeft;
  }, value);
}

/**
 * Clicks a canvas-space x with the real mouse, so nothing auto-scrolls the target into view
 * first: the byte has to be genuinely exposed by the horizontal scroll under test. Asserts the
 * point sits inside the viewport's clip box and that the canvas is what actually receives it.
 */
async function clickCanvasAt(page: Page, canvasX: number): Promise<void> {
  const point = await page.locator('.hex-canvas').evaluate((node, x) => {
    const canvasRect = node.getBoundingClientRect();
    const clipRect = (node.parentElement as HTMLElement).getBoundingClientRect();
    const clientX = canvasRect.left + x;
    const clientY = canvasRect.top + 9; // middle of the first 18 px row
    return {
      clientX,
      clientY,
      exposed: clientX >= clipRect.left && clientX <= clipRect.right,
      topmost: (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.className ?? '',
    };
  }, canvasX);
  expect(point.exposed, `canvas x=${canvasX} is clipped by the Bytes viewport`).toBe(true);
  expect(point.topmost, `canvas x=${canvasX} is covered by another element`).toContain('hex-canvas');
  await page.mouse.click(point.clientX, point.clientY);
}

const firstRowOf = async (page: Page): Promise<number> =>
  Number(await page.locator('[data-hex-pane]').getAttribute('data-hex-first-row'));

/** Reads the painted first row, clicks a byte column, and asserts the resulting global offset. */
async function expectByteAt(page: Page, canvasX: number, index: number): Promise<void> {
  const firstRow = await firstRowOf(page);
  await clickCanvasAt(page, canvasX);
  await expect(page.locator('[data-hex-pane]')).toHaveAttribute(
    'data-hex-caret',
    String(firstRow * 16 + index),
  );
}

async function gotoHexOffset(page: Page, offset: number): Promise<void> {
  await page.getByLabel('Go to offset').fill(String(offset));
  await page.getByLabel('Go to offset').press('Enter');
}

/**
 * Frees dock width with the Sources separator, then DRAGS the Values divider past its limit so
 * Bytes ends up at its published minimum. Everything asserted afterwards is therefore also an
 * assertion about the state a divider drag leaves behind.
 */
async function narrowBytesByDragging(page: Page): Promise<void> {
  const sources = page.getByRole('separator', { name: 'Resize sources', exact: true });
  await sources.focus();
  await sources.press('End');
  const sourcesMax = Number(await sources.getAttribute('aria-valuemax'));
  await expect.poll(async () => Number(await sources.getAttribute('aria-valuenow'))).toBe(sourcesMax);

  const values = page.getByRole('separator', { name: 'Resize values', exact: true });
  const valuesMax = Number(await values.getAttribute('aria-valuemax'));
  await drag(page, 'Resize values', 320, 0);
  await expect.poll(async () => Number(await values.getAttribute('aria-valuenow'))).toBe(valuesMax);
}

/** Parks the pointer over the Bytes viewport so wheel gestures land on it. */
async function hoverBytes(page: Page): Promise<void> {
  const box = await hexViewport(page).boundingBox();
  if (!box) throw new Error('the Bytes viewport has no rectangle');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test('a narrowed Bytes pane still reaches every byte after a divider drag', async ({ page }) => {
  await openMidiSample(page);
  const geometry = await hexGeometry(page);

  // Wide enough to need no horizontal scroll: the same coordinates already resolve correctly,
  // and a horizontal gesture with nothing to scroll must not move byte rows instead.
  await gotoHexOffset(page, 1024);
  const restingRow = await firstRowOf(page);
  expect(restingRow).toBeGreaterThan(0);
  await hoverBytes(page);
  await page.mouse.wheel(400, 0);
  await expect(page.locator('[data-hex-pane]')).toHaveAttribute('data-hex-first-row', String(restingRow));
  await gotoHexOffset(page, 0);
  await expect(page.locator('[data-hex-pane]')).toHaveAttribute('data-hex-first-row', '0');
  await expectByteAt(page, asciiByteX(geometry, 5) + geometry.charWidth / 2, 5);

  await narrowBytesByDragging(page);

  const overflow = await hexViewport(page).evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow, 'a minimum-width Bytes pane must be able to scroll to its ASCII column').toBeGreaterThan(
    0,
  );
  // The canvas keeps its fixed 16-byte width; it is never scaled down to fit the pane. Its painted
  // height stops at the viewport's client height, which the horizontal scrollbar eats into.
  const canvasBox = await page.locator('.hex-canvas').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const clip = node.parentElement as HTMLElement;
    return {
      width: rect.width,
      height: rect.height,
      clientHeight: clip.clientHeight,
      scrollbar: clip.offsetHeight - clip.clientHeight,
    };
  });
  expect(Math.abs(canvasBox.width - geometry.width)).toBeLessThanOrEqual(1);
  // Rows are painted against the viewport's CLIENT height, so whatever a horizontal scrollbar
  // eats is already gone from the drawing surface. (This Chromium draws overlay scrollbars, so
  // `scrollbar` is legitimately 0 here; the reported chrome height covers the other case.)
  expect(canvasBox.scrollbar).toBeGreaterThanOrEqual(0);
  expect(Math.abs(canvasBox.height - canvasBox.clientHeight)).toBeLessThanOrEqual(1);

  await gotoHexOffset(page, 0);
  await expect(page.locator('[data-hex-pane]')).toHaveAttribute('data-hex-first-row', '0');

  // A real horizontal wheel gesture reaches the far edge, and moves no byte rows on the way.
  await hoverBytes(page);
  await page.mouse.wheel(10_000, 0);
  await expect.poll(async () => scrollLeftOf(page)).toBe(overflow);
  await expect(page.locator('[data-hex-pane]')).toHaveAttribute('data-hex-first-row', '0');

  await expectByteAt(page, hexByteX(geometry, 15) + geometry.charWidth, 15); // last hex byte
  await expectByteAt(page, asciiByteX(geometry, 15) + geometry.charWidth / 2, 15); // final ASCII column
  await expectByteAt(page, asciiByteX(geometry, 5) + geometry.charWidth / 2, 5);

  // Shift + wheel is the other horizontal gesture; it must not page the byte rows either.
  await hoverBytes(page);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -10_000);
  await page.keyboard.up('Shift');
  await expect.poll(async () => scrollLeftOf(page)).toBe(0);
  await expect(page.locator('[data-hex-pane]')).toHaveAttribute('data-hex-first-row', '0');
  await expectByteAt(page, hexByteX(geometry, 0) + geometry.charWidth, 0);

  // A plain vertical wheel keeps its custom row scrolling.
  await hoverBytes(page);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => firstRowOf(page)).toBeGreaterThan(0);

  // A nonzero painted first row still resolves to the correct GLOBAL offset.
  await gotoHexOffset(page, 1024);
  expect(await firstRowOf(page)).toBeGreaterThan(0);
  await scrollBytesTo(page, 10_000);
  await expectByteAt(page, asciiByteX(geometry, 3) + geometry.charWidth / 2, 3);
});

test('Bytes keeps its horizontal scroll across appearance, hiding and resizing', async ({ page }) => {
  await openMidiSample(page);
  await narrowBytesByDragging(page);
  await gotoHexOffset(page, 0);

  const chosen = await scrollBytesTo(page, 40);
  expect(chosen).toBe(40);
  const caret = await page.locator('[data-hex-pane]').getAttribute('data-hex-caret');

  await page.getByRole('button', { name: 'Use dark appearance' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await scrollLeftOf(page)).toBe(chosen);

  // Hiding the dock unmounts the viewport; reopening it restores the scroll the user chose.
  await page.getByRole('button', { name: 'Hide inspection' }).click();
  await expect(page.locator('[data-trace-dock]')).toHaveAttribute('data-dock-collapsed', 'true');
  await page.getByRole('button', { name: 'Show inspection' }).click();
  await expect(page.locator('[data-trace-dock]')).toHaveAttribute('data-dock-collapsed', 'false');
  await expect.poll(async () => scrollLeftOf(page)).toBe(chosen);

  // An ordinary resize preserves scroll and selection: it never snaps the caret back into view.
  await drag(page, 'Resize inspection', 0, -40);
  await expect.poll(async () => scrollLeftOf(page)).toBe(chosen);
  await expect(page.locator('[data-hex-pane]')).toHaveAttribute('data-hex-caret', caret!);
});
