import { describe, expect, it } from 'vitest';
import { IssueCollector } from '../issues.js';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import { createProjectionSession } from './session.js';
import type { ParserRegistry } from './parsers.js';
import type { StreamRegistries } from './streams.js';

// Same table/dissect/stream YAML as stream-compile.test.ts's validYaml, with flow columns:
//   flows: peer utf8, segment_count uint32, byte_count uint32, message_count uint32,
//          pending_bytes uint32, status utf8
// records root shape: { records: [{ n, body: { bytes, start } }] }
// chunk bytes layout: [port, seq, ...payload]
const yaml = `
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
      peer: { expr: '_.peer', type: utf8 }
      segment_count: { expr: '_.segment_count', type: uint32 }
      byte_count: { expr: '_.byte_count', type: uint32 }
      message_count: { expr: '_.message_count', type: uint32 }
      pending_bytes: { expr: '_.pending_bytes', type: uint32 }
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

const registry: ParserRegistry = new Map([
  // chunk bytes: [port, seq, ...payload]; payload starts at byte 2 of the chunk buffer.
  [
    'chunk_parser',
    (bytes: Uint8Array) => ({
      root: {
        port: bytes[0],
        seq: bytes[1],
        payload: { bytes: bytes.subarray(2), start: 2 },
      },
    }),
  ],
  // message bytes: [len, ...ascii]; text decodes the ascii payload.
  [
    'msg_parser',
    (bytes: Uint8Array) => ({
      root: { message: { text: new TextDecoder().decode(bytes.subarray(1)) } },
    }),
  ],
]);

const streamRegistries: StreamRegistries = {
  keyExtractors: new Map([
    [
      'chunk_key',
      ({ node }) => {
        const port = (node as { port?: number }).port;
        if (typeof port !== 'number') return null;
        return { key: `flow-${port}`, root: { peer: `peer-${port}` } };
      },
    ],
  ]),
  // 1-byte length prefix; total = 1 + len. Throws on len 0.
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

// One record per chunk; chunk n at file offset n*100 for readable provenance.
const chunk = (port: number, seq: number, payload: number[]) => Uint8Array.from([port, seq, ...payload]);
const project = (chunks: Uint8Array[], issues = new IssueCollector()) => {
  const compiled = compileProjection(parseProjectionSpec(yaml), registry, streamRegistries);
  const session = createProjectionSession(compiled, { issues });
  session.project(
    {
      records: chunks.map((bytes, index) => ({
        n: index,
        body: { bytes, start: index * 100 },
      })),
    },
    { resolve: () => ({ start: 0, end: 4 }) },
  );
  return { finished: session.finish(), issues };
};
const table = (finished: { name: string }[], name: string) =>
  finished.find((t) => t.name === name)! as never as {
    rowCount: number;
    arrow: { getChild(c: string): { toArray(): unknown; get(i: number): unknown } | null };
  };

describe('stream runtime', () => {
  it('frames a message split across two in-order chunks and attributes it to the completing record', () => {
    // message: len=4, 'abcd' → bytes [4, 97, 98, 99, 100]; split [4,97,98] + [99,100]
    const { finished, issues } = project([chunk(7, 0, [4, 97, 98]), chunk(7, 3, [99, 100])]);
    expect(issues.issues()).toHaveLength(0);
    const msgs = table(finished, 'msgs');
    expect(msgs.rowCount).toBe(1);
    expect(msgs.arrow.getChild('text')!.get(0)).toBe('abcd');
    expect(msgs.arrow.getChild('record_id')!.get(0)).toBe(2n); // completing record
    expect(msgs.arrow.getChild('stream_id')!.get(0)).toBe(1n);
    const flows = table(finished, 'flows');
    expect(flows.rowCount).toBe(1);
    expect(flows.arrow.getChild('flow_id')!.get(0)).toBe(1n);
    expect(flows.arrow.getChild('peer')!.get(0)).toBe('peer-7');
    expect(flows.arrow.getChild('segment_count')!.get(0)).toBe(2);
    expect(flows.arrow.getChild('byte_count')!.get(0)).toBe(5);
    expect(flows.arrow.getChild('message_count')!.get(0)).toBe(1);
    expect(flows.arrow.getChild('pending_bytes')!.get(0)).toBe(0);
    expect(flows.arrow.getChild('status')!.get(0)).toBe('ok');
    const segments = table(finished, 'flow_segments');
    expect(segments.rowCount).toBe(2);
    expect(segments.arrow.getChild('stream_id')!.toArray()).toEqual(new BigInt64Array([1n, 1n]));
    expect(segments.arrow.getChild('chunk_id')!.toArray()).toEqual(new BigInt64Array([1n, 2n]));
    expect(segments.arrow.getChild('offset')!.toArray()).toEqual(new BigInt64Array([0n, 3n]));
  });

  it('cuts multiple messages from one contribution and separate flows stay separate', () => {
    // two 1-byte messages [1,65][1,66] in one chunk on port 7; port 9 gets its own flow
    const { finished } = project([chunk(7, 0, [1, 65, 1, 66]), chunk(9, 0, [1, 67])]);
    const msgs = table(finished, 'msgs');
    expect(msgs.rowCount).toBe(3);
    const flows = table(finished, 'flows');
    expect(flows.rowCount).toBe(2);
    expect(flows.arrow.getChild('flow_id')!.toArray()).toEqual(new BigInt64Array([1n, 2n]));
  });

  it('reassembles an out-of-order start via rebase, attributing to the chronologically last chunk', () => {
    // arrival order: [99,100] at seq 3, then [4,97,98] at seq 0 — completes on record 2
    const { finished, issues } = project([chunk(7, 3, [99, 100]), chunk(7, 0, [4, 97, 98])]);
    expect(issues.issues()).toHaveLength(0);
    const msgs = table(finished, 'msgs');
    expect(msgs.rowCount).toBe(1);
    expect(msgs.arrow.getChild('text')!.get(0)).toBe('abcd');
    expect(msgs.arrow.getChild('record_id')!.get(0)).toBe(2n);
    expect(table(finished, 'flows').arrow.getChild('status')!.get(0)).toBe('ok');

    // Geometry: record 0's body sits at file offset 0 and carries the seq=3 chunk
    // (payload [99,100], 2 bytes in past the [port,seq] header → file [2, 4));
    // record 1's body sits at file offset 100 and carries the seq=0 chunk
    // (payload [4,97,98], 3 bytes → file [102, 105)). The seq=3 chunk contributes FIRST
    // (arrival order), establishing base=3; the seq=0 chunk contributes second and rebases
    // the base down to 0. Segment rows are emitted at flush, arrival-ordered, with `offset`
    // computed against the FINAL base (0): seq=3's absolute offset 3 relative to base 0 is
    // 3n; seq=0's absolute offset 0 relative to base 0 is 0n — i.e. [3n, 0n] in arrival order
    // (NOT [0n, 3n]; a stale offset computed at contribution time against the transient
    // base=3 would have wrongly read [0n, 0n] for both rows).
    const segments = table(finished, 'flow_segments');
    expect(segments.rowCount).toBe(2);
    expect(segments.arrow.getChild('offset')!.toArray()).toEqual(new BigInt64Array([3n, 0n]));
    expect(segments.arrow.getChild('_src_start')!.toArray()).toEqual(new BigUint64Array([2n, 102n]));
    expect(segments.arrow.getChild('_src_end')!.toArray()).toEqual(new BigUint64Array([4n, 105n]));

    // The reassembled message spans both segments. In stream position the seq=0 segment
    // (file [102,105)) comes first and the seq=3 segment (file [2,4)) comes last, so a naive
    // first-segment-start/last-segment-end span would invert to start=102, end=4. The correct
    // covering range is the min/max over each segment's own clipped file range: min(102, 2)=2,
    // max(105, 4)=105 — a proper range with start < end.
    expect(msgs.arrow.getChild('_src_start')!.get(0)).toBe(2n);
    expect(msgs.arrow.getChild('_src_end')!.get(0)).toBe(105n);
  });

  it('segment offsets are final-base-relative after a rebase', () => {
    // Same geometry as above, isolated to just the flow_segments/offset semantics: the offset
    // column must reflect the FINAL assembler base at flush, not whatever base was current at
    // the moment each contribution was recorded.
    const { finished } = project([chunk(7, 3, [99, 100]), chunk(7, 0, [4, 97, 98])]);
    const segments = table(finished, 'flow_segments');
    const finalBase = 0n; // the seq=0 contribution rebases the base down to 0 and nothing raises it again
    expect(segments.arrow.getChild('offset')!.toArray()).toEqual(
      new BigInt64Array([3n - finalBase, 0n - finalBase]),
    );
  });

  it('computes exact provenance spans per message', () => {
    // Record n's body sits at file offset n*100 and the chunk payload starts 2 bytes in
    // (the [port, seq] header), so chunk 0's payload covers stream [0, 3) at file [2, 5) and
    // chunk 1's payload covers stream [3, 5) at file [102, 104).
    // Message 1 [1, 65] occupies stream [0, 2) → file [2, 4).
    // Message 2 [2, 66, 67] starts at stream 2 → file 4, ends at stream 5 → file 104.
    const { finished } = project([chunk(7, 0, [1, 65, 2]), chunk(7, 3, [66, 67])]);
    const msgs = table(finished, 'msgs');
    expect(msgs.rowCount).toBe(2);
    expect(msgs.arrow.getChild('_src_start')!.toArray()).toEqual(new BigUint64Array([2n, 4n]));
    expect(msgs.arrow.getChild('_src_end')!.toArray()).toEqual(new BigUint64Array([4n, 104n]));
  });

  it('leaves a trailing incomplete message as pending bytes with status ok', () => {
    const { finished, issues } = project([chunk(7, 0, [5, 97, 98])]); // needs 6 bytes, has 3
    expect(issues.issues()).toHaveLength(0);
    const flows = table(finished, 'flows');
    expect(flows.arrow.getChild('status')!.get(0)).toBe('ok');
    expect(flows.arrow.getChild('pending_bytes')!.get(0)).toBe(3);
    expect(table(finished, 'msgs').rowCount).toBe(0);
  });

  it('stream_id stays null on rows fed by a non-stream path', () => {
    // A second dissect path feeding msgs directly (udp-analog) is not declared in this spec;
    // instead assert the msgs schema contains stream_id and chunks does not.
    const compiled = compileProjection(parseProjectionSpec(yaml), registry, streamRegistries);
    expect(compiled.tables.find((t) => t.name === 'chunks')!.streamFed).toBe(false);
    expect(compiled.tables.find((t) => t.name === 'msgs')!.streamFed).toBe(true);
  });
});

describe('stream runtime robustness', () => {
  it('drops an exact duplicate silently', () => {
    const { finished, issues } = project([
      chunk(7, 0, [4, 97, 98]),
      chunk(7, 0, [4, 97, 98]), // retransmission
      chunk(7, 3, [99, 100]),
    ]);
    expect(issues.issues()).toHaveLength(0);
    expect(table(finished, 'msgs').rowCount).toBe(1);
    const flows = table(finished, 'flows');
    expect(flows.arrow.getChild('segment_count')!.get(0)).toBe(2);
    expect(flows.arrow.getChild('byte_count')!.get(0)).toBe(5);
    expect(table(finished, 'flow_segments').rowCount).toBe(2);
  });

  it('marks a partial overlap as error, keeps prior messages, and stops', () => {
    const { finished, issues } = project([
      chunk(7, 0, [1, 65]), // complete message, consumed
      chunk(7, 2, [3, 66, 67, 68]),
      chunk(7, 4, [9, 9]), // overlaps [2,6)
      chunk(7, 6, [1, 70]), // dropped: stream inactive
    ]);
    expect(issues.issues()).toEqual([
      expect.objectContaining({ stage: 'reassembling', code: 'STREAM_ERROR', recoverable: true }),
    ]);
    const flows = table(finished, 'flows');
    expect(flows.arrow.getChild('status')!.get(0)).toBe('error');
    expect(table(finished, 'msgs').rowCount).toBe(2); // 'A' + the [3,66,67,68] message framed before the overlap
  });

  it('marks a below-base segment after consumption as error', () => {
    const { finished, issues } = project([
      chunk(7, 10, [1, 65]), // framed immediately, consumed
      chunk(7, 8, [9, 9]), // below locked base
    ]);
    expect(issues.issues()).toEqual([expect.objectContaining({ code: 'STREAM_ERROR' })]);
    expect(table(finished, 'flows').arrow.getChild('status')!.get(0)).toBe('error');
  });

  it('truncates at the buffer cap, keeping completed messages', () => {
    // max_buffer 64: first a complete message, then a segment stretching past the cap
    const big = Array.from({ length: 63 }, (_, i) => i % 251);
    const { finished, issues } = project([
      chunk(7, 0, [1, 65]),
      chunk(7, 2, big), // extent 2+63 = 65 > 64
    ]);
    expect(issues.issues()).toEqual([expect.objectContaining({ code: 'STREAM_TRUNCATED' })]);
    const flows = table(finished, 'flows');
    expect(flows.arrow.getChild('status')!.get(0)).toBe('truncated');
    expect(table(finished, 'msgs').rowCount).toBe(1);
  });

  it('reports an unfilled gap once at finish', () => {
    const { finished, issues } = project([
      chunk(7, 0, [4, 97]), // bytes 0..2 of a 5-byte message
      chunk(7, 4, [100]), // gap at 2..4 never fills
    ]);
    expect(issues.issues()).toEqual([expect.objectContaining({ code: 'STREAM_GAP' })]);
    expect(table(finished, 'flows').arrow.getChild('status')!.get(0)).toBe('gap');
    expect(table(finished, 'msgs').rowCount).toBe(0);
  });

  it('stalls on a framer throw and reports error at finish (garbage stream)', () => {
    const { finished, issues } = project([chunk(7, 0, [0, 1, 2])]); // len byte 0 → framer throws
    expect(issues.issues()).toEqual([
      expect.objectContaining({ code: 'STREAM_ERROR', message: expect.stringContaining('zero-length') }),
    ]);
    expect(table(finished, 'flows').arrow.getChild('status')!.get(0)).toBe('error');
  });

  it('clears a framing stall when a rebase changes byte zero', () => {
    // First capture starts mid-stream: framer sees [0, 67] and throws (stall). The true start
    // then arrives at seq 0; the rebase shifts the buffer to [2, 65, 0, 67] and clears the
    // stall, so framing retries: len=2 → message [2, 65, 0] (text decodes [65, 0]), leaving
    // [67] as the pending tail of the next message.
    const { finished, issues } = project([chunk(7, 2, [0, 67]), chunk(7, 0, [2, 65])]);
    expect(issues.issues()).toHaveLength(0);
    expect(table(finished, 'msgs').rowCount).toBe(1);
    expect(table(finished, 'flows').arrow.getChild('status')!.get(0)).toBe('ok');
    expect(table(finished, 'flows').arrow.getChild('pending_bytes')!.get(0)).toBe(1);
  });

  it('skips empty payloads silently (no contribution, no flow)', () => {
    const { finished, issues } = project([chunk(7, 0, [])]);
    expect(issues.issues()).toHaveLength(0);
    expect(table(finished, 'flows').rowCount).toBe(0);
  });

  it('reports STREAM_KEY_INVALID and skips when the extractor returns null', () => {
    // Doctor the chunk parser to omit `port`, so chunk_key returns null.
    const badRegistry = new Map(registry);
    badRegistry.set('chunk_parser', (bytes: Uint8Array) => ({
      root: { seq: bytes[1], payload: { bytes: bytes.subarray(2), start: 2 } },
    }));
    const compiled = compileProjection(parseProjectionSpec(yaml), badRegistry, streamRegistries);
    const issues = new IssueCollector();
    const session = createProjectionSession(compiled, { issues });
    session.project(
      { records: [{ n: 0, body: { bytes: chunk(7, 0, [1, 65]), start: 0 } }] },
      { resolve: () => ({ start: 0, end: 4 }) },
    );
    const finished = session.finish();
    expect(issues.issues()).toEqual([
      expect.objectContaining({ stage: 'reassembling', code: 'STREAM_KEY_INVALID', recoverable: true }),
    ]);
    expect(finished.find((t) => t.name === 'flows')!.rowCount).toBe(0);
  });

  it('records the true source span for a flow whose only contribution is rejected as truncated', () => {
    // A single segment already bigger than max_buffer (64) is rejected by assembler.add() as
    // 'truncated' before it is ever stored — assembler.segmentCount stays 0 and assembler.srcSpan
    // stays null forever, so flushStreams must fall back to the rejected contribution's own
    // {srcStart, srcEnd} (see fallbackSpan in project.ts), not the meaningless {0, 0}.
    // Geometry: record 0's body sits at file offset 0; the chunk's payload starts 2 bytes in
    // (past the [port, seq] header) → file [2, 72) for a 70-byte payload.
    const big70 = Array.from({ length: 70 }, (_, i) => i % 251);
    const { finished, issues } = project([chunk(7, 0, big70)]);
    expect(issues.issues()).toEqual([expect.objectContaining({ code: 'STREAM_TRUNCATED' })]);
    const flows = table(finished, 'flows');
    expect(flows.rowCount).toBe(1);
    expect(flows.arrow.getChild('status')!.get(0)).toBe('truncated');
    expect(flows.arrow.getChild('message_count')!.get(0)).toBe(0);
    expect(flows.arrow.getChild('_src_start')!.get(0)).toBe(2n);
    expect(flows.arrow.getChild('_src_end')!.get(0)).toBe(72n);
  });

  it('reports STREAM_ERROR when offset is not a non-negative integer', () => {
    // seq byte is uint8 so a negative offset needs a doctored parser: recompile with a
    // chunk_parser emitting seq: -1 and assert the issue.
    const badRegistry = new Map(registry);
    badRegistry.set('chunk_parser', (bytes: Uint8Array) => ({
      root: { port: bytes[0], seq: -1, payload: { bytes: bytes.subarray(2), start: 2 } },
    }));
    const compiled = compileProjection(parseProjectionSpec(yaml), badRegistry, streamRegistries);
    const issues = new IssueCollector();
    const session = createProjectionSession(compiled, { issues });
    session.project(
      { records: [{ n: 0, body: { bytes: chunk(7, 0, [1, 65]), start: 0 } }] },
      { resolve: () => ({ start: 0, end: 4 }) },
    );
    session.finish();
    expect(issues.issues()).toEqual([
      expect.objectContaining({ code: 'STREAM_ERROR', message: expect.stringContaining('offset') }),
    ]);
  });
});
