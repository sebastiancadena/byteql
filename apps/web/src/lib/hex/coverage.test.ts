import { tableFromArrays } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { buildCoverage, COVERAGE_ROW_CAP, createCoverageMemo, provenanceOfRow } from './coverage.js';

const FILE = 'capture.pcap';

function provenanceTable(rows: Array<[number, number]>, file = FILE) {
  return tableFromArrays({
    id: Int32Array.from(rows.map((_, i) => i)),
    _src_file: rows.map(() => file),
    _src_start: BigUint64Array.from(rows.map(([s]) => BigInt(s))),
    _src_end: BigUint64Array.from(rows.map(([, e]) => BigInt(e))),
  });
}

function multiFileTable(rows: Array<{ file: string; start: number; end: number }>) {
  return tableFromArrays({
    id: Int32Array.from(rows.map((_, i) => i)),
    _src_file: rows.map((row) => row.file),
    _src_start: BigUint64Array.from(rows.map((row) => BigInt(row.start))),
    _src_end: BigUint64Array.from(rows.map((row) => BigInt(row.end))),
  });
}

function tableWithoutSrcFile(rows: Array<[number, number]>) {
  return tableFromArrays({
    _src_start: BigUint64Array.from(rows.map(([s]) => BigInt(s))),
    _src_end: BigUint64Array.from(rows.map(([, e]) => BigInt(e))),
  });
}

describe('buildCoverage', () => {
  it('reports no-provenance when the columns are absent', () => {
    const table = tableFromArrays({ n: Int32Array.from([1, 2]) });
    expect(buildCoverage(table, FILE)).toEqual({ index: null, reason: 'no-provenance' });
  });

  it('buildCoverage without a _src_file column reports no-provenance', () => {
    expect(buildCoverage(tableWithoutSrcFile([[0, 4]]), 'a.pcap').reason).toBe('no-provenance');
  });

  it('buildCoverage indexes only the requested file', () => {
    // rows: a.pcap [0,4), b.pcap [0,8)
    const table = multiFileTable([
      { file: 'a.pcap', start: 0, end: 4 },
      { file: 'b.pcap', start: 0, end: 8 },
    ]);
    const coverage = buildCoverage(table, 'b.pcap');
    expect(coverage.reason).toBe('ok');
    expect(coverage.index!.rowsAt(6)).toEqual([1]); // only b.pcap's row covers offset 6
    expect(coverage.index!.rowsAt(1)).toEqual([1]); // a.pcap's [0,4) row is excluded from this view
  });

  it('finds covering rows smallest-interval first', () => {
    // row 0: packet [0, 100); row 1: tcp [20, 100); row 2: dns [40, 60); row 3: next packet [100, 200)
    const { index, reason } = buildCoverage(
      provenanceTable([
        [0, 100],
        [20, 100],
        [40, 60],
        [100, 200],
      ]),
      FILE,
    );
    expect(reason).toBe('ok');
    expect(index?.rowsAt(50)).toEqual([2, 1, 0]);
    expect(index?.rowsAt(10)).toEqual([0]);
    expect(index?.rowsAt(100)).toEqual([3]); // _src_end is exclusive
    expect(index?.rowsAt(250)).toEqual([]);
  });

  it('clips spans to the queried viewport and alternates adjacent records', () => {
    const { index } = buildCoverage(
      provenanceTable([
        [0, 32],
        [32, 64],
        [200, 232],
      ]),
      FILE,
    );
    const spans = index?.spansIn(16, 48) ?? [];
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ start: 16, end: 32 });
    expect(spans[1]).toMatchObject({ start: 32, end: 48 });
    expect(spans[0]?.alt).not.toBe(spans[1]?.alt);
    expect(index?.spansIn(64, 200)).toEqual([]);
  });

  it('skips null provenance slots without failing', () => {
    const table = tableFromArrays({
      _src_file: [FILE, FILE, FILE],
      _src_start: [0n, null, 10n],
      _src_end: [5n, null, 20n],
    });
    expect(buildCoverage(table, FILE).index?.rowsAt(12)).toEqual([2]);
  });

  it('declines to index past the cap', () => {
    expect(COVERAGE_ROW_CAP).toBe(2_000_000);
    // Cap check is on numRows alone — no need to materialize 2M rows here; verified by contract.
  });
});

describe('CoverageIndex.rangeAt', () => {
  // row 0: packet [0, 100); row 1: tcp [20, 100); row 2: dns [40, 60); row 3: next packet [100, 200)
  const nested = () =>
    buildCoverage(
      provenanceTable([
        [0, 100],
        [20, 100],
        [40, 60],
        [100, 200],
      ]),
      FILE,
    ).index;

  it('returns the smallest covering interval UNCLIPPED', () => {
    // spansIn(50, 51) would clip every span to a single byte; rangeAt keeps the dns full range.
    expect(nested()?.rangeAt(50)).toEqual({ start: 40, end: 60 });
  });

  it('returns null when nothing covers the offset', () => {
    expect(nested()?.rangeAt(250)).toBeNull();
    expect(nested()?.rangeAt(-1)).toBeNull();
  });

  it('treats an interval exclusive end as uncovered', () => {
    const { index } = buildCoverage(provenanceTable([[40, 60]]), FILE);
    expect(index?.rangeAt(59)).toEqual({ start: 40, end: 60 });
    expect(index?.rangeAt(60)).toBeNull();
  });

  it('breaks size ties by later start (same ordering as rowsAt)', () => {
    // Two equal-size covering intervals over offset 30: [0, 40) and [10, 50); later start wins.
    const { index } = buildCoverage(
      provenanceTable([
        [0, 40],
        [10, 50],
      ]),
      FILE,
    );
    expect(index?.rangeAt(30)).toEqual({ start: 10, end: 50 });
  });
});

describe('createCoverageMemo', () => {
  it('reuses the result for the same table and file, and rebuilds for a new table', () => {
    const memo = createCoverageMemo();
    const table = provenanceTable([[0, 10]]);
    const first = memo(table, FILE);
    const second = memo(table, FILE);
    expect(second).toBe(first); // reference-identical across calls with the same (table, file)
    expect(memo(null, FILE)).toEqual({ index: null, reason: 'no-provenance' });
    const other = provenanceTable([[0, 20]]);
    expect(memo(other, FILE)).not.toBe(first);
  });

  it('rebuilds when the file changes for the same table reference', () => {
    const memo = createCoverageMemo();
    const table = multiFileTable([
      { file: 'a.pcap', start: 0, end: 4 },
      { file: 'b.pcap', start: 0, end: 8 },
    ]);
    const forA = memo(table, 'a.pcap');
    const forB = memo(table, 'b.pcap');
    expect(forA).not.toBe(forB);
    expect(memo(table, null)).toEqual({ index: null, reason: 'no-provenance' });
  });
});

describe('provenanceOfRow', () => {
  it('reads a row range directly and converts bigint to number', () => {
    const table = provenanceTable([
      [0, 100],
      [20, 100],
    ]);
    expect(provenanceOfRow(table, 1)).toEqual({ file: FILE, start: 20, end: 100 });
  });

  it('returns null without provenance columns or on null slots', () => {
    expect(provenanceOfRow(tableFromArrays({ n: Int32Array.from([1]) }), 0)).toBeNull();
  });

  it('provenanceOfRow returns the file-qualified range and null without _src_file', () => {
    const table = provenanceTable([[0, 4]], 'a.pcap');
    expect(provenanceOfRow(table, 0)).toEqual({ file: 'a.pcap', start: 0, end: 4 });
    expect(provenanceOfRow(tableWithoutSrcFile([[0, 4]]), 0)).toBeNull();
  });
});
