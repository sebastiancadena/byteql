import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { runSql, waitForAppReady } from './support/app.js';

// The fixture bytes are a committed, crafted `.pcap`: one eth -> ipv4 -> udp -> dns packet
// carrying a query for "a.ru", generated once from the Task 3 builders in
// packages/formats/pcap/test/build-pcap.ts (mirrors the packet built in
// packages/formats/pcap/test/project-pcap.test.ts). The e2e itself does not depend on those
// builders at test runtime — only on the static fixture file below.
const samplePcapPath = fileURLToPath(new URL('./fixtures/sample.pcap', import.meta.url));
const streamPcapPath = fileURLToPath(new URL('./fixtures/dns-stream.pcap', import.meta.url));

test('opens a pcap and runs the DNS-join query', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);

  await page.getByLabel('Open file').setInputFiles(samplePcapPath);
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();

  // C1 regression: the sample fixture is a single eth -> ipv4 -> udp -> dns packet, so only
  // packets/ip/udp/dns (and errors) receive any rows — tcp, icmp, icmpv6, tls, streams, and
  // stream_segments all finalize as empty tables. The "overview" query auto-runs (Workbench,
  // fired on `ready`) the instant the session is ready and is a UNION ALL over every pcap table;
  // before the fix, the zero-row tables did not exist in DuckDB at all and the auto-run failed
  // with a Catalog Error instead of rendering a grid with those tables at 0 rows.
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('gridcell', { name: 'tcp', exact: true })).toBeVisible();

  await runSql(page, 'select query_name from dns join packets using (packet_id)');
  await expect(page.getByRole('gridcell', { name: 'a.ru' })).toBeVisible();
});

// The fixture bytes are a committed, crafted `.pcap`: a two-segment DNS-over-TCP query for
// "stream.example" split across TCP seq 0 (10 bytes) and seq 10 (remainder), generated once from
// the Task 3 builders in packages/formats/pcap/test/build-pcap.ts via the gated generator test
// packages/formats/pcap/test/generate-e2e-fixture.test.ts. The e2e itself does not depend on
// those builders at test runtime — only on the static fixture file below.
test('reassembles a two-segment DNS-over-TCP query and joins its stream tables', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);

  await page.getByLabel('Open file').setInputFiles(streamPcapPath);
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();

  await runSql(
    page,
    `select d.query_name, s.status, count(g.segment_id) as segments
     from dns d
     join streams s using (stream_id)
     join stream_segments g using (stream_id)
     group by d.query_name, s.status`,
  );
  await expect(page.getByRole('gridcell', { name: 'stream.example' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'ok', exact: true })).toBeVisible();
});
