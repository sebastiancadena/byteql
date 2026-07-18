import { describe, expect, it } from 'vitest';
import { IssueCollector } from './issues.js';

describe('IssueCollector', () => {
  it('collects issues and renders the errors table with the default ordinal column', () => {
    const collector = new IssueCollector();
    collector.report({
      stage: 'framing',
      code: 'BAD_RECORD',
      message: 'truncated',
      recoverable: true,
      ordinal: 3,
      sourceStart: 10,
      sourceEnd: 20,
    });
    collector.report({ stage: 'parsing', code: 'CHILD_FAILED', message: 'boom', recoverable: true });

    expect(collector.issues()).toEqual([
      {
        stage: 'framing',
        track: 3,
        code: 'BAD_RECORD',
        message: 'truncated',
        recoverable: true,
        sourceStart: 10,
        sourceEnd: 20,
      },
      {
        stage: 'parsing',
        track: null,
        code: 'CHILD_FAILED',
        message: 'boom',
        recoverable: true,
        sourceStart: null,
        sourceEnd: null,
      },
    ]);

    const table = collector.table();
    expect(table.name).toBe('errors');
    expect(table.rowCount).toBe(2);
    expect(Object.keys(table.columns)).toEqual([
      'error_id',
      'stage',
      'record',
      'code',
      'message',
      'recoverable',
      '_src_start',
      '_src_end',
    ]);
    expect(table.columns.error_id).toEqual([1n, 2n]);
    expect(table.columns.record).toEqual([3, null]);
    expect(table.columns._src_start).toEqual([10n, null]);
    expect(table.types).toEqual({
      error_id: 'int64',
      stage: 'utf8',
      record: 'int32',
      code: 'utf8',
      message: 'utf8',
      recoverable: 'bool',
      _src_start: 'uint64',
      _src_end: 'uint64',
    });
  });

  it('names the ordinal column per options', () => {
    const collector = new IssueCollector({ ordinalColumn: 'track' });
    collector.report({ stage: 'parsing', code: 'X', message: 'y', recoverable: false, ordinal: 0 });
    expect(Object.keys(collector.table().columns)).toContain('track');
    expect(collector.table().types.track).toBe('int32');
  });

  it('rejects an ordinal column that collides with a fixed issues-table column', () => {
    expect(() => new IssueCollector({ ordinalColumn: 'code' })).toThrow(/ISSUE_ORDINAL_COLUMN_RESERVED/);
  });

  it('still allows the default and other non-reserved ordinal column names', () => {
    expect(() => new IssueCollector({ ordinalColumn: 'record' })).not.toThrow();
    expect(() => new IssueCollector({ ordinalColumn: 'track' })).not.toThrow();
  });
});
