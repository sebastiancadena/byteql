import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

import { buildPcap, dnsOverTcp, dnsQuery, ethFrame, ipv4, tcp, udp } from './build-pcap.js';
import { pcapngFromPackets } from './build-pcapng.js';

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

// Regenerates apps/web/e2e/fixtures/sample.pcapng: the same single eth -> ipv4 -> udp -> dns
// packet as sample.pcap (query "a.ru"), written as a one-interface little-endian pcapng.
it.runIf(process.env.GENERATE_E2E_FIXTURES === '1')('writes the sample.pcapng e2e fixture', () => {
  const data = ethFrame({
    etherType: 0x0800,
    payload: ipv4({
      protocol: 17,
      src: '1.1.1.1',
      dst: '8.8.8.8',
      payload: udp({
        srcPort: 5000,
        dstPort: 53,
        payload: dnsQuery({ txId: 0x1234, name: 'a.ru', type: 1 }),
      }),
    }),
  });
  const bytes = pcapngFromPackets({ endian: 'le', linktype: 1, packets: [{ tsSec: 1, tsFrac: 0, data }] });
  const target = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../apps/web/e2e/fixtures/sample.pcapng',
  );
  writeFileSync(target, bytes);
});

// Regenerates apps/web/e2e/fixtures/tcp-reuse.pcap: two DNS-over-TCP connections on one 4-tuple
// (10.0.0.1:40000 -> 10.0.0.2:53). Connection 1: SYN, query "reuse-one.example", FIN.
// Connection 2: SYN (new ISN), query "reuse-two.example", RST. Packet 1 is the first SYN, whose
// TCP header starts at file offset 24 + 16 + 14 + 20 = 74 (global header, record header,
// Ethernet, IPv4) and is 20 bytes long.
it.runIf(process.env.GENERATE_E2E_FIXTURES === '1')('writes the tcp-reuse e2e fixture', () => {
  const one = dnsOverTcp({ txId: 0x0101, name: 'reuse-one.example', type: 1 });
  const two = dnsOverTcp({ txId: 0x0202, name: 'reuse-two.example', type: 1 });
  const packet = (seq: number, flags: number, data = new Uint8Array(0)) =>
    ethFrame({
      etherType: 0x0800,
      payload: ipv4({
        protocol: 6,
        src: '10.0.0.1',
        dst: '10.0.0.2',
        payload: tcp({ srcPort: 40000, dstPort: 53, flags, seq, payload: data }),
      }),
    });
  const pcap = buildPcap({
    magic: 'be_us',
    linktype: 1,
    packets: [
      packet(1000, 0x02),
      packet(1001, 0x18, one),
      packet(1001 + one.length, 0x11),
      packet(70000, 0x02),
      packet(70001, 0x18, two),
      packet(70001 + two.length, 0x04),
    ].map((data, i) => ({ tsSec: i + 1, tsFrac: 0, data })),
  });
  const target = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../apps/web/e2e/fixtures/tcp-reuse.pcap',
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, pcap);
});
