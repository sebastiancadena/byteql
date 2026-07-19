import { describe, expect, it } from 'vitest';

import { parseOffsetInput } from './goto.js';

describe('parseOffsetInput', () => {
  it('parses hex, decimal, and relative forms', () => {
    expect(parseOffsetInput('0x1a2b', 0)).toBe(0x1a2b);
    expect(parseOffsetInput('6699', 0)).toBe(6699);
    expect(parseOffsetInput('+16', 100)).toBe(116);
    expect(parseOffsetInput('-0x10', 100)).toBe(84);
    expect(parseOffsetInput('  0X2F ', 0)).toBe(47);
  });

  it('rejects garbage', () => {
    expect(parseOffsetInput('', 0)).toBe('invalid');
    expect(parseOffsetInput('0x', 0)).toBe('invalid');
    expect(parseOffsetInput('12g', 0)).toBe('invalid');
    expect(parseOffsetInput('--4', 0)).toBe('invalid');
  });
});
