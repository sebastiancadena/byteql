import { expect, test, type Page } from '@playwright/test';

import { openMidiSample, runSql, waitForAppReady } from './support/app.js';

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

const LONG_LINE = `-- ${'wide-column-comment-'.repeat(25)}`; // one ~500 character line
const LONG_SQL = [
  ...Array.from({ length: 60 }, (_, index) => `-- comment line ${index + 1}`),
  LONG_LINE,
  'select 1 as sentinel',
].join('\n');

/** Overflow the host reports for itself versus the overflow its `.cm-scroller` reports. */
const editorScrollOwnership = (page: Page) =>
  page.evaluate(() => {
    const host = document.querySelector('.sql-editor') as HTMLElement;
    const scroller = document.querySelector('.sql-editor .cm-scroller') as HTMLElement;
    return {
      hostX: host.scrollWidth - host.clientWidth,
      hostY: host.scrollHeight - host.clientHeight,
      scrollerX: scroller.scrollWidth - scroller.clientWidth,
      scrollerY: scroller.scrollHeight - scroller.clientHeight,
      scrollerTop: scroller.scrollTop,
    };
  });

test('a long query keeps one scroll owner, its selection and its undo history across a resize', async ({
  page,
}) => {
  await openMidiSample(page);
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill(LONG_SQL);
  await expect(editor).toContainText('sentinel');

  // Scroll to the end of the document and select its last word.
  await editor.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  const scrolled = await editorScrollOwnership(page);
  expect(scrolled.scrollerTop, 'the editor must have scrolled to its end').toBeGreaterThan(0);

  // `.cm-scroller` owns BOTH axes; the host is a fixed clipping box with no scrolling of its own.
  expect(scrolled.scrollerX, 'the 500 character line must scroll horizontally').toBeGreaterThan(0);
  expect(scrolled.scrollerY, '60+ lines must scroll vertically').toBeGreaterThan(0);
  expect(scrolled.hostX).toBe(0);
  expect(scrolled.hostY).toBe(0);

  await drag(page, 'Resize query', 0, 120);
  await drag(page, 'Resize query', 0, -60);
  const resized = await editorScrollOwnership(page);
  expect(resized.hostX).toBe(0);
  expect(resized.hostY).toBe(0);

  // The selection survived the resize: typing replaces exactly the word that was selected…
  await editor.focus();
  await page.keyboard.type('marker');
  await expect(editor).toContainText('select 1 as marker');
  await expect(editor).not.toContainText('sentinel');

  // …and undo puts it back, with the rest of the long document untouched.
  await page.keyboard.press('Control+z');
  await expect(editor).toContainText('select 1 as sentinel');
  await expect(editor).toContainText('comment line 60');
  await expect(editor).toContainText(LONG_LINE);

  // A theme switch is a CodeMirror reconfigure, never a rerun: the result generation stands.
  const before = await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics());
  await page.getByRole('button', { name: 'Use dark appearance' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(editor).toContainText('select 1 as sentinel');
  const after = await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics());
  expect(after.sendCount).toBe(before.sendCount);
  expect(after.resultOpfsPaths).toEqual(before.resultOpfsPaths);
});

test('enlarging Results crosses the demand threshold with no scroll event', async ({ page }) => {
  await openMidiSample(page);
  await runSql(page, 'select i from range(1000000) t(i)');
  const meta = page.locator('.results-heading-meta');
  await expect(meta.getByText('1,024 loaded · more available', { exact: true })).toBeVisible();

  const scroll = page.locator('.grid-scroll');
  // Park the last visible row one short of the forward-demand edge (loadedRows - 8 - 1).
  await scroll.evaluate((node) => {
    node.scrollTop = (1024 - 9) * 36 - node.clientHeight - 1;
    node.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(500);
  await expect(meta.getByText('1,024 loaded · more available', { exact: true })).toBeVisible();

  const parked = await scroll.evaluate((node) => ({ top: node.scrollTop, height: node.clientHeight }));
  // Shrinking the dock hands Results more rows without producing a scroll event.
  await drag(page, 'Resize inspection', 0, 90);
  await expect.poll(async () => scroll.evaluate((node) => node.clientHeight)).toBeGreaterThan(parked.height);
  expect(await scroll.evaluate((node) => node.scrollTop)).toBe(parked.top);

  await expect
    .poll(async () => (await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics())).loadedRows)
    .toBeGreaterThan(1024);

  // One generation throughout: growing a panel never re-sends the query.
  const metrics = await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics());
  expect(metrics.sendCount).toBe(1);
  const generations = new Set(metrics.resultOpfsPaths.map((path) => path.split('/')[1]));
  expect(generations.size).toBe(1);
});

/* ------------------------------------------------------------------------------------------- *
 * Adversarial regression matrix. Every case below exists to pin one of the design's acceptance
 * gates to something a real browser can observe, rather than to a style value or a test name.
 * ------------------------------------------------------------------------------------------- */

interface SeparatorReading {
  now: number;
  min: number;
  max: number;
  size: number;
  text: string;
  controls: string;
}

/**
 * Reads a separator's published ARIA numbers together with the border-box size of the pane its
 * own `aria-controls` names, in one evaluation so the two cannot be read a frame apart.
 */
async function readSeparator(page: Page, name: string): Promise<SeparatorReading> {
  return page.getByRole('separator', { name, exact: true }).evaluate((node) => {
    const controls = node.getAttribute('aria-controls') ?? '';
    const pane = document.getElementById(controls);
    if (!pane) throw new Error(`${controls} is not on the page`);
    const rect = pane.getBoundingClientRect();
    return {
      now: Number(node.getAttribute('aria-valuenow')),
      min: Number(node.getAttribute('aria-valuemin')),
      max: Number(node.getAttribute('aria-valuemax')),
      size: node.getAttribute('aria-orientation') === 'horizontal' ? rect.height : rect.width,
      text: node.getAttribute('aria-valuetext') ?? '',
      controls,
    };
  });
}

/** `aria-valuenow` is a promise about a pane; this is where it gets checked against the pane. */
async function expectAriaMatchesPane(page: Page, name: string, step: string): Promise<number> {
  const reading = await readSeparator(page, name);
  expect(
    Math.abs(reading.now - reading.size),
    `${name} after ${step}: aria-valuenow ${reading.now} vs ${reading.controls} ${reading.size}`,
  ).toBeLessThanOrEqual(1);
  expect(reading.now, `${name} after ${step}: value below its minimum`).toBeGreaterThanOrEqual(reading.min);
  expect(reading.now, `${name} after ${step}: value above its maximum`).toBeLessThanOrEqual(reading.max);
  expect(reading.text).toContain(String(reading.now));
  return reading.now;
}

/** The four dividers, with the key and the pointer offset that each one grows its pane by. */
const SEPARATORS = [
  { name: 'Resize sources', grow: 'ArrowRight', shrink: 'ArrowLeft', axis: 'x' },
  { name: 'Resize query', grow: 'ArrowDown', shrink: 'ArrowUp', axis: 'y' },
  { name: 'Resize inspection', grow: 'ArrowUp', shrink: 'ArrowDown', axis: 'y' },
  { name: 'Resize values', grow: 'ArrowRight', shrink: 'ArrowLeft', axis: 'x' },
] as const;

/** A pointer offset along a divider's own axis, as the `drag` helper's `(dx, dy)` pair. */
const along = (axis: 'x' | 'y', offset: number): [number, number] =>
  axis === 'x' ? [offset, 0] : [0, offset];

test('every separator keeps its ARIA numbers within a pixel of the pane it controls', async ({ page }) => {
  await openMidiSample(page);
  await runSql(page, 'select i from range(300) t(i)');
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();

  for (const { name, grow, shrink, axis } of SEPARATORS) {
    const separator = page.getByRole('separator', { name, exact: true });
    await separator.focus();
    await expect(separator).toBeFocused();
    const rest = await expectAriaMatchesPane(page, name, 'rest');

    // Both keyboard directions, at both step sizes, then both absolute ends.
    await separator.press(grow);
    const grown = await expectAriaMatchesPane(page, name, grow);
    expect(grown, `${name} did not grow`).toBeGreaterThan(rest);

    await separator.press(`Shift+${grow}`);
    const stretched = await expectAriaMatchesPane(page, name, `Shift+${grow}`);
    expect(stretched, `${name} ignored the Shift step`).toBeGreaterThan(grown);

    await separator.press(shrink);
    const eased = await expectAriaMatchesPane(page, name, shrink);
    expect(eased, `${name} did not shrink`).toBeLessThan(stretched);

    await separator.press(`Shift+${shrink}`);
    const shrunk = await expectAriaMatchesPane(page, name, `Shift+${shrink}`);
    expect(shrunk, `${name} ignored the Shift step downward`).toBeLessThan(eased);

    await separator.press('Home');
    const atMin = await readSeparator(page, name);
    expect(atMin.now).toBe(atMin.min);
    await expectAriaMatchesPane(page, name, 'Home');

    await separator.press('End');
    const atMax = await readSeparator(page, name);
    expect(atMax.now).toBe(atMax.max);
    await expectAriaMatchesPane(page, name, 'End');

    // Both pointer directions from wherever End left it.
    await drag(page, name, ...along(axis, -60));
    await expectAriaMatchesPane(page, name, 'drag back');
    await drag(page, name, ...along(axis, 30));
    await expectAriaMatchesPane(page, name, 'drag forward');

    // Double-click resets exactly this divider, and the promise still holds afterwards.
    await separator.dblclick();
    await expectAriaMatchesPane(page, name, 'reset');
  }
});

test('the inspection divider exchanges its pixels with Results alone', async ({ page }) => {
  await openMidiSample(page);
  await runSql(page, 'select i from range(300) t(i)');
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();

  const query0 = await heightOf(page, '#query-pane');
  const results0 = await heightOf(page, '.results-panel');
  const dock0 = await heightOf(page, '#inspection-pane');

  // Upward on the inspection divider grows the dock: its direction is -1.
  await drag(page, 'Resize inspection', 0, -100);
  await expect.poll(async () => Math.round((await heightOf(page, '#inspection-pane')) - dock0)).toBe(100);
  expect(Math.round(results0 - (await heightOf(page, '.results-panel')))).toBe(100);
  expect(Math.abs((await heightOf(page, '#query-pane')) - query0)).toBeLessThanOrEqual(1);
});

const LAYOUT_KEY = 'byteql.ui.layout.v1';
const storedLayout = (page: Page) => page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_KEY);

test('a passive shrink clamps the panes without rewriting what the user saved', async ({ page }) => {
  await openMidiSample(page);

  // Commit deliberately large sizes for both vertical panes.
  const query = page.getByRole('separator', { name: 'Resize query', exact: true });
  await query.focus();
  await query.press('Shift+ArrowDown');
  await query.press('Shift+ArrowDown');
  const inspection = page.getByRole('separator', { name: 'Resize inspection', exact: true });
  await inspection.focus();
  await inspection.press('Shift+ArrowUp');

  const chosen = {
    query: Math.round(await heightOf(page, '#query-pane')),
    dock: Math.round(await heightOf(page, '#inspection-pane')),
  };
  const saved = await storedLayout(page);
  expect(saved, 'the committed sizes must be on record before the shrink').not.toBeNull();
  const savedSizes = JSON.parse(saved!) as { queryHeight: number; dockHeight: number };
  expect(savedSizes.queryHeight).toBe(chosen.query);
  expect(savedSizes.dockHeight).toBe(chosen.dock);

  // A viewport too short for both preferences: the dock yields first, then the query.
  await page.setViewportSize({ width: 1440, height: 520 });
  await expect
    .poll(async () => Math.round(await heightOf(page, '#inspection-pane')))
    .toBeLessThan(chosen.dock);
  expect(Math.round(await heightOf(page, '#query-pane'))).toBeLessThanOrEqual(chosen.query);
  // Results never went below their own floor, whatever else had to give.
  expect(await heightOf(page, '.results-panel')).toBeGreaterThanOrEqual(127);
  // Nothing about a passive clamp is a choice, so nothing about it reaches storage.
  expect(await storedLayout(page)).toBe(saved);

  await page.setViewportSize({ width: 1440, height: 960 });
  await expect.poll(async () => Math.round(await heightOf(page, '#query-pane'))).toBe(chosen.query);
  expect(Math.round(await heightOf(page, '#inspection-pane'))).toBe(chosen.dock);
  expect(await storedLayout(page)).toBe(saved);
});

/**
 * Everything on the page that actually scrolls, by CSS selector, so a new accidental scroll
 * owner (or a lost one) is visible rather than merely absent from an assertion.
 */
const scrollOwners = (page: Page) =>
  page.evaluate(() => {
    const describe = (element: Element): string => {
      const classes = Array.from(element.classList)
        .filter((name) => !name.startsWith('svelte-'))
        .join('.');
      return classes ? `${element.tagName.toLowerCase()}.${classes}` : element.tagName.toLowerCase();
    };
    // Only elements that can actually scroll count. An `overflow: visible` box reports a
    // scrollHeight larger than its client height too, but the scrolling belongs to an ancestor.
    const scrollable = (value: string): boolean => value === 'auto' || value === 'scroll';
    const owners: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      const x = scrollable(style.overflowX) ? element.scrollWidth - element.clientWidth : 0;
      const y = scrollable(style.overflowY) ? element.scrollHeight - element.clientHeight : 0;
      if (x > 1 || y > 1) owners.push(`${describe(element)}${x > 1 ? ' x' : ''}${y > 1 ? ' y' : ''}`);
    }
    const workspace = document.querySelector('.sql-workspace') as HTMLElement;
    const workspaceStyle = getComputedStyle(workspace);
    return {
      owners,
      // The grid itself must never become a second scroller inside the one that owns it.
      workspaceScrolls: scrollable(workspaceStyle.overflowX) || scrollable(workspaceStyle.overflowY),
      documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
      mainOverflowY: (() => {
        const main = document.querySelector('.workbench-main') as HTMLElement;
        return main.scrollHeight - main.clientHeight;
      })(),
    };
  });

/**
 * Brings the element into view through every scrollable ancestor at once and then hit-tests it
 * where a pointer would land. Done in a single evaluation on purpose: at these heights the
 * notices box and the workspace scroller are nested, and Playwright's own retrying
 * scroll-then-hover oscillates between them instead of settling.
 */
async function expectReachable(locator: ReturnType<Page['locator']>, what: string) {
  await expect(locator, `${what} is not visible`).toBeVisible();
  const hit = await locator.evaluate((node) => {
    node.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = node.getBoundingClientRect();
    const x = rect.left + Math.min(rect.width / 2, 24);
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y);
    return {
      reached: target === node || node.contains(target) || (target?.contains(node) ?? false),
      blockedBy: target ? `${target.tagName.toLowerCase()}.${target.className}` : 'nothing',
      inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
    };
  });
  expect(hit.inViewport, `${what} cannot be scrolled fully into the viewport`).toBe(true);
  expect(hit.reached, `${what} is covered by ${hit.blockedBy}`).toBe(true);
}

for (const { width, height } of [
  { width: 1440, height: 480 },
  { width: 844, height: 390 },
]) {
  test(`a ${width}x${height} viewport scrolls the workspace instead of overflowing the page`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await openMidiSample(page);
    // A real diagnostic, so the error text is one of the things that has to stay reachable.
    await runSql(page, 'select * from not_a_table');
    await expect(page.getByRole('alert')).toBeVisible();

    const geometry = await scrollOwners(page);
    // No horizontal page overflow at either extreme, on the document or the body.
    expect(geometry.documentOverflowX, 'the document scrolls sideways').toBeLessThanOrEqual(0);
    expect(geometry.bodyOverflowX, 'the body scrolls sideways').toBeLessThanOrEqual(0);
    // The workspace is the vertical scroll owner, and it is genuinely scrolling here.
    expect(geometry.mainOverflowY, 'the workspace has nothing to scroll').toBeGreaterThan(0);
    expect(geometry.workspaceScrolls, 'the workspace grid became a second scroller').toBe(false);
    for (const owner of geometry.owners) {
      expect(
        [
          '.workbench-main', // the workspace's own vertical scroller
          '.grid-scroll', // results, both axes
          '.cm-scroller', // the SQL document, both axes
          '.hex-viewport', // Bytes, horizontally
          '.explorer', // the source catalog
          '.query-notices-scroll', // the design's bounded notices area, min(160px, 25dvh)
          '.inspector', // the Values column's own content scroller
        ].some((allowed) => owner.includes(allowed)),
        `unexpected scroll owner: ${owner} (all: ${geometry.owners.join(', ')})`,
      ).toBe(true);
    }

    // The notices row is `auto` in a workspace that no longer fits: it must keep the height its
    // content needs (bounded by its own scroller) rather than being squeezed out of existence.
    const notices = await page.evaluate(() => {
      const row = document.querySelector('.query-notices') as HTMLElement;
      const scroller = document.querySelector('.query-notices-scroll') as HTMLElement;
      return { row: row.offsetHeight, scroller: scroller.offsetHeight };
    });
    expect(notices.row, 'the notices row collapsed away').toBeGreaterThan(0);
    expect(notices.row).toBe(notices.scroller);

    await expectReachable(page.getByRole('button', { name: 'Run query' }), 'Run query');
    // The notices area is a bounded scroller, so the diagnostic is reached through it: its
    // heading has to be hittable and its message has to be readable in full.
    await expectReachable(page.getByRole('alert').locator('strong'), 'the query diagnostic');
    await expect(page.getByRole('alert')).toContainText('not_a_table');
    await expectReachable(page.getByRole('heading', { name: 'Results', exact: true }), 'Results');
    await expectReachable(page.locator('.trace-dock-strip'), 'the trace strip');
    await expectReachable(page.locator('.status-bar'), 'the status bar');
  });
}

test('a diagnostic arriving mid-drag cancels it and leaves nothing behind', async ({ page }) => {
  await openMidiSample(page);
  expect(await storedLayout(page), 'this test needs a session that has saved nothing yet').toBeNull();

  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill('select * from not_a_table');

  const before = Math.round(await heightOf(page, '#query-pane'));
  const handle = page.getByRole('separator', { name: 'Resize query', exact: true });
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 90, { steps: 10 });
  await expect.poll(async () => Math.round(await heightOf(page, '#query-pane'))).toBeGreaterThan(before);

  // The pointer is captured by the divider, so the query can only be started from script — which
  // is exactly the case this covers: something else changes the layout mid-drag.
  await page.evaluate(() => {
    const run = document.querySelector('.query-actions button') as HTMLButtonElement;
    run.click();
  });
  await expect(page.getByRole('alert')).toBeVisible();

  // The drag is gone: the pane is back where it started and the preview was rolled back.
  await expect.poll(async () => Math.round(await heightOf(page, '#query-pane'))).toBe(before);

  const residue = await page.evaluate(() => ({
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
    captured: (
      document.querySelector('[aria-label="Resize query"]') as HTMLElement & {
        hasPointerCapture(id: number): boolean;
      }
    ).hasPointerCapture(1),
  }));
  expect(residue.cursor, 'the drag cursor is still on the body').toBe('');
  expect(residue.userSelect, 'the selection lock is still on the body').toBe('');
  expect(residue.captured, 'the divider still holds the pointer').toBe(false);
  expect(await storedLayout(page), 'a cancelled drag wrote a size to storage').toBeNull();

  // The pointerup that arrives after the cancellation must not resurrect the transaction.
  await page.mouse.move(x, y + 120);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(Math.round(await heightOf(page, '#query-pane'))).toBe(before);
  expect(await storedLayout(page)).toBeNull();
});

/**
 * The query divider's published maximum, recomputed from the rendered chrome: the workspace's
 * own height less the measured toolbars, notices and divider tracks, less the dock, less the
 * 128 px Results floor. If a track stops being charged for, these two stop agreeing.
 */
const solvedQueryHeadroom = (page: Page) =>
  page.evaluate(() => {
    const height = (selector: string) => (document.querySelector(selector) as HTMLElement).offsetHeight;
    const main = document.querySelector('.workbench-main') as HTMLElement;
    const gutter = height('.query-resize-slot');
    const chrome =
      height('.editor-heading') + height('.query-notices') + height('.results-heading') + 2 * gutter;
    return main.clientHeight - chrome - height('#inspection-pane') - 128;
  });

test('a diagnostic moves the query divider bounds without overlap or an observer loop', async ({ page }) => {
  await openMidiSample(page);
  const handle = page.getByRole('separator', { name: 'Resize query', exact: true });
  const quiet = await readSeparator(page, 'Resize query');
  expect(Math.round(await heightOf(page, '.query-notices'))).toBe(0);

  expect(await solvedQueryHeadroom(page)).toBe(quiet.max);

  await runSql(page, 'select * from not_a_table');
  await expect(page.getByRole('alert')).toBeVisible();
  expect(Math.round(await heightOf(page, '.query-notices'))).toBeGreaterThan(0);
  // Notices are chrome: once the measurement frame lands, the headroom the divider publishes is
  // again exactly the budget minus the measured chrome, the dock, and the Results floor.
  await expect
    .poll(async () => (await solvedQueryHeadroom(page)) - (await readSeparator(page, 'Resize query')).max)
    .toBe(0);
  const noticed = await readSeparator(page, 'Resize query');
  expect(noticed.max, 'the notices took no headroom from the divider').toBeLessThan(quiet.max);
  expect(noticed.now).toBe(quiet.now);

  // Nothing oscillates: two reads a beat apart agree, and the divider is still hittable.
  const settled = await page.evaluate(() => ({
    query: (document.querySelector('#query-pane') as HTMLElement).offsetHeight,
    notices: (document.querySelector('.query-notices') as HTMLElement).offsetHeight,
  }));
  await page.waitForTimeout(600);
  expect(
    await page.evaluate(() => ({
      query: (document.querySelector('#query-pane') as HTMLElement).offsetHeight,
      notices: (document.querySelector('.query-notices') as HTMLElement).offsetHeight,
    })),
  ).toEqual(settled);

  // The rows stay in order and nothing overlaps the divider track.
  const stack = await page.evaluate(() =>
    ['#query-pane', '.query-notices', '.query-resize-slot', '.results-heading', '.results-panel'].map(
      (selector) => {
        const rect = (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
        return { selector, top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
      },
    ),
  );
  for (let index = 1; index < stack.length; index += 1) {
    expect(
      stack[index].top,
      `${stack[index].selector} overlaps ${stack[index - 1].selector}`,
    ).toBeGreaterThanOrEqual(stack[index - 1].bottom);
  }
  expect(
    await handle.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === node;
    }),
    'the divider stopped being the topmost element at its own centre',
  ).toBe(true);

  // And it still resizes with the diagnostic on screen.
  await drag(page, 'Resize query', 0, 40);
  await expect.poll(async () => Math.round(await heightOf(page, '#query-pane')) - quiet.now).toBe(40);
});

/**
 * The dock's published minimum is the only place the byte pane's reported chrome becomes
 * observable from outside: `minDock = strip + tabs + max(112, hexChrome + 72)`. Recomputing
 * `hexChrome` here from its three real parts is what pins the composition — unit tests can only
 * stub the element geometry it is built from.
 */
const hexChromeParts = (page: Page) =>
  page.evaluate(() => {
    const pane = document.querySelector('[data-hex-pane]') as HTMLElement;
    const chrome = pane.querySelector('.hex-chrome') as HTMLElement;
    const viewport = pane.querySelector('.hex-viewport') as HTMLElement;
    const strip = document.querySelector('.trace-dock-strip') as HTMLElement;
    const tabs = document.querySelector('.trace-dock-tabs') as HTMLElement | null;
    return {
      chrome: chrome.offsetHeight,
      paneBorder: pane.offsetHeight - pane.clientHeight,
      viewportScrollbar: viewport.offsetHeight - viewport.clientHeight,
      strip: strip.offsetHeight,
      tabs: tabs && !tabs.hidden ? tabs.offsetHeight : 0,
    };
  });

const composedDockMinimum = (parts: Awaited<ReturnType<typeof hexChromeParts>>): number => {
  const hexChrome = parts.chrome + parts.paneBorder + parts.viewportScrollbar;
  return Math.max(40, parts.strip) + parts.tabs + Math.max(112, hexChrome + 72);
};

test('the dock floor is composed from the byte pane chrome the browser actually renders', async ({
  page,
}) => {
  await openMidiSample(page);
  const separator = page.getByRole('separator', { name: 'Resize inspection', exact: true });
  // A result with byte provenance: the pane shows its toolbar and no coverage hint.
  await runSql(page, 'select * from events limit 50');
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  await expect(page.locator('[data-hex-hint]')).toHaveCount(0);

  const parts = await hexChromeParts(page);
  expect(parts.chrome, 'the byte pane reported no chrome at all').toBeGreaterThan(0);
  await expect
    .poll(async () => Number(await separator.getAttribute('aria-valuemin')))
    .toBe(composedDockMinimum(parts));

  // The published floor is the real floor: Home lands exactly on it.
  await separator.focus();
  await separator.press('Home');
  await expect
    .poll(async () => Math.round(await heightOf(page, '#inspection-pane')))
    .toBe(composedDockMinimum(parts));

  // Growing the chrome moves the floor with it. An aggregate has no byte provenance, so the pane
  // adds a real coverage hint row inside `.hex-chrome`; nothing else about the pane changes.
  await runSql(page, 'select count(*) as n from events');
  await expect(page.locator('[data-hex-hint]')).toBeVisible();
  const grown = await hexChromeParts(page);
  expect(grown.chrome, 'the coverage hint did not grow the chrome').toBeGreaterThan(parts.chrome);
  await expect
    .poll(async () => Number(await separator.getAttribute('aria-valuemin')))
    .toBe(composedDockMinimum(grown));
  // And the dock follows its floor up rather than clipping the pane.
  await expect
    .poll(async () => Math.round(await heightOf(page, '#inspection-pane')))
    .toBe(composedDockMinimum(grown));
});

test('a narrowed Bytes pane keeps the caret exposed and reaches the end of the file', async ({ page }) => {
  await openMidiSample(page);
  const geometry = await hexGeometry(page);
  await narrowBytesByDragging(page);

  const overflow = await hexViewport(page).evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeGreaterThan(0);

  // Park the scroll at the ASCII end, then walk the caret back with the keyboard: the hex cell
  // it lands on has to be brought back into the clip box.
  await gotoHexOffset(page, 0);
  await scrollBytesTo(page, overflow);
  await hexViewport(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-hex-pane]')).toHaveAttribute('data-hex-caret', '1');
  const exposed = async (index: number) =>
    hexViewport(page).evaluate(
      (node, x) => {
        const canvas = node.querySelector('.hex-canvas') as HTMLElement;
        const left = canvas.getBoundingClientRect().left + x;
        const clip = node.getBoundingClientRect();
        return left >= clip.left - 0.5 && left <= clip.right + 0.5;
      },
      hexByteX(geometry, index) + geometry.charWidth,
    );
  expect(await exposed(1), 'the caret cell is still off-screen after ArrowRight').toBe(true);

  // Control+End goes to the last byte of the file: its row is painted and its cell is exposed.
  await page.keyboard.press('Control+End');
  const caret = Number(await page.locator('[data-hex-pane]').getAttribute('data-hex-caret'));
  expect(caret).toBeGreaterThan(0);
  const tail = await page.evaluate(() => {
    const pane = document.querySelector('[data-hex-pane]') as HTMLElement;
    const viewport = pane.querySelector('.hex-viewport') as HTMLElement;
    return {
      firstRow: Number(pane.dataset.hexFirstRow),
      rows: Math.floor(viewport.clientHeight / 18),
    };
  });
  expect(Math.floor(caret / 16)).toBeGreaterThanOrEqual(tail.firstRow);
  expect(Math.floor(caret / 16)).toBeLessThan(tail.firstRow + tail.rows + 1);
  expect(await exposed(caret % 16)).toBe(true);
});

test('a legacy hex height becomes the dock height, and only the new record is written', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('byteql.hexpane.height', '320');
  });
  await openMidiSample(page);

  await expect.poll(async () => Math.round(await heightOf(page, '#inspection-pane'))).toBe(320);
  // Reading a legacy record migrates it in memory; it is not written back until the user resizes.
  expect(await storedLayout(page)).toBeNull();

  const separator = page.getByRole('separator', { name: 'Resize inspection', exact: true });
  await separator.focus();
  await separator.press('ArrowUp');
  const record = JSON.parse((await storedLayout(page))!) as Record<string, unknown>;
  expect(record.version).toBe(1);
  expect(record.dockHeight).toBe(338);
  expect(record.sourcesWidth).toBeNull();
  expect(record.valuesWidth).toBeNull();
});

test('only the dividers a layout actually has are in the tab sequence', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMidiSample(page);

  const separators = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="separator"]')).map((node) => ({
        label: node.getAttribute('aria-label'),
        tabindex: node.getAttribute('tabindex'),
      })),
    );

  expect(await separators()).toEqual([
    { label: 'Resize sources', tabindex: '0' },
    { label: 'Resize query', tabindex: '0' },
    { label: 'Resize inspection', tabindex: '0' },
    { label: 'Resize values', tabindex: '0' },
  ]);

  // Tabbing the dock and collapsing Sources must remove those separators from the document, not
  // merely hide them: an aria-hidden or display:none divider left at tabindex 0 still traps Tab.
  const sources = page.getByRole('separator', { name: 'Resize sources', exact: true });
  await sources.focus();
  await sources.press('End');
  await expect(page.getByRole('tablist', { name: 'Inspection views' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Hide sources', exact: true }).click();
  expect(await separators()).toEqual([
    { label: 'Resize query', tabindex: '0' },
    { label: 'Resize inspection', tabindex: '0' },
  ]);

  // A real Tab walk agrees: it reaches both survivors and never lands on a removed one.
  await page.locator('.app-header').getByRole('button').first().focus();
  const visited: string[] = [];
  for (let press = 0; press < 40; press += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const active = document.activeElement;
      return active?.getAttribute('role') === 'separator' ? active.getAttribute('aria-label') : null;
    });
    if (label) visited.push(label);
    if (visited.length === 2) break;
  }
  expect(visited).toEqual(['Resize query', 'Resize inspection']);
});

test('a reload with no source keeps the chosen sizes until a source is loaded again', async ({ page }) => {
  await openMidiSample(page);
  await drag(page, 'Resize sources', 60, 0);
  const query = page.getByRole('separator', { name: 'Resize query', exact: true });
  await query.focus();
  await query.press('Shift+ArrowDown');

  const chosen = {
    sources: Math.round(await widthOf(page, '#source-pane')),
    query: Math.round(await heightOf(page, '#query-pane')),
  };
  const saved = await storedLayout(page);

  // Back to intake: no source, so the shell mounts no catalog and offers no divider at all.
  await page.reload();
  await waitForAppReady(page);
  await expect(page.getByRole('separator')).toHaveCount(0);
  expect(await storedLayout(page), 'an idle reload rewrote the record').toBe(saved);

  await openMidiSample(page, { navigate: false });
  await expect.poll(async () => Math.round(await widthOf(page, '#source-pane'))).toBe(chosen.sources);
  expect(Math.round(await heightOf(page, '#query-pane'))).toBe(chosen.query);
});

test('a wide result keeps one scroller and its selected row across a resize', async ({ page }) => {
  await openMidiSample(page);
  await runSql(
    page,
    'select i as alpha, i as bravo, i as charlie, i as delta, i as echo, i as foxtrot, ' +
      'i as golf, i as hotel, i as india, i as juliet from range(300) t(i)',
  );
  await expect(page.locator('.results-heading-meta').getByText('300 rows', { exact: true })).toBeVisible();

  const scroll = page.locator('.grid-scroll');
  await scroll.evaluate((node) => {
    node.scrollTop = 200 * 36;
    node.dispatchEvent(new Event('scroll'));
  });
  const row = page.getByRole('row', { name: 'Row 205', exact: true });
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true');

  const before = await page.evaluate(() => {
    const grid = document.querySelector('.result-grid') as HTMLElement;
    const scroller = document.querySelector('.grid-scroll') as HTMLElement;
    const header = document.querySelector('.result-grid [role="columnheader"]') as HTMLElement;
    return {
      gridOverflowX: grid.scrollWidth - grid.clientWidth,
      scrollerOverflowX: scroller.scrollWidth - scroller.clientWidth,
      rowHeight: (document.querySelector('.result-grid [role="row"]') as HTMLElement).offsetHeight,
      headerLeft: Math.round(header.getBoundingClientRect().left),
      cellLeft: Math.round(
        (
          document.querySelector(
            '.result-grid [role="row"][aria-selected="true"] [role="gridcell"]',
          ) as HTMLElement
        ).getBoundingClientRect().left,
      ),
    };
  });
  // One two-axis scroller, and the header column is aligned with the row cell beneath it.
  expect(before.gridOverflowX).toBe(0);
  expect(before.scrollerOverflowX).toBeGreaterThan(0);
  expect(before.headerLeft).toBe(before.cellLeft);

  await drag(page, 'Resize values', 120, 0);
  await drag(page, 'Resize query', 0, 60);

  const after = await page.evaluate(() => {
    const grid = document.querySelector('.result-grid') as HTMLElement;
    const scroller = document.querySelector('.grid-scroll') as HTMLElement;
    const header = document.querySelector('.result-grid [role="columnheader"]') as HTMLElement;
    return {
      gridOverflowX: grid.scrollWidth - grid.clientWidth,
      scrollerOverflowX: scroller.scrollWidth - scroller.clientWidth,
      rowHeight: (document.querySelector('.result-grid [role="row"]') as HTMLElement).offsetHeight,
      headerLeft: Math.round(header.getBoundingClientRect().left),
      cellLeft: Math.round(
        (
          document.querySelector(
            '.result-grid [role="row"][aria-selected="true"] [role="gridcell"]',
          ) as HTMLElement
        ).getBoundingClientRect().left,
      ),
    };
  });
  expect(after.gridOverflowX).toBe(0);
  expect(after.scrollerOverflowX).toBeGreaterThan(0);
  expect(after.rowHeight).toBe(before.rowHeight);
  expect(after.headerLeft).toBe(after.cellLeft);
  // The selection is a global row, not a window index: it is still the same row.
  await expect(page.getByRole('row', { name: 'Row 205', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test.describe('coarse pointers', () => {
  test.use({ hasTouch: true, viewport: { width: 1440, height: 960 } });

  test('every divider track is 24 px wide and hittable off its centre line', async ({ page }) => {
    await openMidiSample(page);
    expect(
      await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches),
      'this context is not reported as a coarse pointer',
    ).toBe(true);
    expect(
      await page
        .locator('.app-shell')
        .evaluate((node) => getComputedStyle(node).getPropertyValue('--panel-gutter').trim()),
    ).toBe('24px');

    for (const { name, axis } of SEPARATORS) {
      const handle = page.getByRole('separator', { name, exact: true });
      const box = (await handle.boundingBox())!;
      const thickness = axis === 'x' ? box.width : box.height;
      expect(Math.round(thickness), `${name} is not a coarse-pointer target`).toBe(24);
      // A touch lands anywhere in the gutter, not only on the 1 px rule: both edges must hit it.
      for (const offset of [-10, 10]) {
        const hit = await handle.evaluate(
          (node, [dx, dy]) => {
            const rect = node.getBoundingClientRect();
            const point = document.elementFromPoint(
              rect.x + rect.width / 2 + dx,
              rect.y + rect.height / 2 + dy,
            );
            return point === node;
          },
          along(axis, offset),
        );
        expect(hit, `${name} does not receive a pointer ${offset} px off its centre`).toBe(true);
      }
    }

    // And the wider track still drags: grabbing 10 px off-centre resizes by the travel, not by
    // the travel plus the grab offset.
    const before = Math.round(await widthOf(page, '#source-pane'));
    const box = (await page.getByRole('separator', { name: 'Resize sources', exact: true }).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 10 + 40, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => Math.round(await widthOf(page, '#source-pane'))).toBe(before + 40);
  });
});
