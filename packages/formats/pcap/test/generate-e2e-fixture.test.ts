import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

import { buildPcap, dnsOverTcp, ethFrame, ipv4, tcp } from './build-pcap.js';

// Regenerates apps/web/e2e/fixtures/dns-stream.pcap. Skipped unless explicitly requested:
//   GENERATE_E2E_FIXTURES=1 pnpm --filter @byteql/pcap test -- --run test/generate-e2e-fixture.test.ts
it.runIf(process.env.GENERATE_E2E_FIXTURES === '1')('writes the dns-stream e2e fixture', () => {
  const payload = dnsOverTcp({ txId: 0xbeef, name: 'stream.example', type: 1 });
  const packet = (seq: number, data: Uint8Array) =>
    ethFrame({
      etherType: 0x0800,
      payload: ipv4({
        protocol: 6,
        src: '10.0.0.1',
        dst: '10.0.0.2',
        payload: tcp({ srcPort: 40000, dstPort: 53, flags: 0x18, seq, payload: data }),
      }),
    });
  const pcap = buildPcap({
    magic: 'be_us',
    linktype: 1,
    packets: [
      { tsSec: 1, tsFrac: 0, data: packet(0, payload.subarray(0, 10)) },
      { tsSec: 1, tsFrac: 100, data: packet(10, payload.subarray(10)) },
    ],
  });
  const target = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../apps/web/e2e/fixtures/dns-stream.pcap',
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, pcap);
});
