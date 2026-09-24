import { describe, expect, it } from 'vitest';
import { IssueCollector } from '../issues.js';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import { createProjectionSession } from './session.js';
import type { ParserRegistry } from './parsers.js';
import type { StreamRegistries } from './streams.js';

export const lifecycleYaml = (streamExtra = '', maxBuffer = 64) => `
version: '0.5'
format: streamy
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      n: { expr: '_.n', type: uint32 }
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
      peer: { expr: '_.peer', type: utf8 }
      segment_count: { expr: '_.segment_count', type: uint32 }
      byte_count: { expr: '_.byte_count', type: uint32 }
      message_count: { expr: '_.message_count', type: uint32 }
      status: { expr: '_.status', type: utf8 }
      opened: { expr: '_.opened', type: bool }
      closed_by: { expr: '_.closed_by', type: utf8, nullable: true }
      generation: { expr: '_.generation', type: uint32 }
      conflict_count: { expr: '_.conflict_count', type: uint32 }
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
    open: _.open
    close: _.close
    reset: _.reset
${streamExtra}
    framer: len_framer
    table: flows
    segments_table: flow_segments
    max_buffer: ${maxBuffer}
    messages:
      - { when: 'true', parser: msg_parser, table: msgs }
`;

export const OPEN = 1;
export const CLOSE = 2;
export const RESET = 4;

export const registry: ParserRegistry = new Map([
  [
    'chunk_parser',
    (bytes: Uint8Array) => ({
      root: {
        port: bytes[0],
        open: (bytes[1]! & OPEN) !== 0,
        close: (bytes[1]! & CLOSE) !== 0,
        reset: (bytes[1]! & RESET) !== 0,
        seq: bytes[2],
        payload: { bytes: bytes.subarray(3), start: 3 },
      },
    }),
  ],
  [
    'msg_parser',
    (bytes: Uint8Array) => ({ root: { message: { text: new TextDecoder().decode(bytes.subarray(1)) } } }),
  ],
]);

export const streamRegistries: StreamRegistries = {
  keyExtractors: new Map([
    [
      'chunk_key',
      ({ node }) => {
        const port = (node as { port?: number }).port;
        return typeof port === 'number' ? { key: `flow-${port}`, root: { peer: `peer-${port}` } } : null;
      },
    ],
  ]),
  framers: new Map([
    [
      'len_framer',
      (buffer: Uint8Array) => {
        if (buffer.length < 1) return null;
        if (buffer[0] === 0) throw new Error('zero-length message');
        return 1 + buffer[0]!;
      },
    ],
  ]),
};

export const chunk = (port: number, flags: number, seq: number, payload: number[] = []) =>
  Uint8Array.from([port, flags, seq, ...payload]);

export const project = (chunks: Uint8Array[], streamExtra = '', maxBuffer = 64) => {
  const issues = new IssueCollector();
  const compiled = compileProjection(
    parseProjectionSpec(lifecycleYaml(streamExtra, maxBuffer)),
    registry,
    streamRegistries,
  );
  const session = createProjectionSession(compiled, { issues });
  session.project(
    { records: chunks.map((bytes, index) => ({ n: index, body: { bytes, start: index * 100 } })) },
    { resolve: () => ({ start: 0, end: 4 }) },
  );
  return { finished: session.finish(), issues };
};

type Col = { toArray(): unknown; get(i: number): unknown };
export const rows = (finished: { name: string }[], name: string) => {
  const t = finished.find((x) => x.name === name)! as never as {
    rowCount: number;
    arrow: { getChild(c: string): Col | null };
  };
  return {
    count: t.rowCount,
    col: (c: string) => Array.from({ length: t.rowCount }, (_, i) => t.arrow.getChild(c)!.get(i)),
  };
};

describe('stream lifecycle: control segments', () => {
  it('lets an empty open segment create a flow and anchor its base', () => {
    // SYN at seq 10 (no payload), then message [2,'a','b'] split: seq 10 [2,97], seq 12 [98]
    const { finished, issues } = project([
      chunk(7, OPEN, 10),
      chunk(7, 0, 10, [2, 97]),
      chunk(7, 0, 12, [98]),
    ]);
    expect(issues.issues()).toEqual([]);
    const flows = rows(finished, 'flows');
    expect(flows.count).toBe(1);
    expect(flows.col('opened')).toEqual([true]);
    expect(flows.col('closed_by')).toEqual([null]);
    expect(flows.col('generation')).toEqual([1]);
    expect(flows.col('conflict_count')).toEqual([0]);
    expect(flows.col('segment_count')).toEqual([2]); // data-bearing only
    expect(rows(finished, 'msgs').col('text')).toEqual(['ab']);
    const segs = rows(finished, 'flow_segments');
    expect(segs.count).toBe(3); // the SYN is recorded
    expect(segs.col('offset')).toEqual([0n, 0n, 2n]);
    // control segment provenance = the feeding chunk row's range (record 0's chunk at [0, 3))
    expect(segs.col('_src_start')[0]).toBe(0n);
    expect(segs.col('_src_end')[0]).toBe(3n);
  });

  it('turns a missing first data segment after an open into a gap', () => {
    const { finished } = project([chunk(7, OPEN, 10), chunk(7, 0, 12, [98])]);
    expect(rows(finished, 'flows').col('status')).toEqual(['gap']);
  });

  it('ignores empty segments with no lifecycle signal', () => {
    const { finished } = project([chunk(7, 0, 10)]);
    expect(rows(finished, 'flows').count).toBe(0);
    expect(rows(finished, 'flow_segments').count).toBe(0);
  });

  it('records close and lets reset take precedence', () => {
    const closeOnly = project([chunk(7, 0, 10, [1, 65]), chunk(7, CLOSE, 12)]).finished;
    expect(rows(closeOnly, 'flows').col('closed_by')).toEqual(['close']);
    const resetThenClose = project([chunk(7, OPEN, 10), chunk(7, RESET, 10), chunk(7, CLOSE, 10)]).finished;
    expect(rows(resetThenClose, 'flows').col('closed_by')).toEqual(['reset']);
    const closeThenReset = project([chunk(7, OPEN, 10), chunk(7, CLOSE, 10), chunk(7, RESET, 10)]).finished;
    expect(rows(closeThenReset, 'flows').col('closed_by')).toEqual(['reset']);
  });

  // Review Focus 3
  it('gives a close-only mid-connection flow a header-spanning row', () => {
    const { finished } = project([chunk(7, CLOSE, 40)]);
    const flows = rows(finished, 'flows');
    expect(flows.count).toBe(1);
    expect(flows.col('opened')).toEqual([false]);
    expect(flows.col('closed_by')).toEqual(['close']);
    expect(flows.col('byte_count')).toEqual([0]);
    expect(flows.col('status')).toEqual(['ok']);
    expect(flows.col('_src_start')).toEqual([0n]);
    expect(flows.col('_src_end')).toEqual([3n]);
  });

  it('keeps tracking lifecycle after the stream goes inactive', () => {
    // zero-length message stalls framing -> status error at flush; the later reset still lands
    const { finished } = project([chunk(7, OPEN, 10), chunk(7, 0, 10, [0]), chunk(7, RESET, 11)]);
    const flows = rows(finished, 'flows');
    expect(flows.col('status')).toEqual(['error']);
    expect(flows.col('closed_by')).toEqual(['reset']);
  });
});
