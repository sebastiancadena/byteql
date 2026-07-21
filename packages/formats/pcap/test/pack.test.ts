import { memoryByteSource } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { pcapFormatPack } from '../src/pack.js';
import { buildPcap } from './build-pcap.js';

describe('pcapFormatPack', () => {
  it('probes pcap magic in both byte orders', () => {
    expect(pcapFormatPack.probe(new Uint8Array([0xa1, 0xb2, 0xc3, 0xd4]))).toBe(1); // be_us
    expect(pcapFormatPack.probe(new Uint8Array([0xa1, 0xb2, 0x3c, 0x4d]))).toBe(1); // be_ns
    expect(pcapFormatPack.probe(new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1]))).toBe(1); // le_us
    expect(pcapFormatPack.probe(new Uint8Array([0x4d, 0x3c, 0xb2, 0xa1]))).toBe(1); // le_ns
    expect(pcapFormatPack.probe(new Uint8Array([0x4d, 0x54, 0x68, 0x64]))).toBeNull(); // MThd
  });

  it('returns null for a head shorter than 4 bytes', () => {
    expect(pcapFormatPack.probe(new Uint8Array([0xa1, 0xb2, 0xc3]))).toBeNull();
  });

  it('declares schemas for all eight pcap tables plus errors', () => {
    expect(pcapFormatPack.schemas().map((schema) => schema.name)).toEqual([
      'packets',
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
    const ip = pcapFormatPack.schemas().find((schema) => schema.name === 'ip')!;
    // key first, then parent key, then spec columns, then provenance.
    expect(ip.columns.map((column) => column.name)).toEqual([
      'ip_id',
      'packet_id',
      'version',
      'src_addr',
      'dst_addr',
      'proto',
      'hop_limit',
      'length',
      '_src_start',
      '_src_end',
    ]);
    expect(ip.columns.find((column) => column.name === 'ip_id')!.nullable).toBe(false);
    expect(ip.columns.find((column) => column.name === 'packet_id')!.nullable).toBe(false);
    expect(ip.columns.find((column) => column.name === 'hop_limit')!.nullable).toBe(true);

    const errors = pcapFormatPack.schemas().find((schema) => schema.name === 'errors')!;
    expect(errors.columns.map((column) => column.name)).toEqual([
      'error_id',
      'stage',
      'record',
      'code',
      'message',
      'recoverable',
      '_src_start',
      '_src_end',
    ]);
    expect(errors.columns.find((column) => column.name === 'record')!.nullable).toBe(true);
    expect(errors.columns.find((column) => column.name === 'error_id')!.nullable).toBe(false);
  });

  it('declares schemas for streams and stream_segments, and stream_id on tls/dns', () => {
    const schemas = pcapFormatPack.schemas();
    const byName = new Map(schemas.map((s) => [s.name, s]));
    expect(byName.get('streams')!.columns.map((c) => c.name)).toEqual([
      'stream_id',
      'src_addr',
      'src_port',
      'dst_addr',
      'dst_port',
      'segment_count',
      'byte_count',
      'message_count',
      'pending_bytes',
      'status',
      '_src_start',
      '_src_end',
    ]);
    expect(byName.get('stream_segments')!.columns.map((c) => c.name)).toEqual([
      'segment_id',
      'stream_id',
      'tcp_id',
      'offset',
      '_src_start',
      '_src_end',
    ]);
    expect(byName.get('dns')!.columns.map((c) => c.name)).toContain('stream_id');
    expect(byName.get('tls')!.columns.map((c) => c.name)).toContain('stream_id');
    const dnsStreamId = byName.get('dns')!.columns.find((c) => c.name === 'stream_id')!;
    expect(dnsStreamId.nullable).toBe(true);
  });

  it('open() drains to the projected tables then finish() returns', async () => {
    const pcap = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [{ tsSec: 0, tsFrac: 0, data: new Uint8Array([0]) }],
    });
    const src = pcapFormatPack.open(memoryByteSource(pcap), {
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    const seen: string[] = [];
    for (let b = await src.nextBatch(); b; b = await src.nextBatch()) seen.push(b.table);
    expect(seen).toContain('packets');
    expect(() => src.finish()).not.toThrow();
  });

  it('rejects finish() after only a partial drain', async () => {
    const pcap = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [{ tsSec: 0, tsFrac: 0, data: new Uint8Array([0]) }],
    });
    const src = pcapFormatPack.open(memoryByteSource(pcap), { signal: new AbortController().signal });
    const first = await src.nextBatch();
    expect(first?.table).toBe('packets');
    expect(() => src.finish()).toThrow(/RECORD_SOURCE_NOT_DRAINED/);
  });

  it('rejects when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const pcap = buildPcap({
      magic: 'be_us',
      linktype: 1,
      packets: [{ tsSec: 0, tsFrac: 0, data: new Uint8Array([0]) }],
    });
    const src = pcapFormatPack.open(memoryByteSource(pcap), { signal: controller.signal });
    await expect(src.nextBatch()).rejects.toThrow();
  });

  // Regression: packet_id restarts at 1 for every file in a multi-file session, so it is not
  // unique across files. Any saved query that joins across pcap tables must also match _src_file,
  // or a DNS row from one file matches same-id packets from other files (row inflation + wrong
  // timestamps). See fix(pcap) "scope the DNS-by-time join to _src_file for multi-file sessions".
  it('scopes the DNS-by-time saved query to the source file for multi-file safety', () => {
    const dnsByTime = pcapFormatPack.queries.find((query) => query.id === 'dns_join');
    expect(dnsByTime, 'the dns_join saved query must exist').toBeDefined();
    const sql = dnsByTime!.sql;
    // It joins packets, so it must also match _src_file...
    expect(sql).toMatch(/join\s+packets/i);
    expect(sql).toMatch(/_src_file/);
    // ...and must NOT use the cross-file-unsafe `using (packet_id)` join.
    expect(sql).not.toMatch(/using\s*\(\s*packet_id\s*\)/i);
  });

  it('has no saved query that joins pcap tables on packet_id without _src_file', () => {
    for (const query of pcapFormatPack.queries) {
      if (!/join\s+/i.test(query.sql)) continue;
      // Every cross-table join in a preset must be file-scoped (see regression above).
      expect(query.sql, `saved query "${query.id}" joins without _src_file`).toMatch(/_src_file/);
    }
  });
});
