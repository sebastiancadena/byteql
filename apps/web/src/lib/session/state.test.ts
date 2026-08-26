import type { PackQuery, ParseIssue, TableOverview } from '@byteql/core';
import { tableFromArrays, type Table } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { initialSessionState, reduceSession, type PagedResultState } from './state.js';

const tables: readonly TableOverview[] = [{ name: 'events', rowCount: 1, columns: [] }];
const format = { id: 'standard_midi_file', title: 'Standard MIDI file' };
const queries: readonly PackQuery[] = [
  { id: 'overview', title: 'Overview', kind: 'grid', sql: 'select 1 limit 1;' },
];
const capabilities = { audio: { enabled: false, reason: 'SMPTE timing is unsupported.' } } as const;

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
const pagedTable = tableFromArrays({ value: Int32Array.from([0]) });
const pagedResult: PagedResultState = {
  generation: 1,
  schema: pagedTable.schema,
  loadedRows: 1_024,
  complete: false,
  loadingMore: false,
  windowStart: 0,
  window: pagedTable,
  completeTable: null,
  elapsedMs: 7,
  pageError: null,
  pageErrorRetryable: false,
};

describe('reduceSession', () => {
  it('advances through the file intake stages without exposing the source object', () => {
    let state = reduceSession(initialSessionState, {
      type: 'opening',
      source: { files: [{ name: 'song.mid', size: 42 }], totalSize: 42 },
    });
    expect(state).toMatchObject({
      phase: 'opening',
      source: { files: [{ name: 'song.mid', size: 42 }], totalSize: 42 },
      tables: [],
      issues: [],
      result: null,
    });
    expect(state.openStartedAt).toEqual(expect.any(Number));
    const openStartedAt = state.openStartedAt;

    state = reduceSession(state, {
      type: 'progress',
      stage: 'normalizing',
      completed: 0,
      total: 2,
      label: 'Normalizing tracks',
      bytes: 0,
      fileIndex: 1,
      fileCount: 1,
    });
    expect(state).toMatchObject({
      phase: 'normalizing',
      progress: { completed: 0, total: 2, label: 'Normalizing tracks', bytes: 0, fileIndex: 1, fileCount: 1 },
    });
    // openStartedAt survives every progress update — it anchors the throughput rate computation.
    expect(state.openStartedAt).toBe(openStartedAt);

    state = reduceSession(state, {
      type: 'progress',
      stage: 'parsing',
      completed: 1,
      total: 2,
      label: 'Parsing track 1',
      bytes: 128,
      fileIndex: 1,
      fileCount: 1,
    });
    expect(state.phase).toBe('parsing');
    expect(state.progress).toMatchObject({ bytes: 128 });

    state = reduceSession(state, {
      type: 'progress',
      stage: 'projecting',
      completed: 2,
      total: 2,
      label: 'Projecting tables',
      bytes: 256,
      fileIndex: 1,
      fileCount: 1,
    });
    expect(state.phase).toBe('projecting');
    expect(state.openStartedAt).toBe(openStartedAt);

    state = reduceSession(state, {
      type: 'ready',
      format,
      files: [{ name: 'song.mid', size: 42 }],
      tables,
      issues: [issue],
      queries,
      capabilities,
    });
    expect(state).toMatchObject({
      phase: 'ready',
      format,
      source: { files: [{ name: 'song.mid', size: 42 }], totalSize: 42 },
      tables,
      issues: [issue],
      queries,
      capabilities,
      progress: null,
      fatalError: null,
    });
    expect(state.openStartedAt).toBeNull();
  });

  it('starts and completes a query while resetting selection and prior errors', () => {
    const ready = reduceSession(initialSessionState, {
      type: 'ready',
      format,
      files: [],
      tables,
      issues: [],
      queries,
      capabilities,
    });
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

  it('publishes a paged initial result and clears byte selection', () => {
    const querying = {
      ...initialSessionState,
      phase: 'querying' as const,
      byteSelection: { file: 'a.pcap', start: 1, end: 2 },
    };

    expect(reduceSession(querying, { type: 'querySucceeded', result: pagedResult })).toMatchObject({
      phase: 'ready',
      pagedResult,
      queryError: null,
      selectedRow: null,
      byteSelection: null,
    });
  });

  it('preserves global and byte selections when the paged window rebases', () => {
    const ready = {
      ...initialSessionState,
      phase: 'ready' as const,
      pagedResult,
      selectedRow: 9_000,
      byteSelection: { file: 'a.pcap', start: 1, end: 2 },
    };

    const next = reduceSession(ready, {
      type: 'queryWindowUpdated',
      result: { ...pagedResult, loadedRows: 9_216, windowStart: 1_024, loadingMore: false },
    });

    expect(next.selectedRow).toBe(9_000);
    expect(next.byteSelection).toEqual({ file: 'a.pcap', start: 1, end: 2 });
    expect(next.pagedResult).toMatchObject({ loadedRows: 9_216, windowStart: 1_024 });
  });

  it('records a retryable page failure without discarding loaded rows', () => {
    const ready = { ...initialSessionState, phase: 'ready' as const, pagedResult };

    const next = reduceSession(ready, {
      type: 'queryPageFailed',
      message: 'Local result storage is full.',
      retryable: true,
    });

    expect(next.pagedResult).toMatchObject({
      loadedRows: 1_024,
      loadingMore: false,
      pageError: 'Local result storage is full.',
      pageErrorRetryable: true,
    });
  });

  it('accepts retry-start and EOF updates without changing the selected global row', () => {
    const ready = { ...initialSessionState, phase: 'ready' as const, pagedResult, selectedRow: 1_023 };
    const retrying = reduceSession(ready, {
      type: 'queryWindowUpdated',
      result: { ...pagedResult, loadingMore: true, pageError: null, pageErrorRetryable: false },
    });
    const completed = reduceSession(retrying, {
      type: 'queryWindowUpdated',
      result: { ...pagedResult, loadedRows: 1_024, complete: true, loadingMore: false },
    });

    expect(retrying.pagedResult).toMatchObject({ loadingMore: true, pageError: null });
    expect(completed.pagedResult).toMatchObject({ complete: true, loadingMore: false });
    expect(completed.selectedRow).toBe(1_023);
  });

  it('returns to ready when a query is cancelled and to idle when intake is cancelled', () => {
    expect(
      reduceSession(
        { ...initialSessionState, phase: 'querying', tables, pagedResult },
        { type: 'cancelled' },
      ),
    ).toMatchObject({ phase: 'ready', tables, pagedResult: { complete: false, loadedRows: 1_024 } });
    expect(
      reduceSession(
        {
          ...initialSessionState,
          phase: 'parsing',
          source: { files: [{ name: 'x.mid', size: 2 }], totalSize: 2 },
          openStartedAt: 1000,
        },
        { type: 'cancelled' },
      ),
    ).toEqual(initialSessionState);
  });

  it('records row selection only for a current result', () => {
    expect(reduceSession({ ...initialSessionState, result }, { type: 'rowSelected', row: 4 })).toMatchObject({
      selectedRow: 4,
    });
    expect(
      reduceSession({ ...initialSessionState, pagedResult }, { type: 'rowSelected', row: 1_023 }),
    ).toMatchObject({
      selectedRow: 1_023,
    });
    expect(reduceSession(initialSessionState, { type: 'rowSelected', row: 4 }).selectedRow).toBeNull();
  });

  it('fails safely after a worker crash while retaining only retry-safe source metadata', () => {
    const failed = reduceSession(
      {
        ...initialSessionState,
        phase: 'parsing',
        source: { files: [{ name: 'bad.mid', size: 9 }], totalSize: 9 },
        openStartedAt: 1000,
      },
      { type: 'failed', message: 'The parser worker stopped unexpectedly.' },
    );
    expect(failed).toMatchObject({
      phase: 'failed',
      source: { files: [{ name: 'bad.mid', size: 9 }], totalSize: 9 },
      fatalError: 'The parser worker stopped unexpectedly.',
      progress: null,
      tables: [],
      result: null,
    });
    expect(failed.openStartedAt).toBeNull();
  });

  it('clears every prior session artifact when loading a replacement file', () => {
    const previous = {
      ...initialSessionState,
      phase: 'ready' as const,
      source: { files: [{ name: 'old.mid', size: 10 }], totalSize: 10 },
      format: { id: 'midi', title: 'MIDI' },
      tables,
      issues: [issue],
      sql: 'select * from events',
      result,
      pagedResult,
      queryElapsedMs: 4,
      queryError: 'old error',
      selectedRow: 2,
      fatalError: 'old fatal',
      capabilities,
    };

    const next = reduceSession(previous, {
      type: 'opening',
      source: { files: [{ name: 'new.mid', size: 20 }], totalSize: 20 },
    });
    expect(next).toMatchObject({
      ...initialSessionState,
      phase: 'opening',
      source: { files: [{ name: 'new.mid', size: 20 }], totalSize: 20 },
      openStartedAt: expect.any(Number),
    });
    expect(initialSessionState.capabilities).toBeNull();
    expect(next.pagedResult).toBeNull();
  });
});

describe('byteRangeSelected', () => {
  it('stores the range while a source is open and clears on lifecycle resets', () => {
    let state = reduceSession(initialSessionState, {
      type: 'opening',
      source: { files: [{ name: 'a.pcap', size: 10 }], totalSize: 10 },
    });
    state = reduceSession(state, { type: 'byteRangeSelected', range: { file: 'a.pcap', start: 4, end: 8 } });
    expect(state.byteSelection).toEqual({ file: 'a.pcap', start: 4, end: 8 });
    state = reduceSession(state, { type: 'byteRangeSelected', range: null });
    expect(state.byteSelection).toBeNull();
  });

  it('is a no-op when no source is open', () => {
    const state = reduceSession(initialSessionState, {
      type: 'byteRangeSelected',
      range: { file: 'a.pcap', start: 0, end: 1 },
    });
    expect(state).toBe(initialSessionState);
    expect(state.byteSelection).toBeNull();
  });

  it('is kept across queryStarted, queryFailed, and rowSelected', () => {
    let state = reduceSession(initialSessionState, {
      type: 'opening',
      source: { files: [{ name: 'a.pcap', size: 10 }], totalSize: 10 },
    });
    state = reduceSession(state, { type: 'byteRangeSelected', range: { file: 'a.pcap', start: 2, end: 5 } });
    state = reduceSession(state, { type: 'queryStarted', sql: 'select 1' });
    expect(state.byteSelection).toEqual({ file: 'a.pcap', start: 2, end: 5 });
    state = reduceSession(state, { type: 'queryFailed', message: 'bad sql' });
    expect(state.byteSelection).toEqual({ file: 'a.pcap', start: 2, end: 5 });
    state = reduceSession(state, { type: 'rowSelected', row: 1 });
    expect(state.byteSelection).toEqual({ file: 'a.pcap', start: 2, end: 5 });
  });

  it('is cleared by a new query result, by failure, and by opening', () => {
    let state = reduceSession(initialSessionState, {
      type: 'opening',
      source: { files: [{ name: 'a.pcap', size: 10 }], totalSize: 10 },
    });
    state = reduceSession(state, { type: 'byteRangeSelected', range: { file: 'a.pcap', start: 0, end: 1 } });
    state = reduceSession(state, { type: 'querySucceeded', result, elapsedMs: 1 });
    expect(state.byteSelection).toBeNull();

    state = reduceSession(state, { type: 'byteRangeSelected', range: { file: 'a.pcap', start: 0, end: 1 } });
    state = reduceSession(state, { type: 'failed', message: 'boom' });
    expect(state.byteSelection).toBeNull();

    state = reduceSession(
      { ...initialSessionState, source: { files: [{ name: 'a.pcap', size: 10 }], totalSize: 10 } },
      { type: 'byteRangeSelected', range: { file: 'a.pcap', start: 0, end: 1 } },
    );
    state = reduceSession(state, {
      type: 'opening',
      source: { files: [{ name: 'b', size: 1 }], totalSize: 1 },
    });
    expect(state.byteSelection).toBeNull();
  });
});
