import { describe, expect, it } from 'vitest';
import { ProjectionCompileError } from './expression.js';
import { parseProjectionSpec, specVersionAtLeast } from './spec.js';

const spec = (version: string, streamExtra: string) => `
version: '${version}'
format: streamy
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      n: { expr: '_.n', type: uint8, nullable: true }
  - name: flows
    rows: $
    key: flow_id
    columns:
      status: { expr: '_.status', type: utf8 }
streams:
  - name: byte_stream
    key: chunk_key
    offset: _.seq
    framer: len_framer
    table: flows
    segments_table: flow_segments
    max_buffer: 64
${streamExtra}
    messages:
      - { when: 'true', parser: msg_parser }
`;

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProjectionCompileError) return `${error.code}@${error.path}`;
    throw error;
  }
  return 'ok';
};

describe('spec v0.5', () => {
  it('accepts lifecycle and offset_bits fields on 0.5', () => {
    const parsed = parseProjectionSpec(
      spec('0.5', '    offset_bits: 32\n    open: _.syn\n    close: _.fin\n    reset: _.rst'),
    );
    expect(parsed.version).toBe('0.5');
    expect(parsed.streams![0]).toMatchObject({
      offset_bits: 32,
      open: '_.syn',
      close: '_.fin',
      reset: '_.rst',
    });
  });

  it('accepts numeric 0.5', () => {
    expect(parseProjectionSpec(spec('0.5', '').replace("'0.5'", '0.5')).version).toBe('0.5');
  });

  it.each(['offset_bits: 32', 'open: _.syn'])('rejects %s below 0.5', (field) => {
    expect(codeOf(() => parseProjectionSpec(spec('0.4', `    ${field}`)))).toBe(
      'PROJECTION_VERSION_REQUIRED@streams.0',
    );
  });

  it.each([7, 49, 32.5])('rejects offset_bits %s', (bits) => {
    expect(codeOf(() => parseProjectionSpec(spec('0.5', `    offset_bits: ${bits}`)))).toMatch(
      /^PROJECTION_(STREAM|SPEC)_INVALID@streams\.0\.offset_bits$/,
    );
  });

  it.each(['close: _.fin', 'reset: _.rst'])('rejects %s without open', (field) => {
    expect(codeOf(() => parseProjectionSpec(spec('0.5', `    ${field}`)))).toMatch(
      /^PROJECTION_STREAM_INVALID@streams\.0\.(close|reset)$/,
    );
  });

  it('keeps nullable legal on 0.5 (0.4 features carry forward)', () => {
    expect(codeOf(() => parseProjectionSpec(spec('0.5', '')))).toBe('ok');
  });

  it('orders versions', () => {
    expect(specVersionAtLeast('0.5', '0.4')).toBe(true);
    expect(specVersionAtLeast('0.4', '0.4')).toBe(true);
    expect(specVersionAtLeast('0.3', '0.4')).toBe(false);
  });
});
