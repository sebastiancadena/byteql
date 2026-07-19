import { fileURLToPath } from 'node:url';

import { expect, type Page } from '@playwright/test';

import type { SpillProbeReport } from '@byteql/db';

export interface AudioStats {
  loadCalls: number;
  disposeCalls: number;
  loadedRows: number;
}

export interface ByteqlE2EControl {
  armParserCrash(): void;
  workerCount(): number;
  audioStats(): AudioStats;
  spillProbe(): Promise<SpillProbeReport>;
}

declare global {
  interface Window {
    __byteqlE2E?: ByteqlE2EControl;
  }
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
  await page.getByRole('textbox', { name: 'SQL query' }).fill(sql);
  await page.getByRole('button', { name: 'Run query' }).click();
}

export async function openAudioViewer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open in…' }).click();
  await page.getByRole('menuitem', { name: 'Audio playback' }).click();
  await expect(page.getByRole('heading', { name: 'Audio playback' })).toBeVisible();
}
