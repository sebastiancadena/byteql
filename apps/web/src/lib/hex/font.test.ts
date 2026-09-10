import { describe, expect, it } from 'vitest';

import { measureHexFont } from './font.js';

function fakeContext(width: number): { font: string; measureText: (text: string) => TextMetrics } {
  return {
    font: '',
    measureText: (text: string) => ({ width: width * text.length }) as TextMetrics,
  };
}

describe('measureHexFont', () => {
  it('measures the same font specification it asks callers to paint with', () => {
    const context = fakeContext(6.6);

    const { fontSpec, charWidth } = measureHexFont(context, "'IBM Plex Mono', monospace");

    expect(fontSpec).toBe("12px 'IBM Plex Mono', monospace");
    expect(context.font).toBe(fontSpec);
    expect(charWidth).toBe(6.6);
  });

  it('tracks a different family so measurement never lags the painted font', () => {
    const context = fakeContext(8);

    expect(measureHexFont(context, 'monospace')).toEqual({ fontSpec: '12px monospace', charWidth: 8 });
  });

  it('falls back to a usable advance width when measurement is unusable', () => {
    for (const width of [0, Number.NaN, Number.POSITIVE_INFINITY, -3]) {
      expect(measureHexFont(fakeContext(width), 'monospace').charWidth).toBe(7.2);
    }
  });
});
