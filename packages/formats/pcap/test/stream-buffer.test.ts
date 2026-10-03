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
    const recordCount = 90;
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
    expect(totalBytes).toBeGreaterThan(MAX_BUFFER);

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
    expect(result.issues.filter((issue) => issue.code === 'STREAM_TRUNCATED')).toEqual([]);
  });

  it('reassembles a DNS-over-TCP direction carrying well over max_buffer', async () => {
    const perSegment = 400;
    const segmentCount = 100;
    const packets = [segment(53, 5000, SYN, new Uint8Array(0))];
    let seq = 5001;
    let txId = 0;
    for (let s = 0; s < segmentCount; s++) {
      const messages: Uint8Array[] = [];
      for (let m = 0; m < perSegment; m++) {
        messages.push(dnsOverTcp({ txId: txId++ & 0xffff, name: 'bulk.example', type: 1 }));
      }
      const payload = new Uint8Array(messages.reduce((sum, message) => sum + message.length, 0));
      let at = 0;
      for (const message of messages) {
        payload.set(message, at);
        at += message.length;
      }
      packets.push(segment(53, seq, PSH | ACK, payload));
      seq += payload.length;
    }
    expect(seq - 5001).toBeGreaterThan(MAX_BUFFER);

    const { result, table } = await run(packets);
    const flows = table('streams').toArray();
    expect(flows.map((flow) => [flow.status, flow.message_count, flow.pending_bytes])).toEqual([
      ['ok', perSegment * segmentCount, 0],
    ]);
    expect(table('dns').numRows).toBe(perSegment * segmentCount);
    expect(result.issues.filter((issue) => issue.code === 'STREAM_TRUNCATED')).toEqual([]);
  });
});
