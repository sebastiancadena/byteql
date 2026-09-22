import { describe, expect, it } from 'vitest';

import { columnLayout, hexByteX, type HexMetrics } from './layout.js';
import { drawHexFrame, type CanvasTextContext, type HexColors, type HexFrame } from './render.js';

const metrics: HexMetrics = { charWidth: 8, rowHeight: 18, gutterDigits: 8, padding: 12 };
const layout = columnLayout(metrics);
const colors: HexColors = {
  background: '#bg',
  gutter: '#gu',
  text: '#tx',
  ascii: '#as',
  shadeA: '#sa',
  shadeB: '#sb',
  selection: '#se',
  highlight: '#hi',
  gap: '#gp',
  caret: '#ca',
  placeholder: '#pl',
};

interface Op {
  kind: 'rect' | 'text' | 'stroke';
  style: string;
  args: unknown[];
}

function recordingContext() {
  const ops: Op[] = [];
  const ctx: CanvasTextContext = {
    fillStyle: '',
    font: '',
    textBaseline: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect: (...args) => ops.push({ kind: 'rect', style: String(ctx.fillStyle), args }),
    fillText: (...args) => ops.push({ kind: 'text', style: String(ctx.fillStyle), args }),
    strokeRect: (...args) => ops.push({ kind: 'stroke', style: String(ctx.strokeStyle), args }),
  };
  return { ctx, ops };
}

function frame(overrides: Partial<HexFrame> = {}): HexFrame {
  return {
    widthPx: 800,
    heightPx: 54,
    firstRow: 0,
    fileSize: 64,
    metrics,
    layout,
    colors,
    fontSpec: '12px monospace',
    byteAt: (offset) => (offset === 20 ? null : offset & 0xff),
    shading: [],
    selection: null,
    highlight: null,
    caret: null,
    ...overrides,
  };
}

describe('drawHexFrame', () => {
  it('draws gutter offsets, hex pairs, and ascii for available bytes', () => {
    const { ctx, ops } = recordingContext();
    drawHexFrame(ctx, frame());
    const texts = ops.filter((op) => op.kind === 'text').map((op) => op.args[0]);
    expect(texts).toContain('00000000');
    expect(texts).toContain('00000010');
    expect(texts).toContain('0f'); // hex pair for offset 15 (byteAt returns offset & 0xff)
  });

  it('paints a placeholder rect instead of text for missing bytes', () => {
    const { ctx, ops } = recordingContext();
    drawHexFrame(ctx, frame());
    const placeholder = ops.find((op) => op.kind === 'rect' && op.style === '#pl');
    expect(placeholder).toBeDefined();
    expect(placeholder?.args[0]).toBe(hexByteX(metrics, layout, 4)); // offset 20 = row 1, byte 4
  });

  it('paints selection above shading and outlines the caret', () => {
    const { ctx, ops } = recordingContext();
    drawHexFrame(
      ctx,
      frame({
        shading: [{ start: 0, end: 32, alt: false }],
        selection: { start: 4, end: 6 },
        caret: 5,
      }),
    );
    const styles = ops.map((op) => op.style);
    expect(styles.indexOf('#se')).toBeGreaterThan(styles.indexOf('#sa'));
    expect(ops.some((op) => op.kind === 'stroke' && op.style === '#ca')).toBe(true);
  });

  it('stops at EOF instead of painting phantom bytes', () => {
    const { ctx, ops } = recordingContext();
    drawHexFrame(ctx, frame({ fileSize: 3 }));
    const hexTexts = ops.filter((op) => op.kind === 'text' && op.style === '#tx');
    expect(hexTexts).toHaveLength(3);
  });

  it('renders a single empty row for zero-byte files', () => {
    const { ctx, ops } = recordingContext();
    drawHexFrame(ctx, frame({ fileSize: 0, heightPx: 54 }));
    const gutterTexts = ops.filter((op) => op.kind === 'text' && op.style === '#gu');
    expect(gutterTexts).toHaveLength(1);
    expect(gutterTexts[0]?.args[0]).toBe('00000000');
    const hexTexts = ops.filter((op) => op.kind === 'text' && op.style === '#tx');
    expect(hexTexts).toHaveLength(0);
  });

  it('marks bounding-span bytes outside every piece with the gap color, and only pieces with highlight', () => {
    const { ctx, ops } = recordingContext();
    const gapColors: HexColors = { ...colors, gap: 'GAP', highlight: 'HI' };
    drawHexFrame(
      ctx,
      frame({
        colors: gapColors,
        highlight: {
          start: 0,
          end: 32,
          ranges: [
            { start: 0, end: 4 },
            { start: 28, end: 32 },
          ],
        },
      }),
    );
    const rectAt = (offset: number, style: string): boolean => {
      const row = Math.floor(offset / 16);
      const i = offset % 16;
      const x = hexByteX(metrics, layout, i);
      const y = row * metrics.rowHeight;
      return ops.some(
        (op) => op.kind === 'rect' && op.style === style && op.args[0] === x && op.args[1] === y,
      );
    };
    for (let offset = 4; offset < 28; offset += 1) {
      expect(rectAt(offset, 'GAP')).toBe(true);
      expect(rectAt(offset, 'HI')).toBe(false);
    }
    for (const offset of [0, 1, 2, 3, 28, 29, 30, 31]) {
      expect(rectAt(offset, 'HI')).toBe(true);
    }
  });

  it('draws no gap fill for a single-piece (exact) highlight', () => {
    const { ctx, ops } = recordingContext();
    const gapColors: HexColors = { ...colors, gap: 'GAP', highlight: 'HI' };
    drawHexFrame(
      ctx,
      frame({
        colors: gapColors,
        highlight: { start: 0, end: 4, ranges: [{ start: 0, end: 4 }] },
      }),
    );
    expect(ops.some((op) => op.kind === 'rect' && op.style === 'GAP')).toBe(false);
    expect(ops.some((op) => op.kind === 'rect' && op.style === 'HI')).toBe(true);
  });
});
