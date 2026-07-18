/**
 * Classic-pcap streaming framer: parses the 24-byte global header and iterates
 * 16-byte record headers, producing one `PcapPacket` per record. Pure TS — no
 * Kaitai — because the container format is a flat, fixed-size-header stream
 * that a hand-rolled `DataView` reader handles more simply than a generated
 * Kaitai parser would.
 *
 * `body.bytes` is a `subarray` view (not a copy) into the original file buffer
 * and `body.start` is the absolute file offset of that view — later tasks
 * (dissect, projection) rely on both for byte provenance.
 */

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
  /** A `subarray` view into the original file buffer — never a copy. */
  bytes: Uint8Array;
}

export interface PcapPacket {
  /** 0-based index of this record within the capture. */
  index: number;
  tsSec: number;
  /** Fractional timestamp, always normalized to microseconds. */
  tsFracUs: number;
  inclLen: number;
  origLen: number;
  /** `linktype` from the global header, normalized for raw-IP (101 → 228/229). */
  linktype: number;
  /** Absolute offset of this record's 16-byte header. */
  recordStart: number;
  /** Absolute offset one past this record's body (i.e. `body.start + inclLen`). */
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

/** The four magic-number spellings pcap global headers may open with. */
const MAGIC_BE_US = 0xa1b2c3d4;
const MAGIC_BE_NS = 0xa1b23c4d;
const MAGIC_LE_US = 0xd4c3b2a1;
const MAGIC_LE_NS = 0x4d3cb2a1;

/** Raw-IP linktype, per the `LINKTYPE_RAW` family (tcpdump/libpcap). */
const LINKTYPE_RAW_IP = 101;
const LINKTYPE_RAW_IPV4 = 228;
const LINKTYPE_RAW_IPV6 = 229;

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
      throw new Error(
        `UNRECOGNIZED_PCAP_MAGIC: expected one of the classic-pcap magic numbers, got 0x${magicBe.toString(16).padStart(8, '0')}`,
      );
  }
}

/**
 * Parses a classic-pcap byte buffer into its global header and per-record
 * packets. Framing problems (truncated header or body) are reported as
 * `TRUNCATED_RECORD` issues and stop the loop, keeping packets already framed;
 * an unrecognized magic number is fatal and throws.
 */
export function parsePcapContainer(bytes: Uint8Array): PcapContainer {
  if (bytes.length < GLOBAL_HEADER_SIZE) {
    throw new Error(
      `UNRECOGNIZED_PCAP_MAGIC: expected at least ${GLOBAL_HEADER_SIZE} global-header bytes, got ${bytes.length}`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { byteOrder, timeUnit } = detectMagic(view);
  const littleEndian = byteOrder === 'le';

  const snaplen = view.getUint32(16, littleEndian);
  const linktype = view.getUint32(20, littleEndian);

  const header: PcapHeader = { byteOrder, timeUnit, snaplen, linktype };
  const packets: PcapPacket[] = [];
  const issues: PcapFramingIssue[] = [];

  let recordStart = GLOBAL_HEADER_SIZE;
  let index = 0;
  while (recordStart < bytes.length) {
    const headerEnd = recordStart + RECORD_HEADER_SIZE;
    if (headerEnd > bytes.length) {
      issues.push({
        code: 'TRUNCATED_RECORD',
        message: `record ${index}: expected a ${RECORD_HEADER_SIZE}-byte record header but only ${bytes.length - recordStart} bytes remain`,
        sourceStart: recordStart,
        sourceEnd: bytes.length,
      });
      break;
    }

    const tsSec = view.getUint32(recordStart, littleEndian);
    const tsUsecOrNsec = view.getUint32(recordStart + 4, littleEndian);
    const inclLen = view.getUint32(recordStart + 8, littleEndian);
    const origLen = view.getUint32(recordStart + 12, littleEndian);

    const bodyStart = headerEnd;
    const bodyEnd = bodyStart + inclLen;
    if (bodyEnd > bytes.length) {
      issues.push({
        code: 'TRUNCATED_RECORD',
        message: `record ${index}: declared ${inclLen} body bytes but only ${bytes.length - bodyStart} remain`,
        sourceStart: recordStart,
        sourceEnd: bytes.length,
      });
      break;
    }

    const bodyBytes = bytes.subarray(bodyStart, bodyEnd);
    let packetLinktype = linktype;
    if (linktype === LINKTYPE_RAW_IP) {
      const firstByte = bodyBytes[0] ?? 0;
      packetLinktype = firstByte >> 4 === 4 ? LINKTYPE_RAW_IPV4 : LINKTYPE_RAW_IPV6;
    }

    packets.push({
      index,
      tsSec,
      tsFracUs: timeUnit === 'ns' ? Math.floor(tsUsecOrNsec / 1000) : tsUsecOrNsec,
      inclLen,
      origLen,
      linktype: packetLinktype,
      recordStart,
      bodyEnd,
      body: { bytes: bodyBytes, start: bodyStart },
    });

    recordStart = bodyEnd;
    index += 1;
  }

  return { header, packets, issues };
}
