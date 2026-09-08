import { readFile } from 'node:fs/promises';

import { expect, test, type Download, type Page, type TestInfo } from '@playwright/test';

import { openMidiSample, runSql } from './support/app.js';

interface SerializableResult {
  columns: string[];
  types: string[];
  rows: Array<Array<string | number | boolean | null>>;
}

interface CsvColumn {
  name: string;
  type: string;
}

interface PickerState {
  mode: 'ok' | 'delay' | 'quota';
  files: string[];
  writeAttempts: number;
  closes: number;
  aborts: number;
}

interface DownloadHarness {
  queryResultMetrics(): Promise<{
    loadedRows: number;
    complete: boolean;
    windowStart: number;
    windowRows: number;
    sendCount: number;
    decodedBytes: number;
    resultOpfsPaths: readonly string[];
  }>;
  storedResult(): Promise<SerializableResult>;
  readExportArtifact(input: {
    format: 'csv' | 'parquet';
    bytes: number[];
    csvColumns?: CsvColumn[];
  }): Promise<SerializableResult & { externalAccess: boolean; configurationLocked: boolean }>;
}

async function saveDownload(download: Download, testInfo: TestInfo, name: string): Promise<string> {
  expect(await download.failure()).toBeNull();
  const path = testInfo.outputPath(name);
  await download.saveAs(path);
  await testInfo.attach(name, { path });
  return path;
}

async function readArtifact(
  page: Page,
  path: string,
  format: 'csv' | 'parquet',
  csvColumns?: CsvColumn[],
): Promise<Awaited<ReturnType<DownloadHarness['readExportArtifact']>>> {
  const bytes = [...(await readFile(path))];
  return page.evaluate(
    ({ format, bytes, csvColumns }) =>
      (window.__BYTEQL_E2E__ as unknown as DownloadHarness).readExportArtifact({
        format,
        bytes,
        csvColumns,
      }),
    { format, bytes, csvColumns },
  );
}

async function readArtifactBytes(path: string): Promise<number[]> {
  return [...(await readFile(path))];
}

function expectCsvHeader(bytes: number[], header: string, headerOnly = false): void {
  expect(bytes.slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
  const body = new TextDecoder().decode(Uint8Array.from(bytes.slice(3)));
  const headerEnd = body.indexOf('\n') + 1;
  expect(headerEnd).toBeGreaterThan(0);
  expect(body.slice(0, headerEnd)).toBe(header);
  if (headerOnly) expect(body).toBe(header);
}

async function installControlledPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: PickerState = { mode: 'ok', files: [], writeAttempts: 0, closes: 0, aborts: 0 };
    const scope = globalThis as typeof globalThis & {
      __BYTEQL_PICKER_STATE__?: PickerState;
      showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
    };
    scope.__BYTEQL_PICKER_STATE__ = state;
    scope.showSaveFilePicker = async (options) => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('byteql-e2e-picked', { create: true });
      const name = `${state.files.length}-${options?.suggestedName ?? 'result.bin'}`;
      const path = `byteql-e2e-picked/${name}`;
      state.files.push(path);
      const handle = await directory.getFileHandle(name, { create: true });
      return {
        kind: 'file',
        name,
        async createWritable() {
          const writable = await handle.createWritable();
          let aborted = false;
          return {
            async write(bytes: FileSystemWriteChunkType) {
              state.writeAttempts += 1;
              while (state.mode === 'delay' && !aborted) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              if (aborted) throw new DOMException('The test destination was aborted.', 'AbortError');
              if (state.mode === 'quota') {
                throw new DOMException('The test destination quota is exhausted.', 'QuotaExceededError');
              }
              await writable.write(bytes);
            },
            async close() {
              state.closes += 1;
              await writable.close();
            },
            async abort(reason?: unknown) {
              if (aborted) return;
              aborted = true;
              state.aborts += 1;
              await writable.abort(reason);
              await directory.removeEntry(name).catch(() => undefined);
            },
          } as FileSystemWritableFileStream;
        },
      } as FileSystemFileHandle;
    };
  });
}

async function pickerState(page: Page): Promise<PickerState> {
  return page.evaluate(() => {
    const state = (globalThis as typeof globalThis & { __BYTEQL_PICKER_STATE__?: PickerState })
      .__BYTEQL_PICKER_STATE__;
    if (!state) throw new Error('The controlled picker was not installed.');
    return { ...state, files: [...state.files] };
  });
}

async function setPickerMode(page: Page, mode: PickerState['mode']): Promise<void> {
  await page.evaluate((nextMode) => {
    const state = (globalThis as typeof globalThis & { __BYTEQL_PICKER_STATE__?: PickerState })
      .__BYTEQL_PICKER_STATE__;
    if (!state) throw new Error('The controlled picker was not installed.');
    state.mode = nextMode;
  }, mode);
}

async function readPickedBytes(page: Page, path?: string): Promise<number[]> {
  return page.evaluate(async (requestedPath) => {
    const state = (globalThis as typeof globalThis & { __BYTEQL_PICKER_STATE__?: PickerState })
      .__BYTEQL_PICKER_STATE__;
    const relativePath = requestedPath ?? state?.files.at(-1);
    if (!relativePath) throw new Error('No picked export file exists.');
    const segments = relativePath.split('/');
    let directory = await navigator.storage.getDirectory();
    for (const segment of segments.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(segment);
    }
    const handle = await directory.getFileHandle(segments.at(-1)!);
    return [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
  }, path);
}

async function beginDownload(page: Page, format: 'csv' | 'parquet', includeProvenance = true): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Download results' });
  if (!(await dialog.isVisible())) {
    await page.getByRole('button', { name: 'Download results', exact: true }).click();
  }
  await expect(page.getByLabel('Format').locator(`option[value="${format}"]`)).toBeEnabled();
  await page.getByLabel('Format').selectOption(format);
  const provenance = page.getByRole('checkbox', {
    name: 'Include hidden columns and byte provenance',
  });
  if ((await provenance.isChecked()) !== includeProvenance) await provenance.click();
  const button = page.getByRole('button', { name: 'Download', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
}

test('fallback CSV saves every stored volatile value without rerunning SQL', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });
  await openMidiSample(page);

  await runSql(page, 'select i, random() as sample from range(20000) t(i)');
  await expect(page.locator('.results-heading-meta')).toContainText('1,024 loaded');
  await page.getByRole('button', { name: 'Download results', exact: true }).click();
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();

  const stored = await page.evaluate(() =>
    (window.__BYTEQL_E2E__ as unknown as DownloadHarness).storedResult(),
  );
  expect(stored.rows).toHaveLength(20_000);

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  const path = await saveDownload(await pending, testInfo, 'volatile-20000.csv');
  const exported = await readArtifact(page, path, 'csv', [
    { name: 'i', type: 'BIGINT' },
    { name: 'sample', type: 'DOUBLE' },
  ]);

  expect(exported).toMatchObject({
    columns: ['i', 'sample'],
    types: ['BIGINT', 'DOUBLE'],
    externalAccess: false,
    configurationLocked: true,
  });
  expect(exported.rows).toEqual(stored.rows);
  expect((await page.evaluate(() => window.__BYTEQL_E2E__!.queryResultMetrics())).sendCount).toBe(1);
});

test('direct picker CSV preserves a scrolled result after an unexecuted SQL edit', async ({ page }) => {
  await installControlledPicker(page);
  await openMidiSample(page);
  await runSql(page, "select i, 'stored-' || i::varchar as value from range(20000) t(i)");
  await expect(page.locator('.results-heading-meta')).toContainText('1,024 loaded');
  await page.evaluate(() => window.__BYTEQL_E2E__!.drainQueryResult());
  const scroll = page.locator('.grid-scroll');
  await scroll.hover();
  await page.mouse.wheel(0, 20_000);
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).not.toBeVisible();
  const stored = await page.evaluate(() =>
    (window.__BYTEQL_E2E__ as unknown as DownloadHarness).storedResult(),
  );
  await page.getByRole('textbox', { name: 'SQL query' }).fill('select 999 as edited_but_not_run');

  await beginDownload(page, 'csv');
  await expect(page.locator('.results-download-status')).toContainText('File saved.');
  const picked = await pickerState(page);
  expect(picked).toMatchObject({ closes: 1, aborts: 0 });
  const exported = await page.evaluate(
    ({ bytes }) =>
      (window.__BYTEQL_E2E__ as unknown as DownloadHarness).readExportArtifact({
        format: 'csv',
        bytes,
        csvColumns: [
          { name: 'i', type: 'BIGINT' },
          { name: 'value', type: 'VARCHAR' },
        ],
      }),
    { bytes: await readPickedBytes(page) },
  );
  expect(exported.rows).toEqual(stored.rows);
  expect(exported.columns).toEqual(['i', 'value']);
});

test('fallback CSV independently distinguishes null, quoted empty, Unicode, U+FEFF, quotes, and newlines', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });
  await openMidiSample(page);
  await runSql(
    page,
    `select * from (values
      (1::bigint, 'comma,"quote"', null::varchar, ''::varchar, 'line' || chr(10) || 'break'),
      (2::bigint, '=1+1', 'present', '雪', 'plain')
    ) t(id, text_value, null_text, empty_text, multiline)`,
  );
  await expect(page.locator('.results-heading-meta')).toContainText('2 rows');
  await beginDownload(page, 'csv');
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  const path = await saveDownload(await pending, testInfo, 'csv-special-values.csv');
  const exported = await readArtifact(page, path, 'csv', [
    { name: 'id', type: 'BIGINT' },
    { name: 'text_value', type: 'VARCHAR' },
    { name: 'null_text', type: 'VARCHAR' },
    { name: 'empty_text', type: 'VARCHAR' },
    { name: 'multiline', type: 'VARCHAR' },
  ]);
  expect(exported.rows).toEqual([
    ['1', 'comma,"quote"', null, '', 'line\nbreak'],
    ['2', '=1+1', 'present', '雪', 'plain'],
  ]);

  // Arrow's .get() in the independent reader strips leading U+FEFF, so use literal downloaded
  // bytes as the oracle for these cells and the separate file-level BOM.
  await runSql(page, `select chr(65279) || 'keep' as leading, chr(65279) as only_bom`);
  await expect(page.locator('.results-heading-meta')).toContainText('1 row');
  await beginDownload(page, 'csv');
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();
  const bomDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  const bomPath = await saveDownload(await bomDownload, testInfo, 'csv-leading-bom.csv');
  expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await readFile(bomPath))).toBe(
    '\uFEFF"leading","only_bom"\r\n"\uFEFFkeep","\uFEFF"\r\n',
  );
});

test('fallback Parquet readback preserves schema and page sequence after an SQL edit', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });
  await openMidiSample(page);
  await runSql(
    page,
    "select i::integer as seq, (10000-i)::bigint as reverse, ('row-' || i::varchar) as label from range(12000) t(i)",
  );
  await expect(page.locator('.results-heading-meta')).toContainText('1,024 loaded');
  await page.evaluate(() => window.__BYTEQL_E2E__!.drainQueryResult());
  const scroll = page.locator('.grid-scroll');
  await scroll.hover();
  await page.mouse.wheel(0, 20_000);
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('textbox', { name: 'SQL query' }).fill('select -1 as replacement_not_run');
  await beginDownload(page, 'parquet');
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();
  const stored = await page.evaluate(() =>
    (window.__BYTEQL_E2E__ as unknown as DownloadHarness).storedResult(),
  );
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  const path = await saveDownload(await pending, testInfo, 'ordered-12000.parquet');
  const exported = await readArtifact(page, path, 'parquet');
  expect(exported).toMatchObject({
    columns: ['seq', 'reverse', 'label'],
    types: ['INTEGER', 'BIGINT', 'VARCHAR'],
    externalAccess: false,
    configurationLocked: true,
  });
  expect(exported.rows).toEqual(stored.rows);
});

for (const format of ['csv', 'parquet'] as const) {
  test(`${format} supports a zero-row schema and provenance-only inclusion`, async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'showSaveFilePicker');
    });
    await openMidiSample(page);
    await runSql(page, 'select i::integer as id, null::varchar as note from range(0) t(i)');
    await expect(page.locator('.results-heading-meta')).toContainText('0 rows');
    const storedEmpty = await page.evaluate(() =>
      (window.__BYTEQL_E2E__ as unknown as DownloadHarness).storedResult(),
    );
    expect(storedEmpty).toEqual({ columns: ['id', 'note'], types: ['Int32', 'Utf8'], rows: [] });
    await beginDownload(page, format);
    await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();
    let pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    let path = await saveDownload(await pending, testInfo, `empty.${format}`);
    if (format === 'csv') {
      expectCsvHeader(await readArtifactBytes(path), '"id","note"\r\n', true);
    }
    let exported = await readArtifact(
      page,
      path,
      format,
      format === 'csv'
        ? [
            { name: 'id', type: 'INTEGER' },
            { name: 'note', type: 'VARCHAR' },
          ]
        : undefined,
    );
    expect(exported).toMatchObject({
      columns: ['id', 'note'],
      types: ['INTEGER', 'VARCHAR'],
      rows: [],
      externalAccess: false,
      configurationLocked: true,
    });

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await runSql(page, 'select _src_start, _src_end from events limit 3');
    await expect(page.locator('.results-heading-meta')).toContainText('3 rows');
    const storedProvenance = await page.evaluate(() =>
      (window.__BYTEQL_E2E__ as unknown as DownloadHarness).storedResult(),
    );
    expect(storedProvenance.columns).toEqual(['_src_start', '_src_end']);
    expect(storedProvenance.types).toEqual(['Uint64', 'Uint64']);
    expect(storedProvenance.rows).toHaveLength(3);
    const provenance = page.getByRole('checkbox', {
      name: 'Include hidden columns and byte provenance',
    });
    await provenance.click();
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeDisabled();
    await expect(page.getByText('At least one column must be selected for export.')).toBeVisible();
    await provenance.click();
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();
    pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    path = await saveDownload(await pending, testInfo, `provenance-only.${format}`);
    if (format === 'csv') {
      expectCsvHeader(await readArtifactBytes(path), '"_src_start","_src_end"\r\n');
    }
    exported = await readArtifact(
      page,
      path,
      format,
      format === 'csv'
        ? [
            { name: '_src_start', type: 'UBIGINT' },
            { name: '_src_end', type: 'UBIGINT' },
          ]
        : undefined,
    );
    expect(exported).toMatchObject({
      columns: ['_src_start', '_src_end'],
      types: ['UBIGINT', 'UBIGINT'],
      externalAccess: false,
      configurationLocked: true,
    });
    expect(exported.rows).toEqual(storedProvenance.rows);
  });
}

for (const format of ['csv', 'parquet'] as const) {
  test(`${format} lifecycle removes replacement, quota, and cancellation artifacts and permits repeats`, async ({
    page,
  }) => {
    await installControlledPicker(page);
    await openMidiSample(page);
    await runSql(page, 'select i from range(20000) t(i)');
    await setPickerMode(page, 'delay');
    await beginDownload(page, format);
    await expect.poll(async () => (await pickerState(page)).writeAttempts).toBeGreaterThan(0);
    const replacementPath = (await pickerState(page)).files[0];

    await runSql(page, 'select 7::integer as replacement');
    await setPickerMode(page, 'ok');
    await expect(page.getByRole('gridcell', { name: '7', exact: true })).toBeVisible();
    await expect.poll(async () => (await pickerState(page)).aborts).toBe(1);
    expect(await pickerState(page)).toMatchObject({ files: [replacementPath], closes: 0, aborts: 1 });
    await expect(readPickedBytes(page, replacementPath)).rejects.toThrow();

    await setPickerMode(page, 'quota');
    await beginDownload(page, format);
    await expect(page.getByRole('alert')).toContainText('quota');
    await expect(page.getByRole('gridcell', { name: '7', exact: true })).toBeVisible();
    const afterQuota = await pickerState(page);
    expect(afterQuota).toMatchObject({ closes: 0, aborts: 2 });
    expect(afterQuota.files).toHaveLength(2);
    await expect(readPickedBytes(page, afterQuota.files[1])).rejects.toThrow();

    const stored = await page.evaluate(() =>
      (window.__BYTEQL_E2E__ as unknown as DownloadHarness).storedResult(),
    );
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await setPickerMode(page, 'ok');
    await beginDownload(page, format);
    await expect(page.locator('.results-download-status')).toContainText('File saved.');
    const afterRetry = await pickerState(page);
    expect(afterRetry).toMatchObject({ closes: 1, aborts: 2 });
    expect(afterRetry.files).toHaveLength(3);
    const retryReadback = await page.evaluate(
      ({ bytes, format }) =>
        (window.__BYTEQL_E2E__ as unknown as DownloadHarness).readExportArtifact({
          format,
          bytes,
          csvColumns: format === 'csv' ? [{ name: 'replacement', type: 'INTEGER' }] : undefined,
        }),
      { bytes: await readPickedBytes(page, afterRetry.files[2]), format },
    );
    expect(retryReadback).toMatchObject({ columns: ['replacement'], types: ['INTEGER'] });
    expect(retryReadback.rows).toEqual(stored.rows);

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await beginDownload(page, format);
    await expect(page.locator('.results-download-status')).toContainText('File saved.');
    const afterRepeat = await pickerState(page);
    expect(afterRepeat).toMatchObject({ closes: 2, aborts: 2 });
    expect(afterRepeat.files).toHaveLength(4);
    expect(new Set(afterRepeat.files).size).toBe(4);
    expect(await readPickedBytes(page, afterRepeat.files[3])).toEqual(
      await readPickedBytes(page, afterRetry.files[2]),
    );

    await page.getByRole('button', { name: 'Dismiss' }).click();
    const writesBeforeCancel = afterRepeat.writeAttempts;
    await setPickerMode(page, 'delay');
    await beginDownload(page, format);
    await expect
      .poll(async () => (await pickerState(page)).writeAttempts)
      .toBeGreaterThan(writesBeforeCancel);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await setPickerMode(page, 'ok');
    await expect(page.locator('.results-download-status')).toContainText('Download cancelled.');
    await expect(page.getByRole('gridcell', { name: '7', exact: true })).toBeVisible();
    const afterCancel = await pickerState(page);
    expect(afterCancel).toMatchObject({ closes: 2, aborts: 3 });
    expect(afterCancel.files).toHaveLength(5);
    await expect(readPickedBytes(page, afterCancel.files[4])).rejects.toThrow();
  });
}

test('two tabs retain separate fallback artifacts and clean up only their own file', async ({
  context,
  page,
}) => {
  await context.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });
  const other = await context.newPage();
  await openMidiSample(page);
  await openMidiSample(other);
  await runSql(page, "select 1 as tab, 'first' as value");
  await runSql(other, "select 2 as tab, 'second' as value");

  await beginDownload(page, 'csv');
  await beginDownload(other, 'csv');
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();
  await expect(other.getByRole('button', { name: 'Save file', exact: true })).toBeVisible();
  const both = await page.evaluate(() => window.__BYTEQL_E2E__!.exportFiles());
  expect(both).toHaveLength(2);
  expect(new Set(both).size).toBe(2);

  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect.poll(() => other.evaluate(() => window.__BYTEQL_E2E__!.exportFiles())).toHaveLength(1);
  const pending = other.waitForEvent('download');
  await other.getByRole('button', { name: 'Save file', exact: true }).click();
  expect(await (await pending).failure()).toBeNull();
  await other.getByRole('button', { name: 'Dismiss' }).click();
  await expect.poll(() => other.evaluate(() => window.__BYTEQL_E2E__!.exportFiles())).toEqual([]);
});
