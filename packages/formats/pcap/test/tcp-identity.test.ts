import { ipcToTable } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { buildPcap, dnsOverTcp, ethFrame, ipv4, tcp } from './build-pcap.js';
import { parseAndProjectPcap } from './parse-and-project.js';

const SYN = 0x02;
const FIN = 0x01;
const RST = 0x04;
const ACK = 0x10;
const PSH = 0x08;

export interface SegOptions {
  seq: number;
  flags: number;
  payload?: Uint8Array;
  reverse?: boolean; // server -> client
}
export const seg = ({ seq, flags, payload = new Uint8Array(0), reverse = false }: SegOptions) =>
  ethFrame({
    etherType: 0x0800,
    payload: ipv4({
      protocol: 6,
      src: reverse ? '10.0.0.2' : '10.0.0.1',
      dst: reverse ? '10.0.0.1' : '10.0.0.2',
      payload: tcp({
        srcPort: reverse ? 53 : 40000,
        dstPort: reverse ? 40000 : 53,
        flags,
        seq,
        payload,
      }),
    }),
  });
export const capture = (packets: Uint8Array[]) =>
  buildPcap({
    magic: 'be_us',
    linktype: 1,
    packets: packets.map((data, i) => ({ tsSec: i + 1, tsFrac: 0, data })),
  });
export const run = async (packets: Uint8Array[]) => {
  const result = await parseAndProjectPcap(capture(packets), new AbortController().signal);
  const table = (name: string) => ipcToTable(result.tables.find((t) => t.name === name)!.ipc);
  return { result, table };
};
const clientFlows = (table: ReturnType<typeof ipcToTable>) =>
  table.toArray().filter((row) => row.src_port === 40000);

describe('tcp connection identity (lifecycle)', () => {
  it('fixture 1: splits two connections on one 4-tuple separated by FIN', async () => {
    const a = dnsOverTcp({ txId: 1, name: 'first.example', type: 1 });
    const b = dnsOverTcp({ txId: 2, name: 'second.example', type: 1 });
    const { table } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 1001, flags: PSH | ACK, payload: a }),
      seg({ seq: 1001 + a.length, flags: FIN | ACK }),
      seg({ seq: 5000, flags: SYN }),
      seg({ seq: 5001, flags: PSH | ACK, payload: b }),
    ]);
    const flows = clientFlows(table('streams'));
    expect(flows.map((f) => [f.generation, f.handshake, f.close_reason, f.status])).toEqual([
      [1, true, 'fin', 'ok'],
      [2, true, null, 'ok'],
    ]);
    const dns = table('dns').toArray();
    expect(dns.map((d) => d.query_name)).toEqual(['first.example', 'second.example']);
    expect(dns[0]!.stream_id).not.toBe(dns[1]!.stream_id);
  });

  it('fixture 2: splits reuse after RST', async () => {
    const b = dnsOverTcp({ txId: 2, name: 'after-rst.example', type: 1 });
    const { table } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 1001, flags: RST }),
      seg({ seq: 9000, flags: SYN }),
      seg({ seq: 9001, flags: PSH | ACK, payload: b }),
    ]);
    const flows = clientFlows(table('streams'));
    expect(flows.map((f) => [f.generation, f.close_reason])).toEqual([
      [1, 'rst'],
      [2, null],
    ]);
    expect(
      table('dns')
        .toArray()
        .map((d) => d.query_name),
    ).toEqual(['after-rst.example']);
  });

  it('fixture 6: gives a SYN answered by RST two control-only flows', async () => {
    const { table } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 0, flags: RST | ACK, reverse: true }),
    ]);
    const flows = table('streams').toArray();
    expect(flows).toHaveLength(2);
    expect(flows.map((f) => [f.src_port, f.byte_count, f.handshake, f.close_reason])).toEqual([
      [40000, 0, true, null],
      [53, 0, false, 'rst'],
    ]);
    expect(table('stream_segments').numRows).toBe(2);
  });

  it('fixture 7: reports a gap, not a framer error, when the first data segment is missing', async () => {
    const payload = dnsOverTcp({ txId: 7, name: 'lost.example', type: 1 });
    const { table, result } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 1011, flags: PSH | ACK, payload: payload.subarray(10) }),
    ]);
    expect(clientFlows(table('streams'))[0]!.status).toBe('gap');
    expect(result.issues.map((i) => i.code)).toEqual(['STREAM_GAP']);
  });

  it('fix B: reports a gap when FIN closes past the last byte actually captured', async () => {
    // SYN at 1000 anchors the base at 1001 (ISN+1); no data ever arrives; FIN|ACK at 1501 is 500
    // bytes past that base, in the extended-offset space fix B compares against. The assembler
    // itself sees no internal hole (nothing was ever buffered), so only fix B's close-vs-data-end
    // check catches this.
    const { table, result } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 1501, flags: FIN | ACK }),
    ]);
    const flow = clientFlows(table('streams'))[0]!;
    expect(flow.status).toBe('gap');
    expect(result.issues.map((i) => i.code)).toEqual(['STREAM_GAP']);
  });

  it('control segments map packets to connections through stream_segments', async () => {
    const { table } = await run([seg({ seq: 1000, flags: SYN }), seg({ seq: 1001, flags: FIN | ACK })]);
    const segs = table('stream_segments').toArray();
    expect(segs.map((s) => [s.stream_id, s.tcp_id])).toEqual([
      [1n, 1n],
      [1n, 2n],
    ]);
    // provenance is the 20-byte TCP header
    expect(segs.map((s) => Number(s._src_end - s._src_start))).toEqual([20, 20]);
  });
});

describe('tcp connection identity (wraparound and overlap)', () => {
  it('fixture 3: reassembles a DNS response straddling 2^32', async () => {
    // 32-byte message; payload starts at 0xfffffff1, so byte 15 sits at 2^32. The third
    // segment's raw seq is (0xfffffff0 + 21) mod 2^32 = 5: without unwrapping it lands ~4 GiB
    // below the base and the stream truncates.
    const payload = dnsOverTcp({ txId: 3, name: 'wrap.example', type: 1 });
    const isn = 0xfffffff0;
    const { table, result } = await run([
      seg({ seq: isn, flags: SYN }),
      seg({ seq: isn + 1, flags: PSH | ACK, payload: payload.subarray(0, 10) }),
      seg({ seq: isn + 11, flags: PSH | ACK, payload: payload.subarray(10, 20) }),
      seg({ seq: (isn + 21) >>> 0, flags: PSH | ACK, payload: payload.subarray(20) }),
    ]);
    expect(result.issues).toEqual([]);
    expect(
      table('dns')
        .toArray()
        .map((d) => d.query_name),
    ).toEqual(['wrap.example']);
    expect(clientFlows(table('streams'))[0]!.status).toBe('ok');
  });

  it('fixture 4: accepts a repacked retransmission spanning two segments', async () => {
    const payload = dnsOverTcp({ txId: 4, name: 'repack.example', type: 1 });
    const { table, result } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 1001, flags: PSH | ACK, payload: payload.subarray(0, 6) }),
      seg({ seq: 1007, flags: PSH | ACK, payload: payload.subarray(6, 12) }),
      seg({ seq: 1004, flags: PSH | ACK, payload: payload.subarray(3) }), // covers both + the rest
    ]);
    expect(result.issues).toEqual([]);
    expect(
      table('dns')
        .toArray()
        .map((d) => d.query_name),
    ).toEqual(['repack.example']);
    const flow = clientFlows(table('streams'))[0]!;
    expect([flow.status, flow.conflict_count]).toEqual(['ok', 0]);
  });

  it('fixture 5: keeps the first bytes of a conflicting retransmission and flags it', async () => {
    const payload = dnsOverTcp({ txId: 5, name: 'first.example', type: 1 });
    const forged = payload.slice(0, 12);
    forged[11] ^= 0xff;
    const { table } = await run([
      seg({ seq: 1000, flags: SYN }),
      seg({ seq: 1001, flags: PSH | ACK, payload: payload.subarray(0, 12) }),
      seg({ seq: 1001, flags: PSH | ACK, payload: forged }), // packet 3: the conflicting one
      seg({ seq: 1013, flags: PSH | ACK, payload: payload.subarray(12) }),
    ]);
    expect(
      table('dns')
        .toArray()
        .map((d) => d.query_name),
    ).toEqual(['first.example']);
    expect(clientFlows(table('streams'))[0]!.conflict_count).toBe(1);
    const errors = table('errors').toArray();
    expect(errors.map((e) => e.code)).toEqual(['STREAM_OVERLAP_CONFLICT']);
    const conflictSeg = table('tcp').toArray()[2]!;
    expect(errors[0]!._src_start).toBe(conflictSeg._src_start + 20n); // its payload, past the TCP header
  });
});
