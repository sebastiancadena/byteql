import { expect, it } from 'vitest';

import { pcapFormatPack } from '../src/index.js';

it('compiles the pcap spec against the pack hooks', () => {
  // definePack compiles the spec against the hook objects at load; the derived schemas list
  // the spec tables in order, then the engine-owned stream segment table and errors.
  expect(pcapFormatPack.schemas().map((t) => t.name)).toEqual([
    'packets',
    'interfaces',
    'ip',
    'tcp',
    'udp',
    'dns',
    'icmp',
    'icmpv6',
    'tls',
    'streams',
    'stream_segments',
    'errors',
  ]);
});
