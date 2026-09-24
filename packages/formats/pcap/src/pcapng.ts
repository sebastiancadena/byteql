/**
 * Streaming pcapng block reader. Walks blocks over a shared `ChunkWindow` (the same chunking,
 * straddle-copy, and oversized-read rules as the classic reader), tracking per-section byte
 * order and interfaces. Yields interface and packet items in file order; everything else is
 * skipped by its length. See docs/superpowers/specs/2026-09-23-pcapng-intake-design.md
 * ("Block framing", "Timestamps", "Errors") — this file implements that contract.
 */

import { PackFatalError, type ByteSource } from '@byteql/core';

import { createChunkWindow, type WindowRead } from './chunk-window.js';
import {
  normalizeLinktype,
  PCAP_CHUNK_BYTES,
  type PcapFramingIssue,
  type PcapPacketBody,
} from './container.js';
import { optionText, walkOptions } from './options.js';

export const BLOCK_SHB = 0x0a0d0d0a;
export const BLOCK_IDB = 1;
export const BLOCK_OPB = 2;
export const BLOCK_SPB = 3;
export const BLOCK_EPB = 6;
/** Valid block types that are not projected: NRB, ISB, systemd journal, DSB, custom (copyable / not). */
const SILENTLY_SKIPPED = new Set([4, 5, 9, 10, 0xbad, 0x40000bad]);

const BYTE_ORDER_MAGIC = 0x1a2b3c4d;
const MIN_LENGTH = { shb: 28, idb: 20, epb: 32, opb: 32, spb: 16 } as const;
const OPT_COMMENT = 1;
const SHB_OS = 3;
const IF_NAME = 2;
const IF_DESCRIPTION = 3;
const IF_TSRESOL = 9;
const IF_TSOFFSET = 14;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX_EXCLUSIVE = 2n ** 63n;
const NS_PER_S = 1_000_000_000n;

export interface TsResolution {
  base: 10 | 2;
  exponent: number;
}

export interface PcapngInterface {
  /** 1-based file-global ordinal of yielded interfaces; equals the engine's interface_id. */
  ordinal: number;
  section: number;
  ifIndex: number;
  linktype: number;
  snaplen: number;
  name: string | null;
  description: string | null;
  os: string | null;
  comment: string | null;
  tsResolution: TsResolution;
  tsOffsetS: bigint;
  blockStart: number;
  blockEnd: number;
}

export interface PcapngPacket {
  /** 0-based index among yielded packets. */
  index: number;
  interfaceOrdinal: number;
  /** The interface's linktype, raw-IP 101 normalized to 228/229. */
  linktype: number;
  tsNs: bigint | null;
  inclLen: number;
  origLen: number;
  comment: string | null;
  blockStart: number;
  blockEnd: number;
  body: PcapPacketBody;
}

export type PcapngItem =
  { kind: 'interface'; iface: PcapngInterface } | { kind: 'packet'; packet: PcapngPacket };

export interface PcapngReader {
  next(): Promise<PcapngItem | null>;
  issues(): readonly PcapFramingIssue[];
  bytesConsumed(): number;
}

export const decodeTsResolution = (byte: number): TsResolution =>
  byte & 0x80 ? { base: 2, exponent: byte & 0x7f } : { base: 10, exponent: byte };

export const formatTsResolution = (r: TsResolution): string => `${r.base}^-${r.exponent}`;

/** Precomputed per interface so the per-packet cost is one multiply/divide or shift. */
interface TsScale {
  multiply: bigint;
  divide: bigint;
  shift: bigint;
  offsetNs: bigint;
}

const tsScale = (r: TsResolution, offsetS: bigint): TsScale =>
  r.base === 10
    ? r.exponent <= 9
      ? { multiply: 10n ** BigInt(9 - r.exponent), divide: 1n, shift: 0n, offsetNs: offsetS * NS_PER_S }
      : { multiply: 1n, divide: 10n ** BigInt(r.exponent - 9), shift: 0n, offsetNs: offsetS * NS_PER_S }
    : { multiply: NS_PER_S, divide: 1n, shift: BigInt(r.exponent), offsetNs: offsetS * NS_PER_S };

/** floor(units · 10⁹ · resolution) + offset. `units` is non-negative, so `/` and `>>` floor. */
const toNs = (units: bigint, s: TsScale): bigint =>
  (((units * s.multiply) / s.divide) >> s.shift) + s.offsetNs;

const dataView = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** true = little-endian, false = big-endian, null = not a byte-order magic. */
const byteOrderAt = (view: DataView, offset: number): boolean | null => {
  if (view.getUint32(offset, true) === BYTE_ORDER_MAGIC) return true;
  if (view.getUint32(offset, false) === BYTE_ORDER_MAGIC) return false;
  return null;
};

/**
 * Rounds `length` up to a 4-byte boundary. Arithmetic, not `(length + 3) & ~3`: a uint32
 * captured length at or above 2^31 would go negative through 32-bit bitwise operators.
 */
export const padTo4 = (length: number): number => length + ((4 - (length % 4)) % 4);

const hex8 = (value: number): string => `0x${value.toString(16).padStart(8, '0')}`;

export async function createPcapngReader(
  source: ByteSource,
  chunkBytes: number = PCAP_CHUNK_BYTES,
): Promise<PcapngReader> {
  // The first Section Header Block decides whether this is pcapng at all: fatal paths only here.
  const head = await source.read(0, 16);
  const headView = dataView(head);
  // Short-circuit order matters: fewer than 4 bytes cannot even hold a block type.
  if (head.length < 4 || headView.getUint32(0, false) !== BLOCK_SHB) {
    throw new PackFatalError(
      'NOT_PCAPNG',
      'NOT_PCAPNG: the file does not start with a pcapng Section Header Block',
    );
  }
  if (head.length < 16) {
    throw new PackFatalError(
      'TRUNCATED_BLOCK',
      `TRUNCATED_BLOCK: the file ends after ${head.length} of the first Section Header Block's ` +
        'first 16 bytes (block type, length, byte-order magic, version)',
    );
  }
  const firstOrder = byteOrderAt(headView, 8);
  if (firstOrder === null) {
    throw new PackFatalError(
      'BAD_BYTE_ORDER_MAGIC',
      `BAD_BYTE_ORDER_MAGIC: first section byte-order magic is ${hex8(headView.getUint32(8, false))}`,
    );
  }
  const firstMajor = headView.getUint16(12, firstOrder);
  if (firstMajor !== 1) {
    throw new PackFatalError(
      'UNSUPPORTED_SECTION_VERSION',
      `UNSUPPORTED_SECTION_VERSION: first section major version ${firstMajor} is not 1`,
    );
  }

  const window = createChunkWindow(source, chunkBytes, 0);
  const issues: PcapFramingIssue[] = [];
  const unsupported = new Map<number, { count: number; start: number; end: number }>();
  let littleEndian = firstOrder;
  let section = -1;
  let sectionOs: string | null = null;
  // Positional per section; a malformed IDB leaves `null` so later indices stay correct.
  let interfaces: ({ iface: PcapngInterface; scale: TsScale } | null)[] = [];
  let ordinal = 0;
  let packetIndex = 0;
  let cursor = 0;
  let stopped = false;
  let finished = false;

  const report = (code: string, message: string, start: number, end: number) =>
    issues.push({ code, message, sourceStart: start, sourceEnd: end });
  const stop = (code: string, message: string, start: number, end: number) => {
    report(code, message, start, end);
    stopped = true;
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const [type, entry] of unsupported) {
      report(
        'UNSUPPORTED_BLOCK_TYPE',
        `block type ${hex8(type)}: ${entry.count} block(s) skipped`,
        entry.start,
        entry.end,
      );
    }
  };

  const next = async (): Promise<PcapngItem | null> => {
    while (!stopped) {
      const blockStart = cursor;
      if (blockStart >= source.size) {
        stopped = true;
        break;
      }
      const remaining = source.size - blockStart;
      if (remaining < 12) {
        stop(
          'TRUNCATED_BLOCK',
          `block at ${blockStart}: expected a 12-byte block header but only ${remaining} bytes remain`,
          blockStart,
          source.size,
        );
        break;
      }
      const generationAtStart = window.generation;
      const headerView = dataView((await window.ensure(blockStart, 12)).bytes);
      const isShb = headerView.getUint32(0, false) === BLOCK_SHB; // palindrome: order-independent
      if (isShb) {
        const order = byteOrderAt(headerView, 8);
        if (order === null) {
          stop(
            'BAD_BYTE_ORDER_MAGIC',
            `section header at ${blockStart}: byte-order magic is ${hex8(headerView.getUint32(8, false))}`,
            blockStart,
            blockStart + 12,
          );
          break;
        }
        littleEndian = order;
      }
      const type = headerView.getUint32(0, littleEndian);
      const length = headerView.getUint32(4, littleEndian);
      if (length < 12 || length % 4 !== 0) {
        stop(
          'BLOCK_LENGTH_MISMATCH',
          `block at ${blockStart}: total length ${length} is not a multiple of 4 of at least 12`,
          blockStart,
          blockStart + 12,
        );
        break;
      }
      if (length > remaining) {
        stop(
          'TRUNCATED_BLOCK',
          `block at ${blockStart}: declared ${length} bytes but only ${remaining} remain`,
          blockStart,
          source.size,
        );
        break;
      }
      const blockEnd = blockStart + length;
      const parsed =
        isShb || type === BLOCK_IDB || type === BLOCK_EPB || type === BLOCK_OPB || type === BLOCK_SPB;
      // Parsed blocks are read whole (one window read, so the body view and the trailer come from
      // the same chunk); skipped blocks only read their trailer.
      const read: WindowRead | null = parsed ? await window.ensure(blockStart, length) : null;
      const trailer = read
        ? dataView(read.bytes).getUint32(length - 4, littleEndian)
        : dataView((await window.ensure(blockEnd - 4, 4)).bytes).getUint32(0, littleEndian);
      if (trailer !== length) {
        stop(
          'BLOCK_LENGTH_MISMATCH',
          `block at ${blockStart}: trailing length ${trailer} does not match leading length ${length}`,
          blockStart,
          blockEnd,
        );
        break;
      }
      cursor = blockEnd;

      if (!read) {
        if (!SILENTLY_SKIPPED.has(type)) {
          const entry = unsupported.get(type);
          if (entry) entry.count += 1;
          else unsupported.set(type, { count: 1, start: blockStart, end: blockEnd });
        }
        continue;
      }

      const bytes = read.bytes;
      const view = dataView(bytes);
      const le = littleEndian;
      const malformedOptions = () =>
        report(
          'MALFORMED_OPTION',
          `block at ${blockStart}: an option runs past the options area`,
          blockStart,
          blockEnd,
        );

      if (isShb) {
        if (length < MIN_LENGTH.shb) {
          stop(
            'MALFORMED_BLOCK',
            `section header at ${blockStart}: ${length} bytes is shorter than the 28-byte minimum`,
            blockStart,
            blockEnd,
          );
          break;
        }
        const major = view.getUint16(12, le);
        if (major !== 1) {
          stop(
            'UNSUPPORTED_SECTION_VERSION',
            `section header at ${blockStart}: major version ${major} is not 1`,
            blockStart,
            blockEnd,
          );
          break;
        }
        section += 1;
        interfaces = [];
        sectionOs = null;
        const walk = walkOptions(view, 24, length - 4, le, (code, start, size) => {
          if (code === SHB_OS && sectionOs === null) sectionOs = optionText(bytes, start, size);
        });
        if (walk === 'malformed') malformedOptions();
        continue;
      }

      if (type === BLOCK_IDB) {
        if (length < MIN_LENGTH.idb) {
          interfaces.push(null);
          report(
            'MALFORMED_BLOCK',
            `interface description at ${blockStart}: ${length} bytes is shorter than the 20-byte minimum`,
            blockStart,
            blockEnd,
          );
          continue;
        }
        let name: string | null = null;
        let description: string | null = null;
        let comment: string | null = null;
        let tsResolution: TsResolution = { base: 10, exponent: 6 };
        let tsOffsetS = 0n;
        const walk = walkOptions(view, 16, length - 4, le, (code, start, size) => {
          if (code === OPT_COMMENT) comment ??= optionText(bytes, start, size);
          else if (code === IF_NAME) name ??= optionText(bytes, start, size);
          else if (code === IF_DESCRIPTION) description ??= optionText(bytes, start, size);
          else if (code === IF_TSRESOL && size >= 1) tsResolution = decodeTsResolution(bytes[start]!);
          else if (code === IF_TSOFFSET && size >= 8) tsOffsetS = view.getBigInt64(start, le);
        });
        if (walk === 'malformed') malformedOptions();
        ordinal += 1;
        const iface: PcapngInterface = {
          ordinal,
          section,
          ifIndex: interfaces.length,
          linktype: view.getUint16(8, le),
          snaplen: view.getUint32(12, le),
          name,
          description,
          os: sectionOs,
          comment,
          tsResolution,
          tsOffsetS,
          blockStart,
          blockEnd,
        };
        interfaces.push({ iface, scale: tsScale(tsResolution, tsOffsetS) });
        return { kind: 'interface', iface };
      }

      // Packet blocks: EPB, OPB, SPB.
      const isSpb = type === BLOCK_SPB;
      const minimum = isSpb ? MIN_LENGTH.spb : MIN_LENGTH.epb;
      if (length < minimum) {
        report(
          'MALFORMED_BLOCK',
          `packet block at ${blockStart}: ${length} bytes is shorter than the ${minimum}-byte minimum`,
          blockStart,
          blockEnd,
        );
        continue;
      }
      const interfaceIndex = isSpb ? 0 : type === BLOCK_EPB ? view.getUint32(8, le) : view.getUint16(8, le);
      const entry = interfaces[interfaceIndex];
      if (entry === undefined || entry === null) {
        report(
          'UNKNOWN_INTERFACE',
          `packet block at ${blockStart}: interface ${interfaceIndex} is not declared in section ${section}`,
          blockStart,
          blockEnd,
        );
        continue;
      }
      let dataStart: number;
      let inclLen: number;
      let origLen: number;
      let tsNs: bigint | null = null;
      let comment: string | null = null;
      if (isSpb) {
        dataStart = 12;
        origLen = view.getUint32(8, le);
        const room = length - 16;
        const snaplen = entry.iface.snaplen === 0 ? room : entry.iface.snaplen;
        inclLen = Math.min(origLen, snaplen, room);
      } else {
        dataStart = 28;
        inclLen = view.getUint32(20, le);
        origLen = view.getUint32(24, le);
        if (dataStart + inclLen > length - 4) {
          report(
            'MALFORMED_BLOCK',
            `packet block at ${blockStart}: captured length ${inclLen} exceeds the block's ${length - 32} data bytes`,
            blockStart,
            blockEnd,
          );
          continue;
        }
        const units = (BigInt(view.getUint32(12, le)) << 32n) | BigInt(view.getUint32(16, le));
        tsNs = toNs(units, entry.scale);
        if (tsNs < INT64_MIN || tsNs >= INT64_MAX_EXCLUSIVE) {
          report(
            'TIMESTAMP_OUT_OF_RANGE',
            `packet block at ${blockStart}: timestamp ${tsNs} ns does not fit in 64 bits`,
            blockStart,
            blockEnd,
          );
          tsNs = null;
        }
        const optionsStart = dataStart + padTo4(inclLen);
        const walk = walkOptions(view, optionsStart, length - 4, le, (code, start, size) => {
          if (code === OPT_COMMENT) comment ??= optionText(bytes, start, size);
        });
        if (walk === 'malformed') malformedOptions();
      }
      const body = window.stable(
        { bytes: bytes.subarray(dataStart, dataStart + inclLen), isChunkView: read.isChunkView },
        generationAtStart,
      );
      const packet: PcapngPacket = {
        index: packetIndex,
        interfaceOrdinal: entry.iface.ordinal,
        linktype: normalizeLinktype(entry.iface.linktype, body),
        tsNs,
        inclLen,
        origLen,
        comment,
        blockStart,
        blockEnd,
        body: { start: blockStart + dataStart, bytes: body },
      };
      packetIndex += 1;
      return { kind: 'packet', packet };
    }
    finish();
    return null;
  };

  return { next, issues: () => issues, bytesConsumed: () => cursor };
}
