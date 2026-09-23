/**
 * Deterministic `.pcapng` byte builder, for tests only. Hand-rolled `DataView` writers following
 * the pcapng block layout: type u32, total length u32, body padded to 4, total length u32 again,
 * every multi-byte field in the enclosing section's byte order. No third-party writer.
 */

import type { PcapPacket } from './build-pcap.js';

export type Endian = 'le' | 'be';

export interface PcapngOption {
  code: number;
  /** Raw bytes, or a bigint written as an 8-byte signed integer in the section byte order. */
  value: Uint8Array | bigint;
}

export const OPT_COMMENT = 1;
export const IF_NAME = 2;
export const IF_DESCRIPTION = 3;
export const SHB_OS = 3;
export const IF_TSRESOL = 9;
export const IF_TSOFFSET = 14;

export type PcapngBlock =
  | {
      type: 'shb';
      endian: Endian;
      options?: PcapngOption[];
      /** Major version; default 1. */
      major?: number;
      /** Byte-order magic override (written in `endian`); default 0x1A2B3C4D. */
      byteOrderMagic?: number;
    }
  | { type: 'idb'; linktype: number; snaplen?: number; options?: PcapngOption[] }
  | {
      type: 'epb';
      interfaceId: number;
      /** Raw 64-bit timestamp units, in the interface's resolution. */
      ts: bigint;
      data: Uint8Array;
      origLen?: number;
      options?: PcapngOption[];
    }
  | { type: 'opb'; interfaceId: number; ts: bigint; data: Uint8Array; options?: PcapngOption[] }
  | { type: 'spb'; data: Uint8Array; origLen?: number }
  /** Any block type with a verbatim body (header and trailer are added). */
  | { type: 'raw'; blockType: number; body: Uint8Array };

const textEncoder = new TextEncoder();
const pad4 = (length: number): number => (length + 3) & ~3;

export const optText = (code: number, text: string): PcapngOption => ({
  code,
  value: textEncoder.encode(text),
});
export const optU8 = (code: number, value: number): PcapngOption => ({ code, value: Uint8Array.of(value) });
export const optI64 = (code: number, value: bigint): PcapngOption => ({ code, value });

class Writer {
  private bytes = new Uint8Array(256);
  private view = new DataView(this.bytes.buffer);
  length = 0;
  le: boolean;

  constructor(le: boolean) {
    this.le = le;
  }

  private grow(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra));
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  u16(value: number): void {
    this.grow(2);
    this.view.setUint16(this.length, value, this.le);
    this.length += 2;
  }

  u32(value: number): void {
    this.grow(4);
    this.view.setUint32(this.length, value >>> 0, this.le);
    this.length += 4;
  }

  i64(value: bigint): void {
    this.grow(8);
    this.view.setBigInt64(this.length, value, this.le);
    this.length += 8;
  }

  raw(data: Uint8Array, padTo4 = true): void {
    const size = padTo4 ? pad4(data.length) : data.length;
    this.grow(size);
    this.bytes.set(data, this.length);
    this.bytes.fill(0, this.length + data.length, this.length + size);
    this.length += size;
  }

  patchU32(at: number, value: number): void {
    this.view.setUint32(at, value >>> 0, this.le);
  }

  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

const encodeOptions = (w: Writer, options: PcapngOption[] | undefined): void => {
  if (!options || options.length === 0) return;
  for (const option of options) {
    w.u16(option.code);
    if (typeof option.value === 'bigint') {
      w.u16(8);
      w.i64(option.value);
    } else {
      w.u16(option.value.length);
      w.raw(option.value);
    }
  }
  w.u16(0); // opt_endofopt
  w.u16(0);
};

const BLOCK_TYPES = { shb: 0x0a0d0d0a, idb: 1, opb: 2, spb: 3, epb: 6 } as const;

export function buildPcapngWithOffsets(blocks: PcapngBlock[]): {
  bytes: Uint8Array;
  blocks: { start: number; end: number }[];
} {
  const w = new Writer(true);
  const offsets: { start: number; end: number }[] = [];
  for (const block of blocks) {
    if (block.type === 'shb') w.le = block.endian === 'le';
    const start = w.length;
    w.u32(block.type === 'raw' ? block.blockType : BLOCK_TYPES[block.type]);
    w.u32(0); // total length, patched below
    switch (block.type) {
      case 'shb':
        w.u32(block.byteOrderMagic ?? 0x1a2b3c4d);
        w.u16(block.major ?? 1);
        w.u16(0);
        w.i64(-1n); // section length unknown
        encodeOptions(w, block.options);
        break;
      case 'idb':
        w.u16(block.linktype);
        w.u16(0);
        w.u32(block.snaplen ?? 0);
        encodeOptions(w, block.options);
        break;
      case 'epb':
      case 'opb':
        if (block.type === 'epb') {
          w.u32(block.interfaceId);
        } else {
          w.u16(block.interfaceId);
          w.u16(0); // drops
        }
        w.u32(Number(block.ts >> 32n));
        w.u32(Number(block.ts & 0xffff_ffffn));
        w.u32(block.data.length);
        w.u32(block.type === 'epb' ? (block.origLen ?? block.data.length) : block.data.length);
        w.raw(block.data);
        encodeOptions(w, block.options);
        break;
      case 'spb':
        w.u32(block.origLen ?? block.data.length);
        w.raw(block.data);
        break;
      case 'raw':
        w.raw(block.body);
        break;
    }
    const total = w.length + 4 - start;
    w.u32(total);
    w.patchU32(start + 4, total);
    offsets.push({ start, end: w.length });
  }
  return { bytes: w.result(), blocks: offsets };
}

export const buildPcapng = (blocks: PcapngBlock[]): Uint8Array => buildPcapngWithOffsets(blocks).bytes;

export function pcapngFromPackets(opts: {
  endian: Endian;
  linktype: number;
  packets: PcapPacket[];
}): Uint8Array {
  return buildPcapng([
    { type: 'shb', endian: opts.endian },
    { type: 'idb', linktype: opts.linktype },
    ...opts.packets.map((packet): PcapngBlock => ({
      type: 'epb',
      interfaceId: 0,
      ts: BigInt(packet.tsSec) * 1_000_000n + BigInt(packet.tsFrac),
      data: packet.data,
    })),
  ]);
}
