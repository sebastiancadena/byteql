import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { ResultColumnsProbeReport } from '@byteql/db';

import { waitForAppReady } from './support/app.js';

for (const variant of ['mvp', 'eh'] as const) {
  test(`duplicate result columns in the ${variant} bundle`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    // This independent database probe must not depend on consumers migrated in later tasks.
    await page.goto('/');
    await waitForAppReady(page);
    const report = await page.evaluate(
      (bundle) =>
        (
          window.__byteqlE2E as unknown as {
            probeResultColumns(variant: 'mvp' | 'eh'): Promise<ResultColumnsProbeReport>;
          }
        ).probeResultColumns(bundle),
      variant,
    );
    const path = testInfo.outputPath(`result-columns-${variant}.json`);
    await writeFile(path, JSON.stringify(report, null, 2));
    await testInfo.attach(`result-columns-${variant}.json`, { path, contentType: 'application/json' });
    expect(report.errors).toEqual([]);
    expect(report.checks).toEqual({
      mixed: true,
      sameType: true,
      empty: true,
      sliced: true,
      ipc: true,
      exactValues: true,
    });
  });
}
