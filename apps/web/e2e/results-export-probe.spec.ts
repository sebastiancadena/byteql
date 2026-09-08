import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { ExportProbeReport } from '@byteql/db';

import { openMidiSample } from './support/app.js';

for (const variant of ['mvp', 'eh'] as const) {
  test(`Parquet scalar families: ${variant}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await openMidiSample(page);
    const report = await page.evaluate(
      ({ variant }) =>
        (
          window.__byteqlE2E as unknown as {
            probeResultsExport(variant: 'mvp' | 'eh', rows: number): Promise<ExportProbeReport>;
          }
        ).probeResultsExport(variant, 1),
      { variant },
    );
    const reportPath = testInfo.outputPath(`parquet-scalars-${variant}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await testInfo.attach(`parquet-scalars-${variant}.json`, {
      path: reportPath,
      contentType: 'application/json',
    });
    expect(report.productionWriter).toMatchObject({ exactTypes: true, emptySchema: true });
    expect(report.parquetTypes).toEqual([
      'TINYINT',
      'SMALLINT',
      'INTEGER',
      'BIGINT',
      'UTINYINT',
      'USMALLINT',
      'UINTEGER',
      'UBIGINT',
      'FLOAT',
      'DOUBLE',
      'DECIMAL(38,9)',
      'BOOLEAN',
      'VARCHAR',
      'BLOB',
      'DATE',
      'TIME',
      'TIMESTAMP',
      'TIMESTAMP_NS',
      'TIMESTAMP WITH TIME ZONE',
    ]);
    expect(report.requestsAfterReady).toEqual([]);
  });

  for (const rows of [250_000, 1_000_000, 2_000_000]) {
    test(`Parquet export gate: ${variant}, ${rows} rows`, async ({ page }, testInfo) => {
      test.setTimeout(300_000);
      page.on('pageerror', (error) => console.log('probe page error:', error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') console.log('probe console:', message.text());
      });
      await openMidiSample(page);
      const requests: Array<{ url: string; at: number }> = [];
      page.on('request', (request) => requests.push({ url: request.url(), at: Date.now() }));
      const cdp = await page.context().newCDPSession(page);
      const workerSessions = new Set<string>();
      let workerHeapPeak: number | null = null;
      let workerBackingPeak: number | null = null;
      let requestId = 0;
      cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
        if (targetInfo.type === 'worker' && targetInfo.url.startsWith('blob:')) workerSessions.add(sessionId);
      });
      cdp.on('Target.detachedFromTarget', ({ sessionId }) => workerSessions.delete(sessionId));
      cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
        const value = JSON.parse(message) as { result?: { usedSize?: number; backingStorageSize?: number } };
        if (value.result?.usedSize !== undefined)
          workerHeapPeak = Math.max(workerHeapPeak ?? 0, value.result.usedSize);
        if (value.result?.backingStorageSize !== undefined)
          workerBackingPeak = Math.max(workerBackingPeak ?? 0, value.result.backingStorageSize);
      });
      await cdp.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: false,
        filter: [{ type: 'worker', exclude: false }],
      });
      const interval = setInterval(() => {
        for (const sessionId of workerSessions)
          void cdp
            .send('Target.sendMessageToTarget', {
              sessionId,
              message: JSON.stringify({ id: ++requestId, method: 'Runtime.getHeapUsage' }),
            })
            .catch(() => undefined);
      }, 100);
      let report: ExportProbeReport;
      try {
        report = await page.evaluate(
          ({ variant, rows }) =>
            (
              window.__byteqlE2E as unknown as {
                probeResultsExport(variant: 'mvp' | 'eh', rows: number): Promise<ExportProbeReport>;
              }
            ).probeResultsExport(variant, rows),
          { variant, rows },
        );
      } finally {
        clearInterval(interval);
        await cdp.detach();
      }
      const networkAfterReady = requests
        .filter((request) => report.readyAtEpochMs !== null && request.at >= report.readyAtEpochMs)
        .map((request) => request.url);
      const evidence = { ...report, workerHeapPeak, workerBackingPeak, networkAfterReady };
      const reportPath = testInfo.outputPath(`export-${variant}-${rows}.json`);
      await writeFile(reportPath, JSON.stringify(evidence, null, 2));
      await testInfo.attach(`export-${variant}.json`, { path: reportPath, contentType: 'application/json' });
      expect(report).toMatchObject({
        rows,
        ordered: true,
        exactTypes: true,
        emptySchema: true,
        releasedFileReadable: true,
        cancellationPreservesResult: true,
        deniedOutsideAllowlist: true,
        productionWriter: { ordered: true, exactTypes: true, emptySchema: true },
      });
      if (rows >= 1_000_000) expect(report.inputIpcBytes).toBeGreaterThan(64 * 1024 * 1024);
      expect(report.requestsAfterReady).toEqual([]);
      expect(networkAfterReady).toEqual([]);
      expect(report.peakWasmBytes).toBeGreaterThan(0);
      expect(workerHeapPeak).not.toBeNull();
    });
  }
}
