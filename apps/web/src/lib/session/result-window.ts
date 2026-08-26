import type { QueryPage, QueryPageSummary } from '@byteql/db';
import { Table } from 'apache-arrow';

export const RESULT_WINDOW_ROWS = 16_384;

const loadedRows = (pages: readonly QueryPageSummary[]): number =>
  pages.reduce((maximum, page) => Math.max(maximum, page.startRow + page.rowCount), 0);

const windowRange = (
  pages: readonly QueryPageSummary[],
  anchorRow: number,
  maximumRows: number,
): { startRow: number; endRow: number } | null => {
  const totalRows = loadedRows(pages);
  const capacity = Number.isFinite(maximumRows)
    ? Math.min(RESULT_WINDOW_ROWS, Math.max(0, Math.floor(maximumRows)))
    : 0;
  if (totalRows === 0 || capacity === 0) return null;

  const anchor = Math.min(Math.max(0, Math.floor(anchorRow)), totalRows - 1);
  const rowCount = Math.min(capacity, totalRows);
  const startRow = Math.min(Math.max(0, anchor - Math.floor(rowCount / 2)), totalRows - rowCount);
  return { startRow, endRow: startRow + rowCount };
};

/** Returns stored pages that intersect the capped, anchor-centered global row window. */
export function pageIndexesForWindow(
  pages: readonly QueryPageSummary[],
  anchorRow: number,
  maximumRows = RESULT_WINDOW_ROWS,
): number[] {
  const range = windowRange(pages, anchorRow, maximumRows);
  if (range === null) return [];

  return [...pages]
    .sort((left, right) => left.startRow - right.startRow || left.index - right.index)
    .filter((page) => page.startRow < range.endRow && page.startRow + page.rowCount > range.startRow)
    .map((page) => page.index);
}

/**
 * Builds a bounded Arrow table for the requested global range. Page tables are sliced directly,
 * so rows retain Arrow representation instead of being materialized as JavaScript objects.
 */
export function assembleResultWindow(
  pages: readonly QueryPage[],
  range: { startRow: number; rowCount: number },
): { startRow: number; table: Table } {
  const ordered = [...pages].sort((left, right) => left.startRow - right.startRow);
  const totalRows = loadedRows(ordered);
  const startRow = Math.min(Math.max(0, Math.floor(range.startRow)), totalRows);
  const endRow = Math.min(
    startRow + Math.min(RESULT_WINDOW_ROWS, Math.max(0, Math.floor(range.rowCount))),
    totalRows,
  );
  const first = ordered[0];

  if (first === undefined) return { startRow, table: new Table() };

  const slices = ordered.flatMap((page) => {
    const pageEnd = page.startRow + page.rowCount;
    const sliceStart = Math.max(startRow, page.startRow);
    const sliceEnd = Math.min(endRow, pageEnd);
    return sliceStart >= sliceEnd
      ? []
      : [page.table.slice(sliceStart - page.startRow, sliceEnd - page.startRow)];
  });

  if (slices.length === 0) return { startRow, table: first.table.slice(0, 0) };
  const [head, ...tail] = slices;
  return { startRow, table: head!.concat(...tail) };
}
