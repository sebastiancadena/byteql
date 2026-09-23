import type { Framer } from '@byteql/core';

import { createPcapFramer, type PcapPacketBody } from './container.js';
import { createPcapngReader, formatTsResolution } from './pcapng.js';

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

const NS_PER_US = 1000n;

/** floor division for a possibly negative bigint (tsoffset can move timestamps before 1970). */
const floorDiv = (value: bigint, divisor: bigint): bigint => {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
};

export const pcapngFramer: Framer = async function* (source, ctx) {
  const reader = await createPcapngReader(source, ctx.chunkBytes);
  for (let item = await reader.next(); item !== null; item = await reader.next()) {
    ctx.bytes(reader.bytesConsumed()); // before yield
    if (item.kind === 'interface') {
      const iface = item.iface;
      yield {
        root: interfaceRoot({
          section: iface.section,
          if_index: iface.ifIndex,
          linktype: iface.linktype,
          snaplen: iface.snaplen,
          name: iface.name,
          description: iface.description,
          os: iface.os,
          comment: iface.comment,
          ts_resolution: formatTsResolution(iface.tsResolution),
          ts_offset_s: iface.tsOffsetS,
        }),
        provenance: { start: iface.blockStart, end: iface.blockEnd },
        tables: ['interfaces'],
      };
    } else {
      const packet = item.packet;
      yield {
        root: packetRoot({
          ts_us: packet.tsNs === null ? null : floorDiv(packet.tsNs, NS_PER_US),
          ts_ns: packet.tsNs,
          incl_len: packet.inclLen,
          orig_len: packet.origLen,
          linktype: packet.linktype,
          interface_id: packet.interfaceOrdinal,
          comment: packet.comment,
          body: packet.body,
        }),
        provenance: { start: packet.blockStart, end: packet.blockEnd },
        tables: ['packets'],
      };
    }
  }
  for (const issue of reader.issues()) ctx.report(issue);
  ctx.bytes(reader.bytesConsumed());
};
