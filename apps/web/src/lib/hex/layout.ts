/** Fixed hex-view geometry: 16 bytes per row, grouped 8 + 8 with a one-char mid-gap. */
export const BYTES_PER_ROW = 16;
/** Scrollbar thumb never shrinks below this, so it stays grabbable on multi-GB files. */
export const MIN_THUMB_PX = 24;

export interface HexMetrics {
  charWidth: number;
  rowHeight: number;
  gutterDigits: number;
  padding: number;
}

export interface ColumnLayout {
  gutterX: number;
  hexX: number;
  asciiX: number;
  width: number;
}

export function offsetDigits(fileSize: number): number {
  let digits = 8;
  while (fileSize > 2 ** (4 * digits)) digits += 2;
  return digits;
}

export const totalRows = (fileSize: number): number =>
  fileSize === 0 ? 1 : Math.ceil(fileSize / BYTES_PER_ROW);

export function columnLayout(m: HexMetrics): ColumnLayout {
  const gutterX = m.padding;
  const hexX = gutterX + (m.gutterDigits + 2) * m.charWidth;
  const hexWidth = (BYTES_PER_ROW * 3 + 1) * m.charWidth;
  const asciiX = hexX + hexWidth + 2 * m.charWidth;
  return { gutterX, hexX, asciiX, width: asciiX + BYTES_PER_ROW * m.charWidth + m.padding };
}

export const hexByteX = (m: HexMetrics, layout: ColumnLayout, i: number): number =>
  layout.hexX + (i * 3 + (i >= BYTES_PER_ROW / 2 ? 1 : 0)) * m.charWidth;

export const asciiByteX = (m: HexMetrics, layout: ColumnLayout, i: number): number =>
  layout.asciiX + i * m.charWidth;

export function byteAtPoint(
  x: number,
  y: number,
  m: HexMetrics,
  layout: ColumnLayout,
  firstRow: number,
  fileSize: number,
): number | null {
  const row = firstRow + Math.floor(y / m.rowHeight);
  if (row < 0) return null;
  let index: number | null = null;
  if (x >= layout.asciiX && x < layout.asciiX + BYTES_PER_ROW * m.charWidth) {
    index = Math.floor((x - layout.asciiX) / m.charWidth);
  } else if (x >= layout.hexX && x < layout.asciiX - 2 * m.charWidth) {
    for (let i = BYTES_PER_ROW - 1; i >= 0; i -= 1) {
      const left = hexByteX(m, layout, i);
      if (x >= left) {
        if (x < left + 3 * m.charWidth) index = i;
        break;
      }
    }
  }
  if (index === null) return null;
  const offset = row * BYTES_PER_ROW + index;
  return offset < fileSize ? offset : null;
}

export const rowsInView = (heightPx: number, rowHeight: number): number =>
  Math.max(1, Math.floor(heightPx / rowHeight));

export const clampScrollRow = (row: number, total: number, view: number): number =>
  Math.max(0, Math.min(row, Math.max(0, total - view)));

export function thumbGeometry(
  trackPx: number,
  total: number,
  view: number,
  scrollRow: number,
): { thumbPx: number; thumbTop: number } {
  if (total <= view) return { thumbPx: trackPx, thumbTop: 0 };
  const thumbPx = Math.max(MIN_THUMB_PX, Math.min(trackPx, (view / total) * trackPx));
  const maxScroll = total - view;
  const thumbTop = ((trackPx - thumbPx) * clampScrollRow(scrollRow, total, view)) / maxScroll;
  return { thumbPx, thumbTop };
}

export function scrollRowForThumbTop(topPx: number, trackPx: number, total: number, view: number): number {
  const { thumbPx } = thumbGeometry(trackPx, total, view, 0);
  const range = trackPx - thumbPx;
  if (range <= 0) return 0;
  const maxScroll = Math.max(0, total - view);
  return clampScrollRow(Math.round((topPx / range) * maxScroll), total, view);
}
