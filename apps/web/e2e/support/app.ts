import { fileURLToPath } from 'node:url';

import { expect, type Download, type Page, type TestInfo } from '@playwright/test';

import type { SpillProbeReport } from '@byteql/db';

export interface AudioStats {
  loadCalls: number;
  disposeCalls: number;
  loadedRows: number;
}

export interface SessionOverrides {
  tiering?: { tierThresholdBytes?: number; rotationBytes?: number };
}

export interface ReadStats {
  totalBytesRead: number;
  spillBytes: number;
}

export interface ByteqlE2EControl {
  armParserCrash(): void;
  workerCount(): number;
  audioStats(): AudioStats;
  spillProbe(): Promise<SpillProbeReport>;
  sessionOverrides?: SessionOverrides;
  spillFiles(): Promise<readonly string[]>;
  enableReadStats(tables: readonly string[]): Promise<void>;
  readStats(): Promise<ReadStats>;
  queryResultMetrics(): Promise<{
    loadedRows: number;
    complete: boolean;
    windowStart: number;
    windowRows: number;
    sendCount: number;
    decodedBytes: number;
    orderRevision: number;
    sort: { columnIndex: number; direction: 'asc' | 'desc' } | null;
    sortPending: boolean;
    derivedViewCount: number;
    viewCaches: readonly { kind: 'base' | 'display'; decodedBytes: number }[];
    resultOpfsPaths: readonly string[];
  }>;
  exportFiles(): Promise<readonly string[]>;
  drainQueryResult(): Promise<void>;
  loadResultWindow(globalRow: number): Promise<void>;
  seedResultPageOrphan(): Promise<{ orphanPath: string; unrelatedPath: string }>;
}

declare global {
  interface Window {
    __byteqlE2E?: ByteqlE2EControl;
    __BYTEQL_E2E__?: ByteqlE2EControl;
    __byteqlE2EOverrides?: SessionOverrides;
  }
}

/**
 * Arms `SessionOverrides` for the next page load. Must run BEFORE `page.goto()`: the app reads
 * `window.__byteqlE2EOverrides` synchronously while constructing its e2e harness, on boot — a
 * `page.evaluate()` after navigation would always lose that race. See the mirrored comment on
 * `createBrowserE2EHarness` in `apps/web/src/lib/e2e-harness.ts`.
 */
export async function setSessionOverrides(page: Page, overrides: SessionOverrides): Promise<void> {
  await page.addInitScript((value: SessionOverrides) => {
    window.__byteqlE2EOverrides = value;
  }, overrides);
}

export const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../../../../packages/formats/midi/test/fixtures/${name}`, import.meta.url));

export async function waitForAppReady(page: Page): Promise<void> {
  await page.locator('[data-app-ready="true"]').waitFor();
}

export async function openMidiSample(
  page: Page,
  { navigate = true }: { navigate?: boolean } = {},
): Promise<void> {
  if (navigate) {
    await page.goto('/');
    await waitForAppReady(page);
  }
  await page.getByRole('button', { name: /Try sample/u }).click();
  await page.getByRole('menuitem', { name: 'MIDI song (.mid)' }).click();
  // Below 960 px the catalog is a closed drawer, and a `hidden` subtree is outside the
  // accessibility tree — so role queries cannot see it at all. Wait on readiness the session
  // actually publishes instead. A test that wants to click Browse at those widths must open
  // Sources first.
  await expect(page.locator('[data-hex-pane]')).toBeAttached();
  await expect(page.locator('.explorer .table-browse').first()).toBeAttached();
}

export async function openFixture(page: Page, name: string): Promise<void> {
  // The intake keeps one visible "Open file" button; this is its attached input, kept for
  // drag-and-drop, automation and the picker fallback.
  await page.getByLabel('Open file input').setInputFiles(fixturePath(name));
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();
}

export async function runSql(page: Page, sql: string): Promise<void> {
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  // The auto-run "overview" query (fired the instant the session reaches "ready") briefly
  // disables the CodeMirror editor while it's in flight, flipping its `contenteditable`
  // attribute false -> true. `locator.fill()`'s own actionability wait does not reliably survive
  // that flip, so wait for it explicitly first — `expect().toHaveAttribute()` polls on the
  // standard expect timeout, unlike `fill()`'s narrower retry window for this specific condition.
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.fill(sql);
  await page.getByRole('button', { name: 'Run query' }).click();
}

export async function openAudioViewer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open in…' }).click();
  await page.getByRole('menuitem', { name: 'Audio playback' }).click();
  await expect(page.getByRole('heading', { name: 'Audio playback' })).toBeVisible();
}

export const metrics = (page: Page) => page.evaluate(() => window.__byteqlE2E.queryResultMetrics());

/** Clicks a sort control by its accessible name and waits for the sort to commit. */
export const sortBy = async (page: Page, name: string): Promise<void> => {
  await page.getByRole('button', { name, exact: true }).click();
  await expect.poll(async () => (await metrics(page)).sortPending, { timeout: 120_000 }).toBe(false);
};

/**
 * Drains the cursor and asserts the complete row count, which the toolbar only shows partially.
 * Draining inside the poll covers both streaming and the moment just after a new query is started,
 * when the previous result is briefly still the one on display.
 */
export const expectRows = async (
  page: Page,
  rows: number,
  options: { timeout?: number } = {},
): Promise<void> => {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.__byteqlE2E.drainQueryResult());
        return (await metrics(page)).loadedRows;
      },
      { timeout: options.timeout ?? 120_000 },
    )
    .toBe(rows);
};

/** Opens the download options popover only when it is closed: its opener is a toggle. */
export async function openDownloadOptions(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Download results' });
  if (!(await dialog.isVisible())) {
    await page.getByRole('button', { name: 'Download results', exact: true }).click();
  }
  await expect(dialog).toBeVisible();
}

/** Configures format and provenance in the open download popover, then starts the export. */
export async function beginDownload(
  page: Page,
  format: 'csv' | 'parquet',
  includeProvenance = true,
): Promise<void> {
  await openDownloadOptions(page);
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

/** Saves a completed Playwright download and attaches it to the test as evidence. */
export async function saveDownload(download: Download, testInfo: TestInfo, name: string): Promise<string> {
  expect(await download.failure()).toBeNull();
  const path = testInfo.outputPath(name);
  await download.saveAs(path);
  await testInfo.attach(name, { path });
  return path;
}
