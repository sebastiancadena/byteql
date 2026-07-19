import { asciiByteX, BYTES_PER_ROW, hexByteX, type ColumnLayout, type HexMetrics } from './layout.js';
import type { ByteSpan } from './coverage.js';

export interface HexColors {
  background: string;
  gutter: string;
  text: string;
  ascii: string;
  shadeA: string;
  shadeB: string;
  selection: string;
  highlight: string;
  caret: string;
  placeholder: string;
}

export interface CanvasTextContext {
  fillStyle: string;
  font: string;
  textBaseline: string;
  strokeStyle: string;
  lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
}

export interface HexFrame {
  widthPx: number;
  heightPx: number;
  firstRow: number;
  fileSize: number;
  metrics: HexMetrics;
  layout: ColumnLayout;
  colors: HexColors;
  fontSpec: string;
  byteAt(offset: number): number | null;
  shading: readonly ByteSpan[];
  selection: { start: number; end: number } | null;
  highlight: { start: number; end: number } | null;
  caret: number | null;
}

const HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, '0'));

const printable = (byte: number): string => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '·');

/** Fills the hex-cell and ascii-cell rects for every byte of [start, end) in view. */
function fillRange(ctx: CanvasTextContext, frame: HexFrame, start: number, end: number, style: string): void {
  const { metrics, layout, firstRow } = frame;
  const lastRowExclusive = firstRow + Math.ceil(frame.heightPx / metrics.rowHeight) + 1;
  const from = Math.max(start, firstRow * BYTES_PER_ROW);
  const to = Math.min(end, lastRowExclusive * BYTES_PER_ROW, frame.fileSize);
  ctx.fillStyle = style;
  for (let offset = from; offset < to; offset += 1) {
    const row = Math.floor(offset / BYTES_PER_ROW);
    const i = offset % BYTES_PER_ROW;
    const y = (row - firstRow) * metrics.rowHeight;
    ctx.fillRect(hexByteX(metrics, layout, i), y, 2 * metrics.charWidth, metrics.rowHeight);
    ctx.fillRect(asciiByteX(metrics, layout, i), y, metrics.charWidth, metrics.rowHeight);
  }
}

export function drawHexFrame(ctx: CanvasTextContext, frame: HexFrame): void {
  const { metrics, layout, colors, firstRow } = frame;
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, frame.widthPx, frame.heightPx);
  ctx.font = frame.fontSpec;
  ctx.textBaseline = 'middle';

  for (const span of frame.shading)
    fillRange(ctx, frame, span.start, span.end, span.alt ? colors.shadeB : colors.shadeA);
  if (frame.highlight) fillRange(ctx, frame, frame.highlight.start, frame.highlight.end, colors.highlight);
  if (frame.selection) fillRange(ctx, frame, frame.selection.start, frame.selection.end, colors.selection);

  const rows = Math.ceil(frame.heightPx / metrics.rowHeight);
  for (let r = 0; r < rows; r += 1) {
    const rowOffset = (firstRow + r) * BYTES_PER_ROW;
    if (rowOffset >= frame.fileSize && frame.fileSize > 0) break;
    const y = r * metrics.rowHeight + metrics.rowHeight / 2;
    ctx.fillStyle = colors.gutter;
    ctx.fillText(rowOffset.toString(16).padStart(metrics.gutterDigits, '0'), layout.gutterX, y);
    for (let i = 0; i < BYTES_PER_ROW; i += 1) {
      const offset = rowOffset + i;
      if (offset >= frame.fileSize) break;
      const byte = frame.byteAt(offset);
      if (byte === null) {
        ctx.fillStyle = colors.placeholder;
        ctx.fillRect(
          hexByteX(metrics, layout, i),
          r * metrics.rowHeight + 3,
          2 * metrics.charWidth,
          metrics.rowHeight - 6,
        );
        continue;
      }
      ctx.fillStyle = colors.text;
      ctx.fillText(HEX[byte] as string, hexByteX(metrics, layout, i), y);
      ctx.fillStyle = colors.ascii;
      ctx.fillText(printable(byte), asciiByteX(metrics, layout, i), y);
    }
  }

  if (frame.caret !== null) {
    const row = Math.floor(frame.caret / BYTES_PER_ROW) - firstRow;
    const i = frame.caret % BYTES_PER_ROW;
    if (row >= 0 && row < rows) {
      ctx.strokeStyle = colors.caret;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        hexByteX(metrics, layout, i) - 1,
        row * metrics.rowHeight + 1,
        2 * metrics.charWidth + 2,
        metrics.rowHeight - 2,
      );
    }
  }
}
