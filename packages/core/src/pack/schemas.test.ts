import { describe, expect, it } from 'vitest';

import { compileProjection } from '../projection/project.js';
import { parseProjectionSpec } from '../projection/spec.js';
import type { ParserRegistry } from '../projection/parsers.js';
import type { StreamRegistries } from '../projection/streams.js';
import { projectionSchemas } from './schemas.js';

const yaml = (version: string) => `
version: '${version}'
format: f
tables:
  - name: parent
    rows: $.items[*]
    key: parent_id
    columns:
      label: { expr: _.label, type: utf8${version === '0.4' ? ', nullable: true' : ''} }
      size: { expr: _.size, type: uint32 }
`;

describe('projectionSchemas', () => {
  it('derives order, types, and v0.4 nullability plus the errors table', () => {
    const compiled = compileProjection(parseProjectionSpec(yaml('0.4')));
    expect(projectionSchemas(compiled, { ordinalColumn: 'record' })).toEqual([
      {
        name: 'parent',
        columns: [
          { name: 'parent_id', type: 'int64', nullable: false },
          { name: 'label', type: 'utf8', nullable: true },
          { name: 'size', type: 'uint32', nullable: false },
          { name: '_src_start', type: 'uint64', nullable: false },
          { name: '_src_end', type: 'uint64', nullable: false },
        ],
      },
      {
        name: 'errors',
        columns: [
          { name: 'error_id', type: 'int64', nullable: false },
          { name: 'stage', type: 'utf8', nullable: false },
          { name: 'record', type: 'int32', nullable: true },
          { name: 'code', type: 'utf8', nullable: false },
          { name: 'message', type: 'utf8', nullable: false },
          { name: 'recoverable', type: 'bool', nullable: false },
          { name: '_src_start', type: 'uint64', nullable: true },
          { name: '_src_end', type: 'uint64', nullable: true },
        ],
      },
    ]);
  });

  it('treats every spec column as nullable before v0.4', () => {
    const compiled = compileProjection(parseProjectionSpec(yaml('0.3')));
    const parent = projectionSchemas(compiled, { ordinalColumn: 'record' })[0]!;
    expect(parent.columns.find((c) => c.name === 'size')!.nullable).toBe(true);
    expect(parent.columns.find((c) => c.name === 'parent_id')!.nullable).toBe(false);
  });

  it('marks stream-engine columns nullable: message stream_id/_src_ranges, segments feed key', () => {
    const registry: ParserRegistry = new Map([
      ['chunk_parser', () => ({ root: {} })],
      ['msg_parser', () => ({ root: {} })],
    ]);
    const streamRegistries: StreamRegistries = {
      keyExtractors: new Map([['chunk_key', () => ({ key: 'k', root: {} })]]),
      framers: new Map([['len_framer', () => null]]),
    };
    const streamYaml = `
version: '0.4'
format: streamy
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      n: { expr: '_.n', type: uint8 }
  - name: chunks
    rows: $
    key: chunk_id
    parent_key: { table: records, column: record_id }
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
    parent_key: { table: records, column: record_id }
    columns:
      text: { expr: '_.text', type: utf8 }
dissect:
  - from: records
    payload: _.body
    chain:
      - { when: 'true', parser: chunk_parser, table: chunks }
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
    const compiled = compileProjection(parseProjectionSpec(streamYaml), registry, streamRegistries);
    const schemas = projectionSchemas(compiled, { ordinalColumn: 'record' });

    const msgs = schemas.find((table) => table.name === 'msgs')!;
    expect(msgs.columns.find((c) => c.name === 'stream_id')!.nullable).toBe(true);
    expect(msgs.columns.find((c) => c.name === '_src_ranges')!.nullable).toBe(true);

    const segments = schemas.find((table) => table.name === 'flow_segments')!;
    expect(segments.columns.find((c) => c.name === 'chunk_id')!.nullable).toBe(true);
    expect(segments.columns.find((c) => c.name === 'segment_id')!.nullable).toBe(false);
    expect(segments.columns.find((c) => c.name === 'stream_id')!.nullable).toBe(false);
    expect(segments.columns.find((c) => c.name === 'offset')!.nullable).toBe(false);
    expect(segments.columns.find((c) => c.name === '_src_start')!.nullable).toBe(false);
    expect(segments.columns.find((c) => c.name === '_src_end')!.nullable).toBe(false);
  });
});
