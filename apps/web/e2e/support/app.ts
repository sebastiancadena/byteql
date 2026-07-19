import { fileURLToPath } from 'node:url';

import { expect, type Page } from '@playwright/test';

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
}

declare global {
  interface Window {
    __byteqlE2E?: ByteqlE2EControl;
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

export async function openFixture(page: Page, name: string): Promise<void> {
  await page.getByLabel('Open file').setInputFiles(fixturePath(name));
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
