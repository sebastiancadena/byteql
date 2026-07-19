import type { Table } from 'apache-arrow';
import { TableBatchBuilder } from '../arrow/batch.js';
import type { IssueCollector } from '../issues.js';
import {
  createRuntimes,
  createStreamsRuntime,
  flushStreams,
  projectInto,
  streamSegmentsOutputTypes,
  tableOutputTypes,
  type CompiledProjection,
  type EmitContext,
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
}

export const createProjectionSession = (
  compiled: CompiledProjection,
  options: ProjectionSessionOptions = {},
): ProjectionSession => {
  const builders = new Map<string, TableBatchBuilder>(
    compiled.tables.map((table) => [
      table.name,
      new TableBatchBuilder(table.name, tableOutputTypes(table), options),
    ]),
  );
  // One extra builder per stream's segments_table — these have no CompiledProjectionTable of
  // their own (see streamSegmentsOutputTypes), so they are not covered by the loop above.
  for (const segmentsTable of compiled.segmentsTables) {
    builders.set(
      segmentsTable.name,
      new TableBatchBuilder(
        segmentsTable.name,
        streamSegmentsOutputTypes(segmentsTable.feedKeyColumn),
        options,
      ),
    );
  }
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
      projectInto(compiled, root, resolver, sink, runtimes, subset, options.issues, streams);
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
    finish() {
      // Streams flush first: their flow (and, transitively, message) rows must land before the
      // rest of `finish()` reads back row counts / seals builders.
      const emitContext: EmitContext = {
        compiled,
        runtimes,
        sink,
        streams,
        ...(options.issues ? { issues: options.issues } : {}),
      };
      flushStreams(emitContext);
      return [
        ...compiled.tables.map((table) => {
          const builder = builders.get(table.name)!;
          return { name: table.name, arrow: builder.finish(), rowCount: builder.rowCount };
        }),
        ...compiled.segmentsTables.map((segmentsTable) => {
          const builder = builders.get(segmentsTable.name)!;
          return { name: segmentsTable.name, arrow: builder.finish(), rowCount: builder.rowCount };
        }),
      ];
    },
  };
};
