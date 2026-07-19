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
  readonly rowCount: number;
}

export interface ProjectionSession {
  project(root: unknown, resolver: ProvenanceResolver, options?: ProjectCallOptions): void;
  finish(): FinishedTable[];
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
  const sink: RowSink = { push: (table, row) => builders.get(table)!.appendRow(row) };

  return {
    project(root, resolver, callOptions) {
      const subset = callOptions?.tables === undefined ? null : new Set(callOptions.tables);
      projectInto(compiled, root, resolver, sink, runtimes, subset, options.issues, streams);
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
