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

const ranges = (value: unknown) =>
  value === null
    ? null
    : Array.from(value as Iterable<{ start: bigint; end: bigint }>, (p) => [p.start, p.end]);

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
    // The flow's _src_ranges holds the SYN's own control range [0, 3) as its own piece,
    // alongside the two data pieces: record 1's chunk payload at file [103, 105) (chunk bytes
    // start at 1*100 = 100, payload after the 3-byte header at 103) and record 2's at
    // [203, 204) (chunk bytes start at 2*100 = 200, payload at 203).
    expect(ranges(rows(finished, 'flows').col('_src_ranges')[0])).toEqual([
      [0n, 3n],
      [103n, 105n],
      [203n, 204n],
    ]);
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
    // Control-only flow: the assembler was never anchored (no open), so flushStreams falls back
    // to the FIN's own absOffset (40) as the base — its stream_segments row reads offset 0, not
    // the raw stream offset 40.
    expect(rows(finished, 'flow_segments').col('offset')).toEqual([0n]);
  });

  it('keeps tracking lifecycle after the stream goes inactive', () => {
    // zero-length message stalls framing -> status error at flush; the later reset still lands
    const { finished } = project([chunk(7, OPEN, 10), chunk(7, 0, 10, [0]), chunk(7, RESET, 11)]);
    const flows = rows(finished, 'flows');
    expect(flows.col('status')).toEqual(['error']);
    expect(flows.col('closed_by')).toEqual(['reset']);
  });

  it('keeps recording control segments once the stream is truncated', () => {
    // max_buffer 2: the 6-byte data contribution alone exceeds it and is truncated (dropped,
    // never recorded); the SYN before it and the RST after it are still recorded, and the RST
    // still updates closed_by even though the stream is already inactive by then.
    const { finished } = project(
      [chunk(7, OPEN, 10), chunk(7, 0, 10, [5, 1, 2, 3, 4, 5]), chunk(7, RESET, 16)],
      '',
      2,
    );
    const flows = rows(finished, 'flows');
    expect(flows.col('status')).toEqual(['truncated']);
    expect(flows.col('closed_by')).toEqual(['reset']);
    expect(rows(finished, 'flow_segments').count).toBe(2); // SYN + RST; the truncated data is not
  });

  it('keeps a control segment below a real data base at its negative offset', () => {
    // CLOSE at stream offset 5 arrives before any data; the data that follows anchors the
    // assembler's base at 10 (its own offset). The CLOSE segment stays below that base and its
    // stream_segments offset is negative, not clamped to 0.
    const { finished } = project([chunk(7, CLOSE, 5), chunk(7, 0, 10, [2, 97, 98])]); // [2,97,98] = msg('ab')
    expect(rows(finished, 'flow_segments').col('offset')).toEqual([-5n, 0n]);
  });

  it('finishes without crashing when a control-only flow accumulates far more segments than fit in a call-stack spread', () => {
    // No open ever arrives, so the assembler is never anchored and flushStreams' finalBase
    // fallback (the minimum recorded absOffset) has to scan this many segments without blowing
    // the call stack (a naive `Math.min(...entry.segments.map(...))` throws well before this
    // count — an RST-storm/scan capture with no SYN can put 100k+ control segments on one tuple).
    const CONTROL_SEGMENT_COUNT = 200_000;
    const chunks = Array.from({ length: CONTROL_SEGMENT_COUNT }, (_, i) => chunk(7, CLOSE, i));
    const { finished } = project(chunks);
    const flows = rows(finished, 'flows');
    expect(flows.count).toBe(1);
    expect(rows(finished, 'flow_segments').count).toBe(CONTROL_SEGMENT_COUNT);
  });
});

describe('stream lifecycle: generations', () => {
  const msg = (text: string) => [text.length, ...[...text].map((c) => c.charCodeAt(0))];

  it('splits a reused tuple after close into two flows', () => {
    const { finished } = project([
      chunk(7, OPEN, 10),
      chunk(7, 0, 10, msg('ab')),
      chunk(7, CLOSE, 13),
      chunk(7, OPEN, 50),
      chunk(7, 0, 50, msg('cd')),
    ]);
    const flows = rows(finished, 'flows');
    expect(flows.count).toBe(2);
    expect(flows.col('flow_id')).toEqual([1n, 2n]);
    expect(flows.col('generation')).toEqual([1, 2]);
    expect(flows.col('closed_by')).toEqual(['close', null]);
    const msgs = rows(finished, 'msgs');
    expect(msgs.col('text')).toEqual(['ab', 'cd']);
    expect(msgs.col('stream_id')).toEqual([1n, 2n]);
    expect(rows(finished, 'flow_segments').col('stream_id')).toEqual([1n, 1n, 1n, 2n, 2n]);
  });

  it('keeps a retransmitted open in the same generation', () => {
    const { finished } = project([chunk(7, OPEN, 10), chunk(7, OPEN, 10), chunk(7, 0, 10, msg('a'))]);
    expect(rows(finished, 'flows').count).toBe(1);
    expect(rows(finished, 'flow_segments').count).toBe(3);
  });

  it('starts a new generation for an open at a different offset without any close', () => {
    const { finished } = project([chunk(7, OPEN, 10), chunk(7, OPEN, 90)]);
    expect(rows(finished, 'flows').col('generation')).toEqual([1, 2]);
  });

  it('adopts a mid-stream flow when a late open lands on its base', () => {
    // [5, 97] is an incomplete message, so nothing is consumed yet
    const { finished } = project([chunk(7, 0, 10, [5, 97]), chunk(7, OPEN, 10)]);
    const flows = rows(finished, 'flows');
    expect(flows.count).toBe(1);
    expect(flows.col('opened')).toEqual([true]);
  });

  // Review Focus 2
  it('adopts even after the data was framed (consumed > 0)', () => {
    const { finished, issues } = project([chunk(7, 0, 10, msg('ab')), chunk(7, OPEN, 10)]);
    expect(rows(finished, 'msgs').count).toBe(1);
    expect(rows(finished, 'flows').col('generation')).toEqual([1]);
    expect(issues.issues()).toEqual([]);
  });

  it('starts a new generation when an open follows a mid-stream flow at another offset', () => {
    const { finished } = project([chunk(7, 0, 10, msg('ab')), chunk(7, OPEN, 60)]);
    expect(rows(finished, 'flows').col('generation')).toEqual([1, 2]);
  });

  // Review Focus 4
  it('keeps a late FIN in the closed generation and lets the next open start generation 2', () => {
    const { finished } = project([
      chunk(7, OPEN, 10),
      chunk(7, CLOSE, 10),
      chunk(7, CLOSE, 10), // retransmitted FIN
      chunk(7, OPEN, 70),
    ]);
    expect(rows(finished, 'flow_segments').col('stream_id')).toEqual([1n, 1n, 1n, 2n]);
  });

  it('keeps generations independent per key', () => {
    const { finished } = project([chunk(7, OPEN, 10), chunk(9, OPEN, 10), chunk(7, OPEN, 20)]);
    expect(rows(finished, 'flows').col('peer')).toEqual(['peer-7', 'peer-9', 'peer-7']);
    expect(rows(finished, 'flows').col('generation')).toEqual([1, 1, 2]);
  });

  // Review Focus 1
  it('handles thousands of generations on one tuple in linear time', () => {
    const chunks = Array.from({ length: 5000 }, (_, i) => chunk(7, OPEN, i % 256));
    const started = performance.now();
    const { finished } = project(chunks);
    expect(rows(finished, 'flows').count).toBe(5000);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('stream overlap reconciliation (runtime)', () => {
  it('counts a conflict, reports it at the conflicting segment, and keeps going', () => {
    // msg [3,'a','b','c'] = seq 10..14; retransmit of seq 11..13 with 'X' instead of 'b'
    // Base 10 (the open). Record n's payload sits at file offset n * 100 + 3.
    const { finished, issues } = project([
      chunk(7, OPEN, 10),
      chunk(7, 0, 10, [3, 97]), // offsets 10..11: length byte 3, 'a'
      chunk(7, 0, 11, [88, 99]), // offset 11 conflicts (88 vs stored 97, 97 kept); offset 12 'c' is new
      chunk(7, 0, 13, [100]), // offset 13 'd' completes [3, 97, 99, 100]
    ]);
    expect(rows(finished, 'msgs').col('text')).toEqual(['acd']);
    const flows = rows(finished, 'flows');
    expect(flows.col('conflict_count')).toEqual([1]);
    expect(flows.col('status')).toEqual(['ok']);
    expect(issues.issues().map((i) => [i.code, i.sourceStart, i.sourceEnd])).toEqual([
      ['STREAM_OVERLAP_CONFLICT', 203, 205],
    ]);
  });

  it('compares a retransmission of already-framed bytes against the consumed data', () => {
    const { finished, issues } = project([
      chunk(7, OPEN, 10),
      chunk(7, 0, 10, [1, 97]), // message 'a', framed and consumed
      chunk(7, 0, 10, [1, 98]), // same offsets, different byte
    ]);
    expect(rows(finished, 'msgs').col('text')).toEqual(['a']);
    expect(rows(finished, 'flows').col('conflict_count')).toEqual([1]);
    expect(issues.issues().map((i) => i.code)).toEqual(['STREAM_OVERLAP_CONFLICT']);
  });

  it('reports STREAM_BELOW_BASE once per flow and keeps the stream ok', () => {
    const { finished, issues } = project([
      chunk(7, 0, 20, [1, 97]), // mid-stream start; framed, base locked at 20
      chunk(7, 0, 18, [5, 5, 1]), // 18,19 below base; offset 20 duplicates the stored 1
      chunk(7, 0, 17, [5]),
    ]);
    expect(rows(finished, 'flows').col('status')).toEqual(['ok']);
    expect(issues.issues().map((i) => i.code)).toEqual(['STREAM_BELOW_BASE']);
  });
});
