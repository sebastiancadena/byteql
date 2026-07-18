import process from 'node:process';

import { chromium, defineConfig, devices } from '@playwright/test';

import { resolveChromiumExecutable } from './scripts/chromium.mjs';

const executablePath = resolveChromiumExecutable(chromium);

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath, args: ['--no-sandbox'] },
      },
    },
  ],
  webServer: {
    command:
      'BYTEQL_E2E=1 pnpm build && pnpm exec vite preview --outDir dist-e2e --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
