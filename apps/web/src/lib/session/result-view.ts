import type { QueryPage, QueryResultView } from '@byteql/db';
import { Table, type Schema } from 'apache-arrow';

import { RESULT_WINDOW_ROWS, assembleResultWindow, pageIndexesForWindow } from './result-window.js';

export interface ResultWindow {
  readonly schema: Schema;
  readonly loadedRows: number;
  readonly complete: boolean;
  readonly elapsedMs: number;
  readonly windowStart: number;
  readonly window: Table;
}

/**
 * Reads one bounded, anchor-centred window from any result view — the original cursor-backed
 * result or a sorted one.
 *
 * It reads only the pages the window intersects and holds no result-wide table. It performs no
 * identity checks of its own: the caller captured which view and which committed order it asked
 * for, and only the caller can decide whether that is still the right answer once this resolves.
 */
export async function readResultWindow(view: QueryResultView, anchorRow: number): Promise<ResultWindow> {
  const status = view.status();
  const summaries = view.pages();
  const indexes = pageIndexesForWindow(summaries, anchorRow);
  view.pinPages(indexes);

  const pages: QueryPage[] = [];
  for (const index of indexes) pages.push(await view.readPage(index));

  const rowCount = Math.min(RESULT_WINDOW_ROWS, status.loadedRows);
  const normalizedAnchor =
    status.loadedRows === 0 ? 0 : Math.min(Math.max(0, Math.floor(anchorRow)), status.loadedRows - 1);
  const windowStart = Math.min(
    Math.max(0, normalizedAnchor - Math.floor(rowCount / 2)),
    Math.max(0, status.loadedRows - rowCount),
  );

  return {
    schema: view.schema,
    loadedRows: status.loadedRows,
    complete: status.complete,
    elapsedMs: status.elapsedMs,
    windowStart,
    window:
      pages.length === 0
        ? new Table(view.schema)
        : assembleResultWindow(pages, { startRow: windowStart, rowCount }).table,
  };
}
