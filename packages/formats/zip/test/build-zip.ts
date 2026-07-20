import { deflateRawSync } from 'node:zlib';

export interface ZipEntrySpec {
  name: string;
  data: Uint8Array;
  /** 0 = stored, 8 = deflate. Default 0. */
  method?: 0 | 8;
  /** When true, zero the sizes/crc in the local header, set flag bit 3, and append a data descriptor. */
  dataDescriptor?: boolean;
  modDate?: number;
  modTime?: number;
  comment?: string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

interface Built {
  name: Uint8Array;
  comment: Uint8Array;
  method: number;
  flags: number;
  crc: number;
  compressed: Uint8Array;
  uncompressedSize: number;
  modDate: number;
  modTime: number;
  dataDescriptor: boolean;
  localOffset: number;
}

export const buildZip = (entries: ZipEntrySpec[], opts: { comment?: string } = {}): Uint8Array => {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const u16 = (v: number): Uint8Array => Uint8Array.from([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number): Uint8Array =>
    Uint8Array.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  const built: Built[] = entries.map((entry) => {
    const method = entry.method ?? 0;
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const dataDescriptor = entry.dataDescriptor ?? false;
    return {
      name: utf8(entry.name),
      comment: utf8(entry.comment ?? ''),
      method,
      flags: dataDescriptor ? 0x08 : 0,
      crc: crc32(entry.data),
      compressed,
      uncompressedSize: entry.data.length,
      modDate: entry.modDate ?? 0x52cf, // 2021-06-15
      modTime: entry.modTime ?? 0x63d6, // 12:30:44
      dataDescriptor,
      localOffset: 0,
    };
  });

  // Local file records.
  for (const b of built) {
    b.localOffset = offset;
    push(u32(0x04034b50));
    push(u16(20)); // version needed
    push(u16(b.flags));
    push(u16(b.method));
    push(u16(b.modTime));
    push(u16(b.modDate));
    push(u32(b.dataDescriptor ? 0 : b.crc));
    push(u32(b.dataDescriptor ? 0 : b.compressed.length));
    push(u32(b.dataDescriptor ? 0 : b.uncompressedSize));
    push(u16(b.name.length));
    push(u16(0)); // extra len
    push(b.name);
    push(b.compressed);
    if (b.dataDescriptor) {
      push(u32(0x08074b50));
      push(u32(b.crc));
      push(u32(b.compressed.length));
      push(u32(b.uncompressedSize));
    }
  }

  // Central directory.
  const centralStart = offset;
  for (const b of built) {
    push(u32(0x02014b50));
    push(u16(20)); // version made by
    push(u16(20)); // version needed
    push(u16(b.flags));
    push(u16(b.method));
    push(u16(b.modTime));
    push(u16(b.modDate));
    push(u32(b.crc));
    push(u32(b.compressed.length));
    push(u32(b.uncompressedSize));
    push(u16(b.name.length));
    push(u16(0)); // extra len
    push(u16(b.comment.length));
    push(u16(0)); // disk start
    push(u16(0)); // internal attrs
    push(u32(0)); // external attrs
    push(u32(b.localOffset));
    push(b.name);
    push(b.comment);
  }
  const centralSize = offset - centralStart;

  // End of central directory.
  const archiveComment = utf8(opts.comment ?? '');
  push(u32(0x06054b50));
  push(u16(0)); // disk num
  push(u16(0)); // cd start disk
  push(u16(built.length));
  push(u16(built.length));
  push(u32(centralSize));
  push(u32(centralStart));
  push(u16(archiveComment.length));
  push(archiveComment);

  const total = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    total.set(chunk, cursor);
    cursor += chunk.length;
  }
  return total;
};
