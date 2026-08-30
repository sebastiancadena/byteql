import { describe, expect, it } from 'vitest';
import { ProjectionCompileError } from './expression.js';
import { compileProjection, streamSegmentsOutputTypes, tableOutputTypes } from './project.js';
import { parseProjectionSpec } from './spec.js';
import type { StreamRegistries } from './streams.js';
import type { ParserRegistry } from './parsers.js';

const registry: ParserRegistry = new Map([
  ['chunk_parser', () => ({ root: {} })],
  ['msg_parser', () => ({ root: {} })],
]);
const streamRegistries: StreamRegistries = {
  keyExtractors: new Map([['chunk_key', () => ({ key: 'k', root: {} })]]),
  framers: new Map([['len_framer', () => null]]),
};

// The valid v0.3 spec from Task 2 (records → chunks feed table added so parent-key
// availability is exercised):
const validYaml = `
version: '0.3'
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

const compile = (yaml: string) => compileProjection(parseProjectionSpec(yaml), registry, streamRegistries);

const expectCode = (yaml: string, code: string) => {
  try {
    compile(yaml);
    expect.unreachable('expected compile to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectionCompileError);
    expect((error as ProjectionCompileError).code).toBe(code);
  }
};

describe('projection stream compilation', () => {
  it('compiles a valid stream graph', () => {
    const compiled = compile(validYaml);
    expect(compiled.streams).toHaveLength(1);
    const stream = compiled.streams[0]!;
    expect(stream.feedTable).toBe('chunks');
    expect(stream.feedKeyColumn).toBe('chunk_id');
    expect(stream.segmentsTable).toBe('flow_segments');
    expect(compiled.segmentsTables).toEqual([{ name: 'flow_segments', feedKeyColumn: 'chunk_id' }]);
    expect(compiled.rootTables.map((t) => t.name)).toEqual(['records']); // flows + msgs excluded
    const msgs = compiled.tables.find((t) => t.name === 'msgs')!;
    expect(msgs.streamFed).toBe(true);
    expect(Object.keys(tableOutputTypes(msgs))).toEqual([
      'msg_id',
      'record_id',
      'stream_id',
      'text',
      '_src_start',
      '_src_end',
    ]);
    expect(Object.keys(streamSegmentsOutputTypes('chunk_id'))).toEqual([
      'segment_id',
      'stream_id',
      'chunk_id',
      'offset',
      '_src_start',
      '_src_end',
    ]);
  });

  it('rule 1: rejects a stream link referencing an undeclared stream', () => {
    const yaml = validYaml.replace('stream: byte_stream }', 'stream: no_such_stream }');
    expectCode(yaml, 'PROJECTION_STREAM_INVALID');
  });

  it('rule 2: rejects a stream link inside a parser-rooted entry', () => {
    const yaml = validYaml.replace(
      '- from: chunks\n    payload: _.payload',
      '- from: chunk_parser\n    payload: _.payload',
    );
    expectCode(yaml, 'PROJECTION_STREAM_INVALID');
  });

  it('rule 3: rejects two entries with different from tables feeding one stream', () => {
    const yaml = validYaml
      .replace(
        `      port: { expr: '_.port', type: uint16 }
  - name: flows`,
        `      port: { expr: '_.port', type: uint16 }
  - name: chunks2
    rows: $
    key: chunk2_id
    parent_key: { table: records, column: record_id }
    columns:
      port2: { expr: '_.port', type: uint16 }
  - name: flows`,
      )
      .replace(
        `      - { when: 'true', parser: chunk_parser, table: chunks }
  - from: chunks`,
        `      - { when: 'true', parser: chunk_parser, table: chunks }
      - { when: 'true', parser: chunk_parser, table: chunks2 }
  - from: chunks`,
      )
      .replace(
        `      - { when: 'true', stream: byte_stream }
streams:`,
        `      - { when: 'true', stream: byte_stream }
  - from: chunks2
    payload: _.payload
    chain:
      - { when: 'true', stream: byte_stream }
streams:`,
      );
    expectCode(yaml, 'PROJECTION_STREAM_INVALID');
  });

  it('rule 3: rejects a stream never fed by any chain link', () => {
    const yaml = validYaml.replace(
      `  - from: chunks
    payload: _.payload
    chain:
      - { when: 'true', stream: byte_stream }
`,
      '',
    );
    expectCode(yaml, 'PROJECTION_STREAM_INVALID');
  });

  it('rule 4: rejects a stream name colliding with a declared table', () => {
    const yaml = validYaml.replace(/byte_stream/gu, 'chunks');
    expectCode(yaml, 'PROJECTION_STREAM_INVALID');
  });

  it('rule 5: rejects an unknown key extractor id', () => {
    const yaml = validYaml.replace('key: chunk_key', 'key: no_such_key');
    expectCode(yaml, 'PROJECTION_STREAM_INVALID');
  });

  it('rule 5: rejects an unknown framer id', () => {
    const yaml = validYaml.replace('framer: len_framer', 'framer: no_such_framer');
    expectCode(yaml, 'PROJECTION_STREAM_INVALID');
  });

  it('rule 6: rejects a flow table that declares parent_key', () => {
    const yaml = validYaml.replace('table: flows\n    segments_table', 'table: chunks\n    segments_table');
    expectCode(yaml, 'PROJECTION_STREAM_INVALID');
  });

  it('rule 6: rejects an undeclared flow table', () => {
    const yaml = validYaml.replace(
      'table: flows\n    segments_table',
      'table: no_such_flow\n    segments_table',
    );
    expectCode(yaml, 'PROJECTION_STREAM_INVALID');
  });

  it('rule 6: rejects a flow table whose rows anchor is not "$"', () => {
    const yaml = validYaml.replace(
      '  - name: flows\n    rows: $\n    key: flow_id',
      '  - name: flows\n    rows: $.message\n    key: flow_id',
    );
    expectCode(yaml, 'PROJECTION_STREAM_INVALID');
  });

  it('rule 7: rejects a segments_table colliding with a declared table', () => {
    const yaml = validYaml.replace('segments_table: flow_segments', 'segments_table: msgs');
    expectCode(yaml, 'PROJECTION_STREAM_INVALID');
  });

  it('rule 7: rejects two streams sharing a segments_table with different feed tables', () => {
    const yaml = validYaml
      .replace(
        `      port: { expr: '_.port', type: uint16 }
  - name: flows`,
        `      port: { expr: '_.port', type: uint16 }
  - name: chunks2
    rows: $
    key: chunk2_id
    parent_key: { table: records, column: record_id }
    columns:
      port2: { expr: '_.port', type: uint16 }
  - name: flows`,
      )
      .replace(
        `      - { when: 'true', parser: chunk_parser, table: chunks }
  - from: chunks`,
        `      - { when: 'true', parser: chunk_parser, table: chunks }
      - { when: 'true', parser: chunk_parser, table: chunks2 }
  - from: chunks`,
      )
      .replace(
        `      - { when: 'true', stream: byte_stream }
streams:`,
        `      - { when: 'true', stream: byte_stream }
  - from: chunks2
    payload: _.payload
    chain:
      - { when: 'true', stream: byte_stream2 }
streams:`,
      )
      .replace(
        `    messages:
      - { when: 'true', parser: msg_parser, table: msgs }
`,
        `    messages:
      - { when: 'true', parser: msg_parser, table: msgs }
  - name: byte_stream2
    key: chunk_key
    offset: _.seq
    framer: len_framer
    table: flows
    segments_table: flow_segments
    max_buffer: 64
    messages:
      - { when: 'true', parser: msg_parser, table: msgs }
`,
      );
    expectCode(yaml, 'PROJECTION_STREAM_INVALID');
  });

  it('rule 7: rejects a feed table whose key collides with a segments-table fixed column', () => {
    // streamSegmentsOutputTypes places the feed key next to the fixed segment_id/stream_id/
    // offset columns; a feed key with any of those names would collapse into one of them in
    // the schema object literal and silently corrupt the segments table's join.
    for (const key of ['segment_id', 'stream_id', 'offset']) {
      const yaml = validYaml.replace('key: chunk_id', `key: ${key}`);
      expectCode(yaml, 'PROJECTION_STREAM_INVALID');
    }
  });

  it('rule 8: rejects an unregistered message parser', () => {
    const yaml = validYaml.replace('parser: msg_parser, table: msgs', 'parser: no_such_parser, table: msgs');
    expectCode(yaml, 'PROJECTION_PARSER_UNKNOWN');
  });

  it('rule 8: rejects a message link referencing an undeclared table', () => {
    const yaml = validYaml.replace(
      'parser: msg_parser, table: msgs',
      'parser: msg_parser, table: no_such_table',
    );
    expectCode(yaml, 'PROJECTION_DISSECT_INVALID');
  });

  it('rule 8: rejects a message table that does not declare parent_key', () => {
    const yaml = validYaml.replace('parser: msg_parser, table: msgs', 'parser: msg_parser, table: records');
    expectCode(yaml, 'PROJECTION_DISSECT_INVALID');
  });

  it('rule 9: rejects a message parent_key.table unavailable at contribution time', () => {
    const yaml = validYaml.replace(
      'key: msg_id\n    parent_key: { table: records, column: record_id }',
      'key: msg_id\n    parent_key: { table: flows, column: flow_id }',
    );
    expectCode(yaml, 'PROJECTION_PARENT_KEY_INVALID');
  });

  it('rule 10: rejects a stream-fed table declaring a stream_id column', () => {
    const yaml = validYaml.replace(
      `      text: { expr: '_.text', type: utf8 }`,
      `      text: { expr: '_.text', type: utf8 }
      stream_id: { expr: '_.sid', type: int64 }`,
    );
    expectCode(yaml, 'PROJECTION_SPEC_INVALID');
  });

  it('rule 10: rejects a stream-fed table whose key (not column) is named stream_id', () => {
    const yaml = validYaml.replace('key: msg_id', 'key: stream_id');
    expectCode(yaml, 'PROJECTION_SPEC_INVALID');
  });

  it('rule 11: extends acyclicity detection over stream nodes', () => {
    // A deeper dissect entry chained off the message parser feeds back into `chunks`, the
    // very table that feeds byte_stream: chunks -> byte_stream -> msg_parser -> chunk_parser
    // -> chunks closes a cycle that only exists once stream/message edges are in the graph.
    const yaml = validYaml.replace(
      'streams:\n',
      `  - from: msg_parser
    payload: _.trailer
    chain:
      - { when: 'true', parser: chunk_parser, table: chunks }
streams:
`,
    );
    expectCode(yaml, 'PROJECTION_DISSECT_CYCLE');
  });

  it('rule 12: message when rejects context references; stream offset allows them', () => {
    const messageWhenYaml = validYaml.replace(
      "{ when: 'true', parser: msg_parser, table: msgs }",
      "{ when: '_parent == null', parser: msg_parser, table: msgs }",
    );
    expectCode(messageWhenYaml, 'PROJECTION_DISSECT_INVALID');

    const offsetYaml = validYaml.replace('offset: _.seq', 'offset: _parent');
    expect(() => compile(offsetYaml)).not.toThrow();
  });
});
