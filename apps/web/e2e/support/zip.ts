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

/** Builds a minimal store-only ZIP archive from string entries. */
export const makeZip = (entries: { name: string; data: string }[], comment = ''): Uint8Array => {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (b: Uint8Array): void => {
    chunks.push(b);
    offset += b.length;
  };
  const u16 = (v: number): Uint8Array => Uint8Array.from([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number): Uint8Array =>
    Uint8Array.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  const meta = entries.map((e) => ({
    name: enc.encode(e.name),
    data: enc.encode(e.data),
    crc: crc32(enc.encode(e.data)),
    offset: 0,
  }));

  for (const m of meta) {
    m.offset = offset;
    push(u32(0x04034b50));
    push(u16(20));
    push(u16(0));
    push(u16(0)); // stored
    push(u16(0x63d6)); // mod time 12:30:44
    push(u16(0x52cf)); // mod date 2021-06-15
    push(u32(m.crc));
    push(u32(m.data.length));
    push(u32(m.data.length));
    push(u16(m.name.length));
    push(u16(0));
    push(m.name);
    push(m.data);
  }

  const centralStart = offset;
  for (const m of meta) {
    push(u32(0x02014b50));
    push(u16(20));
    push(u16(20));
    push(u16(0));
    push(u16(0));
    push(u16(0x63d6));
    push(u16(0x52cf));
    push(u32(m.crc));
    push(u32(m.data.length));
    push(u32(m.data.length));
    push(u16(m.name.length));
    push(u16(0));
    push(u16(0));
    push(u16(0));
    push(u16(0));
    push(u32(0));
    push(u32(m.offset));
    push(m.name);
  }
  const centralSize = offset - centralStart;

  const commentBytes = enc.encode(comment);
  push(u32(0x06054b50));
  push(u16(0));
  push(u16(0));
  push(u16(meta.length));
  push(u16(meta.length));
  push(u32(centralSize));
  push(u32(centralStart));
  push(u16(commentBytes.length));
  push(commentBytes);

  const total = new Uint8Array(offset);
  let cursor = 0;
  for (const c of chunks) {
    total.set(c, cursor);
    cursor += c.length;
  }
  return total;
};
