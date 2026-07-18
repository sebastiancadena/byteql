import { existsSync } from 'node:fs';
import process from 'node:process';

/** @param {import('@playwright/test').BrowserType<import('@playwright/test').ChromiumBrowser>} chromium */
export function resolveChromiumExecutable(chromium) {
  const candidates = [
    process.env.BYTEQL_CHROMIUM_PATH,
    chromium.executablePath(),
    '/snap/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  if (!executablePath) {
    throw new Error(
      'Chromium is required. Install Playwright Chromium or set BYTEQL_CHROMIUM_PATH to a system executable.',
    );
  }
  return executablePath;
}
