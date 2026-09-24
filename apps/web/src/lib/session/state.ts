import type { PackQuery, ParseIssue, ParseResult, TableOverview } from '@byteql/core';
import type { ResultSort } from '@byteql/db';
import type { Schema, Table } from 'apache-arrow';

import { sameResultSchema } from './result-sort.js';
import { RESULT_WINDOW_ROWS } from './result-window.js';
import type { ExportState } from '../export/operation.js';

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

/** Serializable query-result metadata plus the bounded Arrow window rendered by the grid. */
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
  /**
   * How many committed order changes this result has published. Starts at 0 and increments only
   * when a new display order is adopted, so a window read against an older order can be recognised
   * and discarded even when its row count matches.
   */
  readonly orderRevision: number;
  /** The committed header sort, or null for the original query order. */
  readonly sort: ResultSort | null;
}

/** A sort or order-restoration in flight, from the request until it commits, fails or is cancelled. */
export interface ResultSortingState {
  readonly requestId: number;
  readonly queryGeneration: number;
  readonly fromRevision: number;
  /** The order being asked for; null means restoring the original query order. */
  readonly requestedSort: ResultSort | null;
  readonly phase: 'loading' | 'staging' | 'sorting' | 'storing' | 'cancelling' | 'failed';
  readonly rows: number;
  readonly totalRows: number | null;
  readonly message: string;
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
  result: PagedResultState | null;
  queryError: string | null;
  selectedRow: number | null;
  fatalError: string | null;
  /** Active hex-pane byte selection: display-name-qualified absolute offsets, end exclusive. */
  byteSelection: { file: string; start: number; end: number } | null;
  download: ExportState | null;
  sorting: ResultSortingState | null;
  /**
   * Whether `result` belongs to the CURRENT query. A previous result stays visible after a query
   * fails, but it is no longer current: it must not offer sorting or downloads, which would act on
   * a result family the session has already moved past.
   */
  resultIsCurrent: boolean;
  /**
   * How many query executions have settled — succeeded or failed — this session. It resets to 0
   * only when a file opens (the `'opening'` event replaces the whole state via
   * `initialSessionState`); within one open it only ever increases, and `phase` returning to
   * `'ready'` either way never resets it, so a caller that only holds a before/after snapshot
   * (e.g. e2e waiting for a run to finish) can detect "a new execution settled" without racing
   * `phase`'s transient `'querying'` value.
   */
  resultSettleCount: number;
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
  | { type: 'querySucceeded'; result: PagedResultState }
  | { type: 'queryWindowUpdated'; result: PagedResultState }
  | { type: 'queryPageFailed'; message: string; retryable: boolean }
  | { type: 'queryFailed'; message: string }
  | { type: 'rowSelected'; row: number | null }
  | { type: 'cancelled' }
  | { type: 'failed'; message: string }
  | { type: 'byteRangeSelected'; range: { file: string; start: number; end: number } | null }
  | { type: 'downloadUpdated'; generation: number; download: ExportState | null }
  | {
      type: 'resultSortUpdated';
      queryGeneration: number;
      requestId: number;
      sorting: ResultSortingState;
    }
  | { type: 'resultSortEnded'; queryGeneration: number; requestId: number }
  | { type: 'resultUnavailable'; queryGeneration: number }
  | {
      type: 'resultOrderCommitted';
      queryGeneration: number;
      requestId: number;
      fromRevision: number;
      result: PagedResultState;
    };

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
  queryError: null,
  selectedRow: null,
  fatalError: null,
  byteSelection: null,
  download: null,
  sorting: null,
  resultIsCurrent: false,
  resultSettleCount: 0,
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
  // Order identity as well as query identity: a window read under an older order can carry the
  // right row count and still describe entirely different rows.
  next.orderRevision === current.orderRevision &&
  next.loadedRows >= current.loadedRows &&
  (!current.complete || next.complete) &&
  isValidPagedWindow(next);

/** Whether a sort event belongs to the operation the session currently has in flight. */
const isCurrentSortRequest = (state: SessionState, queryGeneration: number, requestId: number): boolean =>
  state.result !== null &&
  state.resultIsCurrent &&
  state.result.generation === queryGeneration &&
  state.sorting !== null &&
  state.sorting.requestId === requestId;

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
        queryError: null,
        selectedRow: null,
        sorting: null,
        resultIsCurrent: false,
      };
    case 'querySucceeded':
      if (!isValidPagedWindow(event.result)) return state;
      return {
        ...state,
        phase: 'ready',
        result: { ...event.result, orderRevision: 0, sort: null },
        queryError: null,
        selectedRow: null,
        byteSelection: null,
        sorting: null,
        resultIsCurrent: true,
        resultSettleCount: state.resultSettleCount + 1,
      };
    case 'queryWindowUpdated':
      return state.result && isValidPagedUpdate(state.result, event.result)
        ? { ...state, result: event.result }
        : state;
    case 'queryPageFailed':
      return !state.result
        ? state
        : {
            ...state,
            result: {
              ...state.result,
              loadingMore: false,
              pageError: event.message,
              pageErrorRetryable: event.retryable,
            },
          };
    case 'queryFailed':
      // The previous result stays visible, but it is no longer current: acting on it would act on
      // a family the session has moved past.
      return {
        ...state,
        phase: 'ready',
        queryError: event.message,
        selectedRow: null,
        sorting: null,
        resultIsCurrent: false,
        resultSettleCount: state.resultSettleCount + 1,
      };
    case 'rowSelected':
      return state.result === null ? state : { ...state, selectedRow: event.row };
    case 'cancelled':
      return state.phase === 'querying'
        ? { ...state, phase: 'ready', queryError: null, sorting: null, resultIsCurrent: false }
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
        queryError: null,
        selectedRow: null,
        fatalError: event.message,
        byteSelection: null,
        sorting: null,
        resultIsCurrent: false,
      };
    case 'byteRangeSelected':
      return state.source === null ? state : { ...state, byteSelection: event.range };
    case 'downloadUpdated':
      if (event.download && event.download.generation !== event.generation) return state;
      if (state.download && state.download.generation !== event.generation) return state;
      return { ...state, download: event.download };
    case 'resultSortUpdated': {
      const current = state.result;
      if (!current || !state.resultIsCurrent || current.generation !== event.queryGeneration) {
        return state;
      }
      if (event.sorting.requestId !== event.requestId) return state;
      if (event.sorting.fromRevision !== current.orderRevision) return state;
      // Request ids only move forward. A newer request replaces an older one — including one that
      // failed — while a delayed start or progress report from an older request is ignored rather
      // than allowed to revive it.
      if (state.sorting && event.requestId < state.sorting.requestId) return state;
      return { ...state, sorting: event.sorting };
    }
    case 'resultSortEnded':
      return isCurrentSortRequest(state, event.queryGeneration, event.requestId)
        ? { ...state, sorting: null }
        : state;
    case 'resultUnavailable':
      // Generation-fenced: closing an OLD family must not invalidate a newer result.
      return state.result && state.result.generation === event.queryGeneration
        ? { ...state, resultIsCurrent: false, sorting: null }
        : state;
    case 'resultOrderCommitted': {
      const current = state.result;
      if (!current || !isCurrentSortRequest(state, event.queryGeneration, event.requestId)) return state;
      const next = event.result;
      const sort = next.sort;
      if (
        event.fromRevision !== current.orderRevision ||
        next.orderRevision !== current.orderRevision + 1 ||
        next.generation !== current.generation ||
        !sameResultSchema(next.schema, current.schema) ||
        !next.complete ||
        next.loadedRows !== current.loadedRows ||
        !isValidPagedWindow(next) ||
        (sort !== null &&
          (!Number.isSafeInteger(sort.columnIndex) ||
            sort.columnIndex < 0 ||
            sort.columnIndex >= current.schema.fields.length ||
            (sort.direction !== 'asc' && sort.direction !== 'desc')))
      ) {
        return state;
      }
      // A selected row means a position in the committed display, so a reorder invalidates it and
      // the byte range it revealed.
      return {
        ...state,
        result: { ...next, pageError: null, pageErrorRetryable: false },
        selectedRow: null,
        byteSelection: null,
        sorting: null,
      };
    }
  }
}
