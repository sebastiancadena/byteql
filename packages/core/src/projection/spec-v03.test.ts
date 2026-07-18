import { describe, expect, it } from 'vitest';
import { parseProjectionSpec } from './spec.js';

const base = `
version: '0.3'
format: streamy
tables:
  - name: chunks
    rows: $
    key: chunk_id
    columns:
      port: { expr: '_.port', type: uint16 }
  - name: flows
    rows: $
    key: flow_id
    columns:
      status: { expr: '_.status', type: utf8 }
  - name: msgs
    rows: $.message
    key: msg_id
    parent_key: { table: chunks, column: chunk_id }
    columns:
      text: { expr: '_.text', type: utf8 }
dissect:
  - from: chunks
    payload: _.payload
    chain:
      - { when: 'true', stream: byte_stream }
streams:
  - name: byte_stream
    key: chunk_key
    offset: _.seq
    framer: len_framer
    table: flows
    segments_table: flow_segments
    max_buffer: 64
    messages:
      - { when: 'true', parser: msg_parser, table: msgs }
`;

describe('projection spec v0.3', () => {
  it('parses streams and stream chain links', () => {
    const spec = parseProjectionSpec(base);
    expect(spec.version).toBe('0.3');
    expect(spec.streams).toHaveLength(1);
    expect(spec.streams![0]!.max_buffer).toBe(64);
    expect(spec.streams![0]!.messages[0]!.parser).toBe('msg_parser');
    expect(spec.dissect![0]!.chain[0]!.stream).toBe('byte_stream');
    expect(spec.dissect![0]!.chain[0]!.parser).toBeUndefined();
  });

  it('accepts numeric 0.3 and keeps 0.2 parsing unchanged', () => {
    expect(parseProjectionSpec(base.replace("version: '0.3'", 'version: 0.3')).version).toBe('0.3');
  });

  it('rejects streams below version 0.3', () => {
    expect(() => parseProjectionSpec(base.replace("version: '0.3'", "version: '0.2'"))).toThrowError(
      /PROJECTION_VERSION_REQUIRED|version 0.3/,
    );
  });

  it('rejects a stream chain link below version 0.3', () => {
    const v02 = `
version: '0.2'
format: f
tables:
  - name: t
    rows: $
    key: k
    columns:
      a: { expr: '_.a', type: uint8 }
dissect:
  - from: t
    payload: _.body
    chain:
      - { when: 'true', stream: s }
`;
    expect(() => parseProjectionSpec(v02)).toThrowError(/version 0.3/);
  });

  it('rejects a link with both parser and stream, and with neither', () => {
    expect(() =>
      parseProjectionSpec(base.replace('stream: byte_stream', 'stream: byte_stream, parser: p')),
    ).toThrowError(/exactly one of parser or stream/);
    expect(() => parseProjectionSpec(base.replace(', stream: byte_stream', ''))).toThrowError(
      /exactly one of parser or stream/,
    );
  });

  it('rejects table on a stream link', () => {
    expect(() =>
      parseProjectionSpec(base.replace('stream: byte_stream', 'stream: byte_stream, table: msgs')),
    ).toThrowError(/table is not allowed on a stream link/);
  });

  it('rejects a non-positive or non-integer max_buffer', () => {
    expect(() => parseProjectionSpec(base.replace('max_buffer: 64', 'max_buffer: 0'))).toThrow();
    expect(() => parseProjectionSpec(base.replace('max_buffer: 64', 'max_buffer: 1.5'))).toThrow();
  });
});
