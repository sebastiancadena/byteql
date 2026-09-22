import { Field, List, Struct, Table, Uint64, tableFromArrays, vectorFromArray } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { withResultLabels } from '../../test-support/result-columns.js';
import { buildCoverage, COVERAGE_INTERVAL_CAP, createCoverageMemo, provenanceOfRow } from './coverage.js';

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

function canonicalProvenanceTable(duplicateLabel?: '_src_file' | '_src_start' | '_src_end') {
  const duplicateValue =
    duplicateLabel === '_src_file'
      ? ['other.pcap']
      : duplicateLabel === '_src_start'
        ? BigUint64Array.from([12n])
        : BigUint64Array.from([24n]);
  return withResultLabels(
    tableFromArrays({
      c0: Int32Array.from([7]),
      c1: ['left'],
      c2: ['right'],
      c3: [FILE],
      c4: BigUint64Array.from([12n]),
      c5: BigUint64Array.from([24n]),
      ...(duplicateLabel ? { c6: duplicateValue } : {}),
    }),
    ['id', 'dup', 'dup', '_src_file', '_src_start', '_src_end', ...(duplicateLabel ? [duplicateLabel] : [])],
  );
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

  it('uses unique logical source labels while ignoring unrelated repeated labels', () => {
    const table = canonicalProvenanceTable();

    expect(provenanceOfRow(table, 0)).toEqual({
      file: FILE,
      start: 12,
      end: 24,
      ranges: [{ start: 12, end: 24 }],
    });
    expect(buildCoverage(table, FILE).index?.rowsAt(16)).toEqual([0]);
  });

  it.each(['_src_file', '_src_start', '_src_end'] as const)(
    'refuses ambiguous %s source labels',
    (duplicateLabel) => {
      const table = canonicalProvenanceTable(duplicateLabel);

      expect(provenanceOfRow(table, 0)).toBeNull();
      expect(buildCoverage(table, FILE)).toEqual({ index: null, reason: 'ambiguous-provenance' });
    },
  );

  it('adds the render-window start to returned coverage row indexes', () => {
    const coverage = buildCoverage(
      provenanceTable([
        [0, 4],
        [4, 8],
      ]),
      FILE,
      20_000,
    );

    expect(coverage.index?.rowsAt(6)).toEqual([20_001]);
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
    expect(COVERAGE_INTERVAL_CAP).toBe(2_000_000);
    // Exact rows contribute one interval each, so a row-count-over-cap table is a valid
    // interval-count-over-cap fixture — no need to materialize ranged pieces here.
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
    const first = memo(table, FILE, 20_000);
    const second = memo(table, FILE, 20_000);
    expect(second).toBe(first); // reference-identical across calls with the same (table, file)
    expect(memo(null, FILE)).toEqual({ index: null, reason: 'no-provenance' });
    const other = provenanceTable([[0, 20]]);
    expect(memo(other, FILE, 20_000)).not.toBe(first);
    expect(memo(table, FILE, 30_000)).not.toBe(first);
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
    expect(provenanceOfRow(table, 1)).toEqual({
      file: FILE,
      start: 20,
      end: 100,
      ranges: [{ start: 20, end: 100 }],
    });
  });

  it('returns null without provenance columns or on null slots', () => {
    expect(provenanceOfRow(tableFromArrays({ n: Int32Array.from([1]) }), 0)).toBeNull();
  });

  it('provenanceOfRow returns the file-qualified range and null without _src_file', () => {
    const table = provenanceTable([[0, 4]], 'a.pcap');
    expect(provenanceOfRow(table, 0)).toEqual({
      file: 'a.pcap',
      start: 0,
      end: 4,
      ranges: [{ start: 0, end: 4 }],
    });
    expect(provenanceOfRow(tableWithoutSrcFile([[0, 4]]), 0)).toBeNull();
  });
});

const RANGES_TYPE = new List(
  new Field(
    'item',
    new Struct([new Field('start', new Uint64(), true), new Field('end', new Uint64(), true)]),
    true,
  ),
);

function rangesTable(
  rows: Array<{ start: number; end: number; ranges: Array<[number, number]> | null; file?: string }>,
) {
  const base = tableFromArrays({
    id: Int32Array.from(rows.map((_, i) => i)),
    _src_file: rows.map((row) => row.file ?? FILE),
    _src_start: BigUint64Array.from(rows.map((row) => BigInt(row.start))),
    _src_end: BigUint64Array.from(rows.map((row) => BigInt(row.end))),
  });
  const ranges = vectorFromArray(
    rows.map((row) => row.ranges?.map(([s, e]) => ({ start: BigInt(s), end: BigInt(e) })) ?? null),
    RANGES_TYPE,
  );
  return base.assign(new Table({ _src_ranges: ranges }));
}

describe('source ranges', () => {
  // Row 0: message with pieces [10,20) and [50,60), bounding [10,60).
  // Row 1: an unrelated packet [30,45) sitting inside the gap.
  const table = rangesTable([
    {
      start: 10,
      end: 60,
      ranges: [
        [10, 20],
        [50, 60],
      ],
    },
    { start: 30, end: 45, ranges: null },
  ]);

  it('returns every piece from provenanceOfRow, and a single piece for exact rows', () => {
    expect(provenanceOfRow(table, 0)).toEqual({
      file: FILE,
      start: 10,
      end: 60,
      ranges: [
        { start: 10, end: 20 },
        { start: 50, end: 60 },
      ],
    });
    expect(provenanceOfRow(table, 1)!.ranges).toEqual([{ start: 30, end: 45 }]);
  });

  it('does not match the message on a gap byte', () => {
    const { index } = buildCoverage(table, FILE);
    expect(index!.rowsAt(35)).toEqual([1]);
    expect(index!.rowsAt(25)).toEqual([]);
    expect(index!.rowsAt(55)).toEqual([0]);
  });

  it('returns the covering piece from rangeAt', () => {
    const { index } = buildCoverage(table, FILE);
    expect(index!.rangeAt(52)).toEqual({ start: 50, end: 60 });
  });

  it("shades a message's pieces with the same alternation", () => {
    const { index } = buildCoverage(table, FILE);
    const spans = index!.spansIn(0, 100);
    const messageSpans = spans.filter((span) => span.start === 10 || span.start === 50);
    expect(new Set(messageSpans.map((span) => span.alt)).size).toBe(1);
    expect(index!.intervalCount).toBe(3);
  });

  it("indexes pieces only for the row's own file", () => {
    const multi = rangesTable([
      {
        start: 10,
        end: 60,
        ranges: [
          [10, 20],
          [50, 60],
        ],
        file: 'a.pcap',
      },
      { start: 10, end: 60, ranges: null, file: 'b.pcap' },
    ]);
    expect(buildCoverage(multi, 'b.pcap').index!.rowsAt(30)).toEqual([1]);
    expect(buildCoverage(multi, 'a.pcap').index!.rowsAt(30)).toEqual([]);
  });

  it('treats a result without _src_ranges as single-range', () => {
    const plain = provenanceTable([[10, 60]]);
    expect(provenanceOfRow(plain, 0)!.ranges).toEqual([{ start: 10, end: 60 }]);
    expect(buildCoverage(plain, FILE).index!.rowsAt(30)).toEqual([0]);
  });

  it('ignores a same-named column of another type', () => {
    const impostor = provenanceTable([[10, 60]]).assign(tableFromArrays({ _src_ranges: ['10-20;50-60'] }));
    expect(provenanceOfRow(impostor, 0)!.ranges).toEqual([{ start: 10, end: 60 }]);
  });

  it('reports ambiguity when _src_ranges is repeated', () => {
    const doubled = withResultLabels(table.assign(new Table({ dup: table.getChild('_src_ranges')! })), [
      'id',
      '_src_file',
      '_src_start',
      '_src_end',
      '_src_ranges',
      '_src_ranges',
    ]);
    expect(buildCoverage(doubled, FILE).reason).toBe('ambiguous-provenance');
  });
});
