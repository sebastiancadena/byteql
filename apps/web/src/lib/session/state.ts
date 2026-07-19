import type { PackQuery, ParseIssue, ParseResult, TableOverview } from '@byteql/core';
import type { Table } from 'apache-arrow';

export type SessionPhase =
  'idle' | 'opening' | 'normalizing' | 'parsing' | 'projecting' | 'ready' | 'querying' | 'failed';

export interface SessionProgress {
  completed: number;
  total: number | null;
  label: string;
  /** Cumulative bytes ingested (streamed batch IPC) so far this open, for a throughput readout. */
  bytes: number;
}

export interface SessionState {
  phase: SessionPhase;
  source: { name: string; size: number } | null;
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
  result: Table | null;
  queryElapsedMs: number | null;
  queryError: string | null;
  selectedRow: number | null;
  fatalError: string | null;
  /** Active hex-pane byte selection: absolute file offsets, end exclusive. */
  byteSelection: { start: number; end: number } | null;
}

export type SessionEvent =
  | { type: 'opening'; source: { name: string; size: number } }
  | {
      type: 'progress';
      stage: 'normalizing' | 'parsing' | 'projecting';
      completed: number;
      total: number | null;
      label: string;
      bytes: number;
    }
  | {
      type: 'ready';
      format: { id: string; title: string };
      tables: readonly TableOverview[];
      issues: readonly ParseIssue[];
      queries: readonly PackQuery[];
      capabilities: ParseResult['capabilities'];
    }
  | { type: 'queryStarted'; sql: string }
  | { type: 'querySucceeded'; result: Table; elapsedMs: number }
  | { type: 'queryFailed'; message: string }
  | { type: 'rowSelected'; row: number | null }
  | { type: 'cancelled' }
  | { type: 'failed'; message: string }
  | { type: 'byteRangeSelected'; range: { start: number; end: number } | null };

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
  queryElapsedMs: null,
  queryError: null,
  selectedRow: null,
  fatalError: null,
  byteSelection: null,
};

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
        },
        fatalError: null,
      };
    case 'ready':
      return {
        ...state,
        phase: 'ready',
        format: event.format,
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
      return {
        ...state,
        phase: 'ready',
        result: event.result,
        queryElapsedMs: event.elapsedMs,
        queryError: null,
        selectedRow: null,
        byteSelection: null,
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
      return state.result === null ? state : { ...state, selectedRow: event.row };
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
