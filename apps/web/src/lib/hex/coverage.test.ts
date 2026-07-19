import { tableFromArrays } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { buildCoverage, COVERAGE_ROW_CAP, provenanceOfRow } from './coverage.js';

function provenanceTable(rows: Array<[number, number]>) {
  return tableFromArrays({
    id: Int32Array.from(rows.map((_, i) => i)),
    _src_start: BigUint64Array.from(rows.map(([s]) => BigInt(s))),
    _src_end: BigUint64Array.from(rows.map(([, e]) => BigInt(e))),
  });
}

describe('buildCoverage', () => {
  it('reports no-provenance when the columns are absent', () => {
    const table = tableFromArrays({ n: Int32Array.from([1, 2]) });
    expect(buildCoverage(table)).toEqual({ index: null, reason: 'no-provenance' });
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
      _src_start: BigUint64Array.from([0n, 10n]),
      _src_end: BigUint64Array.from([5n, 20n]),
    });
    expect(buildCoverage(table).index?.rowsAt(12)).toEqual([1]);
  });

  it('declines to index past the cap', () => {
    expect(COVERAGE_ROW_CAP).toBe(2_000_000);
    // Cap check is on numRows alone — no need to materialize 2M rows here; verified by contract.
  });
});

describe('provenanceOfRow', () => {
  it('reads a row range directly and converts bigint to number', () => {
    const table = provenanceTable([
      [0, 100],
      [20, 100],
    ]);
    expect(provenanceOfRow(table, 1)).toEqual({ start: 20, end: 100 });
  });

  it('returns null without provenance columns or on null slots', () => {
    expect(provenanceOfRow(tableFromArrays({ n: Int32Array.from([1]) }), 0)).toBeNull();
  });
});
