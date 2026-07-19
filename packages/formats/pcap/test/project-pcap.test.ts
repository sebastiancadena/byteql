import { ipcToTable, memoryByteSource, type BatchTransfer, type ParseProgress } from '@byteql/core';
import { Table } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { openPcapSource, parseAndProjectPcap } from '../src/project-pcap.js';
import {
  buildPcap,
  dnsOverTcp,
  dnsQuery,
  ethFrame,
  icmpv6Echo,
  ipv4,
  ipv6,
  tcp,
  tlsClientHello,
  udp,
} from './build-pcap.js';

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

  it('projects an icmpv6 row for ipv6 next-header 58', async () => {
    const pkt = ethFrame({
      etherType: 0x86dd,
      payload: ipv6({
        nextHeader: 58,
        src: '::1',
        dst: '::2',
        payload: icmpv6Echo({ id: 5, seq: 9 }),
      }),
    });
    const p = buildPcap({ magic: 'be_us', linktype: 1, packets: [{ tsSec: 1, tsFrac: 0, data: pkt }] });
    const result = await parseAndProjectPcap(p, new AbortController().signal);
    const t = findTable(result, 'icmpv6');
    expect(t.get(0)!.type).toBe(128);
    expect(t.get(0)!.packet_id).toBe(1n); // parented to the packet
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

const tcpPacket = (seq: number, payload: Uint8Array, srcPort = 40000, dstPort = 53) =>
  ethFrame({
    etherType: 0x0800,
    payload: ipv4({
      protocol: 6,
      src: '10.0.0.1',
      dst: '10.0.0.2',
      payload: tcp({ srcPort, dstPort, flags: 0x18, seq, payload }),
    }),
  });
const capture = (packets: Uint8Array[]) =>
  buildPcap({
    magic: 'be_us',
    linktype: 1,
    packets: packets.map((data, i) => ({ tsSec: i + 1, tsFrac: 0, data })),
  });

describe('tcp stream reassembly', () => {
  it('reassembles a DNS-over-TCP message split across two segments', async () => {
    const payload = dnsOverTcp({ txId: 0xbeef, name: 'stream.example', type: 1 });
    const result = await parseAndProjectPcap(
      capture([tcpPacket(0, payload.subarray(0, 10)), tcpPacket(10, payload.subarray(10))]),
      new AbortController().signal,
    );
    expect(result.issues).toHaveLength(0);
    const dnsT = findTable(result, 'dns');
    expect(dnsT.numRows).toBe(1);
    expect(dnsT.get(0)!.query_name).toBe('stream.example');
    expect(dnsT.get(0)!.packet_id).toBe(2n); // completing packet
    expect(dnsT.get(0)!.stream_id).toBe(1n);
    const streams = findTable(result, 'streams');
    expect(streams.numRows).toBe(1);
    const flow = streams.get(0)!;
    expect(flow.src_addr).toBe('10.0.0.1');
    expect(flow.dst_port).toBe(53);
    expect(flow.status).toBe('ok');
    expect(flow.message_count).toBe(1);
    const segs = findTable(result, 'stream_segments');
    expect(segs.numRows).toBe(2);
    expect(segs.get(0)!.stream_id).toBe(1n);
    expect(segs.get(0)!.tcp_id).toBe(1n);
    expect(segs.get(1)!.tcp_id).toBe(2n);
  });

  it('reassembles a TLS ClientHello split across three out-of-order segments', async () => {
    const record = tlsClientHello({ sni: 'split.example' });
    const third = Math.ceil(record.length / 3);
    const [s1, s2, s3] = [
      record.subarray(0, third),
      record.subarray(third, 2 * third),
      record.subarray(2 * third),
    ];
    const result = await parseAndProjectPcap(
      capture([
        tcpPacket(third, s2, 50000, 443), // out-of-order first capture
        tcpPacket(0, s1, 50000, 443),
        tcpPacket(2 * third, s3, 50000, 443),
      ]),
      new AbortController().signal,
    );
    expect(result.issues).toHaveLength(0);
    const tlsT = findTable(result, 'tls');
    expect(tlsT.numRows).toBe(1);
    expect(tlsT.get(0)!.sni).toBe('split.example');
    expect(tlsT.get(0)!.packet_id).toBe(3n);
    expect(findTable(result, 'stream_segments').numRows).toBe(3);
  });

  it('drops a retransmitted segment without an issue', async () => {
    const payload = dnsOverTcp({ txId: 1, name: 'dup.example', type: 1 });
    const result = await parseAndProjectPcap(
      capture([
        tcpPacket(0, payload.subarray(0, 8)),
        tcpPacket(0, payload.subarray(0, 8)),
        tcpPacket(8, payload.subarray(8)),
      ]),
      new AbortController().signal,
    );
    expect(result.issues).toHaveLength(0);
    expect(findTable(result, 'dns').numRows).toBe(1);
    expect(findTable(result, 'streams').get(0)!.segment_count).toBe(2);
  });

  it('marks a gapped stream and emits no message', async () => {
    const payload = dnsOverTcp({ txId: 2, name: 'gap.example', type: 1 });
    const result = await parseAndProjectPcap(
      capture([tcpPacket(0, payload.subarray(0, 8)), tcpPacket(12, payload.subarray(12))]),
      new AbortController().signal,
    );
    expect(result.issues).toEqual([expect.objectContaining({ code: 'STREAM_GAP' })]);
    expect(findTable(result, 'dns').numRows).toBe(0);
    expect(findTable(result, 'streams').get(0)!.status).toBe('gap');

    // The flush-time STREAM_GAP issue (reported by session.finish() -> flushStreams) must also
    // land in the SQL-queryable errors table, not just result.issues.
    const errors = findTable(result, 'errors');
    expect(errors.numRows).toBe(1);
    expect(errors.get(0)!.code).toBe('STREAM_GAP');
    expect(errors.get(0)!.stage).toBe('reassembling');
  });

  it('keeps udp dns rows with a null stream_id', async () => {
    const result = await parseAndProjectPcap(pcap, new AbortController().signal); // existing udp fixture
    expect(findTable(result, 'dns').get(0)!.stream_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// openPcapSource: pull-driven incremental projection
// ---------------------------------------------------------------------------

const rowObject = (table: Table, index: number): Record<string, unknown> =>
  Object.fromEntries(
    table.schema.fields.map((field) => [field.name, table.getChild(field.name)!.get(index)]),
  );

const mergeIpc = (parts: readonly BatchTransfer[]): Table =>
  new Table(parts.flatMap((part) => ipcToTable(part.ipc).batches));

const manyDnsPackets = (count: number): Uint8Array =>
  buildPcap({
    magic: 'be_us',
    linktype: 1,
    packets: Array.from({ length: count }, (_unused, i) => ({
      tsSec: i + 1,
      tsFrac: 0,
      data: ethFrame({
        etherType: 0x0800,
        payload: ipv4({
          protocol: 17,
          src: '1.1.1.1',
          dst: '8.8.8.8',
          payload: udp({
            srcPort: 5000,
            dstPort: 53,
            payload: dnsQuery({ txId: i, name: `q${i}.example`, type: 1 }),
          }),
        }),
      }),
    })),
  });

const drainAll = async (source: ReturnType<typeof openPcapSource>): Promise<BatchTransfer[]> => {
  const batches: BatchTransfer[] = [];
  for (let batch = await source.nextBatch(); batch !== null; batch = await source.nextBatch()) {
    batches.push(batch);
  }
  return batches;
};

describe('openPcapSource (incremental)', () => {
  it('emits multiple batches per table and their union equals the one-shot projection', async () => {
    const bytes = manyDnsPackets(20);
    const source = openPcapSource(
      memoryByteSource(bytes),
      { signal: new AbortController().signal },
      {
        chunkBytes: 4096,
        flushRowThreshold: 8,
      },
    );
    const batches = await drainAll(source);
    expect(() => source.finish()).not.toThrow();

    const byTable = new Map<string, BatchTransfer[]>();
    for (const batch of batches) {
      const parts = byTable.get(batch.table) ?? [];
      parts.push(batch);
      byTable.set(batch.table, parts);
    }
    expect(byTable.get('packets')!.length).toBeGreaterThanOrEqual(2);

    const oneShot = await parseAndProjectPcap(bytes, new AbortController().signal);
    for (const [name, parts] of byTable) {
      const merged = mergeIpc(parts);
      const expected = ipcToTable(oneShot.tables.find((t) => t.name === name)!.ipc);
      expect(merged.numRows).toBe(expected.numRows);
      for (let i = 0; i < merged.numRows; i += 1) {
        expect(rowObject(merged, i)).toEqual(rowObject(expected, i));
      }
    }
  });

  it('reports byte-based progress that ends at the file size', async () => {
    const bytes = manyDnsPackets(20);
    const progress: ParseProgress[] = [];
    const source = openPcapSource(
      memoryByteSource(bytes),
      { signal: new AbortController().signal, onProgress: (p) => progress.push(p) },
      { chunkBytes: 4096, flushRowThreshold: 8 },
    );
    await drainAll(source);
    source.finish();

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.stage === 'projecting')).toBe(true);
    expect(progress.every((p) => p.total === bytes.length)).toBe(true);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]!.completed).toBeGreaterThanOrEqual(progress[i - 1]!.completed);
    }
    expect(progress.at(-1)!.completed).toBe(bytes.length);
  });

  it('keeps the errors table and stream flushes at the tail', async () => {
    const payload = dnsOverTcp({ txId: 0xbeef, name: 'tail.example', type: 1 });
    const bytes = capture([tcpPacket(0, payload.subarray(0, 10)), tcpPacket(10, payload.subarray(10))]);
    const oneShot = await parseAndProjectPcap(bytes, new AbortController().signal);

    const source = openPcapSource(
      memoryByteSource(bytes),
      { signal: new AbortController().signal },
      {
        chunkBytes: 4096,
        flushRowThreshold: 2,
      },
    );
    const batches = await drainAll(source);
    source.finish();

    const lastPacketIndex = batches.map((b) => b.table).lastIndexOf('packets');
    const tailTables = ['streams', 'stream_segments', 'errors'];
    const tailIndices = batches.map((b, i) => (tailTables.includes(b.table) ? i : -1)).filter((i) => i >= 0);
    expect(tailIndices.length).toBeGreaterThan(0);
    expect(tailIndices.every((i) => i > lastPacketIndex)).toBe(true);

    for (const name of ['streams', 'stream_segments', 'dns']) {
      const parts = batches.filter((b) => b.table === name);
      const merged = mergeIpc(parts);
      const expected = ipcToTable(oneShot.tables.find((t) => t.name === name)!.ipc);
      expect(merged.numRows).toBe(expected.numRows);
      for (let i = 0; i < merged.numRows; i += 1) {
        expect(rowObject(merged, i)).toEqual(rowObject(expected, i));
      }
    }
  });

  it('still honors abort signals between chunks', async () => {
    const bytes = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [0, 1].map((i) => ({
        tsSec: i + 1,
        tsFrac: 0,
        // Unrecognized ether_type: dissect stops right after the packets row, so each
        // packet contributes exactly one pending row (no ip/udp/dns fan-out to race).
        data: ethFrame({ etherType: 0x9999, payload: new Uint8Array(0) }),
      })),
    });
    const controller = new AbortController();
    const source = openPcapSource(
      memoryByteSource(bytes),
      { signal: controller.signal },
      {
        chunkBytes: 4096,
        flushRowThreshold: 1,
      },
    );
    const first = await source.nextBatch();
    expect(first?.table).toBe('packets');
    controller.abort();
    await expect(source.nextBatch()).rejects.toThrow();
  });
});
