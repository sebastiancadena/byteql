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
