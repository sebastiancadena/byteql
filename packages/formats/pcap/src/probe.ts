/**
 * pcapng probe: the Section Header Block type (0A 0D 0D 0A — the text "\n\r\r\n", weak evidence on
 * its own) AND a byte-order magic at offset 8, in either byte order.
 */
export const probePcapng = (head: Uint8Array): number | null => {
  if (head.length < 12) return null;
  if (head[0] !== 0x0a || head[1] !== 0x0d || head[2] !== 0x0d || head[3] !== 0x0a) return null;
  const le = head[8] === 0x4d && head[9] === 0x3c && head[10] === 0x2b && head[11] === 0x1a;
  const be = head[8] === 0x1a && head[9] === 0x2b && head[10] === 0x3c && head[11] === 0x4d;
  return le || be ? 1 : null;
};
