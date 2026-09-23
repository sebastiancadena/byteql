import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

import type { FormatPack } from '@byteql/core';
import { midiFormatPack } from '@byteql/midi';
import { pcapFormatPack } from '@byteql/pcap';
import { zipFormatPack } from '@byteql/zip';
import { expect, test, type Page } from '@playwright/test';

import { waitForAppReady } from './support/app.js';
import { makeZip } from './support/zip.js';

// One case per registered pack. Each `open` mirrors the exact file-opening call the pack's own
// spec uses (pcap.spec.ts / zip.spec.ts): `setInputFiles` against the "Open file input" control.
// The MIDI file is the bundled demo asset audio.spec.ts opens via the "Try sample" picker
// (`apps/web/src/assets/fur_Elise_opening.mid`, see `apps/web/src/lib/session/samples.ts`),
// opened here the same `setInputFiles` way as the other two packs for a uniform flow.
const samplePcapPath = fileURLToPath(new URL('./fixtures/sample.pcap', import.meta.url));
const midiDemoPath = fileURLToPath(new URL('../src/assets/fur_Elise_opening.mid', import.meta.url));

const asZipFile = (name: string, bytes: Uint8Array) => ({
  name,
  mimeType: 'application/zip',
  buffer: Buffer.from(bytes),
});

interface PackCase {
  name: string;
  pack: FormatPack;
  open: (page: Page) => Promise<void>;
}

const CASES: readonly PackCase[] = [
  {
    name: 'pcap',
    pack: pcapFormatPack,
    open: async (page) => {
      await page.getByLabel('Open file input').setInputFiles(samplePcapPath);
    },
  },
  {
    name: 'midi',
    pack: midiFormatPack,
    open: async (page) => {
      await page.getByLabel('Open file input').setInputFiles(midiDemoPath);
    },
  },
  {
    name: 'zip',
    pack: zipFormatPack,
    open: async (page) => {
      const archive = makeZip([
        { name: 'alpha.txt', data: 'alpha contents' },
        { name: 'notes/readme.md', data: '# hello' },
      ]);
      await page.getByLabel('Open file input').setInputFiles(asZipFile('sample.zip', archive));
    },
  },
];

/**
 * Runs the currently-loaded SQL and waits for it to actually settle — success or failure —
 * before the caller inspects the page. `.results-heading` carries `data-result-settle-count`,
 * which the session bumps on every query that settles either way (`querySucceeded` or
 * `queryFailed`; see `Workbench.svelte` / `session/state.ts`). Waiting on the elapsed-time text
 * instead is flaky: two consecutive queries can round to the same 0.1 ms display and the wait
 * never observes a change. The settle counter changes on every execution, including a failing
 * one, so the wait cannot false-pass — the error-banner assertion below still gives the real
 * failure reason.
 */
async function runAndSettle(page: Page): Promise<void> {
  const heading = page.locator('.results-heading');
  const before = await heading.getAttribute('data-result-settle-count');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect.poll(() => heading.getAttribute('data-result-settle-count')).not.toBe(before);
}

for (const { name, pack, open } of CASES) {
  test(`runs every canned query of the ${name} pack without an error`, async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await open(page);
    await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();

    // The "overview" query auto-runs the instant the session is ready; wait for it to settle
    // before driving the example-query menu, and confirm it did not itself fail.
    await expect(page.locator('.results-heading-meta .result-count.tabular')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    expect(pack.queries.length).toBeGreaterThan(0);

    const queriesRegion = page.getByRole('region', { name: 'Example queries' });
    for (const query of pack.queries) {
      // Loading an example query only fills the editor — Run query executes it. Playback-kind
      // queries (MIDI) still land in the same grid/results machinery when merely run; only the
      // dedicated "Open in… > Audio playback" viewer renders a player, which this spec does not
      // open. So every query kind is checked the same way: no error surface.
      await queriesRegion.getByRole('button', { name: query.title, exact: true }).click();
      await runAndSettle(page);
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
  });
}
