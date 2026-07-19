import type { Table } from 'apache-arrow';

export const COVERAGE_ROW_CAP = 2_000_000;

export interface ByteSpan {
  start: number;
  end: number;
  alt: boolean;
}

export interface CoverageIndex {
  rowCount: number;
  rowsAt(offset: number): number[];
  spansIn(start: number, end: number): ByteSpan[];
}

export type CoverageReason = 'ok' | 'no-provenance' | 'too-large';

export interface CoverageResult {
  index: CoverageIndex | null;
  reason: CoverageReason;
}

const toRange = (start: unknown, end: unknown): { start: number; end: number } | null => {
  if (start === null || start === undefined || end === null || end === undefined) return null;
  return { start: Number(start), end: Number(end) };
};

export function provenanceOfRow(table: Table, row: number): { start: number; end: number } | null {
  const startColumn = table.getChild('_src_start');
  const endColumn = table.getChild('_src_end');
  if (!startColumn || !endColumn) return null;
  return toRange(startColumn.get(row), endColumn.get(row));
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

export function buildCoverage(table: Table): CoverageResult {
  const startColumn = table.getChild('_src_start');
  const endColumn = table.getChild('_src_end');
  if (!startColumn || !endColumn) return { index: null, reason: 'no-provenance' };
  if (table.numRows > COVERAGE_ROW_CAP) return { index: null, reason: 'too-large' };

  const capacity = table.numRows;
  const rawStarts = new Float64Array(capacity);
  const rawEnds = new Float64Array(capacity);
  const rawRows = new Uint32Array(capacity);
  let count = 0;
  for (let row = 0; row < capacity; row += 1) {
    const range = toRange(startColumn.get(row), endColumn.get(row));
    if (!range || range.end <= range.start) continue;
    rawStarts[count] = range.start;
    rawEnds[count] = range.end;
    rawRows[count] = row;
    count += 1;
  }

  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => {
    const byStart = (rawStarts[a] as number) - (rawStarts[b] as number);
    return byStart !== 0 ? byStart : (rawEnds[b] as number) - (rawEnds[a] as number);
  });
  const starts = new Float64Array(count);
  const ends = new Float64Array(count);
  const rows = new Uint32Array(count);
  const maxEndPrefix = new Float64Array(count);
  order.forEach((source, i) => {
    starts[i] = rawStarts[source] as number;
    ends[i] = rawEnds[source] as number;
    rows[i] = rawRows[source] as number;
    maxEndPrefix[i] =
      i === 0 ? (ends[i] as number) : Math.max(maxEndPrefix[i - 1] as number, ends[i] as number);
  });

  const index: CoverageIndex = {
    rowCount: count,
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
    spansIn(start, end) {
      const spans: ByteSpan[] = [];
      for (let i = upperBound(starts, count, end - 1) - 1; i >= 0; i -= 1) {
        if ((maxEndPrefix[i] as number) <= start) break;
        if ((ends[i] as number) > start) {
          spans.push({
            start: Math.max(starts[i] as number, start),
            end: Math.min(ends[i] as number, end),
            alt: (i & 1) === 1,
          });
        }
      }
      return spans.reverse();
    },
  };
  return { index, reason: 'ok' };
}
