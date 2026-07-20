/* global clearTimeout, document, getComputedStyle, setTimeout */

import console from 'node:console';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { chromium } from '@playwright/test';
import { build, preview } from 'vite';

import { resolveChromiumExecutable } from './chromium.mjs';

const executablePath = resolveChromiumExecutable(chromium);

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const smpteFixture = fileURLToPath(
  new URL('../../../packages/formats/midi/test/fixtures/basic-type0.mid', import.meta.url),
);
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
  if (!result.initial.includes('No registered format recognizes this file')) throw new Error(result.initial);
  if (!result.recreated.includes('No registered format recognizes this file'))
    throw new Error(result.recreated);

  await page.close();

  const appPage = await browser.newPage({ viewport: { width: 980, height: 800 } });
  await appPage.addInitScript(() => {
    globalThis.__byteqlAudioResumeCalls = 0;
    const audioContext = globalThis.AudioContext;
    if (!audioContext) return;
    audioContext.prototype.resume = function resume() {
      globalThis.__byteqlAudioResumeCalls += 1;
      return Promise.resolve();
    };
  });
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
  const appOrigin = new URL(origin).origin;
  const externalAppRequests = appRequests.filter((url) => {
    const requestUrl = new URL(url);
    return requestUrl.protocol.startsWith('http') && requestUrl.origin !== appOrigin;
  });
  if (externalAppRequests.length > 0) {
    throw new Error(`The production app made external requests:\n${externalAppRequests.join('\n')}`);
  }
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
  await appPage.getByRole('menuitem', { name: 'MIDI song (.mid)' }).click();
  await appPage.getByRole('textbox', { name: 'SQL query' }).waitFor();
  await appPage.waitForFunction(() => document.querySelectorAll('.sql-editor .cm-content span').length >= 3);

  const resultsTab = appPage.getByRole('tab', { name: 'Results' });
  const inspectorTab = appPage.getByRole('tab', { name: 'Inspector' });
  await resultsTab.waitFor();
  const compactInitial = await appPage.evaluate(() => ({
    tablists: document.querySelectorAll('[role="tablist"]').length,
    panels: Array.from(document.querySelectorAll('[role="tabpanel"]'), (panel) => ({
      id: panel.id,
      hidden: panel.hidden,
      tabIndex: panel.tabIndex,
    })),
  }));
  if (
    compactInitial.tablists !== 1 ||
    compactInitial.panels.length !== 2 ||
    compactInitial.panels.filter((panel) => !panel.hidden && panel.tabIndex === 0).length !== 1 ||
    compactInitial.panels.filter((panel) => panel.hidden && panel.tabIndex === -1).length !== 1
  ) {
    throw new Error(`980px compact semantics are incomplete: ${JSON.stringify(compactInitial)}`);
  }

  await resultsTab.focus();
  await appPage.keyboard.press('Tab');
  if ((await appPage.evaluate(() => document.activeElement?.id)) !== 'workbench-panel-results') {
    throw new Error('Tab from the Results tab did not enter the active Results panel.');
  }
  await resultsTab.focus();
  await appPage.keyboard.press('ArrowRight');
  await appPage.keyboard.press('Tab');
  if ((await appPage.evaluate(() => document.activeElement?.id)) !== 'workbench-panel-inspector') {
    throw new Error('Tab from the Inspector tab did not skip the inactive Results panel.');
  }

  await appPage.setViewportSize({ width: 1440, height: 900 });
  await appPage.waitForFunction(() => document.querySelector('[role="tablist"]') === null);
  const desktopSemantics = await appPage.evaluate(() => ({
    tablists: document.querySelectorAll('[role="tablist"]').length,
    tabpanels: document.querySelectorAll('[role="tabpanel"]').length,
    mains: document.querySelectorAll('[role="main"][aria-label="Results"]').length,
    inspectors: document.querySelectorAll('aside[aria-label="Inspector"]').length,
  }));
  if (
    desktopSemantics.tablists !== 0 ||
    desktopSemantics.tabpanels !== 0 ||
    desktopSemantics.mains !== 1 ||
    desktopSemantics.inspectors !== 1
  ) {
    throw new Error(`1440px desktop semantics are incomplete: ${JSON.stringify(desktopSemantics)}`);
  }

  await appPage.setViewportSize({ width: 980, height: 800 });
  await appPage.getByRole('tablist', { name: 'Workbench views' }).waitFor();
  await inspectorTab.focus();
  await appPage.keyboard.press('Home');
  if ((await appPage.getByRole('tabpanel').getAttribute('id')) !== 'workbench-panel-results') {
    throw new Error('Compact mode did not restore Results as the sole exposed panel.');
  }

  await appPage.setViewportSize({ width: 1440, height: 900 });
  await appPage.getByRole('button', { name: 'Play all notes' }).click();
  await appPage.getByRole('button', { name: 'Run query' }).click();
  await appPage.getByRole('columnheader', { name: /seconds/u }).waitFor();
  await appPage.getByRole('button', { name: 'Open in…' }).click();
  await appPage.getByRole('menuitem', { name: 'Audio playback' }).click();
  if ((await appPage.evaluate(() => globalThis.__byteqlAudioResumeCalls)) !== 0) {
    throw new Error('The audio context resumed before the explicit Play gesture.');
  }
  await appPage.getByRole('button', { name: 'Play', exact: true }).click();
  await appPage.waitForTimeout(100);
  const audioResumeCalls = await appPage.evaluate(() => globalThis.__byteqlAudioResumeCalls);
  if (audioResumeCalls < 1) {
    const audioAlert = await appPage
      .getByRole('alert')
      .last()
      .textContent()
      .catch(() => null);
    throw new Error(
      `Expected the Play gesture to resume the audio context; received ${audioResumeCalls} resume calls. Viewer alert: ${audioAlert ?? 'none'}`,
    );
  }

  await appPage.getByRole('button', { name: 'Stop', exact: true }).click();
  await appPage.getByRole('button', { name: 'Play', exact: true }).click();
  await appPage.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await appPage.getByRole('button', { name: 'Close audio viewer' }).click();

  const postInteractionRequests = appRequests.slice(readyRequestCount);
  if (postInteractionRequests.length > 0) {
    throw new Error(
      `Local sample, query, inspection, or playback made requests after readiness:\n${postInteractionRequests.join('\n')}`,
    );
  }

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

  const smptePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const smpteRequests = [];
  smptePage.on('request', (request) => smpteRequests.push(request.url()));
  await smptePage.goto(origin);
  await smptePage.locator('[data-app-ready="true"]').waitFor();
  const smpteReadyRequestCount = smpteRequests.length;
  await smptePage.waitForTimeout(150);
  await smptePage.getByLabel('Open file').setInputFiles(smpteFixture);
  await smptePage.getByText('basic-type0.mid', { exact: true }).first().waitFor();
  await smptePage.getByRole('button', { name: 'Run query' }).waitFor();
  await smptePage.getByRole('button', { name: 'Play all notes' }).click();
  await smptePage.getByRole('button', { name: 'Run query' }).click();
  await smptePage.getByRole('columnheader', { name: /seconds/u }).waitFor();
  if ((await smptePage.getByRole('button', { name: 'Open in…' }).count()) !== 0) {
    throw new Error('SMPTE playback results exposed the disabled audio viewer.');
  }
  const smpteNotice = (
    await smptePage.getByRole('status', { name: 'Format capability notice' }).textContent({ timeout: 2_000 })
  )?.trim();
  const expectedSmpteNotice = 'SMPTE time division is not supported by the Phase 0 player.';
  if (smpteNotice !== expectedSmpteNotice) {
    throw new Error(`Expected the exact SMPTE capability reason; received ${smpteNotice ?? 'none'}.`);
  }
  const postSmpteReadyRequests = smpteRequests.slice(smpteReadyRequestCount);
  if (postSmpteReadyRequests.length > 0) {
    throw new Error(`SMPTE inspection made requests after readiness:\n${postSmpteReadyRequests.join('\n')}`);
  }

  console.log(
    JSON.stringify({
      postReadyRequests: requests,
      postAppReadyRequests,
      externalAppRequests,
      postInteractionRequests,
      postSmpteReadyRequests,
      audioResumeCalls,
      smpteNotice,
      openFileFocus,
      compactInitial,
      desktopSemantics,
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
