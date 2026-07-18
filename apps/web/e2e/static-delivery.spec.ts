import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const e2eMarkers = /__BYTEQL_E2E__|__byteqlE2E|armParserCrash|E2E audio engine/u;

async function readJavaScript(directory: string): Promise<string> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.js'));
  return (
    await Promise.all(names.map((name) => readFile(new URL(`./${name}`, `file://${directory}/`), 'utf8')))
  ).join('\n');
}

test('serves instrumented output without changing deployable dist', async ({ page }) => {
  const normalAssets = `${webRoot}dist/assets`;
  const instrumentedAssets = `${webRoot}dist-e2e/assets`;

  expect(existsSync(instrumentedAssets)).toBe(true);
  expect(await readJavaScript(instrumentedAssets)).toMatch(e2eMarkers);
  expect(await readJavaScript(normalAssets)).not.toMatch(e2eMarkers);

  await page.goto('/');
  await page.locator('[data-app-ready="true"]').waitFor();
  expect(await page.evaluate(() => typeof window.__byteqlE2E)).toBe('object');
});
