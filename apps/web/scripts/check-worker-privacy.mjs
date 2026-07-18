/* global clearTimeout, document, getComputedStyle, setTimeout */

import console from 'node:console';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { chromium } from '@playwright/test';
import { build, preview } from 'vite';

const chromiumCandidates = [
  process.env.BYTEQL_CHROMIUM_PATH,
  chromium.executablePath(),
  '/snap/bin/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);
const executablePath = chromiumCandidates.find((candidate) => existsSync(candidate));
if (!executablePath) {
  throw new Error(
    'Chromium is required for the worker privacy probe. Install Playwright Chromium or set BYTEQL_CHROMIUM_PATH.',
  );
}

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const outDir = await mkdtemp(join(tmpdir(), 'byteql-worker-privacy-'));
let previewServer;
let browser;

try {
  await build({
    root: webRoot,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: false,
      rollupOptions: {
        input: {
          app: join(webRoot, 'index.html'),
          workerPrivacy: join(webRoot, 'worker-privacy.html'),
        },
      },
    },
  });
  previewServer = await preview({
    root: webRoot,
    logLevel: 'silent',
    build: { outDir },
    preview: { host: '127.0.0.1', port: 0 },
  });
  const origin = previewServer.resolvedUrls?.local[0];
  if (!origin) throw new Error('Vite preview did not expose a local test URL.');

  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const requests = [];
  let ready = false;
  page.on('request', (request) => {
    if (ready) requests.push(request.url());
  });
  await page.exposeFunction('markByteqlWorkerReady', () => {
    ready = true;
  });
  await page.goto(`${origin}worker-privacy.html`);
  await page.waitForFunction(() => typeof globalThis.runByteqlWorkerProbe === 'function');

  const result = await page.evaluate(() => globalThis.runByteqlWorkerProbe?.());
  await page.waitForTimeout(100);
  if (!result) throw new Error('The browser worker probe returned no result.');
  if (requests.length > 0) {
    throw new Error(`Post-ready worker recreation made network requests:\n${requests.join('\n')}`);
  }
  if (result.workerCount !== 4) throw new Error(`Expected four workers, received ${result.workerCount}.`);
  if (!result.cancellation.startsWith('AbortError:')) throw new Error(result.cancellation);
  if (!result.crash.includes('worker stopped unexpectedly')) throw new Error(result.crash);
  if (!result.messageError.includes('worker stopped unexpectedly')) throw new Error(result.messageError);
  if (!result.initial.includes('Standard MIDI File header')) throw new Error(result.initial);
  if (!result.recreated.includes('Standard MIDI File header')) throw new Error(result.recreated);

  await page.close();

  const appPage = await browser.newPage({ viewport: { width: 760, height: 800 } });
  const appRequests = [];
  let releaseWasm;
  const wasmBlocked = new Promise((resolve) => {
    releaseWasm = resolve;
  });
  let wasmRequested = false;
  await appPage.route(/duckdb.*\.wasm/u, async (route) => {
    wasmRequested = true;
    await wasmBlocked;
    await route.continue();
  });
  appPage.on('request', (request) => appRequests.push(request.url()));
  await appPage.goto(origin);
  await appPage.waitForFunction(() => document.querySelector('.startup-state') !== null);
  await new Promise((resolve, reject) => {
    let settled = false;
    const deadline = setTimeout(() => {
      settled = true;
      reject(new Error('The production app did not request DuckDB WASM.'));
    }, 10_000);
    const check = () => {
      if (settled) return;
      if (wasmRequested) {
        settled = true;
        clearTimeout(deadline);
        resolve();
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
  if ((await appPage.locator('[data-app-ready="true"]').count()) !== 0) {
    throw new Error('The production app published readiness before the DuckDB WASM dependency resolved.');
  }

  releaseWasm();
  await appPage.locator('[data-app-ready="true"]').waitFor();
  const readyRequestCount = appRequests.length;
  await appPage.waitForTimeout(150);
  const postAppReadyRequests = appRequests.slice(readyRequestCount);
  if (postAppReadyRequests.length > 0) {
    throw new Error(`The production app made requests after readiness:\n${postAppReadyRequests.join('\n')}`);
  }

  await appPage.getByLabel('Open file').focus();
  const openFileFocus = await appPage.getByText('Open file', { exact: true }).evaluate((label) => {
    const style = getComputedStyle(label);
    return { outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth) };
  });
  if (openFileFocus.outlineStyle === 'none' || openFileFocus.outlineWidth < 2) {
    throw new Error(`Open file focus is not visibly outlined: ${JSON.stringify(openFileFocus)}`);
  }

  await appPage.getByRole('button', { name: 'Try sample' }).click();
  await appPage.getByRole('textbox', { name: 'SQL query' }).waitFor();
  await appPage.waitForFunction(() => document.querySelectorAll('.sql-editor .cm-content span').length >= 3);
  const editorContrast = await appPage.locator('.sql-editor').evaluate((editor) => {
    const channel = (value) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color) => {
      const values =
        color
          .match(/[\d.]+/gu)
          ?.slice(0, 3)
          .map(Number) ?? [];
      return 0.2126 * channel(values[0]) + 0.7152 * channel(values[1]) + 0.0722 * channel(values[2]);
    };
    const background = getComputedStyle(editor).backgroundColor;
    const backgroundLuminance = luminance(background);
    const colors = [
      ...new Set(
        Array.from(editor.querySelectorAll('.cm-content span'), (span) => getComputedStyle(span).color),
      ),
    ];
    const ratios = colors.map((color) => {
      const foreground = luminance(color);
      return (
        (Math.max(foreground, backgroundLuminance) + 0.05) /
        (Math.min(foreground, backgroundLuminance) + 0.05)
      );
    });
    return { background, colors, ratios };
  });
  if (editorContrast.colors.length < 3 || editorContrast.ratios.some((ratio) => ratio < 4.5)) {
    throw new Error(`SQL syntax contrast is below 4.5:1: ${JSON.stringify(editorContrast)}`);
  }

  console.log(
    JSON.stringify({
      postReadyRequests: requests,
      postAppReadyRequests,
      openFileFocus,
      editorContrast,
      ...result,
    }),
  );
} finally {
  await browser?.close();
  if (previewServer) {
    await new Promise((resolve, reject) => {
      previewServer.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await rm(outDir, { recursive: true, force: true });
}
