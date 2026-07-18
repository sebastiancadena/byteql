import { compileProjection, parseProjectionSpec } from '@byteql/core';
import { expect, it } from 'vitest';

import { pcapParserRegistry } from '../src/parsers.js';
import tablesYaml from '../src/pcap-tables.generated.js';

it('compiles the pcap spec against the parser registry', () => {
  const compiled = compileProjection(parseProjectionSpec(tablesYaml), pcapParserRegistry);
  expect(compiled.tables.map((t) => t.name)).toEqual([
    'packets',
    'ip',
    'tcp',
    'udp',
    'dns',
    'icmp',
    'icmpv6',
    'tls',
  ]);
});
