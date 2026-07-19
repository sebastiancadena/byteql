import { Buffer } from 'node:buffer';

import { expect, test, type Page } from '@playwright/test';

import { generateCapture } from './support/capture.js';
import { runSql, setSessionOverrides, waitForAppReady, type SessionOverrides } from './support/app.js';

// Lowers the tiering thresholds well below production defaults so a modest capture exercises the
// OPFS spill tier and rolls multiple parquet chunks within a CI-friendly runtime. `rotationBytes`
// is deliberately much smaller than a first guess (e.g. 2 MiB) might suggest — see
// LARGE_CAPTURE_BYTES below for why.
const SPILL_OVERRIDES: SessionOverrides = {
  tiering: { tierThresholdBytes: 1024 * 1024, rotationBytes: 256 * 1024 },
};

const CAPTURE_SEED = 42;

// Under the 1 MiB tier threshold above -> memory tier. Generated once from the same seed as
// LARGE_CAPTURE_BYTES below, so its packet 1 is byte-identical to the large capture's packet 1
// (see generateCapture's determinism contract in support/capture.ts).
const SMALL_CAPTURE_BYTES = 64 * 1024;

// Over the 1 MiB tier threshold -> spill tier, and sized to guarantee >=2 rotated 'packets'
// parquet chunks. Two facts pin this value, both found empirically against the real pipeline in a
// real browser (see the Task 11 report):
//  1. The pcap projection pipeline only emits a SECOND 'packets' batch once the pending row count
//     across ALL tables crosses the fixed 65_536-row flush threshold (project-pcap.ts) — below
//     that, the whole capture arrives as one appendBatch call, and one call can only ever produce
//     ONE rotated (or residual) chunk. That threshold is first crossed, for this packet mix,
//     between 6.5 and 7 MiB of raw capture.
//  2. A raw-to-'packets'-IPC-bytes ratio of ~10:1 means the *2 MiB* rotationBytes the harness
//     override started with would need tens of MiB of raw capture to ever roll a chunk — and this
//     pipeline processes maybe ~0.1-1 MB/s of raw capture end to end (worker parse + DuckDB
//     insert), so tens of MiB is minutes per test, not seconds. Lowering rotationBytes to 256 KiB
//     — well under a single batch's ~760 KB of 'packets' IPC bytes — keeps the SAME code path
//     (rotateChunk, multiple opfs parquet chunks, parquet_scan view assembly) provably exercised
//     by a capture that finishes in a CI budget.
const LARGE_CAPTURE_BYTES = 8 * 1024 * 1024;

const asFile = (name: string, bytes: Uint8Array) => ({
  name,
  mimeType: 'application/vnd.tcpdump.pcap',
  buffer: Buffer.from(bytes),
});

/**
 * Reads every gridcell's text off the single-row result grid `limit 1` produces, in column
 * order. Multiple queries run in sequence against the same page, so "Row 1" from the PREVIOUS
 * result is already in the DOM when a new query starts — waiting on the row alone is not enough
 * to avoid reading stale content. Wait for a column header unique to the new query first.
 */
async function firstRowCells(page: Page, firstColumn: string): Promise<string[]> {
  // Not `exact` — the header's accessible name is "<field> <type>" (e.g. "_src_start Uint64"),
  // concatenated from the name/type spans ResultGrid.svelte renders for each columnheader.
  await page.getByRole('columnheader', { name: firstColumn }).waitFor();
  const row = page.getByRole('row', { name: 'Row 1', exact: true });
  await row.waitFor();
  return row.getByRole('gridcell').allTextContents();
}

test('a large capture streams through the opfs spill tier and stays queryable', async ({ page }) => {
  test.setTimeout(240_000);
  await setSessionOverrides(page, SPILL_OVERRIDES);
  await page.goto('/');
  await waitForAppReady(page);

  // Leg 1 (memory tier): open a small prefix of the same deterministic capture and read off the
  // provenance literals the spill-tier leg below must reproduce exactly — the resolution for the
  // "what should _src_start equal" question is to derive it empirically here, once, rather than
  // hard-code a guess about header/offset arithmetic.
  const small = generateCapture(SMALL_CAPTURE_BYTES, CAPTURE_SEED);
  await page.getByLabel('Open file').setInputFiles(asFile('scale-small.pcap', small.bytes));
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();

  await runSql(page, 'select _src_start, _src_end from packets order by packet_id limit 1');
  const memoryTierProvenance = await firstRowCells(page, '_src_start');
  expect(memoryTierProvenance).toHaveLength(2);

  // Leg 2 (spill tier): the "Open file" input only exists in the empty state (Workbench.svelte
  // unmounts it once a session is ready), so reaching it again means reloading — a fresh app
  // boot, re-reading the SAME `sessionOverrides` init script (addInitScript reapplies on every
  // navigation of this page). Same seed => packet 1 is byte-identical to leg 1's packet 1
  // (generateCapture's shape-per-index determinism), so its provenance must match exactly even
  // though this run streams through OPFS parquet chunks instead of an in-memory DuckDB table —
  // that cross-tier identity is the point of this test.
  await page.goto('/');
  await waitForAppReady(page);
  const large = generateCapture(LARGE_CAPTURE_BYTES, CAPTURE_SEED);
  await page.getByLabel('Open file').setInputFiles(asFile('scale.pcap', large.bytes));
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible({ timeout: 120_000 });

  await runSql(page, 'select count(*) as n from packets');
  await expect(page.getByRole('gridcell', { name: String(large.packetCount), exact: true })).toBeVisible();

  await runSql(page, "select count(*) as n from dns where query_name like 'host-%'");
  await expect(page.getByRole('gridcell', { name: String(large.dnsCount), exact: true })).toBeVisible();

  await runSql(page, 'select _src_start, _src_end from packets order by packet_id limit 1');
  const spillTierProvenance = await firstRowCells(page, '_src_start');
  // Absolute anchor: the first packet record header starts at byte 24 (the classic-pcap global
  // header size — see generateCapture's PCAP_GLOBAL_HEADER_SIZE in support/capture.ts).
  expect(Number(spillTierProvenance[0])).toBe(24);
  expect(spillTierProvenance).toEqual(memoryTierProvenance);

  // Rotation actually happened, not just a single residual flush at finalize.
  const files = await page.evaluate(() => window.__byteqlE2E!.spillFiles());
  const packetsChunks = files.filter((path) => path.includes('/packets/'));
  expect(packetsChunks.length).toBeGreaterThanOrEqual(2);
});

test('the memory tier still serves small files with identical values', async ({ page }) => {
  await setSessionOverrides(page, SPILL_OVERRIDES);
  await page.goto('/');
  await waitForAppReady(page);

  const { bytes, packetCount, dnsCount } = generateCapture(SMALL_CAPTURE_BYTES, CAPTURE_SEED);
  await page.getByLabel('Open file').setInputFiles(asFile('scale-small.pcap', bytes));
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();

  await runSql(page, 'select count(*) as n from packets');
  await expect(page.getByRole('gridcell', { name: String(packetCount), exact: true })).toBeVisible();

  await runSql(page, "select count(*) as n from dns where query_name like 'host-%'");
  await expect(page.getByRole('gridcell', { name: String(dnsCount), exact: true })).toBeVisible();

  const files = await page.evaluate(() => window.__byteqlE2E!.spillFiles());
  expect(files).toEqual([]);
});
