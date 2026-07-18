import type { PackQuery, ParseIssue, TableTransfer } from '@byteql/core';
import type { Table } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { initialSessionState, reduceSession } from './state.js';

const tables: readonly TableTransfer[] = [
  { name: 'events', ipc: new Uint8Array([1, 2, 3]), rowCount: 1, columns: [] },
];
const queries: readonly PackQuery[] = [
  { id: 'overview', title: 'Overview', kind: 'grid', sql: 'select 1 limit 1;' },
];

const issue: ParseIssue = {
  stage: 'parsing',
  track: 1,
  code: 'TRACK_FAILED',
  message: 'Track 1 was skipped.',
  recoverable: true,
  sourceStart: 12,
  sourceEnd: 13,
};

const result = { marker: 'local Arrow table' } as unknown as Table;

describe('reduceSession', () => {
  it('advances through the file intake stages without exposing the source object', () => {
    let state = reduceSession(initialSessionState, {
      type: 'opening',
      source: { name: 'song.mid', size: 42 },
    });
    expect(state).toMatchObject({
      phase: 'opening',
      source: { name: 'song.mid', size: 42 },
      tables: [],
      issues: [],
      result: null,
    });

    state = reduceSession(state, {
      type: 'progress',
      stage: 'normalizing',
      completed: 0,
      total: 2,
      label: 'Normalizing tracks',
    });
    expect(state).toMatchObject({
      phase: 'normalizing',
      progress: { completed: 0, total: 2, label: 'Normalizing tracks' },
    });

    state = reduceSession(state, {
      type: 'progress',
      stage: 'parsing',
      completed: 1,
      total: 2,
      label: 'Parsing track 1',
    });
    expect(state.phase).toBe('parsing');

    state = reduceSession(state, {
      type: 'progress',
      stage: 'projecting',
      completed: 2,
      total: 2,
      label: 'Projecting tables',
    });
    expect(state.phase).toBe('projecting');

    state = reduceSession(state, { type: 'registering', format: { id: 'midi', title: 'MIDI' } });
    expect(state).toMatchObject({ phase: 'registering', format: { id: 'midi', title: 'MIDI' } });

    state = reduceSession(state, { type: 'ready', tables, issues: [issue], queries });
    expect(state).toMatchObject({
      phase: 'ready',
      tables,
      issues: [issue],
      queries,
      progress: null,
      fatalError: null,
    });
  });

  it('starts and completes a query while resetting selection and prior errors', () => {
    const ready = reduceSession(initialSessionState, { type: 'ready', tables, issues: [], queries });
    const querying = reduceSession(
      { ...ready, queryError: 'old error', selectedRow: 3 },
      { type: 'queryStarted', sql: 'select 1' },
    );
    expect(querying).toMatchObject({
      phase: 'querying',
      sql: 'select 1',
      queryError: null,
      selectedRow: null,
    });

    expect(reduceSession(querying, { type: 'querySucceeded', result, elapsedMs: 7 })).toMatchObject({
      phase: 'ready',
      result,
      queryElapsedMs: 7,
      queryError: null,
    });
  });

  it('retains the prior result after a query failure', () => {
    const ready = { ...initialSessionState, phase: 'querying' as const, result, tables };
    expect(reduceSession(ready, { type: 'queryFailed', message: 'syntax error' })).toMatchObject({
      phase: 'ready',
      result,
      queryError: 'syntax error',
      queryElapsedMs: null,
    });
  });

  it('returns to ready when a query is cancelled and to idle when intake is cancelled', () => {
    expect(
      reduceSession({ ...initialSessionState, phase: 'querying', tables }, { type: 'cancelled' }),
    ).toMatchObject({ phase: 'ready', tables });
    expect(
      reduceSession(
        { ...initialSessionState, phase: 'parsing', source: { name: 'x.mid', size: 2 } },
        { type: 'cancelled' },
      ),
    ).toEqual(initialSessionState);
  });

  it('records row selection only for a current result', () => {
    expect(reduceSession({ ...initialSessionState, result }, { type: 'rowSelected', row: 4 })).toMatchObject({
      selectedRow: 4,
    });
    expect(reduceSession(initialSessionState, { type: 'rowSelected', row: 4 }).selectedRow).toBeNull();
  });

  it('fails safely after a worker crash while retaining only retry-safe source metadata', () => {
    const failed = reduceSession(
      { ...initialSessionState, phase: 'parsing', source: { name: 'bad.mid', size: 9 } },
      { type: 'failed', message: 'The parser worker stopped unexpectedly.' },
    );
    expect(failed).toMatchObject({
      phase: 'failed',
      source: { name: 'bad.mid', size: 9 },
      fatalError: 'The parser worker stopped unexpectedly.',
      progress: null,
      tables: [],
      result: null,
    });
  });

  it('clears every prior session artifact when loading a replacement file', () => {
    const previous = {
      ...initialSessionState,
      phase: 'ready' as const,
      source: { name: 'old.mid', size: 10 },
      format: { id: 'midi', title: 'MIDI' },
      tables,
      issues: [issue],
      sql: 'select * from events',
      result,
      queryElapsedMs: 4,
      queryError: 'old error',
      selectedRow: 2,
      fatalError: 'old fatal',
    };

    expect(reduceSession(previous, { type: 'opening', source: { name: 'new.mid', size: 20 } })).toEqual({
      ...initialSessionState,
      phase: 'opening',
      source: { name: 'new.mid', size: 20 },
    });
  });
});
