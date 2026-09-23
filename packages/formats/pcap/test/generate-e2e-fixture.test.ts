import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

import { buildPcap, dnsOverTcp, dnsQuery, ethFrame, ipv4, tcp, udp } from './build-pcap.js';

// Regenerates apps/web/e2e/fixtures/dns-stream.pcap. Skipped unless explicitly requested:
//   GENERATE_E2E_FIXTURES=1 pnpm --filter @byteql/pcap exec vitest run test/generate-e2e-fixture.test.ts
// (NOT `pnpm ... test -- --run <file>`: pnpm appends `-- --run <file>` after the `test` script's
// own `&& vitest` tail, so vitest sees a literal `--` as its first arg and the filter never
// scopes — the whole suite runs. `exec vitest run <file>` invokes vitest directly, so the file
// argument reaches vitest's own filter unmangled. build-pcap.ts has no imports of its own (pure
// DataView writers), so this file needs no prior `byteql-pack build` step.)
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

// Regenerates apps/web/e2e/fixtures/interleaved-stream.pcap: a two-segment DNS-over-TCP query for
// "interleaved.example" (same construction as the dns-stream fixture above) with one unrelated UDP
// DNS query for "noise.example" sandwiched between the two TCP segments. The web acceptance test
// (hex-provenance.spec.ts) uses the UDP packet's bytes as a "gap" — inside the reassembled
// message's bounding span but outside both of its exact pieces — to prove filter-to-selection
// checks the pieces, not the span.
it.runIf(process.env.GENERATE_E2E_FIXTURES === '1')('writes the interleaved-stream e2e fixture', () => {
  const payload = dnsOverTcp({ txId: 0xface, name: 'interleaved.example', type: 1 });
  const tcpPacket = (seq: number, data: Uint8Array) =>
    ethFrame({
      etherType: 0x0800,
      payload: ipv4({
        protocol: 6,
        src: '10.0.0.1',
        dst: '10.0.0.2',
        payload: tcp({ srcPort: 40000, dstPort: 53, flags: 0x18, seq, payload: data }),
      }),
    });
  const noisePacket = ethFrame({
    etherType: 0x0800,
    payload: ipv4({
      protocol: 17,
      src: '10.0.0.3',
      dst: '10.0.0.4',
      payload: udp({
        srcPort: 51000,
        dstPort: 53,
        payload: dnsQuery({ txId: 0x1010, name: 'noise.example', type: 1 }),
      }),
    }),
  });
  const pcap = buildPcap({
    magic: 'be_us',
    linktype: 1,
    packets: [
      { tsSec: 1, tsFrac: 0, data: tcpPacket(0, payload.subarray(0, 10)) },
      { tsSec: 1, tsFrac: 50, data: noisePacket },
      { tsSec: 1, tsFrac: 100, data: tcpPacket(10, payload.subarray(10)) },
    ],
  });
  const target = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../apps/web/e2e/fixtures/interleaved-stream.pcap',
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, pcap);
});
