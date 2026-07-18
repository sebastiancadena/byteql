import type { Table } from 'apache-arrow';
import { TableBatchBuilder } from '../arrow/batch.js';
import type { IssueCollector } from '../issues.js';
import {
  createRuntimes,
  projectInto,
  tableOutputTypes,
  type CompiledProjection,
  type ProvenanceResolver,
  type RowSink,
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
  const runtimes = createRuntimes(compiled);
  const sink: RowSink = { push: (table, row) => builders.get(table)!.appendRow(row) };

  return {
    project(root, resolver, callOptions) {
      const subset = callOptions?.tables === undefined ? null : new Set(callOptions.tables);
      projectInto(compiled, root, resolver, sink, runtimes, subset, options.issues);
    },
    finish() {
      return compiled.tables.map((table) => {
        const builder = builders.get(table.name)!;
        return { name: table.name, arrow: builder.finish(), rowCount: builder.rowCount };
      });
    },
  };
};
