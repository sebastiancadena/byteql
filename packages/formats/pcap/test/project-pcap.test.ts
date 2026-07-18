import { ipcToTable } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { parseAndProjectPcap } from '../src/project-pcap.js';
import { buildPcap, dnsQuery, ethFrame, ipv4, udp } from './build-pcap.js';

const dns = dnsQuery({ txId: 0x1234, name: 'a.ru', type: 1 });
const pkt = ethFrame({
  etherType: 0x0800,
  payload: ipv4({
    protocol: 17,
    src: '1.1.1.1',
    dst: '8.8.8.8',
    payload: udp({ srcPort: 5000, dstPort: 53, payload: dns }),
  }),
});
const pcap = buildPcap({ magic: 'be_us', linktype: 1, packets: [{ tsSec: 1, tsFrac: 0, data: pkt }] });

const findTable = (result: Awaited<ReturnType<typeof parseAndProjectPcap>>, name: string) =>
  ipcToTable(result.tables.find((t) => t.name === name)!.ipc);

describe('parseAndProjectPcap', () => {
  it('projects the full dissect chain with packet_id propagation', async () => {
    const result = await parseAndProjectPcap(pcap, new AbortController().signal);
    const names = result.tables.map((t) => t.name);
    expect(names).toContain('dns');

    const dnsTable = findTable(result, 'dns');
    const row = dnsTable.get(0)!;
    expect(row.query_name).toBe('a.ru');

    const packets = findTable(result, 'packets');
    const packetRow = packets.get(0)!;
    // Synthetic keys are 1-based in the engine (createRuntimes → nextKey: 1n; see
    // core's dissect.test.ts asserting parent keys [1n, 1n, 2n, 2n]). The propagation
    // guarantee under test is that the dns row is parented to the first packets row —
    // i.e. its parent_key equals that row's key — which holds at the engine-true 1n.
    expect(packetRow.packet_id).toBe(1n);
    expect(row.packet_id).toBe(packetRow.packet_id); // parented to packets row 0
    // Non-null root columns catch a broken camelCase → snake_case mapping.
    expect(packetRow.ts).not.toBeNull();
    expect(packetRow.caplen).not.toBeNull();
    expect(packetRow.len).not.toBeNull();
  });

  it('carries absolute provenance into the original file for a dns row', async () => {
    const result = await parseAndProjectPcap(pcap, new AbortController().signal);
    const dnsT = findTable(result, 'dns');
    const start = Number(dnsT.get(0)!._src_start);
    // DNS payload begins after 40 (headers) + 14 (eth) + 20 (ipv4) + 8 (udp) bytes.
    expect(start).toBe(40 + 14 + 20 + 8);
  });

  it('turns a poison transport payload into an errors row, not a throw', async () => {
    const bad = ethFrame({
      etherType: 0x0800,
      payload: ipv4({ protocol: 6, src: '1.1.1.1', dst: '2.2.2.2', payload: new Uint8Array([0]) }),
    });
    const p = buildPcap({ magic: 'be_us', linktype: 1, packets: [{ tsSec: 0, tsFrac: 0, data: bad }] });
    const result = await parseAndProjectPcap(p, new AbortController().signal);
    const errors = findTable(result, 'errors');
    expect(errors.numRows).toBeGreaterThan(0);
  });
});
