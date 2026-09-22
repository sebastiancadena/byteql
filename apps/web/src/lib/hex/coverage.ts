import { isSourceRangesType, resultColumnIndex, resultColumnLabel } from '@byteql/db/result-columns';
import type { Table, Vector } from 'apache-arrow';

export const COVERAGE_INTERVAL_CAP = 2_000_000;

export interface ByteSpan {
  start: number;
  end: number;
  alt: boolean;
}

export interface CoverageIndex {
  rowCount: number;
  intervalCount: number;
  rowsAt(offset: number): number[];
  /** Smallest UNCLIPPED interval covering `offset` (ties: later start), or null. */
  rangeAt(offset: number): { start: number; end: number } | null;
  spansIn(start: number, end: number): ByteSpan[];
}

export type CoverageReason = 'ok' | 'no-provenance' | 'ambiguous-provenance' | 'too-large';

export interface CoverageResult {
  index: CoverageIndex | null;
  reason: CoverageReason;
}

const toRange = (start: unknown, end: unknown): { start: number; end: number } | null => {
  if (start === null || start === undefined || end === null || end === undefined) return null;
  return { start: Number(start), end: Number(end) };
};

type ProvenanceColumnsResult =
  | {
      columns: readonly [file: Vector, start: Vector, end: Vector, ranges: Vector | null];
      reason: null;
    }
  | {
      columns: null;
      reason: 'no-provenance' | 'ambiguous-provenance';
    };

function provenanceColumns(table: Table): ProvenanceColumnsResult {
  const labels = table.schema.fields.map(resultColumnLabel);
  if (
    ['_src_file', '_src_start', '_src_end', '_src_ranges'].some(
      (required) => labels.filter((label) => label === required).length > 1,
    )
  ) {
    return { columns: null, reason: 'ambiguous-provenance' };
  }

  const fileIndex = resultColumnIndex(table.schema, '_src_file');
  const startIndex = resultColumnIndex(table.schema, '_src_start');
  const endIndex = resultColumnIndex(table.schema, '_src_end');
  if (fileIndex === null || startIndex === null || endIndex === null) {
    return { columns: null, reason: 'no-provenance' };
  }
  const fileColumn = table.getChildAt(fileIndex);
  const startColumn = table.getChildAt(startIndex);
  const endColumn = table.getChildAt(endIndex);
  if (!fileColumn || !startColumn || !endColumn) {
    return { columns: null, reason: 'no-provenance' };
  }

  const rangesIndex = resultColumnIndex(table.schema, '_src_ranges');
  const rangesField = rangesIndex === null ? null : table.schema.fields[rangesIndex];
  const rangesColumn =
    rangesField && isSourceRangesType(rangesField.type) ? (table.getChildAt(rangesIndex!) ?? null) : null;

  return { columns: [fileColumn, startColumn, endColumn, rangesColumn], reason: null };
}

type Piece = { start: number; end: number };

/** A row's exact pieces: the `_src_ranges` list when present, else its single range. */
function piecesOf(ranges: Vector | null, row: number, fallback: Piece): Piece[] {
  const value = ranges?.get(row) as Iterable<{ start: bigint; end: bigint }> | null | undefined;
  if (!value) return [fallback];
  return Array.from(value, (piece) => ({ start: Number(piece.start), end: Number(piece.end) }));
}

export interface RowProvenance {
  file: string;
  start: number;
  end: number;
  ranges: readonly Piece[];
}

export function provenanceOfRow(table: Table, row: number): RowProvenance | null {
  const resolved = provenanceColumns(table);
  if (!resolved.columns) return null;
  const [fileColumn, startColumn, endColumn, rangesColumn] = resolved.columns;
  const file = fileColumn.get(row);
  const range = toRange(startColumn.get(row), endColumn.get(row));
  if (typeof file !== 'string' || !range) return null;
  return { file, ...range, ranges: piecesOf(rangesColumn, row, range) };
}

/** First index in `starts[0..count)` whose value is > probe. */
function upperBound(starts: Float64Array, count: number, probe: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((starts[mid] as number) <= probe) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function buildCoverage(table: Table, file: string, rowOffset = 0): CoverageResult {
  const resolved = provenanceColumns(table);
  if (!resolved.columns) return { index: null, reason: resolved.reason };
  const [fileColumn, startColumn, endColumn, rangesColumn] = resolved.columns;

  let capacity = table.numRows;
  let rawStarts = new Float64Array(capacity);
  let rawEnds = new Float64Array(capacity);
  let rawRows = new Float64Array(capacity);
  let rawOrdinal = new Float64Array(capacity);

  const grow = (): void => {
    capacity = capacity === 0 ? 1 : capacity * 2;
    const nextStarts = new Float64Array(capacity);
    const nextEnds = new Float64Array(capacity);
    const nextRows = new Float64Array(capacity);
    const nextOrdinal = new Float64Array(capacity);
    nextStarts.set(rawStarts);
    nextEnds.set(rawEnds);
    nextRows.set(rawRows);
    nextOrdinal.set(rawOrdinal);
    rawStarts = nextStarts;
    rawEnds = nextEnds;
    rawRows = nextRows;
    rawOrdinal = nextOrdinal;
  };

  let count = 0;
  let rowCount = 0;
  for (let row = 0; row < table.numRows; row += 1) {
    if (fileColumn.get(row) !== file) continue;
    const range = toRange(startColumn.get(row), endColumn.get(row));
    if (!range) continue;
    const pieces = piecesOf(rangesColumn, row, range);
    let indexedThisRow = false;
    for (const piece of pieces) {
      if (piece.end <= piece.start) continue;
      if (count >= capacity) grow();
      rawStarts[count] = piece.start;
      rawEnds[count] = piece.end;
      rawRows[count] = row + rowOffset;
      rawOrdinal[count] = rowCount;
      count += 1;
      indexedThisRow = true;
      if (count > COVERAGE_INTERVAL_CAP) return { index: null, reason: 'too-large' };
    }
    if (indexedThisRow) rowCount += 1;
  }

  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => {
    const byStart = (rawStarts[a] as number) - (rawStarts[b] as number);
    return byStart !== 0 ? byStart : (rawEnds[b] as number) - (rawEnds[a] as number);
  });
  const starts = new Float64Array(count);
  const ends = new Float64Array(count);
  const rows = new Float64Array(count);
  const ordinals = new Float64Array(count);
  const maxEndPrefix = new Float64Array(count);
  order.forEach((source, i) => {
    starts[i] = rawStarts[source] as number;
    ends[i] = rawEnds[source] as number;
    rows[i] = rawRows[source] as number;
    ordinals[i] = rawOrdinal[source] as number;
    maxEndPrefix[i] =
      i === 0 ? (ends[i] as number) : Math.max(maxEndPrefix[i - 1] as number, ends[i] as number);
  });

  const index: CoverageIndex = {
    rowCount,
    intervalCount: count,
    rowsAt(offset) {
      const matches: number[] = [];
      for (let i = upperBound(starts, count, offset) - 1; i >= 0; i -= 1) {
        if ((maxEndPrefix[i] as number) <= offset) break;
        if ((ends[i] as number) > offset) matches.push(i);
      }
      matches.sort((a, b) => {
        const bySize =
          (ends[a] as number) - (starts[a] as number) - ((ends[b] as number) - (starts[b] as number));
        return bySize !== 0 ? bySize : (starts[b] as number) - (starts[a] as number);
      });
      return matches.map((i) => rows[i] as number);
    },
    rangeAt(offset) {
      let best = -1;
      for (let i = upperBound(starts, count, offset) - 1; i >= 0; i -= 1) {
        if ((maxEndPrefix[i] as number) <= offset) break;
        if ((ends[i] as number) <= offset) continue;
        if (best === -1) {
          best = i;
          continue;
        }
        const size = (ends[i] as number) - (starts[i] as number);
        const bestSize = (ends[best] as number) - (starts[best] as number);
        // Smaller interval wins; on a size tie the later start wins. Descending `i`
        // visits larger starts first, so a strict `<` keeps the later-start winner.
        if (size < bestSize) best = i;
      }
      if (best === -1) return null;
      return { start: starts[best] as number, end: ends[best] as number };
    },
    spansIn(start, end) {
      const spans: ByteSpan[] = [];
      for (let i = upperBound(starts, count, end - 1) - 1; i >= 0; i -= 1) {
        if ((maxEndPrefix[i] as number) <= start) break;
        if ((ends[i] as number) > start) {
          spans.push({
            start: Math.max(starts[i] as number, start),
            end: Math.min(ends[i] as number, end),
            alt: ((ordinals[i] as number) & 1) === 1,
          });
        }
      }
      return spans.reverse();
    },
  };
  return { index, reason: 'ok' };
}

/**
 * Builds a `buildCoverage` wrapper that memoizes on the (table, file) pair, so
 * repeated session publishes carrying the SAME result and file do not re-index (spec: once
 * per result). Returns a stable `CoverageResult` for an unchanged (table, file) pair.
 */
export function createCoverageMemo(): (
  table: Table | null,
  file: string | null,
  rowOffset?: number,
) => CoverageResult {
  let cache: { table: Table; file: string; rowOffset: number; value: CoverageResult } | null = null;
  return (table, file, rowOffset = 0) => {
    if (!table || file === null) return { index: null, reason: 'no-provenance' };
    if (cache && cache.table === table && cache.file === file && cache.rowOffset === rowOffset) {
      return cache.value;
    }
    const value = buildCoverage(table, file, rowOffset);
    cache = { table, file, rowOffset, value };
    return value;
  };
}
