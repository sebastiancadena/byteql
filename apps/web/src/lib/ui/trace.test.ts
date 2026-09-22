import { describe, expect, it } from 'vitest';

import { buildTraceSummary, formatByteRange, type TraceInput } from './trace.js';

const selected: TraceInput = {
  hasResult: true,
  selectedGlobalRow: 16385,
  selectedLocalRow: 1,
  provenance: { file: 'second.zip', start: 12, end: 20, ranges: [{ start: 12, end: 20 }] },
  files: [{ name: 'second.zip', size: 100 }],
};

describe('formatByteRange', () => {
  it('shows the last included byte, not the exclusive end', () => {
    expect(formatByteRange(12, 20)).toBe('0x0000000c–0x00000013 · 8 bytes');
  });

  it('handles a single byte', () => {
    expect(formatByteRange(0, 1)).toBe('0x00000000–0x00000000 · 1 bytes');
  });

  it('pads beyond eight digits rather than truncating', () => {
    expect(formatByteRange(0x1_0000_0000, 0x1_0000_0002)).toBe('0x100000000–0x100000001 · 2 bytes');
  });

  it('rejects ranges that cannot describe real bytes', () => {
    expect(formatByteRange(20, 20)).toBeNull();
    expect(formatByteRange(21, 20)).toBeNull();
    expect(formatByteRange(-1, 4)).toBeNull();
    expect(formatByteRange(0, -1)).toBeNull();
    expect(formatByteRange(0, Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(formatByteRange(Number.NaN, 8)).toBeNull();
    expect(formatByteRange(0, Number.NaN)).toBeNull();
    expect(formatByteRange(1.5, 8)).toBeNull();
  });
});

describe('buildTraceSummary', () => {
  it('describes a validated range against the selected global row', () => {
    expect(buildTraceSummary(selected)).toEqual({
      kind: 'linked',
      row: 16386,
      range: { file: 'second.zip', start: 12, end: 20 },
      label: '0x0000000c–0x00000013 · 8 bytes',
    });
  });

  it('asks for a query before there is a result', () => {
    expect(buildTraceSummary({ ...selected, hasResult: false })).toEqual({
      kind: 'empty',
      message: 'Run a query to inspect source bytes.',
    });
  });

  it('asks for a row when none is selected', () => {
    expect(buildTraceSummary({ ...selected, selectedGlobalRow: null })).toMatchObject({
      kind: 'unselected',
      message: 'Select a row to trace its source bytes.',
    });
  });

  it('never borrows another row range when the selection is outside the window', () => {
    expect(buildTraceSummary({ ...selected, selectedLocalRow: null })).toMatchObject({
      kind: 'outside-window',
      message: 'Selected row is outside the loaded window.',
    });
  });

  it('says so when the row carries no source columns', () => {
    expect(buildTraceSummary({ ...selected, provenance: null })).toMatchObject({
      kind: 'unlinked',
      message: 'This row has no source byte range.',
    });
  });

  it('refuses a range whose file is gone', () => {
    expect(buildTraceSummary({ ...selected, files: [] })).toMatchObject({ kind: 'unavailable' });
  });

  it('refuses a range whose filename does not match a known source', () => {
    expect(buildTraceSummary({ ...selected, files: [{ name: 'other.zip', size: 100 }] })).toMatchObject({
      kind: 'unavailable',
      message: 'Source bytes are unavailable for this row.',
    });
  });

  it('refuses a range that runs past the end of its file', () => {
    expect(buildTraceSummary({ ...selected, files: [{ name: 'second.zip', size: 19 }] })).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('accepts a range that ends exactly at the end of its file', () => {
    expect(buildTraceSummary({ ...selected, files: [{ name: 'second.zip', size: 20 }] })).toMatchObject({
      kind: 'linked',
    });
  });

  it('refuses an unusable range even when the file exists', () => {
    expect(
      buildTraceSummary({
        ...selected,
        provenance: {
          file: 'second.zip',
          start: Number.NaN,
          end: 20,
          ranges: [{ start: Number.NaN, end: 20 }],
        },
      }),
    ).toMatchObject({ kind: 'unavailable' });
    expect(
      buildTraceSummary({
        ...selected,
        provenance: { file: 'second.zip', start: 20, end: 20, ranges: [{ start: 20, end: 20 }] },
      }),
    ).toMatchObject({ kind: 'unavailable' });
  });

  it('appends the piece count to the label for a reassembled row with more than one range', () => {
    expect(
      buildTraceSummary({
        ...selected,
        provenance: {
          file: 'second.zip',
          start: 12,
          end: 60,
          ranges: [
            { start: 12, end: 20 },
            { start: 50, end: 60 },
          ],
        },
      }),
    ).toMatchObject({ kind: 'linked', label: '0x0000000c–0x0000003b · 48 bytes · 2 ranges' });
  });

  it('leaves the label unchanged for a single-piece range', () => {
    expect(buildTraceSummary(selected)).toMatchObject({ label: '0x0000000c–0x00000013 · 8 bytes' });
  });

  it('numbers the first row 1', () => {
    expect(buildTraceSummary({ ...selected, selectedGlobalRow: 0, selectedLocalRow: 0 })).toMatchObject({
      kind: 'linked',
      row: 1,
    });
  });
});
