import { describe, expect, it } from 'vitest';

import { ipcToTable } from '../arrow/build.js';
import { memoryByteSource } from '../byte-source.js';
import { compileProjection } from '../projection/project.js';
import { ProjectionFieldError } from '../projection/project.js';
import { parseProjectionSpec } from '../projection/spec.js';
import type { RecordSource } from '../protocol.js';
import { openFramedSource } from './driver.js';
import type { Framer } from './framer.js';

const compiled = compileProjection(
  parseProjectionSpec(`
version: '0.4'
format: f
tables:
  - name: rec
    rows: $
    key: rec_id
    columns:
      v: { expr: _.v, type: uint32 }
`),
);
// Two root tables fed from the same anchor, for the `tables` option restriction test.
const compiledTwoTables = compileProjection(
  parseProjectionSpec(`
version: '0.4'
format: f
tables:
  - name: rec
    rows: $
    key: rec_id
    columns:
      v: { expr: _.v, type: uint32 }
  - name: other
    rows: $
    key: other_id
    columns:
      w: { expr: _.v, type: uint32 }
`),
);
const source = memoryByteSource(new Uint8Array(100));
const opts = () => ({ signal: new AbortController().signal });
const drain = async (rs: RecordSource) => {
  const out: { table: string; rows: number }[] = [];
  for (let b = await rs.nextBatch(); b; b = await rs.nextBatch())
    out.push({ table: b.table, rows: b.rowCount });
  return out;
};
const records = (n: number): Framer =>
  async function* (_source, ctx) {
    for (let i = 0; i < n; i += 1) {
      ctx.bytes(i + 1); // report consumption before yielding, as real framers do
      yield { root: { v: i }, provenance: { start: i, end: i + 1 } };
    }
  };

describe('openFramedSource', () => {
  it('projects every record, always emits errors last, and finish() returns capabilities', async () => {
    const framer: Framer = async function* () {
      yield { root: { v: 1 }, provenance: { start: 0, end: 4 } };
      return { capabilities: { audio: { enabled: true, reason: null } } };
    };
    const rs = openFramedSource(compiled, framer, source, opts(), { ordinalColumn: 'record' });
    expect(await drain(rs)).toEqual([
      { table: 'rec', rows: 1 },
      { table: 'errors', rows: 0 },
    ]);
    expect(rs.finish().capabilities).toEqual({ audio: { enabled: true, reason: null } });
  });

  it('drains at the flush threshold', async () => {
    const rs = openFramedSource(compiled, records(5), source, opts(), {
      ordinalColumn: 'record',
      flushRowThreshold: 2,
    });
    const batches = await drain(rs);
    expect(batches.filter((b) => b.table === 'rec').map((b) => b.rows)).toEqual([2, 2, 1]);
  });

  it('orders framer issues before engine issues, even when reported last', async () => {
    const framer: Framer = async function* (_s, ctx) {
      yield {
        root: { v: 1 },
        provenance: { start: 0, end: 1 },
        onError: () => ({ code: 'X', message: 'x' }),
      };
      yield {
        root: { v: 2 },
        provenance: () => {
          throw new Error('boom');
        },
        ordinal: 7,
      };
      ctx.report({ code: 'TRUNCATED', message: 't', sourceStart: 9, sourceEnd: 10 });
    };
    const rs = openFramedSource(compiled, framer, source, opts(), { ordinalColumn: 'record' });
    await drain(rs);
    const issues = rs.finish().issues;
    expect(issues.map((i) => [i.stage, i.code, i.track])).toEqual([
      ['framing', 'TRUNCATED', null],
      ['projecting', 'PROJECTION_FAILED', 7],
    ]);
  });

  it('rethrows ProjectionFieldError instead of recording it', async () => {
    const framer: Framer = async function* () {
      yield { root: { w: 1 }, provenance: { start: 0, end: 1 } };
    };
    const rs = openFramedSource(compiled, framer, source, opts(), {
      ordinalColumn: 'record',
      strictFields: true,
    });
    await expect(drain(rs)).rejects.toBeInstanceOf(ProjectionFieldError);
    expect(() => rs.finish()).toThrow(ProjectionFieldError);
  });

  it('rejects with AbortError even when every batch is already queued', async () => {
    const controller = new AbortController();
    const rs = openFramedSource(
      compiled,
      records(3),
      source,
      { signal: controller.signal },
      { ordinalColumn: 'record' },
    );
    await rs.nextBatch();
    controller.abort();
    await expect(rs.nextBatch()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('finish() before draining throws RECORD_SOURCE_NOT_DRAINED', () => {
    const rs = openFramedSource(compiled, records(1), source, opts(), { ordinalColumn: 'record' });
    expect(() => rs.finish()).toThrow(/RECORD_SOURCE_NOT_DRAINED/u);
  });

  it('reports byte progress at the yield cadence and always at the end', async () => {
    const seen: number[] = [];
    const rs = openFramedSource(
      compiled,
      records(10),
      source,
      { signal: new AbortController().signal, onProgress: (p) => seen.push(p.completed) },
      { ordinalColumn: 'record', yieldInterval: 4 },
    );
    await drain(rs);
    expect(seen).toEqual([4, 8, 10]);
  });

  it('always emits the tail byte-progress event, even when it repeats the last cadence value', async () => {
    const seen: number[] = [];
    // 8 records at yieldInterval 4: the interior cadence flush already reports 8 (after the
    // 8th record), so the tail flush at EOF would previously be swallowed by the dedup guard.
    const rs = openFramedSource(
      compiled,
      records(8),
      source,
      { signal: new AbortController().signal, onProgress: (p) => seen.push(p.completed) },
      { ordinalColumn: 'record', yieldInterval: 4 },
    );
    await drain(rs);
    expect(seen).toEqual([4, 8, 8]);
  });

  it('uses onError to map a projection throw into a custom issue, carrying its code/stage/ordinal', async () => {
    const framer: Framer = async function* () {
      yield {
        root: { v: 1 },
        provenance: () => {
          throw new Error('resolver exploded');
        },
        onError: () => ({
          stage: 'custom',
          code: 'CUSTOM_CODE',
          message: 'mapped',
          ordinal: 42,
          sourceStart: 5,
          sourceEnd: 9,
        }),
      };
    };
    const rs = openFramedSource(compiled, framer, source, opts(), { ordinalColumn: 'record' });
    await drain(rs);
    const issues = rs.finish().issues;
    expect(issues).toEqual([
      {
        stage: 'custom',
        track: 42,
        code: 'CUSTOM_CODE',
        message: 'mapped',
        recoverable: true,
        sourceStart: 5,
        sourceEnd: 9,
      },
    ]);
  });

  it('the tables option restricts which root tables a record feeds', async () => {
    const framer: Framer = async function* () {
      yield { root: { v: 1 }, provenance: { start: 0, end: 1 } }; // feeds both rec and other
      yield { root: { v: 2 }, provenance: { start: 1, end: 2 }, tables: ['rec'] }; // rec only
    };
    const rs = openFramedSource(compiledTwoTables, framer, source, opts(), { ordinalColumn: 'record' });
    const batches = await drain(rs);
    const rowsOf = (table: string) =>
      batches.filter((b) => b.table === table).reduce((sum, b) => sum + b.rows, 0);
    expect(rowsOf('rec')).toBe(2);
    expect(rowsOf('other')).toBe(1);
  });

  it('forwards ctx.progress immediately, not coalesced to the yield cadence', async () => {
    const progressStages: string[] = [];
    const framer: Framer = async function* (_s, ctx) {
      yield { root: { v: 1 }, provenance: { start: 0, end: 1 } };
      ctx.progress({ stage: 'probing', completed: 1, total: 10, label: 'probe' });
      yield { root: { v: 2 }, provenance: { start: 1, end: 2 } };
    };
    const rs = openFramedSource(
      compiled,
      framer,
      source,
      { signal: new AbortController().signal, onProgress: (p) => progressStages.push(p.stage) },
      { ordinalColumn: 'record', yieldInterval: 1_000_000 }, // never reached via byte cadence
    );
    await drain(rs);
    expect(progressStages).toEqual(['probing']);
  });

  it('the default PROJECTION_FAILED issue carries the static provenance range as sourceStart/sourceEnd', async () => {
    // A root whose property reads throw synchronously, forcing session.project() to throw for
    // reasons unrelated to provenance resolution, while provenance itself stays a static range.
    const explodingRoot: object = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('root exploded');
        },
      },
    );
    const framer: Framer = async function* () {
      yield { root: explodingRoot, provenance: { start: 3, end: 9 } };
    };
    const rs = openFramedSource(compiled, framer, source, opts(), { ordinalColumn: 'record' });
    await drain(rs);
    const issues = rs.finish().issues;
    expect(issues).toEqual([
      {
        stage: 'projecting',
        track: null,
        code: 'PROJECTION_FAILED',
        message: expect.stringContaining('root exploded'),
        recoverable: true,
        sourceStart: 3,
        sourceEnd: 9,
      },
    ]);
  });

  it('a framer throw fails the source with that error', async () => {
    // eslint-disable-next-line require-yield -- a fatal framer throws before its first record
    const framer: Framer = async function* () {
      throw new Error('UNRECOGNIZED: nope');
    };
    const rs = openFramedSource(compiled, framer, source, opts(), { ordinalColumn: 'record' });
    await expect(rs.nextBatch()).rejects.toThrow(/UNRECOGNIZED/u);
    await expect(rs.nextBatch()).rejects.toThrow(/UNRECOGNIZED/u);
  });

  it('merged rows are identical for any threshold', async () => {
    const rows = async (threshold: number) => {
      const rs = openFramedSource(compiled, records(7), source, opts(), {
        ordinalColumn: 'record',
        flushRowThreshold: threshold,
      });
      const vs: number[] = [];
      for (let b = await rs.nextBatch(); b; b = await rs.nextBatch()) {
        if (b.table === 'rec') vs.push(...ipcToTable(b.ipc).getChild('v')!.toArray());
      }
      return vs;
    };
    expect(await rows(1)).toEqual(await rows(65_536));
  });
});
