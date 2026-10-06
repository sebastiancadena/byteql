import type { ParseIssue } from './protocol.js';

export interface IssueReport {
  stage: string;
  code: string;
  message: string;
  recoverable: boolean;
  ordinal?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
}

export class IssueCollector {
  private readonly reported: ParseIssue[] = [];

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
}
