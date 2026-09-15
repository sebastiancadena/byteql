import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { ResultSortProbeReport } from '@byteql/db';

import { openMidiSample } from './support/app.js';

/**
 * The execution gate this feature's plan puts before any controller or UI work: the whole
 * snapshot-sorting path — Arrow pages, private Parquet shards, typed ORDER BY, paged Arrow
 * output — proven against the real pinned DuckDB-WASM build under production hardening, for both
 * local bundles. A failure here is a blocked gate, not a prompt to cast values or rerun the SQL.
 *
 * The two bundles are held to different contracts on purpose. `eh` — what every current browser
 * selects — must sort correctly. `mvp` cannot: its `ORDER BY` over `parquet_scan` fails when the
 * key spans the full range of a signed 16- or 32-bit type, so production refuses sorting there.
 * The mvp expectations below pin that finding, including the measurement that attributes it to the
 * runtime rather than to this feature, so a future runtime upgrade that fixes it fails this test
 * and prompts re-enabling. See docs/result-column-sorting-compatibility.md.
 */
const readReport = async (page: import('@playwright/test').Page, variant: 'mvp' | 'eh') =>
  page.evaluate(
    (v) =>
      (
        window.__byteqlE2E as unknown as {
          probeResultSort(variant: 'mvp' | 'eh'): Promise<ResultSortProbeReport>;
        }
      ).probeResultSort(v),
    variant,
  );

for (const variant of ['mvp', 'eh'] as const) {
  test(`snapshot sorting in the ${variant} bundle`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    page.on('pageerror', (error) => console.log('sort probe page error:', error.message));
    await openMidiSample(page);
    const requests: Array<{ url: string; at: number }> = [];
    page.on('request', (request) => requests.push({ url: request.url(), at: Date.now() }));

    const report = await readReport(page, variant);

    const networkAfterReady = requests
      .filter((request) => report.readyAtEpochMs !== null && request.at >= report.readyAtEpochMs)
      .map((request) => request.url);
    const reportPath = testInfo.outputPath(`result-sort-${variant}.json`);
    await writeFile(reportPath, JSON.stringify({ ...report, networkAfterReady }, null, 2));
    await testInfo.attach(`result-sort-${variant}.json`, {
      path: reportPath,
      contentType: 'application/json',
    });

    // Holds for both bundles: sorting never resends the user's SQL, never borrows the original
    // result's connection, and never reaches outside its own storage.
    expect(report).toMatchObject({
      variant,
      originalSendCount: 1,
      sortConnectionIsolated: true,
      rowCount: 20_000,
      externalAccessDenied: true,
    });
    expect(report.requestsAfterReady).toEqual([]);
    expect(networkAfterReady).toEqual([]);

    if (variant === 'eh') {
      expect(report).toMatchObject({
        bundleSupportsSorting: true,
        valuesPreserved: true,
        schemaPreserved: true,
        tiesStable: true,
        nullsLast: true,
        cancellationSettled: true,
        resourcesReleased: true,
        runtimeOrderBy: { inMemory: true, parquet: true },
      });
      // Every admitted value family must survive the round trip exactly; a failure here is a
      // support gate to document and narrow, never something to cast around.
      expect(Object.entries(report.typedFixtures).filter(([, ok]) => !ok)).toEqual([]);
      return;
    }

    // mvp: sorting is refused, and this is the measurement that justifies refusing it. The
    // in-memory ordering succeeding while the identical ordering over a Parquet file the runtime
    // just wrote fails is what places the defect in the bundle, not in the snapshot path.
    expect(report).toMatchObject({
      bundleSupportsSorting: false,
      runtimeOrderBy: { inMemory: true, parquet: false },
    });
  });
}
