import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import type { BrowserE2EControl, SerializableResult } from '../src/lib/e2e-harness.js';

import {
  beginDownload,
  expectRows,
  metrics,
  openDownloadOptions,
  openMidiSample,
  runSql,
  saveDownload,
  sortBy,
} from './support/app.js';

type ExportFormat = 'csv' | 'parquet';

interface ArtifactReadback {
  columns: string[];
  types: string[];
  rows: Array<Array<string | number | boolean | null>>;
  externalAccess: boolean;
  configurationLocked: boolean;
}

/** One captured result row, read by POSITION: the first two labels are both `dup`. */
interface CapturedRow {
  dup1: number;
  dup2: string;
  token: string;
}

const ROWS = 20_001;

/**
 * The workflow fixture: two columns labelled `dup` with different types and unrelated values, plus
 * a volatile column whose values only this execution knows.
 */
const DUPLICATE_SQL = `select i::integer as dup,
       ('row-' || (20000 - i))::varchar as dup,
       random() as token
from range(20001) t(i)`;

/**
 * Names for the independent CSV reader only. The reader addresses columns as a struct, so it
 * cannot take duplicate names — the file's own duplicate header is asserted from its bytes, and
 * these names exist purely to decode the data rows positionally afterwards.
 */
const CSV_READER_COLUMNS = [
  { name: 'read_position_1', type: 'INTEGER' },
  { name: 'read_position_2', type: 'VARCHAR' },
  { name: 'read_position_3', type: 'DOUBLE' },
];

const storedResult = (page: Page): Promise<SerializableResult> =>
  page.evaluate(() => (window.__byteqlE2E as unknown as BrowserE2EControl).storedResult());

const rowCells = (page: Page, row: number) =>
  page.getByRole('row', { name: `Row ${row}`, exact: true }).getByRole('gridcell');

/** Wheels the sole result scroller until the named row is rendered by the virtualizer. */
async function scrollToRow(page: Page, row: number, direction: 1 | -1 = 1): Promise<void> {
  const scroll = page.locator('.grid-scroll');
  // Bounded on purpose: an overlay covering the grid would otherwise retry until the test's own
  // timeout, hiding which step actually broke.
  await scroll.hover({ timeout: 15_000 });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const visible = await rowCells(page, row)
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) return;
    await page.mouse.wheel(0, direction * 40_000);
    await page.waitForTimeout(60);
  }
  throw new Error(`Row ${row} never became visible by scrolling.`);
}

/**
 * Runs one download through the app's own popover and returns the bytes the browser actually
 * saved, attached to the test as evidence.
 */
async function downloadResults(
  page: Page,
  testInfo: TestInfo,
  format: ExportFormat,
  name: string,
  includeProvenance = true,
): Promise<Uint8Array> {
  await beginDownload(page, format, includeProvenance);

  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  const path = await saveDownload(await pending, testInfo, name);

  // Dismiss releases the prepared file; closing the popover then hands the results area back —
  // it overlays the grid while open and would intercept a later scroll.
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await page.getByRole('button', { name: 'Close download options' }).click();
  await expect(page.getByRole('dialog', { name: 'Download results' })).toBeHidden();
  return new Uint8Array(await readFile(path));
}

/** The file's own first line, decoded from its literal bytes with the BOM left in place. */
function csvHeaderLine(bytes: Uint8Array): string {
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const end = text.indexOf('\r\n');
  expect(end).toBeGreaterThan(0);
  return text.slice(0, end + 2);
}

/** Total data rows in a CSV artifact, counted from the bytes rather than from a reader. */
function csvDataLineCount(bytes: Uint8Array): number {
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  return text.split('\r\n').filter((line) => line !== '').length - 1;
}

/**
 * Reads a downloaded artifact back through the isolated export reader.
 *
 * The file crosses into the page as base64 and is expanded there: handing Playwright a
 * three-quarter-megabyte `number[]` costs minutes of protocol serialization per call, and this
 * spec reads six artifacts back.
 */
async function readArtifact(
  page: Page,
  bytes: Uint8Array,
  format: ExportFormat,
  csvColumns?: Array<{ name: string; type: string }>,
): Promise<ArtifactReadback> {
  return page.evaluate(
    ({ format, base64, csvColumns }) => {
      const binary = atob(base64);
      const decoded = Array.from({ length: binary.length }, (_, index) => binary.charCodeAt(index));
      return (window.__byteqlE2E as unknown as BrowserE2EControl).readExportArtifact({
        format,
        bytes: decoded,
        csvColumns,
      });
    },
    { format, base64: Buffer.from(bytes).toString('base64'), csvColumns },
  );
}

const capture = (rows: ArtifactReadback['rows']): CapturedRow[] =>
  rows.map((row) => ({ dup1: Number(row[0]), dup2: String(row[1]), token: String(row[2]) }));

const signatures = (rows: readonly CapturedRow[]): string[] =>
  rows.map((row) => `${row.dup1}|${row.dup2}|${row.token}`);

const byDup2 = (left: CapturedRow, right: CapturedRow): number =>
  left.dup2 < right.dup2 ? -1 : left.dup2 > right.dup2 ? 1 : 0;

test('carries duplicate labels through the grid, the inspector, sorting and both export formats', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });
  await openMidiSample(page);
  await runSql(page, DUPLICATE_SQL);
  await expectRows(page, ROWS);

  // Both labels are shown in full, distinguished by position, and keep their own types.
  await expect(page.getByRole('columnheader', { name: 'dup, column 1, Int32', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'dup, column 2, Utf8', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'token Float64', exact: true })).toBeVisible();
  const started = await metrics(page);
  expect(started).toMatchObject({ loadedRows: ROWS, complete: true, sendCount: 1 });

  // ---- A window past row 16,384 shows the same two labels and the result's last row. ----
  // The streamed result already ends on this window; asking for it again makes that explicit.
  await page.evaluate(() => window.__byteqlE2E.loadResultWindow(20_000));
  await expect.poll(async () => (await metrics(page)).windowStart, { timeout: 60_000 }).toBeGreaterThan(0);
  const later = await metrics(page);
  expect(later.windowRows).toBe(16_384);
  // The window ends on the final row, so it covers rows well beyond 16,384.
  expect(later.windowStart + later.windowRows).toBe(ROWS);
  expect(later.windowStart + later.windowRows).toBeGreaterThan(16_384);
  await scrollToRow(page, ROWS);
  await expect(rowCells(page, ROWS).nth(0)).toHaveText('20000');
  await expect(rowCells(page, ROWS).nth(1)).toHaveText('row-0');
  await expect(page.getByRole('columnheader', { name: 'dup, column 2, Utf8', exact: true })).toBeVisible();

  // ---- Query order, captured once. The volatile column is never produced a second time. ----
  const queryOrderCsv = await downloadResults(page, testInfo, 'csv', 'duplicate-query-order.csv');
  expect(csvHeaderLine(queryOrderCsv)).toBe('\uFEFF"dup","dup","token"\r\n');
  expect(csvDataLineCount(queryOrderCsv)).toBe(ROWS);
  const decoded = await readArtifact(page, queryOrderCsv, 'csv', CSV_READER_COLUMNS);
  // The reader's own names, not the file's: the duplicate header was asserted from the bytes.
  expect(decoded.columns).toEqual(['read_position_1', 'read_position_2', 'read_position_3']);
  expect(decoded.types).toEqual(['INTEGER', 'VARCHAR', 'DOUBLE']);
  expect(decoded).toMatchObject({ externalAccess: false, configurationLocked: true });
  const original = capture(decoded.rows);
  expect(original).toHaveLength(ROWS);
  expect(original.map((row) => row.dup1)).toEqual(Array.from({ length: ROWS }, (_, index) => index));
  expect(original.map((row) => row.dup2)).toEqual(
    Array.from({ length: ROWS }, (_, index) => `row-${20_000 - index}`),
  );
  expect(new Set(original.map((row) => row.token)).size).toBeGreaterThan(ROWS / 2);

  // ---- The first window and the inspector name both duplicates and read them by position. ----
  await page.evaluate(() => window.__byteqlE2E.loadResultWindow(0));
  await expect.poll(async () => (await metrics(page)).windowStart, { timeout: 60_000 }).toBe(0);
  await scrollToRow(page, 1, -1);
  await expect(rowCells(page, 1).nth(0)).toHaveText('0');
  await expect(rowCells(page, 1).nth(1)).toHaveText('row-20000');
  await page.getByRole('row', { name: 'Row 1', exact: true }).click();
  const inspected = await page
    .locator('.trace-values .inspector .value-list > div')
    .evaluateAll((entries) =>
      entries.map((entry) => [
        entry.querySelector('dt')?.textContent ?? '',
        entry.querySelector('dd')?.textContent ?? '',
      ]),
    );
  expect(inspected).toEqual([
    ['dup', '0'],
    ['dup', 'row-20000'],
    ['token', original[0]!.token],
  ]);

  // ---- Each duplicate sorts by its own position, in both directions. ----
  const expectFullExport = async (
    expected: readonly CapturedRow[],
    name: string,
    format: ExportFormat = 'csv',
  ): Promise<void> => {
    const bytes = await downloadResults(page, testInfo, format, name);
    if (format === 'csv') {
      expect(csvHeaderLine(bytes)).toBe('\uFEFF"dup","dup","token"\r\n');
      expect(csvDataLineCount(bytes)).toBe(ROWS);
    }
    const readback = await readArtifact(
      page,
      bytes,
      format,
      format === 'csv' ? CSV_READER_COLUMNS : undefined,
    );
    expect(signatures(capture(readback.rows))).toEqual(signatures(expected));
  };

  await sortBy(page, 'Sort dup, column 1, ascending');
  await expect(page.locator('[role="columnheader"][aria-colindex="1"]')).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await expect(rowCells(page, 1).nth(0)).toHaveText('0');
  await expectFullExport(original, 'duplicate-first-ascending.csv');

  await sortBy(page, 'Sort dup, column 1, descending');
  await expect(rowCells(page, 1).nth(0)).toHaveText('20000');
  await expectFullExport([...original].reverse(), 'duplicate-first-descending.csv');

  const byText = [...original].sort(byDup2);
  await sortBy(page, 'Sort dup, column 2, ascending');
  await expect(page.locator('[role="columnheader"][aria-colindex="2"]')).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await expect(page.locator('[role="columnheader"][aria-sort]')).toHaveCount(1);
  await expect(rowCells(page, 1).nth(1)).toHaveText(byText[0]!.dup2);
  await expectFullExport(byText, 'duplicate-second-ascending.csv');

  // ---- Parquet renames the second duplicate, says so before the click, and keeps every value. ----
  await sortBy(page, 'Sort dup, column 2, descending');
  const byTextDescending = [...byText].reverse();
  await expect(rowCells(page, 1).nth(1)).toHaveText(byTextDescending[0]!.dup2);
  await openDownloadOptions(page);
  await page.getByLabel('Format').selectOption('parquet');
  const preview = page.getByRole('table', { name: 'Parquet column names' });
  await expect(preview.locator('tbody tr')).toHaveCount(1);
  await expect(preview.locator('tbody tr td')).toHaveText(['2', 'dup', 'dup_2']);
  const parquetBytes = await downloadResults(
    page,
    testInfo,
    'parquet',
    'duplicate-second-descending.parquet',
  );
  const parquet = await readArtifact(page, parquetBytes, 'parquet');
  expect(parquet.columns).toEqual(['dup', 'dup_2', 'token']);
  expect(parquet.types).toEqual(['INTEGER', 'VARCHAR', 'DOUBLE']);
  expect(parquet).toMatchObject({ externalAccess: false, configurationLocked: true });
  expect(parquet.rows).toHaveLength(ROWS);
  expect(signatures(capture(parquet.rows))).toEqual(signatures(byTextDescending));

  // ---- Restoring the query order restores exactly the captured execution. ----
  await page.getByRole('button', { name: 'Clear sort', exact: true }).click();
  await expect.poll(async () => (await metrics(page)).sortPending, { timeout: 120_000 }).toBe(false);
  await expect(page.locator('[role="columnheader"][aria-sort]')).toHaveCount(0);
  await expectFullExport(original, 'duplicate-restored-order.csv');

  const final = await metrics(page);
  // Five reorderings and six exported files later, the user's SQL has run exactly once.
  expect(final.sendCount).toBe(1);
  expect(final.loadedRows).toBe(ROWS);
  expect(final.orderRevision).toBe(5);
  await expect.poll(() => page.evaluate(() => window.__byteqlE2E.exportFiles())).toEqual([]);
});

test('keeps duplicate labels, empty results and hidden columns distinct in both export formats', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });
  await openMidiSample(page);

  // A duplicate label, a case-only collision with it, and a duplicated hidden column.
  await runSql(
    page,
    `select 1::integer as "Dup", 'x'::varchar as dup, 2::integer as _dup, 'y'::varchar as _dup`,
  );
  await expectRows(page, 1);
  expect(await storedResult(page)).toEqual({
    columns: ['Dup', 'dup', '_dup', '_dup'],
    physicalColumns: ['c0', 'c1', 'c2', 'c3'],
    types: ['Int32', 'Utf8', 'Int32', 'Utf8'],
    rows: [[1, 'x', 2, 'y']],
  });

  // Excluding hidden columns exports only the visible pair, still with distinct Parquet names.
  await openDownloadOptions(page);
  await page.getByLabel('Format').selectOption('parquet');
  await page.getByRole('checkbox', { name: 'Include hidden columns and byte provenance' }).click();
  const preview = page.getByRole('table', { name: 'Parquet column names' });
  await expect(preview.locator('tbody tr td')).toHaveText(['2', 'dup', 'dup_2']);
  const visibleParquet = await readArtifact(
    page,
    await downloadResults(page, testInfo, 'parquet', 'collision-visible.parquet', false),
    'parquet',
  );
  expect(visibleParquet.columns).toEqual(['Dup', 'dup_2']);
  expect(visibleParquet.types).toEqual(['INTEGER', 'VARCHAR']);
  expect(visibleParquet.rows).toEqual([[1, 'x']]);

  const visibleCsv = await downloadResults(page, testInfo, 'csv', 'collision-visible.csv', false);
  expect(csvHeaderLine(visibleCsv)).toBe('\uFEFF"Dup","dup"\r\n');

  // Including them adds both hidden positions, each with its own name in the file.
  await openDownloadOptions(page);
  await page.getByLabel('Format').selectOption('parquet');
  await page.getByRole('checkbox', { name: 'Include hidden columns and byte provenance' }).click();
  await expect(preview.locator('tbody tr')).toHaveCount(2);
  await expect(preview.locator('tbody tr').nth(1).locator('td')).toHaveText(['4', '_dup', '_dup_2']);
  const allParquet = await readArtifact(
    page,
    await downloadResults(page, testInfo, 'parquet', 'collision-all.parquet'),
    'parquet',
  );
  expect(allParquet.columns).toEqual(['Dup', 'dup_2', '_dup', '_dup_2']);
  expect(allParquet.types).toEqual(['INTEGER', 'VARCHAR', 'INTEGER', 'VARCHAR']);
  expect(allParquet.rows).toEqual([[1, 'x', 2, 'y']]);
  const allCsv = await downloadResults(page, testInfo, 'csv', 'collision-all.csv');
  expect(csvHeaderLine(allCsv)).toBe('\uFEFF"Dup","dup","_dup","_dup"\r\n');
  expect(csvDataLineCount(allCsv)).toBe(1);

  // An empty duplicate-labelled result keeps both positions, their types and their file names.
  await runSql(page, `select 1::integer as dup, 'x'::varchar as dup where false`);
  await expect(page.getByText('No rows returned. Adjust the query and run again.')).toBeVisible();
  expect(await storedResult(page)).toEqual({
    columns: ['dup', 'dup'],
    physicalColumns: ['c0', 'c1'],
    types: ['Int32', 'Utf8'],
    rows: [],
  });
  const emptyCsv = await downloadResults(page, testInfo, 'csv', 'duplicate-empty.csv');
  expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(emptyCsv)).toBe('\uFEFF"dup","dup"\r\n');
  const emptyParquet = await readArtifact(
    page,
    await downloadResults(page, testInfo, 'parquet', 'duplicate-empty.parquet'),
    'parquet',
  );
  expect(emptyParquet.columns).toEqual(['dup', 'dup_2']);
  expect(emptyParquet.types).toEqual(['INTEGER', 'VARCHAR']);
  expect(emptyParquet.rows).toEqual([]);
});
