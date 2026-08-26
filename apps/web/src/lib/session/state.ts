import type { PackQuery, ParseIssue, ParseResult, TableOverview } from '@byteql/core';
import type { Schema, Table } from 'apache-arrow';

import { RESULT_WINDOW_ROWS } from './result-window.js';

export type SessionPhase =
  'idle' | 'opening' | 'normalizing' | 'parsing' | 'projecting' | 'ready' | 'querying' | 'failed';

export interface SourceFile {
  name: string;
  size: number;
}

export interface SessionProgress {
  completed: number;
  total: number | null;
  label: string;
  /** Cumulative bytes ingested (streamed batch IPC) so far this open, for a throughput readout. */
  bytes: number;
  /** 1-based position of the file currently being ingested, and the batch's ok-file count. */
  fileIndex: number;
  fileCount: number;
}

/**
 * The query result shape consumed by the paged controller/grid migration. It coexists with the
 * legacy `result` table temporarily, until both existing consumers can move atomically.
 */
export interface PagedResultState {
  readonly generation: number;
  readonly schema: Schema;
  readonly loadedRows: number;
  readonly complete: boolean;
  readonly loadingMore: boolean;
  readonly windowStart: number;
  readonly window: Table;
  /** Complete result for trusted viewers, or null while incomplete/above the 64 MiB budget. */
  readonly completeTable: Table | null;
  readonly elapsedMs: number;
  readonly pageError: string | null;
  readonly pageErrorRetryable: boolean;
}

export interface SessionState {
  phase: SessionPhase;
  source: { files: readonly SourceFile[]; totalSize: number } | null;
  format: { id: string; title: string } | null;
  progress: SessionProgress | null;
  /**
   * Wall-clock start time (ms, `Date.now()`) of the current open — paired with `progress.bytes`
   * to compute a throughput rate. Set on `opening`, kept through `progress`, cleared on
   * `ready`/`failed`/`cancelled`.
   */
  openStartedAt: number | null;
  tables: readonly TableOverview[];
  issues: readonly ParseIssue[];
  queries: readonly PackQuery[];
  capabilities: ParseResult['capabilities'] | null;
  sql: string;
  /** @deprecated Legacy whole-result table retained until the controller/grid migration. */
  result: Table | null;
  /** Additive paged result contract for the upcoming controller/grid migration. */
  pagedResult?: PagedResultState | null;
  /** @deprecated Legacy timing retained until the controller/grid migration. */
  queryElapsedMs: number | null;
  queryError: string | null;
  selectedRow: number | null;
  fatalError: string | null;
  /** Active hex-pane byte selection: display-name-qualified absolute offsets, end exclusive. */
  byteSelection: { file: string; start: number; end: number } | null;
}

export type SessionEvent =
  | { type: 'opening'; source: { files: readonly SourceFile[]; totalSize: number } }
  | {
      type: 'progress';
      stage: 'normalizing' | 'parsing' | 'projecting';
      completed: number;
      total: number | null;
      label: string;
      bytes: number;
      fileIndex: number;
      fileCount: number;
    }
  | {
      type: 'ready';
      format: { id: string; title: string };
      files: readonly SourceFile[];
      tables: readonly TableOverview[];
      issues: readonly ParseIssue[];
      queries: readonly PackQuery[];
      capabilities: ParseResult['capabilities'];
    }
  | { type: 'queryStarted'; sql: string }
  | { type: 'querySucceeded'; result: Table; elapsedMs: number }
  | { type: 'querySucceeded'; result: PagedResultState }
  | { type: 'queryWindowUpdated'; result: PagedResultState }
  | { type: 'queryPageFailed'; message: string; retryable: boolean }
  | { type: 'queryFailed'; message: string }
  | { type: 'rowSelected'; row: number | null }
  | { type: 'cancelled' }
  | { type: 'failed'; message: string }
  | { type: 'byteRangeSelected'; range: { file: string; start: number; end: number } | null };

export const initialSessionState: SessionState = {
  phase: 'idle',
  source: null,
  format: null,
  progress: null,
  openStartedAt: null,
  tables: [],
  issues: [],
  queries: [],
  capabilities: null,
  sql: '',
  result: null,
  pagedResult: null,
  queryElapsedMs: null,
  queryError: null,
  selectedRow: null,
  fatalError: null,
  byteSelection: null,
};

const isValidPagedWindow = (result: PagedResultState): boolean =>
  Number.isSafeInteger(result.loadedRows) &&
  result.loadedRows >= 0 &&
  Number.isSafeInteger(result.windowStart) &&
  result.windowStart >= 0 &&
  result.window.numRows <= RESULT_WINDOW_ROWS &&
  result.windowStart + result.window.numRows <= result.loadedRows;

const isValidPagedUpdate = (current: PagedResultState, next: PagedResultState): boolean =>
  next.generation === current.generation &&
  next.loadedRows >= current.loadedRows &&
  (!current.complete || next.complete) &&
  isValidPagedWindow(next);

export function reduceSession(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'opening':
      return { ...initialSessionState, phase: 'opening', source: event.source, openStartedAt: Date.now() };
    case 'progress':
      return {
        ...state,
        phase: event.stage,
        progress: {
          completed: event.completed,
          total: event.total,
          label: event.label,
          bytes: event.bytes,
          fileIndex: event.fileIndex,
          fileCount: event.fileCount,
        },
        fatalError: null,
      };
    case 'ready':
      return {
        ...state,
        phase: 'ready',
        format: event.format,
        source: {
          files: event.files,
          totalSize: event.files.reduce((sum, file) => sum + file.size, 0),
        },
        tables: event.tables,
        issues: event.issues,
        queries: event.queries,
        capabilities: event.capabilities,
        progress: null,
        openStartedAt: null,
        fatalError: null,
      };
    case 'queryStarted':
      return {
        ...state,
        phase: 'querying',
        sql: event.sql,
        queryElapsedMs: null,
        queryError: null,
        selectedRow: null,
      };
    case 'querySucceeded':
      if ('elapsedMs' in event) {
        return {
          ...state,
          phase: 'ready',
          result: event.result,
          queryElapsedMs: event.elapsedMs,
          queryError: null,
          selectedRow: null,
          byteSelection: null,
        };
      }
      return {
        ...state,
        phase: 'ready',
        pagedResult: event.result,
        queryError: null,
        selectedRow: null,
        byteSelection: null,
      };
    case 'queryWindowUpdated':
      return state.pagedResult && isValidPagedUpdate(state.pagedResult, event.result)
        ? { ...state, pagedResult: event.result }
        : state;
    case 'queryPageFailed':
      return !state.pagedResult
        ? state
        : {
            ...state,
            pagedResult: {
              ...state.pagedResult,
              loadingMore: false,
              pageError: event.message,
              pageErrorRetryable: event.retryable,
            },
          };
    case 'queryFailed':
      return {
        ...state,
        phase: 'ready',
        queryElapsedMs: null,
        queryError: event.message,
        selectedRow: null,
      };
    case 'rowSelected':
      return state.result === null && !state.pagedResult ? state : { ...state, selectedRow: event.row };
    case 'cancelled':
      return state.phase === 'querying'
        ? { ...state, phase: 'ready', queryElapsedMs: null, queryError: null }
        : initialSessionState;
    case 'failed':
      return {
        ...state,
        phase: 'failed',
        progress: null,
        openStartedAt: null,
        tables: [],
        issues: [],
        queries: [],
        capabilities: null,
        result: null,
        pagedResult: null,
        queryElapsedMs: null,
        queryError: null,
        selectedRow: null,
        fatalError: event.message,
        byteSelection: null,
      };
    case 'byteRangeSelected':
      return state.source === null ? state : { ...state, byteSelection: event.range };
  }
}
