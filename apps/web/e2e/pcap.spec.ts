import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { runSql, waitForAppReady } from './support/app.js';

// The fixture bytes are a committed, crafted `.pcap`: one eth -> ipv4 -> udp -> dns packet
// carrying a query for "a.ru", generated once from the Task 3 builders in
// packages/formats/pcap/test/build-pcap.ts (mirrors the packet built in
// packages/formats/pcap/test/project-pcap.test.ts). The e2e itself does not depend on those
// builders at test runtime — only on the static fixture file below.
const samplePcapPath = fileURLToPath(new URL('./fixtures/sample.pcap', import.meta.url));
const samplePcapngPath = fileURLToPath(new URL('./fixtures/sample.pcapng', import.meta.url));
const streamPcapPath = fileURLToPath(new URL('./fixtures/dns-stream.pcap', import.meta.url));

test('opens a pcap and runs the DNS-join query', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);

  await page.getByLabel('Open file input').setInputFiles(samplePcapPath);
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

  await page.getByLabel('Open file input').setInputFiles(streamPcapPath);
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

test('loads the bundled pcap sample as a four-file session from the picker', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);

  // Open the "Try sample" dropdown and pick the flagship pcap sample.
  await page.getByRole('button', { name: 'Try sample' }).click();
  await page.getByRole('menuitem', { name: 'Network capture (pcap)' }).click();

  // All four captures land in one multi-file session — the _files catalog lists them.
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await runSql(page, 'select original_name from _files order by original_name');
  await expect(page.getByRole('gridcell', { name: 'SkypeIRC.cap' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'v6.pcap' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'dns-stream.pcap' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'http2-16-ssl.pcapng' })).toBeVisible();

  // v6.pcap exercises the IPv6 + DNS path: a recognizable query name proves it parsed.
  await runSql(page, "select query_name from dns where query_name = 'www.wide.ad.jp'");
  await expect(page.getByRole('gridcell', { name: 'www.wide.ad.jp' }).first()).toBeVisible();

  // dns-stream.pcap is a two-segment DNS-over-TCP query, so it reassembles into the streams
  // table — the "TCP flows" saved query is no longer empty on the bundled sample. The reassembled
  // message produces a dns row, and the flow itself lands in streams on port 53.
  await runSql(page, "select query_name from dns where query_name = 'stream.example'");
  await expect(page.getByRole('gridcell', { name: 'stream.example' }).first()).toBeVisible();
  await runSql(page, 'select src_port, dst_port from streams');
  await expect(page.getByRole('gridcell', { name: '53', exact: true }).first()).toBeVisible();

  // http2-16-ssl.pcapng is a real Wireshark pcapng: its TLS ClientHello's SNI reaches the tls
  // table, and its single interface lands in interfaces alongside the classic synthetic ones.
  await runSql(page, "select sni from tls where sni = 'localhost'");
  await expect(page.getByRole('gridcell', { name: 'localhost', exact: true }).first()).toBeVisible();
  await runSql(page, "select ts_resolution from interfaces where _src_file = 'http2-16-ssl.pcapng'");
  await expect(page.getByRole('gridcell', { name: '10^-9', exact: true })).toBeVisible();

  // Regression (multi-file join safety): packet_id restarts per file, so a DNS↔packets join must
  // also match _src_file. The file-scoped join must be 1:1 with the dns table — a cross-file-unsafe
  // `using (packet_id)` join would inflate the count by matching packets from other files.
  await runSql(
    page,
    'select (select count(*) from dns) = ' +
      '(select count(*) from dns d join packets p on d.packet_id = p.packet_id ' +
      'and d._src_file = p._src_file) as matches',
  );
  await expect(page.getByRole('gridcell', { name: 'true', exact: true })).toBeVisible();
});

test('opens a mixed pcap + pcapng session and joins packets to interfaces per file', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);

  await page.getByLabel('Open file input').setInputFiles([samplePcapPath, samplePcapngPath]);
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Both files carry the same DNS packet; each resolves to its own interface row.
  await runSql(
    page,
    `select count(*) as joined from packets p
     join interfaces i on p.interface_id = i.interface_id and p._src_file = i._src_file`,
  );
  // Wait for the custom query's result to land before reading its cell — the auto-run "overview"
  // query that fires on ready also has several "2" cells (per-table row counts), so the assertion
  // below is ambiguous against that stale grid.
  await expect(page.locator('.results-heading-meta').getByText('1 rows', { exact: true })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: '2', exact: true })).toBeVisible();
  await runSql(page, "select count(*) as n from dns where query_name = 'a.ru'");
  await expect(page.locator('.results-heading-meta').getByText('1 rows', { exact: true })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: '2', exact: true })).toBeVisible();
});
