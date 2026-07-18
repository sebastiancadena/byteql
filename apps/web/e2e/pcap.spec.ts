import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { runSql, waitForAppReady } from './support/app.js';

// The fixture bytes are a committed, crafted `.pcap`: one eth -> ipv4 -> udp -> dns packet
// carrying a query for "a.ru", generated once from the Task 3 builders in
// packages/formats/pcap/test/build-pcap.ts (mirrors the packet built in
// packages/formats/pcap/test/project-pcap.test.ts). The e2e itself does not depend on those
// builders at test runtime — only on the static fixture file below.
const samplePcapPath = fileURLToPath(new URL('./fixtures/sample.pcap', import.meta.url));

test('opens a pcap and runs the DNS-join query', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);

  await page.getByLabel('Open file').setInputFiles(samplePcapPath);
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();

  await runSql(page, 'select query_name from dns join packets using (packet_id)');
  await expect(page.getByRole('gridcell', { name: 'a.ru' })).toBeVisible();
});
