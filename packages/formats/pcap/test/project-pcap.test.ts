import { ipcToTable } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { parseAndProjectPcap } from '../src/project-pcap.js';
import { buildPcap, dnsOverTcp, dnsQuery, ethFrame, ipv4, tcp, udp } from './build-pcap.js';

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
    // Concrete root-column values catch a transposed camelCase → snake_case remap
    // (e.g. ts_sec ← incl_len would still be non-null). The fixture has tsSec 1,
    // tsFrac 0, and a 64-byte packet body.
    // ts = ts_sec * 1e6 + ts_frac_us = 1_000_000 us; Arrow reads timestamp_us as ms → 1000.
    expect(packetRow.ts).toBe(1000);
    expect(packetRow.caplen).toBe(pkt.length); // incl_len = 64
    expect(packetRow.len).toBe(pkt.length); // orig_len = 64
    expect(packetRow.linktype).toBe(1);
  });

  it('carries absolute provenance into the original file for a dns row', async () => {
    const result = await parseAndProjectPcap(pcap, new AbortController().signal);
    const dnsT = findTable(result, 'dns');
    const start = Number(dnsT.get(0)!._src_start);
    // DNS payload begins after 40 (headers) + 14 (eth) + 20 (ipv4) + 8 (udp) bytes.
    expect(start).toBe(40 + 14 + 20 + 8);
  });

  it('projects a DNS packet with qdcount=0 with null query_name/query_type', async () => {
    // dnsQuery() always emits one question; qdcount=0 isn't expressible through it, so
    // build the minimal 12-byte DNS header directly (network/dns_packet.ksy's `seq`):
    // transaction_id(2) + flags(2) + qdcount(2)=0 + ancount(2) + nscount(2) + arcount(2).
    const emptyDns = Uint8Array.of(
      0x56,
      0x78, // transaction_id = 0x5678
      0x01,
      0x00, // flags: opcode=0 (valid), rd=1
      0x00,
      0x00, // qdcount = 0
      0x00,
      0x00, // ancount = 0
      0x00,
      0x00, // nscount = 0
      0x00,
      0x00, // arcount = 0
    );
    const pktNoQuestions = ethFrame({
      etherType: 0x0800,
      payload: ipv4({
        protocol: 17,
        src: '1.1.1.1',
        dst: '8.8.8.8',
        payload: udp({ srcPort: 5000, dstPort: 53, payload: emptyDns }),
      }),
    });
    const pcapNoQuestions = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [{ tsSec: 1, tsFrac: 0, data: pktNoQuestions }],
    });

    const result = await parseAndProjectPcap(pcapNoQuestions, new AbortController().signal);
    const dnsTable = findTable(result, 'dns');
    expect(dnsTable.numRows).toBe(1);
    const row = dnsTable.get(0)!;
    expect(row.tx_id).toBe(0x5678);
    expect(row.qd_count).toBe(0);
    expect(row.query_name).toBeNull();
    expect(row.query_type).toBeNull();
  });

  it('projects a dns row from a single-segment DNS-over-TCP query', async () => {
    const pkt = ethFrame({
      etherType: 0x0800,
      payload: ipv4({
        protocol: 6,
        src: '1.1.1.1',
        dst: '2.2.2.2',
        payload: tcp({
          srcPort: 5000,
          dstPort: 53,
          flags: 0,
          payload: dnsOverTcp({ txId: 9, name: 'a.ru', type: 1 }),
        }),
      }),
    });
    const p = buildPcap({ magic: 'be_us', linktype: 1, packets: [{ tsSec: 1, tsFrac: 0, data: pkt }] });
    const result = await parseAndProjectPcap(p, new AbortController().signal);
    const dnsTable = findTable(result, 'dns');
    expect(dnsTable.get(0)!.query_name).toBe('a.ru');
  });

  it('projects NO dns row for a tcp:53 handshake segment', async () => {
    const pkt = ethFrame({
      etherType: 0x0800,
      payload: ipv4({
        protocol: 6,
        src: '1.1.1.1',
        dst: '2.2.2.2',
        payload: tcp({
          srcPort: 5000,
          dstPort: 53,
          flags: 0x02 /* SYN */,
          payload: new Uint8Array(0),
        }),
      }),
    });
    const p = buildPcap({ magic: 'be_us', linktype: 1, packets: [{ tsSec: 1, tsFrac: 0, data: pkt }] });
    const result = await parseAndProjectPcap(p, new AbortController().signal);
    expect(findTable(result, 'dns').numRows).toBe(0);
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
