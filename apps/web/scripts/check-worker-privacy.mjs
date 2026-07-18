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
      rollupOptions: { input: join(webRoot, 'worker-privacy.html') },
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

  console.log(JSON.stringify({ postReadyRequests: requests, ...result }));
} finally {
  await browser?.close();
  if (previewServer) {
    await new Promise((resolve, reject) => {
      previewServer.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await rm(outDir, { recursive: true, force: true });
}
