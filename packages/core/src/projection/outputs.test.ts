import { describe, expect, it } from 'vitest';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import type { ParserRegistry } from './parsers.js';
import type { StreamRegistries } from './streams.js';

const registry: ParserRegistry = new Map([
  ['chunk_parser', () => ({ root: {} })],
  ['msg_parser', () => ({ root: {} })],
]);
const streams: StreamRegistries = {
  keyExtractors: new Map([['chunk_key', () => ({ key: 'k', root: {} })]]),
  framers: new Map([['len_framer', () => null]]),
};

const yaml = (extraStream = '') => `
version: '0.4'
format: streamy
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      n: { expr: '_.n', type: uint8 }
      label: { expr: '_.label', type: utf8, nullable: true }
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
      - { when: 'true', stream: byte_stream }${extraStream ? `\n      - { when: 'false', stream: other_stream }` : ''}
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
${extraStream}`;

const sharedSegments = `  - name: other_stream
    key: chunk_key
    offset: _.seq
    framer: len_framer
    table: flows2
    segments_table: flow_segments
    max_buffer: 64
    messages:
      - { when: 'true', parser: msg_parser, table: msgs }
`;

const compile = (source: string, options = {}) =>
  compileProjection(parseProjectionSpec(source), registry, streams, options);

describe('compiled outputs', () => {
  it('lists projected, flow, segments, then errors, in emit order', () => {
    const outputs = compile(yaml()).outputs;
    expect(outputs.map((o) => [o.name, o.kind])).toEqual([
      ['records', 'projected'],
      ['chunks', 'projected'],
      ['flows', 'flow'],
      ['msgs', 'projected'],
      ['flow_segments', 'segments'],
      ['errors', 'errors'],
    ]);
  });

  it('gives each output its engine column order, types, and v0.4 nullability', () => {
    const byName = new Map(compile(yaml()).outputs.map((o) => [o.name, o]));
    expect(byName.get('records')!.columns).toEqual([
      { name: 'record_id', type: 'int64', nullable: false },
      { name: 'n', type: 'uint8', nullable: false },
      { name: 'label', type: 'utf8', nullable: true },
      { name: '_src_start', type: 'uint64', nullable: false },
      { name: '_src_end', type: 'uint64', nullable: false },
    ]);
    expect(byName.get('msgs')!.columns.map((c) => [c.name, c.nullable])).toEqual([
      ['msg_id', false],
      ['record_id', false],
      ['stream_id', true],
      ['text', false],
      ['_src_start', false],
      ['_src_end', false],
      ['_src_ranges', true],
    ]);
    expect(byName.get('flow_segments')!.columns).toEqual([
      { name: 'segment_id', type: 'int64', nullable: false },
      { name: 'stream_id', type: 'int64', nullable: false },
      { name: 'chunk_id', type: 'int64', nullable: true },
      { name: 'offset', type: 'int64', nullable: false },
      { name: '_src_start', type: 'uint64', nullable: false },
      { name: '_src_end', type: 'uint64', nullable: false },
    ]);
  });

  it('builds errors with the default ordinal column', () => {
    const errors = compile(yaml()).outputs.at(-1)!;
    expect(errors.columns).toEqual([
      { name: 'error_id', type: 'int64', nullable: false },
      { name: 'stage', type: 'utf8', nullable: false },
      { name: 'record', type: 'int32', nullable: true },
      { name: 'code', type: 'utf8', nullable: false },
      { name: 'message', type: 'utf8', nullable: false },
      { name: 'recoverable', type: 'bool', nullable: false },
      { name: '_src_start', type: 'uint64', nullable: true },
      { name: '_src_end', type: 'uint64', nullable: true },
    ]);
  });

  it('takes the errors ordinal column from the compile option', () => {
    const compiled = compile(yaml(), { issues: { ordinalColumn: 'track' } });
    expect(compiled.errorsOrdinalColumn).toBe('track');
    expect(compiled.outputs.at(-1)!.columns[2]).toEqual({ name: 'track', type: 'int32', nullable: true });
  });

  it.each(['error_id', 'stage', 'code', 'message', 'recoverable', '_src_start', '_src_end'])(
    'rejects the reserved ordinal column %s at compile time',
    (name) => {
      expect(() => compile(yaml(), { issues: { ordinalColumn: name } })).toThrow(
        /ISSUE_ORDINAL_COLUMN_RESERVED/u,
      );
    },
  );

  it('lists a segments table shared by two streams once', () => {
    const source = yaml(sharedSegments).replace(
      '  - name: msgs',
      `  - name: flows2
    rows: $
    key: flow2_id
    columns:
      status: { expr: '_.status', type: utf8 }
  - name: msgs`,
    );
    const outputs = compile(source).outputs;
    expect(outputs.filter((o) => o.name === 'flow_segments')).toHaveLength(1);
    expect(outputs.find((o) => o.name === 'flows2')!.kind).toBe('flow');
  });

  it('gives a flow table its key, declared columns, provenance, and nullable ranges', () => {
    const flows = compile(yaml()).outputs.find((o) => o.name === 'flows')!;
    expect(flows.columns).toEqual([
      { name: 'flow_id', type: 'int64', nullable: false },
      { name: 'status', type: 'utf8', nullable: false },
      { name: '_src_start', type: 'uint64', nullable: false },
      { name: '_src_end', type: 'uint64', nullable: false },
      { name: '_src_ranges', type: 'src_ranges', nullable: true },
    ]);
  });

  it.each(['errors', 'ERRORS', '_files', '_Files'])('rejects the engine-owned spec table name %s', (name) => {
    const source = yaml()
      .replace('name: flows\n', `name: ${name}\n`)
      .replace('table: flows', `table: ${name}`);
    expect(() => compile(source)).toThrow(/PROJECTION_TABLE_RESERVED/u);
  });

  it.each(['errors', 'Errors', '_files'])('rejects the engine-owned segments_table name %s', (name) => {
    const source = yaml().replace('segments_table: flow_segments', `segments_table: ${name}`);
    expect(() => compile(source)).toThrow(/PROJECTION_TABLE_RESERVED/u);
  });
});
