import type { Table } from 'apache-arrow';
import { TableBatchBuilder } from '../arrow/batch.js';
import type { IssueCollector } from '../issues.js';
import type { ParseIssue } from '../protocol.js';
import {
  createRuntimes,
  createStreamsRuntime,
  flushStreams,
  projectInto,
  type CompiledProjection,
  type ProvenanceResolver,
  type RowSink,
  type StreamsRuntime,
} from './project.js';

export interface ProjectCallOptions {
  readonly tables?: readonly string[];
}

export interface FinishedTable {
  readonly name: string;
  readonly arrow: Table;
  /**
   * From `finish()`: cumulative rows across the whole session — after prior `drain()` calls
   * this EXCEEDS `arrow.numRows` (which holds only the undrained remainder). From `drain()`:
   * always the rows in this batch (`=== arrow.numRows`).
   */
  readonly rowCount: number;
}

export interface ProjectionSession {
  project(root: unknown, resolver: ProvenanceResolver, options?: ProjectCallOptions): void;
  /** Appends one `errors` row; `error_id` is assigned in append order, starting at 1. */
  appendIssue(issue: ParseIssue): void;
  /**
   * Flushes stream flow rows (and any engine issues that raises). Idempotent; `finish()` calls
   * it, so call it directly only to collect the engine issues before `appendIssue`-ing them.
   */
  flush(): void;
  finish(): FinishedTable[];
  /**
   * Seals and returns every table's rows appended since the last `drain()` (or since session
   * creation), as one `FinishedTable` per table that has pending rows — tables with nothing new
   * are omitted. Unlike `finish()`, each `FinishedTable.rowCount` here is the row count of just
   * this drained batch, **not** the table's cumulative row count. `drain()` never flushes
   * streams — `finish()` keeps sole responsibility for that — so stream flow/segment rows only
   * ever appear via `finish()`.
   */
  drain(): FinishedTable[];
  /** Rows appended across all tables since the last `drain()` (or since session creation). */
  pendingRowCount(): number;
}

export interface ProjectionSessionOptions {
  readonly flushRowThreshold?: number;
  readonly issues?: IssueCollector;
  // When true, a column `expr` evaluation that reads a field absent on the node it's
  // evaluated against throws ProjectionFieldError instead of silently reading null — a
  // typo/naming-mismatch guard. Present-null stays null; `when`, `where`, state updates,
  // dissect payloads, and stream expressions are never strict (see EmitContext's doc).
  readonly strictFields?: boolean;
}

export const createProjectionSession = (
  compiled: CompiledProjection,
  options: ProjectionSessionOptions = {},
): ProjectionSession => {
  const builders = new Map<string, TableBatchBuilder>(
    compiled.outputs.map((output) => [
      output.name,
      new TableBatchBuilder(
        output.name,
        Object.fromEntries(output.columns.map((column) => [column.name, column.type])),
        options,
      ),
    ]),
  );
  const errorsBuilder = builders.get('errors')!;
  const ordinalColumn = compiled.errorsOrdinalColumn;
  let issueCount = 0;
  let flushed = false;
  const runtimes = createRuntimes(compiled);
  const streams: StreamsRuntime = createStreamsRuntime(compiled);
  let pendingSinceDrain = 0;
  const sink: RowSink = {
    push: (table, row) => {
      builders.get(table)!.appendRow(row);
      pendingSinceDrain += 1;
    },
  };

  return {
    project(root, resolver, callOptions) {
      const subset = callOptions?.tables === undefined ? null : new Set(callOptions.tables);
      projectInto(
        compiled,
        root,
        resolver,
        sink,
        runtimes,
        subset,
        options.issues,
        streams,
        options.strictFields ?? false,
      );
    },
    appendIssue(issue) {
      issueCount += 1;
      errorsBuilder.appendRow({
        error_id: BigInt(issueCount),
        stage: issue.stage,
        [ordinalColumn]: issue.track,
        code: issue.code,
        message: issue.message,
        recoverable: issue.recoverable,
        _src_start: issue.sourceStart === null ? null : BigInt(issue.sourceStart),
        _src_end: issue.sourceEnd === null ? null : BigInt(issue.sourceEnd),
      });
      pendingSinceDrain += 1;
    },
    drain() {
      const drained: FinishedTable[] = [];
      for (const [name, builder] of builders) {
        const arrow = builder.drain();
        if (arrow && arrow.numRows > 0) drained.push({ name, arrow, rowCount: arrow.numRows });
      }
      pendingSinceDrain = 0;
      return drained;
    },
    pendingRowCount() {
      return pendingSinceDrain;
    },
    flush() {
      if (flushed) return;
      flushed = true;
      // Streams flush first: their flow (and, transitively, message) rows must land before
      // `finish()` reads back row counts / seals builders.
      flushStreams({
        compiled,
        runtimes,
        sink,
        streams,
        ...(options.issues ? { issues: options.issues } : {}),
        ...(options.strictFields ? { strictFields: options.strictFields } : {}),
      });
    },
    finish() {
      this.flush();
      return compiled.outputs.map((output) => {
        const builder = builders.get(output.name)!;
        return { name: output.name, arrow: builder.finish(), rowCount: builder.rowCount };
      });
    },
  };
};
