import { describe, expect, it } from 'vitest';
import { IssueCollector } from './issues.js';

describe('IssueCollector', () => {
  it('collects issues with defaulted ordinal and source range', () => {
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
  });
});
