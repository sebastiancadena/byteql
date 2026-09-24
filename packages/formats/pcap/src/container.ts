/**
 * Classic-pcap streaming framer: parses the 24-byte global header and iterates
 * 16-byte record headers, producing one `PcapPacket` per record. Pure TS — no
 * Kaitai — because the container format is a flat, fixed-size-header stream
 * that a hand-rolled `DataView` reader handles more simply than a generated
 * Kaitai parser would.
 *
 * `createPcapFramer` pulls fixed-size chunks (`PCAP_CHUNK_BYTES` by default)
 * from a `ByteSource` instead of requiring the whole capture in memory.
 * `body.bytes` is a `subarray` view into the *current* chunk, EXCEPT when
 * framing the record required a chunk reload (the record straddled the
 * previous chunk's edge) or a dedicated oversized read (a body larger than
 * one chunk) — in both of those cases the bytes are copied so they stay valid
 * across subsequent `next()` calls. `body.start` is always the absolute file
 * offset of that view/copy — later tasks (dissect, projection) rely on both
 * for byte provenance.
 *
 * `parsePcapContainer` is an eager compatibility wrapper that drains a framer
 * over `memoryByteSource` and returns the whole capture at once; existing
 * callers that don't need incremental framing use it unchanged.
 */

import { memoryByteSource, PackFatalError, type ByteSource } from '@byteql/core';

import { createChunkWindow } from './chunk-window.js';

export type PcapByteOrder = 'be' | 'le';
export type PcapTimeUnit = 'us' | 'ns';

export interface PcapHeader {
  byteOrder: PcapByteOrder;
  timeUnit: PcapTimeUnit;
  snaplen: number;
  linktype: number;
}

export interface PcapPacketBody {
  /** Absolute offset of `bytes[0]` within the original file buffer. */
  start: number;
  /**
   * A `subarray` view into the framer's current chunk, or a dedicated copy
   * when framing the record required a chunk reload or an oversized read
   * (see `createPcapFramer`'s doc comment) — either way, valid across
   * subsequent `next()` calls.
   */
  bytes: Uint8Array;
}

export interface PcapPacket {
  /** 0-based index of this record within the capture. */
  index: number;
  ts_sec: number;
  /** Fractional timestamp, always normalized to microseconds. */
  ts_frac_us: number;
  /** Exact fractional timestamp in nanoseconds (µs field × 1000, or the ns field as written). */
  ts_frac_ns: number;
  incl_len: number;
  orig_len: number;
  /** `linktype` from the global header, normalized for raw-IP (101 → 228/229). */
  linktype: number;
  /** Absolute offset of this record's 16-byte header. */
  recordStart: number;
  /** Absolute offset one past this record's body (i.e. `body.start + incl_len`). */
  bodyEnd: number;
  body: PcapPacketBody;
}

export interface PcapFramingIssue {
  code: string;
  message: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface PcapContainer {
  header: PcapHeader;
  packets: PcapPacket[];
  issues: PcapFramingIssue[];
}

const GLOBAL_HEADER_SIZE = 24;
const RECORD_HEADER_SIZE = 16;

/** Default chunk size the incremental framer reads from its `ByteSource`. */
export const PCAP_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Largest record body (classic) or parsed block (pcapng) either reader will read. Both read a
 * record whole, so without a cap a hostile file could declare one record as large as the file and
 * force an allocation of that size. 16 MiB is 64 times the largest snaplen in common use
 * (262,144); anything larger is reported and skipped by its declared length, never read.
 */
export const PCAP_MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** The four magic-number spellings pcap global headers may open with. */
const MAGIC_BE_US = 0xa1b2c3d4;
const MAGIC_BE_NS = 0xa1b23c4d;
const MAGIC_LE_US = 0xd4c3b2a1;
const MAGIC_LE_NS = 0x4d3cb2a1;

/** Raw-IP linktype, per the `LINKTYPE_RAW` family (tcpdump/libpcap). */
const LINKTYPE_RAW_IP = 101;
const LINKTYPE_RAW_IPV4 = 228;
const LINKTYPE_RAW_IPV6 = 229;

/** Raw-IP linktype 101 → 228 (IPv4) / 229 (IPv6) by peeking the version nibble. */
export function normalizeLinktype(linktype: number, body: Uint8Array): number {
  if (linktype !== LINKTYPE_RAW_IP) return linktype;
  const firstByte = body[0] ?? 0;
  return firstByte >> 4 === 4 ? LINKTYPE_RAW_IPV4 : LINKTYPE_RAW_IPV6;
}

function detectMagic(view: DataView): { byteOrder: PcapByteOrder; timeUnit: PcapTimeUnit } {
  const magicBe = view.getUint32(0, false);
  switch (magicBe) {
    case MAGIC_BE_US:
      return { byteOrder: 'be', timeUnit: 'us' };
    case MAGIC_BE_NS:
      return { byteOrder: 'be', timeUnit: 'ns' };
    case MAGIC_LE_US:
      return { byteOrder: 'le', timeUnit: 'us' };
    case MAGIC_LE_NS:
      return { byteOrder: 'le', timeUnit: 'ns' };
    default:
      throw new PackFatalError(
        'UNRECOGNIZED_PCAP_MAGIC',
        `UNRECOGNIZED_PCAP_MAGIC: expected one of the classic-pcap magic numbers, got 0x${magicBe.toString(16).padStart(8, '0')}`,
      );
  }
}

export interface PcapFramer {
  readonly header: PcapHeader;
  /** Frames and returns the next packet, or `null` once the capture (or its readable prefix) is exhausted. */
  next(): Promise<PcapPacket | null>;
  /** Framing issues collected so far (stable once `next()` has returned `null`). */
  issues(): readonly PcapFramingIssue[];
  /** Absolute offset up to which records have been successfully framed. */
  bytesConsumed(): number;
}

/**
 * Pull-based classic-pcap framer over a `ByteSource`: reads `chunkBytes`-sized
 * windows (with carry-over via reload, not a sliding buffer) instead of
 * requiring the whole capture in memory. Framing semantics — magic detection,
 * `TRUNCATED_RECORD` issues, raw-IP 101→228/229, ns→us normalization, absolute
 * offsets — are identical to the eager parser `parsePcapContainer` wraps.
 */
export async function createPcapFramer(
  source: ByteSource,
  chunkBytes: number = PCAP_CHUNK_BYTES,
  maxRecordBytes: number = PCAP_MAX_RECORD_BYTES,
): Promise<PcapFramer> {
  const headBytes = await source.read(0, GLOBAL_HEADER_SIZE);
  if (headBytes.length < GLOBAL_HEADER_SIZE) {
    throw new PackFatalError(
      'UNRECOGNIZED_PCAP_MAGIC',
      `UNRECOGNIZED_PCAP_MAGIC: expected at least ${GLOBAL_HEADER_SIZE} global-header bytes, got ${headBytes.length}`,
    );
  }
  const headView = new DataView(headBytes.buffer, headBytes.byteOffset, headBytes.byteLength);
  const { byteOrder, timeUnit } = detectMagic(headView);
  const littleEndian = byteOrder === 'le';
  const header: PcapHeader = {
    byteOrder,
    timeUnit,
    snaplen: headView.getUint32(16, littleEndian),
    linktype: headView.getUint32(20, littleEndian),
  };

  const issues: PcapFramingIssue[] = [];

  const window = createChunkWindow(source, chunkBytes, GLOBAL_HEADER_SIZE);
  let cursor = GLOBAL_HEADER_SIZE;
  let index = 0;
  let stopped = false;

  const next = async (): Promise<PcapPacket | null> => {
    for (;;) {
      if (stopped) return null;
      if (cursor >= source.size) {
        stopped = true;
        return null;
      }
      const packet = await frame();
      if (packet !== 'skipped') return packet;
    }
  };

  const frame = async (): Promise<PcapPacket | 'skipped' | null> => {
    const recordStart = cursor;
    const headerEnd = recordStart + RECORD_HEADER_SIZE;
    if (headerEnd > source.size) {
      issues.push({
        code: 'TRUNCATED_RECORD',
        message: `record ${index}: expected a ${RECORD_HEADER_SIZE}-byte record header but only ${source.size - recordStart} bytes remain`,
        sourceStart: recordStart,
        sourceEnd: source.size,
      });
      stopped = true;
      return null;
    }

    const generationAtStart = window.generation;
    const headerRead = await window.ensure(recordStart, RECORD_HEADER_SIZE);
    const headerBytes = headerRead.bytes;
    const headerView = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
    const tsSec = headerView.getUint32(0, littleEndian);
    const tsUsecOrNsec = headerView.getUint32(4, littleEndian);
    const inclLen = headerView.getUint32(8, littleEndian);
    const origLen = headerView.getUint32(12, littleEndian);

    const bodyStart = headerEnd;
    const bodyEnd = bodyStart + inclLen;
    if (bodyEnd > source.size) {
      issues.push({
        code: 'TRUNCATED_RECORD',
        message: `record ${index}: declared ${inclLen} body bytes but only ${source.size - bodyStart} remain`,
        sourceStart: recordStart,
        sourceEnd: source.size,
      });
      stopped = true;
      return null;
    }
    if (inclLen > maxRecordBytes) {
      // The framing is intact (the declared body fits the file), so skip the body unread and
      // keep going rather than allocating it.
      issues.push({
        code: 'OVERSIZED_RECORD',
        message: `record ${index}: declared ${inclLen} body bytes, more than the ${maxRecordBytes}-byte limit; skipped`,
        sourceStart: recordStart,
        sourceEnd: bodyEnd,
      });
      cursor = bodyEnd;
      return 'skipped';
    }

    const bodyRead = await window.ensure(bodyStart, inclLen);
    // The record straddled the chunk edge it entered with (a reload happened
    // while framing it): the body view points into a chunk window that a
    // later `next()` call may recycle, so copy it now. Oversized dedicated
    // reads (`isChunkView === false`) are already isolated copies.
    const bodyBytes = window.stable(bodyRead, generationAtStart);
    const packetLinktype = normalizeLinktype(header.linktype, bodyBytes);

    const packet: PcapPacket = {
      index,
      ts_sec: tsSec,
      ts_frac_us: timeUnit === 'ns' ? Math.floor(tsUsecOrNsec / 1000) : tsUsecOrNsec,
      ts_frac_ns: timeUnit === 'ns' ? tsUsecOrNsec : tsUsecOrNsec * 1000,
      incl_len: inclLen,
      orig_len: origLen,
      linktype: packetLinktype,
      recordStart,
      bodyEnd,
      body: { bytes: bodyBytes, start: bodyStart },
    };

    cursor = bodyEnd;
    index += 1;
    return packet;
  };

  return {
    header,
    next,
    issues: () => issues,
    bytesConsumed: () => cursor,
  };
}

/**
 * Parses a classic-pcap byte buffer into its global header and per-record
 * packets. Eager compatibility wrapper over `createPcapFramer`, draining it
 * over a `memoryByteSource` — byte-identical framing to the incremental path.
 * Framing problems (truncated header or body) are reported as
 * `TRUNCATED_RECORD` issues and stop the loop, keeping packets already framed;
 * an unrecognized magic number is fatal and rejects.
 */
export async function parsePcapContainer(bytes: Uint8Array): Promise<PcapContainer> {
  const framer = await createPcapFramer(memoryByteSource(bytes));
  const packets: PcapPacket[] = [];
  for (let packet = await framer.next(); packet !== null; packet = await framer.next()) {
    packets.push(packet);
  }
  return { header: framer.header, packets, issues: [...framer.issues()] };
}
