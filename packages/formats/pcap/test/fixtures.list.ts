import { readFile } from 'node:fs/promises';

import type { FixtureCase } from '@byteql/core/testing';

import { sllCapturePackets } from './sll-fixtures.js';
import { buildPcap, dnsQuery, ethFrame, ipv4, udp } from './build-pcap.js';
import { pcapngFromPackets } from './build-pcapng.js';
import { dnsStreamPcapng, multiSectionPcapng } from './pcapng-fixtures.js';

const file = (name: string, path: string, container = 'pcap'): FixtureCase => ({
  name,
  container,
  load: async () => new Uint8Array(await readFile(new URL(path, import.meta.url))),
});
const built = (name: string, make: () => Uint8Array, container = 'pcap'): FixtureCase => ({
  name,
  container,
  load: async () => make(),
});

export const PCAP_FIXTURES: FixtureCase[] = [
  file('sample.pcap', '../../../../apps/web/e2e/fixtures/sample.pcap'),
  file('dns-stream.pcap', '../../../../apps/web/e2e/fixtures/dns-stream.pcap'),
  file('interleaved-stream.pcap', '../../../../apps/web/e2e/fixtures/interleaved-stream.pcap'),
  file('v6.pcap', '../../../../apps/web/src/assets/v6.pcap'),
  file('SkypeIRC.cap', '../../../../apps/web/src/assets/SkypeIRC.cap'),
  built('le-ns-dns.pcap', () =>
    buildPcap({
      magic: 'le_ns',
      linktype: 1,
      packets: [
        {
          tsSec: 1,
          tsFrac: 999_999_999,
          data: ethFrame({
            etherType: 0x0800,
            payload: ipv4({
              protocol: 17,
              src: '10.0.0.1',
              dst: '10.0.0.2',
              payload: udp({
                srcPort: 5353,
                dstPort: 53,
                payload: dnsQuery({ txId: 7, name: 'a.example', type: 1 }),
              }),
            }),
          }),
        },
      ],
    }),
  ),
  file('http2-16-ssl.pcapng', '../../../../apps/web/src/assets/http2-16-ssl.pcapng', 'pcapng'),
  built('multi-section.pcapng', () => multiSectionPcapng().bytes, 'pcapng'),
  built('dns-stream.pcapng', dnsStreamPcapng, 'pcapng'),
  built('linux-sll.pcap', () =>
    buildPcap({ magic: 'le_us', linktype: 113, packets: sllCapturePackets('sll') }),
  ),
  built(
    'linux-sll2.pcapng',
    () => pcapngFromPackets({ endian: 'le', linktype: 276, packets: sllCapturePackets('sll2') }),
    'pcapng',
  ),
];
