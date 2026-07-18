import { describe, expect, it } from 'vitest';

import { compatibleViewers, type FormatViewerMetadata } from './registry.js';

const enabled: FormatViewerMetadata = {
  audio: { enabled: true, reason: null },
};

const columns = [
  { name: 'seconds', type: 'Float64' },
  { name: 'note', type: 'Int32' },
  { name: 'velocity', type: 'Uint8' },
  { name: 'kind', type: 'Utf8' },
] as const;

describe('compatibleViewers', () => {
  it('matches the trusted audio viewer from Arrow schema and audio metadata', () => {
    expect(compatibleViewers(columns, enabled).map(({ id }) => id)).toEqual(['audio']);
    expect(
      compatibleViewers([...columns, { name: 'channel', type: 'Int8' }], enabled).map(({ id }) => id),
    ).toEqual(['audio']);
  });

  it.each([
    ['missing seconds', columns.filter(({ name }) => name !== 'seconds')],
    [
      'non-numeric note',
      columns.map((column) => (column.name === 'note' ? { ...column, type: 'Utf8' } : column)),
    ],
    [
      'non-numeric velocity',
      columns.map((column) => (column.name === 'velocity' ? { ...column, type: 'Bool' } : column)),
    ],
    [
      'non-UTF-8 kind',
      columns.map((column) => (column.name === 'kind' ? { ...column, type: 'Binary' } : column)),
    ],
    ['generic aggregate', [{ name: 'event_count', type: 'Int64' }]],
  ])('does not match %s results', (_label, schema) => {
    expect(compatibleViewers(schema, enabled)).toEqual([]);
  });

  it('does not match when format metadata disables SMPTE audio', () => {
    expect(
      compatibleViewers(columns, {
        audio: {
          enabled: false,
          reason: 'SMPTE time division is not supported by the Phase 0 player.',
        },
      }),
    ).toEqual([]);
  });

  it('does not match when the pack declares no audio capability at all', () => {
    expect(compatibleViewers(columns, {})).toEqual([]);
  });

  it('ignores unrelated capabilities declared by other packs', () => {
    expect(
      compatibleViewers(columns, {
        hex: { enabled: true, reason: null },
        audio: { enabled: true, reason: null },
      }).map(({ id }) => id),
    ).toEqual(['audio']);
  });
});
