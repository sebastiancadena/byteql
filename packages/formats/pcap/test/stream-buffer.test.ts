import { ipcToTable } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { buildPcap, dnsOverTcp, ethFrame, ipv4, tcp, tlsClientHello } from './build-pcap.js';
import { parseAndProjectPcap } from './parse-and-project.js';

// Both pcap streams declare max_buffer: 1048576 (pcap.tables.yaml). The cap bounds the bytes a
// flow has buffered but not yet framed, not the flow's lifetime total, so a long healthy
// connection must reassemble end to end.
const MAX_BUFFER = 1_048_576;
const SYN = 0x02;
const ACK = 0x10;
const PSH = 0x08;

const segment = (port: number, seq: number, flags: number, payload: Uint8Array) =>
  ethFrame({
    etherType: 0x0800,
    payload: ipv4({
      protocol: 6,
      src: '10.0.0.1',
      dst: '10.0.0.2',
      payload: tcp({ srcPort: 40000, dstPort: port, flags, seq, payload }),
    }),
  });

const applicationData = (index: number, bodyLength: number) => {
  const record = new Uint8Array(5 + bodyLength);
  record.set([0x17, 0x03, 0x03, bodyLength >> 8, bodyLength & 0xff]);
  record.fill(index & 0xff, 5);
  return record;
};

const capture = (packets: Uint8Array[]) =>
  buildPcap({
    magic: 'be_us',
    linktype: 1,
    packets: packets.map((data, i) => ({ tsSec: i + 1, tsFrac: 0, data })),
  });

const run = async (packets: Uint8Array[]) => {
  const result = await parseAndProjectPcap(capture(packets), new AbortController().signal);
  const table = (name: string) => ipcToTable(result.tables.find((t) => t.name === name)!.ipc);
  return { result, table };
};

describe('stream buffer cap counts only unconsumed bytes', () => {
  it('reassembles a TLS direction carrying well over max_buffer across many records', async () => {
    const hello = tlsClientHello({ sni: 'long.example' });
    const recordCount = 160;
    const bodyLength = 16_000;
    const packets = [segment(443, 1000, SYN, new Uint8Array(0)), segment(443, 1001, PSH | ACK, hello)];
    let seq = 1001 + hello.length;
    for (let i = 0; i < recordCount; i++) {
      // Split every record across two TCP segments so framing has to wait on each one.
      const record = applicationData(i, bodyLength);
      const cut = 7000;
      packets.push(segment(443, seq, ACK, record.subarray(0, cut)));
      packets.push(segment(443, seq + cut, PSH | ACK, record.subarray(cut)));
      seq += record.length;
    }
    const totalBytes = seq - 1001;
    expect(totalBytes).toBeGreaterThan(2 * MAX_BUFFER + 65_536); // past the history window

    const { result, table } = await run(packets);
    const flows = table('streams').toArray();
    expect(flows).toHaveLength(1);
    expect(flows[0]!.status).toBe('ok');
    expect(flows[0]!.message_count).toBe(recordCount + 1);
    expect(flows[0]!.byte_count).toBe(totalBytes);
    expect(flows[0]!.pending_bytes).toBe(0);
    expect(
      table('tls')
        .toArray()
        .map((row) => row.sni),
    ).toEqual(['long.example']);
    expect(result.issues).toEqual([]);
  });

  // Long names make each DNS-over-TCP message ~225 bytes, so a few thousand messages carry the
  // flow well past 2 x max_buffer — beyond the consumed-history window, so compaction runs.
  const longName = (i: number) => `${'a'.repeat(60)}${i % 10}.${'b'.repeat(63)}.${'c'.repeat(63)}.example`;
  const dnsMessages = (count: number) =>
    Array.from({ length: count }, (_, i) => dnsOverTcp({ txId: i & 0xffff, name: longName(i), type: 1 }));
  const concat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  const span = (row: { _src_start: bigint; _src_end: bigint }) => Number(row._src_end - row._src_start);
  const piecesLength = (ranges: { toArray(): { start: bigint; end: bigint }[] } | null) =>
    (ranges?.toArray() ?? []).reduce((sum, piece) => sum + Number(piece.end - piece.start), 0);

  it('emits one row with exact provenance per DNS message when every message has its own segment', async () => {
    const messages = dnsMessages(12_000);
    const packets = [segment(53, 5000, SYN, new Uint8Array(0))];
    let seq = 5001;
    for (const message of messages) {
      packets.push(segment(53, seq, PSH | ACK, message));
      seq += message.length;
    }
    expect(seq - 5001).toBeGreaterThan(2 * MAX_BUFFER + 65_536);

    const { result, table } = await run(packets);
    expect(result.issues).toEqual([]);
    const flows = table('streams').toArray();
    expect(flows.map((flow) => [flow.status, flow.message_count, flow.pending_bytes])).toEqual([
      ['ok', messages.length, 0],
    ]);
    const rows = table('dns').toArray();
    expect(rows).toHaveLength(messages.length);
    rows.forEach((row, i) => {
      expect(row._src_start).toBeLessThan(row._src_end);
      expect(span(row)).toBe(messages[i]!.length);
      expect(row._src_ranges).toBeNull(); // a single segment: the span alone is exact
      expect(row.query_name).toBe(longName(i));
    });
  });

  it('keeps exact multi-piece provenance for DNS messages straddling segments past the window', async () => {
    const messages = dnsMessages(12_000);
    const stream = concat(messages);
    expect(stream.length).toBeGreaterThan(2 * MAX_BUFFER + 65_536);
    // Fixed-size cuts that ignore message boundaries, so many messages straddle two segments.
    const cut = 9001;
    const packets = [segment(53, 5000, SYN, new Uint8Array(0))];
    for (let at = 0; at < stream.length; at += cut) {
      packets.push(segment(53, 5001 + at, PSH | ACK, stream.subarray(at, at + cut)));
    }

    const { result, table } = await run(packets);
    expect(result.issues).toEqual([]);
    expect(
      table('streams')
        .toArray()
        .map((flow) => [flow.status, flow.message_count, flow.pending_bytes]),
    ).toEqual([['ok', messages.length, 0]]);
    const rows = table('dns').toArray();
    expect(rows).toHaveLength(messages.length);
    let straddling = 0;
    rows.forEach((row, i) => {
      expect(row._src_start).toBeLessThan(row._src_end);
      if (row._src_ranges === null) {
        expect(span(row)).toBe(messages[i]!.length);
      } else {
        straddling += 1;
        // A bounding span over two pieces; the pieces alone hold exactly the message bytes.
        expect(piecesLength(row._src_ranges)).toBe(messages[i]!.length);
        expect(span(row)).toBeGreaterThan(messages[i]!.length);
      }
    });
    expect(straddling).toBeGreaterThan(200);
  });
});
