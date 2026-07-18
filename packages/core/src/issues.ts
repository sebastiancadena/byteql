import type { ParseIssue } from './protocol.js';
import type { ProjectedTable } from './projection/project.js';

export interface IssueReport {
  stage: string;
  code: string;
  message: string;
  recoverable: boolean;
  ordinal?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
}

export interface IssueCollectorOptions {
  readonly ordinalColumn?: string;
}

const toBigIntOrNull = (value: number | null): bigint | null => (value === null ? null : BigInt(value));

const reservedOrdinalColumns = new Set([
  'error_id',
  'stage',
  'code',
  'message',
  'recoverable',
  '_src_start',
  '_src_end',
]);

export class IssueCollector {
  private readonly ordinalColumn: string;
  private readonly reported: ParseIssue[] = [];

  constructor(options: IssueCollectorOptions = {}) {
    const ordinalColumn = options.ordinalColumn ?? 'record';
    if (reservedOrdinalColumns.has(ordinalColumn)) {
      throw new Error(
        `ISSUE_ORDINAL_COLUMN_RESERVED: ordinalColumn ${JSON.stringify(ordinalColumn)} collides with a fixed issues-table column`,
      );
    }
    this.ordinalColumn = ordinalColumn;
  }

  report(issue: IssueReport): void {
    this.reported.push({
      stage: issue.stage,
      track: issue.ordinal ?? null,
      code: issue.code,
      message: issue.message,
      recoverable: issue.recoverable,
      sourceStart: issue.sourceStart ?? null,
      sourceEnd: issue.sourceEnd ?? null,
    });
  }

  issues(): readonly ParseIssue[] {
    return this.reported;
  }

  table(): ProjectedTable {
    const issues = this.reported;
    return {
      name: 'errors',
      rowCount: issues.length,
      columns: {
        error_id: issues.map((_issue, index) => BigInt(index + 1)),
        stage: issues.map((issue) => issue.stage),
        [this.ordinalColumn]: issues.map((issue) => issue.track),
        code: issues.map((issue) => issue.code),
        message: issues.map((issue) => issue.message),
        recoverable: issues.map((issue) => issue.recoverable),
        _src_start: issues.map((issue) => toBigIntOrNull(issue.sourceStart)),
        _src_end: issues.map((issue) => toBigIntOrNull(issue.sourceEnd)),
      },
      types: {
        error_id: 'int64',
        stage: 'utf8',
        [this.ordinalColumn]: 'int32',
        code: 'utf8',
        message: 'utf8',
        recoverable: 'bool',
        _src_start: 'uint64',
        _src_end: 'uint64',
      },
    };
  }
}
