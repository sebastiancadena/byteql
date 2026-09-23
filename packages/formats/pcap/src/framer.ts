import type { Framer } from '@byteql/core';

import { createPcapFramer, type PcapPacketBody } from './container.js';

/** Root shape of every `packets` record, from either container. Must stay total (strictFields). */
export interface PacketRootFields {
  ts_us: bigint | null;
  ts_ns: bigint | null;
  incl_len: number;
  orig_len: number;
  linktype: number;
  interface_id: number;
  comment: string | null;
  body: PcapPacketBody;
}

/** Root shape of every `interfaces` record, from either container. Must stay total. */
export interface InterfaceRootFields {
  section: number;
  if_index: number;
  linktype: number;
  snaplen: number;
  name: string | null;
  description: string | null;
  os: string | null;
  comment: string | null;
  ts_resolution: string;
  ts_offset_s: bigint;
}

export const packetRoot = (fields: PacketRootFields): PacketRootFields => fields;
export const interfaceRoot = (fields: InterfaceRootFields): InterfaceRootFields => fields;

const GLOBAL_HEADER_SIZE = 24;

export const pcapFramer: Framer = async function* (source, ctx) {
  const framer = await createPcapFramer(source, ctx.chunkBytes);
  // Classic pcap has exactly one implicit interface: the global header. It is yielded first so
  // the engine assigns it interface_id 1, which every classic packet references.
  ctx.bytes(GLOBAL_HEADER_SIZE);
  yield {
    root: interfaceRoot({
      section: 0,
      if_index: 0,
      linktype: framer.header.linktype,
      snaplen: framer.header.snaplen,
      name: null,
      description: null,
      os: null,
      comment: null,
      ts_resolution: framer.header.timeUnit === 'ns' ? '10^-9' : '10^-6',
      ts_offset_s: 0n,
    }),
    provenance: { start: 0, end: GLOBAL_HEADER_SIZE },
    tables: ['interfaces'],
  };
  for (let packet = await framer.next(); packet !== null; packet = await framer.next()) {
    ctx.bytes(framer.bytesConsumed()); // before yield: the driver flushes progress while this record is current
    const seconds = BigInt(packet.ts_sec);
    yield {
      root: packetRoot({
        ts_us: seconds * 1_000_000n + BigInt(packet.ts_frac_us),
        ts_ns: seconds * 1_000_000_000n + BigInt(packet.ts_frac_ns),
        incl_len: packet.incl_len,
        orig_len: packet.orig_len,
        linktype: packet.linktype,
        interface_id: 1,
        comment: null,
        body: packet.body,
      }),
      provenance: { start: packet.recordStart, end: packet.bodyEnd },
      tables: ['packets'],
    };
  }
  // Truncation is discovered at EOF; the driver still orders framing issues first.
  for (const issue of framer.issues()) ctx.report(issue);
  ctx.bytes(framer.bytesConsumed());
};
