import type { PackQuery, ParseIssue, ParseResult, TableTransfer } from '@byteql/core';
import type { Table } from 'apache-arrow';

export type SessionPhase =
  | 'idle'
  | 'opening'
  | 'normalizing'
  | 'parsing'
  | 'projecting'
  | 'registering'
  | 'ready'
  | 'querying'
  | 'failed';

export interface SessionState {
  phase: SessionPhase;
  source: { name: string; size: number } | null;
  format: { id: string; title: string } | null;
  progress: { completed: number; total: number | null; label: string } | null;
  tables: readonly TableTransfer[];
  issues: readonly ParseIssue[];
  queries: readonly PackQuery[];
  capabilities: ParseResult['capabilities'] | null;
  sql: string;
  result: Table | null;
  queryElapsedMs: number | null;
  queryError: string | null;
  selectedRow: number | null;
  fatalError: string | null;
}

export type SessionEvent =
  | { type: 'opening'; source: { name: string; size: number } }
  | {
      type: 'progress';
      stage: 'normalizing' | 'parsing' | 'projecting';
      completed: number;
      total: number | null;
      label: string;
    }
  | { type: 'registering'; format: { id: string; title: string } }
  | {
      type: 'ready';
      tables: readonly TableTransfer[];
      issues: readonly ParseIssue[];
      queries: readonly PackQuery[];
      capabilities: ParseResult['capabilities'];
    }
  | { type: 'queryStarted'; sql: string }
  | { type: 'querySucceeded'; result: Table; elapsedMs: number }
  | { type: 'queryFailed'; message: string }
  | { type: 'rowSelected'; row: number | null }
  | { type: 'cancelled' }
  | { type: 'failed'; message: string };

export const initialSessionState: SessionState = {
  phase: 'idle',
  source: null,
  format: null,
  progress: null,
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
};

export function reduceSession(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'opening':
      return { ...initialSessionState, phase: 'opening', source: event.source };
    case 'progress':
      return {
        ...state,
        phase: event.stage,
        progress: {
          completed: event.completed,
          total: event.total,
          label: event.label,
        },
        fatalError: null,
      };
    case 'registering':
      return { ...state, phase: 'registering', format: event.format, progress: null };
    case 'ready':
      return {
        ...state,
        phase: 'ready',
        tables: event.tables,
        issues: event.issues,
        queries: event.queries,
        capabilities: event.capabilities,
        progress: null,
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
        tables: [],
        issues: [],
        queries: [],
        capabilities: null,
        result: null,
        queryElapsedMs: null,
        queryError: null,
        selectedRow: null,
        fatalError: event.message,
      };
  }
}
