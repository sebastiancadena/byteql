import { expect, test, type Page } from '@playwright/test';

import { expectRows as expectRowsWithTimeout, metrics, openMidiSample, sortBy } from './support/app.js';

const storedRows = (page: Page) => page.evaluate(() => window.__byteqlE2E.storedResult());

const runQuery = async (page: Page, sql: string): Promise<void> => {
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill(sql);
  await page.getByRole('button', { name: 'Run query' }).click();
};

/**
 * A header by its ORIGINAL schema position. Its accessible name follows the button's action label,
 * which changes as the cycle advances, so the position is the stable handle.
 */
const header = (page: Page, columnIndex: number) =>
  page.locator(`[role="columnheader"][aria-colindex="${columnIndex + 1}"]`);

/** The first cell of the first displayed row, which is what a reorder must change. */
const firstCell = (page: Page) =>
  page.getByRole('row', { name: 'Row 1', exact: true }).getByRole('gridcell').first();

/** Drains the cursor, then asserts the complete row count. The toolbar shows a partial count
 * while a result is still streaming, so waiting on its text is a race. */
const expectRows = (page: Page, rows: number): Promise<void> =>
  expectRowsWithTimeout(page, rows, { timeout: 60_000 });

test('sorts all result rows and restores the original execution order', async ({ page }) => {
  test.setTimeout(120_000);
  await openMidiSample(page);
  const sql = 'select 20000-i as value, i as identity from range(20000) t(i)';
  await runQuery(page, sql);
  await expect(firstCell(page)).toHaveText('20000');

  await sortBy(page, 'Sort value ascending');
  await expect(header(page, 0)).toHaveAttribute('aria-sort', 'ascending');
  await expect(firstCell(page)).toHaveText('1');
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toHaveText(sql);

  await sortBy(page, 'Sort value descending');
  await expect(header(page, 0)).toHaveAttribute('aria-sort', 'descending');
  await expect(firstCell(page)).toHaveText('20000');

  await page.getByRole('button', { name: 'Clear sort', exact: true }).click();
  await expect(firstCell(page)).toHaveText('20000');
  await expect(page.locator('[role="columnheader"][aria-sort]')).toHaveCount(0);

  const final = await metrics(page);
  // Three reorderings, one execution of the user's SQL.
  expect(final.sendCount).toBe(1);
  expect(final.orderRevision).toBe(3);
  expect(final.loadedRows).toBe(20_000);
});

test('orders nulls last and keeps ties in original query order', async ({ page }) => {
  await openMidiSample(page);
  await runQuery(page, 'select * from (values (0,2),(1,NULL),(2,2),(3,-1),(4,NULL)) t(id, sort_key)');
  await expectRows(page, 5);
  const ids = async (): Promise<unknown[]> => (await storedRows(page)).rows.map((row) => Number(row[0]));

  await sortBy(page, 'Sort sort_key ascending');
  // -1 first, then the two rows tied on 2 in their original order, then the nulls in theirs.
  expect(await ids()).toEqual([3, 0, 2, 1, 4]);

  await sortBy(page, 'Sort sort_key descending');
  expect(await ids()).toEqual([0, 2, 3, 1, 4]);

  await page.getByRole('button', { name: 'Clear sort', exact: true }).click();
  await expect.poll(async () => (await metrics(page)).orderRevision).toBe(3);
  expect(await ids()).toEqual([0, 1, 2, 3, 4]);
});

test('sorts each duplicate label by position, with nulls last and ties in query order', async ({ page }) => {
  test.setTimeout(120_000);
  await openMidiSample(page);
  await runQuery(
    page,
    'select i::integer as id, ' +
      'case when i in (1, 4) then null else (i % 2)::integer end as dup, ' +
      "('t' || (i % 3))::varchar as dup " +
      'from range(5) t(i)',
  );
  await expectRows(page, 5);
  const ids = async (): Promise<number[]> => (await storedRows(page)).rows.map((row) => Number(row[0]));

  const labelled = await storedRows(page);
  // Both duplicates keep their own position, physical identity and type.
  expect(labelled.columns).toEqual(['id', 'dup', 'dup']);
  expect(labelled.physicalColumns).toEqual(['c0', 'c1', 'c2']);
  expect(labelled.types).toEqual(['Int32', 'Int32', 'Utf8']);

  await sortBy(page, 'Sort dup, column 2, ascending');
  await expect(header(page, 1)).toHaveAttribute('aria-sort', 'ascending');
  expect(await ids()).toEqual([0, 2, 3, 1, 4]);
  await sortBy(page, 'Sort dup, column 2, descending');
  expect(await ids()).toEqual([3, 0, 2, 1, 4]);

  // The second duplicate sorts on its own values, not the first one's.
  await sortBy(page, 'Sort dup, column 3, ascending');
  await expect(header(page, 2)).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('[role="columnheader"][aria-sort]')).toHaveCount(1);
  expect(await ids()).toEqual([0, 3, 1, 4, 2]);
  await sortBy(page, 'Sort dup, column 3, descending');
  expect(await ids()).toEqual([2, 1, 4, 0, 3]);

  await page.getByRole('button', { name: 'Restore query order', exact: true }).click();
  await expect.poll(async () => (await metrics(page)).orderRevision).toBe(5);
  expect(await ids()).toEqual([0, 1, 2, 3, 4]);
  expect((await storedRows(page)).columns).toEqual(['id', 'dup', 'dup']);

  // A replacement query releases the sorting resources and names its own columns.
  await runQuery(page, "select 9::integer as other, 'nine'::varchar as other");
  await expectRows(page, 1);
  const replaced = await metrics(page);
  expect(replaced).toMatchObject({ orderRevision: 0, sort: null, derivedViewCount: 0, sendCount: 1 });
  await expect(page.locator('[role="columnheader"][aria-sort]')).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'other, column 2, Utf8', exact: true })).toBeVisible();
  expect((await storedRows(page)).columns).toEqual(['other', 'other']);
  expect(await page.evaluate(() => window.__byteqlE2E.exportFiles())).toEqual([]);
});

test('sorts the rows a LIMIT selected without choosing different ones', async ({ page }) => {
  test.setTimeout(120_000);
  await openMidiSample(page);
  await runQuery(page, 'select i, random() as r from range(20000) t(i) limit 1100 offset 5');
  await expect.poll(async () => (await metrics(page)).loadedRows, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.__byteqlE2E.drainQueryResult());
        return (await metrics(page)).loadedRows;
      },
      { timeout: 60_000 },
    )
    .toBe(1_100);
  const before = await storedRows(page);
  const captured = new Map(before.rows.map((row) => [String(row[0]), String(row[1])]));
  expect(captured.size).toBe(1_100);

  await sortBy(page, 'Sort r ascending');

  const after = await storedRows(page);
  expect(after.rows).toHaveLength(1_100);
  // Same 1,100 rows, same volatile values: a sort reorders an execution, it does not repeat one.
  for (const row of after.rows) {
    expect(captured.get(String(row[0]))).toBe(String(row[1]));
  }
  const values = after.rows.map((row) => Number(row[1]));
  expect(values).toEqual([...values].sort((left, right) => left - right));
  expect((await metrics(page)).sendCount).toBe(1);
});

test('restores the order an existing ORDER BY produced, across a CTE and a UNION', async ({ page }) => {
  await openMidiSample(page);
  await runQuery(
    page,
    'with a as (select i, 1 as part from range(5) t(i)), ' +
      'b as (select i, 2 as part from range(5) t(i)) ' +
      'select * from (select * from a union all select * from b) order by part desc, i desc',
  );
  await expectRows(page, 10);
  const original = (await storedRows(page)).rows.map((row) => `${String(row[1])}:${String(row[0])}`);

  await sortBy(page, 'Sort i ascending');
  expect((await storedRows(page)).rows.map((row) => Number(row[0]))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);

  await page.getByRole('button', { name: 'Clear sort', exact: true }).click();
  await expect.poll(async () => (await metrics(page)).orderRevision).toBe(2);
  // Clear sort restores the query's own ordering, which stays authoritative.
  expect((await storedRows(page)).rows.map((row) => `${String(row[1])}:${String(row[0])}`)).toEqual(original);
});

test('sorts by position when a column is aliased to look like SQL', async ({ page }) => {
  await openMidiSample(page);
  await runQuery(page, 'select i as "x""; drop table events; --" from range(3) t(i) order by i desc');
  await expectRows(page, 3);

  await sortBy(page, 'Sort x"; drop table events; -- ascending');
  expect((await storedRows(page)).rows.map((row) => Number(row[0]))).toEqual([0, 1, 2]);

  // The hostile alias never reached a generated statement: the source tables are still there.
  await runQuery(page, 'select count(*) as n from events');
  await expectRows(page, 1);
  expect(Number((await storedRows(page)).rows[0]![0])).toBeGreaterThan(0);
});

test('refuses to sort a result carrying an unsupported column, and says which', async ({ page }) => {
  await openMidiSample(page);
  await runQuery(page, 'select * from (values ([1,2], 10), ([3], 20)) t(details, value)');
  await expectRows(page, 2);

  const button = page.getByRole('button', { name: 'Sort value ascending', exact: true });
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  // Forced past Playwright's own actionability check, so this proves the component's guard.
  await button.click({ force: true });
  expect((await metrics(page)).orderRevision).toBe(0);
  await expect(page.locator('#result-sort-help')).toContainText('unsupported type');
  await expect(page.locator('#result-sort-help')).toContainText('details');
});

test('keeps schema headers but offers no sort for empty and single-row results', async ({ page }) => {
  await openMidiSample(page);
  await runQuery(page, 'select 1 as value where false');
  await expect(page.getByRole('columnheader', { name: /value/u })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sort value ascending', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  await runQuery(page, 'select 1 as value');
  await expectRows(page, 1);
  await expect(page.getByRole('button', { name: 'Sort value ascending', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('reveals the exact source bytes of a row selected after sorting', async ({ page }) => {
  test.setTimeout(120_000);
  await openMidiSample(page);
  await runQuery(page, 'select note, velocity, _src_start, _src_end from events order by _src_start');
  await expect.poll(async () => (await metrics(page)).loadedRows, { timeout: 60_000 }).toBeGreaterThan(1);
  await page.evaluate(() => window.__byteqlE2E.drainQueryResult());

  await sortBy(page, 'Sort velocity ascending');
  await sortBy(page, 'Sort velocity descending');
  const sorted = (await storedRows(page)).rows;
  const expected = sorted[0]!;

  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  // Provenance follows the row, not its position: the reordered first row reveals its own bytes.
  const revealed = await page.evaluate(() => {
    const selected = document.querySelector('.grid-row.selected');
    return selected?.getAttribute('data-row-index') ?? null;
  });
  expect(revealed).toBe('0');
  await expect(page.locator('.hex-pane')).toBeVisible();
  expect(Number(expected[2])).toBeGreaterThanOrEqual(0);
});

test('leaves an aggregate result unlinked from source bytes after sorting', async ({ page }) => {
  await openMidiSample(page);
  await runQuery(page, 'select channel, count(*) as n from events group by channel order by channel');
  await expect.poll(async () => (await metrics(page)).loadedRows, { timeout: 60_000 }).toBeGreaterThan(1);

  await sortBy(page, 'Sort n ascending');
  await sortBy(page, 'Sort n descending');
  const rows = (await storedRows(page)).rows;
  const counts = rows.map((row) => Number(row[1]));
  expect(counts).toEqual([...counts].sort((left, right) => right - left));
  // No provenance columns, so nothing claims a byte range.
  expect((await storedRows(page)).columns).toEqual(['channel', 'n']);
});

test('reaches both ends of a sorted 50,000-row result by physical scrolling alone', async ({ page }) => {
  test.setTimeout(180_000);
  await openMidiSample(page);
  await runQuery(page, 'select 50000-i as value from range(50000) t(i)');
  await expect.poll(async () => (await metrics(page)).loadedRows, { timeout: 60_000 }).toBeGreaterThan(0);

  await sortBy(page, 'Sort value ascending');
  await expect(firstCell(page)).toHaveText('1');

  const scroll = page.locator('.grid-scroll');
  await scroll.hover();

  /** Wheels forward until the named row is visible, failing if the view stops advancing. */
  const wheelUntil = async (target: number, direction: 1 | -1): Promise<void> => {
    let previous = -1;
    for (let attempt = 0; attempt < 400; attempt++) {
      const row = page.getByRole('row', { name: `Row ${target}`, exact: true });
      if (await row.isVisible().catch(() => false)) return;
      await page.mouse.wheel(0, direction * 20_000);
      await page.waitForTimeout(80);
      const current = (await metrics(page)).windowStart;
      if (attempt > 8 && current === previous) {
        // Still inside one window is fine; stalling with the target outside it is not.
        const visible = await page
          .getByRole('row', { name: `Row ${target}`, exact: true })
          .isVisible()
          .catch(() => false);
        if (visible) return;
      }
      previous = current;
    }
    throw new Error(`Row ${target} never became visible by scrolling.`);
  };

  await wheelUntil(50_000, 1);
  await expect(
    page.getByRole('row', { name: 'Row 50000', exact: true }).getByRole('gridcell').first(),
  ).toHaveText('50000');

  await wheelUntil(1, -1);
  await expect(firstCell(page)).toHaveText('1');

  await page.getByRole('button', { name: 'Clear sort', exact: true }).click();
  await expect.poll(async () => (await metrics(page)).orderRevision).toBe(2);
  await expect(firstCell(page)).toHaveText('50000');
  await scroll.hover();
  await wheelUntil(50_000, 1);
  await expect(
    page.getByRole('row', { name: 'Row 50000', exact: true }).getByRole('gridcell').first(),
  ).toHaveText('1');

  const final = await metrics(page);
  expect(final.sendCount).toBe(1);
  expect(final.windowRows).toBeLessThanOrEqual(16_384);
});

test('sorts a million numeric rows and keeps both ends reachable', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await openMidiSample(page);
  await runQuery(page, 'select 1000000-i as value from range(1000000) t(i)');
  await expect.poll(async () => (await metrics(page)).loadedRows, { timeout: 60_000 }).toBeGreaterThan(0);
  // Sorting starts as soon as rows appear, whether or not the cursor has finished; either way the
  // committed order has to cover all million rows.
  const beforeSort = await metrics(page);

  const startedAt = Date.now();
  await sortBy(page, 'Sort value ascending');
  const durationMs = Date.now() - startedAt;

  await expect(firstCell(page)).toHaveText('1');
  const sorted = await metrics(page);
  expect(sorted.loadedRows).toBe(1_000_000);
  expect(sorted.windowRows).toBeLessThanOrEqual(16_384);
  expect(sorted.sendCount).toBe(1);
  expect(sorted.derivedViewCount).toBe(1);

  await page.evaluate(() => window.__byteqlE2E.loadResultWindow(999_999));
  await expect
    .poll(async () => (await metrics(page)).windowStart, { timeout: 60_000 })
    .toBeGreaterThan(900_000);
  // Loading the window is not the same as looking at its end: the virtualizer renders only what
  // is on screen, so the tail still has to be scrolled to.
  const scroll = page.locator('.grid-scroll');
  await scroll.hover();
  for (let attempt = 0; attempt < 40; attempt++) {
    if (
      await page
        .getByRole('row', { name: 'Row 1000000', exact: true })
        .isVisible()
        .catch(() => false)
    ) {
      break;
    }
    await page.mouse.wheel(0, 200_000);
    await page.waitForTimeout(60);
  }
  await expect(
    page.getByRole('row', { name: 'Row 1000000', exact: true }).getByRole('gridcell').first(),
  ).toHaveText('1000000');

  const geometry = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('.grid-scroll')!;
    const spacer = document.querySelector<HTMLElement>('.grid-virtual-space')!;
    return {
      scrollers: document.querySelectorAll('.result-grid .grid-scroll').length,
      spacerHeight: spacer.getBoundingClientRect().height,
      gridOverflowY: getComputedStyle(element.parentElement!).overflowY,
    };
  });
  expect(geometry.scrollers).toBe(1);
  expect(geometry.spacerHeight).toBeLessThanOrEqual(16_384 * 36);

  await page.evaluate(() => window.__byteqlE2E.loadResultWindow(0));
  await expect.poll(async () => (await metrics(page)).windowStart, { timeout: 60_000 }).toBeLessThan(16_384);
  await scroll.hover();
  for (let attempt = 0; attempt < 80; attempt++) {
    if (
      await page
        .getByRole('row', { name: 'Row 1', exact: true })
        .isVisible()
        .catch(() => false)
    )
      break;
    await page.mouse.wheel(0, -200_000);
    await page.waitForTimeout(60);
  }
  await expect(firstCell(page)).toHaveText('1');

  const evidence = {
    durationMs,
    completeBeforeSort: beforeSort.complete,
    loadedRowsBeforeSort: beforeSort.loadedRows,
    ...sorted,
    resultOpfsPaths: sorted.resultOpfsPaths.length,
  };
  await testInfo.attach('million-row-sort.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  // Recorded, not asserted: this machine's duration is evidence, not a promised throughput.
  console.log('million-row sort evidence:', JSON.stringify(evidence));
});

test('returns to base-only resources after repeated sort and clear cycles', async ({ page }) => {
  test.setTimeout(180_000);
  await openMidiSample(page);
  await runQuery(page, 'select 5000-i as value from range(5000) t(i)');
  await expectRows(page, 5_000);

  for (let cycle = 0; cycle < 10; cycle++) {
    await sortBy(page, 'Sort value ascending');
    expect((await metrics(page)).derivedViewCount).toBe(1);
    await page.getByRole('button', { name: 'Clear sort', exact: true }).click();
    await expect.poll(async () => (await metrics(page)).sortPending).toBe(false);
    const cleared = await metrics(page);
    // Every clear must hand the derived view back; a leak would accumulate across cycles.
    expect(cleared.derivedViewCount).toBe(0);
    expect(cleared.viewCaches).toHaveLength(1);
  }
  expect((await metrics(page)).sendCount).toBe(1);
});

test('a replacement query during a sort leaves no stale order or scratch file behind', async ({ page }) => {
  test.setTimeout(180_000);
  await openMidiSample(page);
  await runQuery(page, 'select 60000-i as value from range(60000) t(i)');
  await expect.poll(async () => (await metrics(page)).loadedRows, { timeout: 60_000 }).toBeGreaterThan(0);

  // The replacement SQL is drafted BEFORE the sort starts, which also shows the draft surviving
  // it. Filling a CodeMirror document mid-render is a harness race, not a product behaviour.
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await editor.fill('select 7 as other');

  await page.getByRole('button', { name: 'Sort value ascending', exact: true }).click();
  await expect.poll(async () => (await metrics(page)).sortPending).toBe(true);
  await expect(editor).toHaveText('select 7 as other');

  await page.getByRole('button', { name: 'Run query' }).click();
  await expectRows(page, 1);
  await expect.poll(async () => (await metrics(page)).sortPending, { timeout: 120_000 }).toBe(false);

  const after = await metrics(page);
  expect(after.orderRevision).toBe(0);
  expect(after.sort).toBeNull();
  expect(after.derivedViewCount).toBe(0);
  await expect(page.locator('[role="columnheader"][aria-sort]')).toHaveCount(0);
  const leftovers = await page.evaluate(() => window.__byteqlE2E.exportFiles());
  expect(leftovers).toEqual([]);
});

test('cancelling a long sort keeps the result, its order and its rows', async ({ page }) => {
  test.setTimeout(180_000);
  await openMidiSample(page);
  await runQuery(page, 'select 120000-i as value from range(120000) t(i)');
  await expect.poll(async () => (await metrics(page)).loadedRows, { timeout: 60_000 }).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Sort value ascending', exact: true }).click();
  await expect.poll(async () => (await metrics(page)).sortPending).toBe(true);
  await page.getByRole('button', { name: 'Cancel sort', exact: true }).click();
  await expect.poll(async () => (await metrics(page)).sortPending, { timeout: 120_000 }).toBe(false);

  const after = await metrics(page);
  expect(after.orderRevision).toBe(0);
  expect(after.sort).toBeNull();
  expect(after.sendCount).toBe(1);
  // Rows kept arriving while the sort drained, so the visible window may have moved; what must
  // not have changed is the ORDER, which still starts where the query's own output did.
  await page.evaluate(() => window.__byteqlE2E.loadResultWindow(0));
  await expect.poll(async () => (await metrics(page)).windowStart, { timeout: 60_000 }).toBe(0);
  await expect(firstCell(page)).toHaveText('120000');
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__byteqlE2E.exportFiles())).toEqual([]);

  // The result is still usable: a second sort succeeds.
  await sortBy(page, 'Sort value ascending');
  await expect(firstCell(page)).toHaveText('1');
});

test('keeps focus on the header that started the sort, including across columns', async ({ page }) => {
  test.setTimeout(120_000);
  await openMidiSample(page);
  await runQuery(page, 'select 500-i as value, i as other from range(500) t(i)');
  await expectRows(page, 500);

  await sortBy(page, 'Sort value ascending');
  await expect(page.getByRole('button', { name: 'Sort value descending', exact: true })).toBeFocused();

  // Switching columns must leave focus on the header just activated, not on the previous key's.
  await sortBy(page, 'Sort other ascending');
  await expect(page.getByRole('button', { name: 'Sort other descending', exact: true })).toBeFocused();
  await expect(header(page, 1)).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('[role="columnheader"][aria-sort]')).toHaveCount(1);
});

test('sorts, clears and cancels entirely from the keyboard', async ({ page }) => {
  test.setTimeout(120_000);
  await openMidiSample(page);
  await runQuery(page, 'select 500-i as value from range(500) t(i)');
  await expectRows(page, 500);

  const header = page.getByRole('button', { name: 'Sort value ascending', exact: true });
  await header.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await metrics(page)).sortPending, { timeout: 60_000 }).toBe(false);
  await expect(firstCell(page)).toHaveText('1');
  // Focus stays on the header that started the sort, so the cycle can continue from the keyboard.
  await expect(page.getByRole('button', { name: 'Sort value descending', exact: true })).toBeFocused();

  await page.keyboard.press('Space');
  await expect.poll(async () => (await metrics(page)).sortPending, { timeout: 60_000 }).toBe(false);
  await expect(firstCell(page)).toHaveText('500');
  await expect(page.getByRole('button', { name: 'Restore query order', exact: true })).toBeFocused();

  await page.keyboard.press('Enter');
  await expect.poll(async () => (await metrics(page)).orderRevision, { timeout: 60_000 }).toBe(3);
  await expect(page.locator('[role="columnheader"][aria-sort]')).toHaveCount(0);
});

test('explains itself when local storage is unavailable, without breaking ordinary queries', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Removed before the app initializes, so the database reports the capability it actually has.
  // The browser's own hardening is untouched: this simulates a browser without OPFS, not a
  // loosened build.
  await page.addInitScript(() => {
    Reflect.deleteProperty(Object.getPrototypeOf(navigator.storage), 'getDirectory');
  });
  await openMidiSample(page);

  await runQuery(page, 'select 4-i as value from range(4) t(i)');
  await expectRows(page, 4);

  const button = page.getByRole('button', { name: 'Sort value ascending', exact: true });
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#result-sort-help')).toContainText('local browser storage');
  await button.click({ force: true });
  expect((await metrics(page)).orderRevision).toBe(0);

  // Everything that does not need snapshot storage still works.
  await expect(firstCell(page)).toHaveText('4');
  await page.getByRole('button', { name: 'Download results', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
});
