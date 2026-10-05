import {
  createRuntimes,
  createStreamsRuntime,
  flushStreams,
  projectInto,
  streamSegmentsOutputTypes,
  tableOutputTypes,
} from './project.js';
import type { CompiledProjection, ProjectedTable, ProvenanceResolver, RowSink } from './project.js';

// Test-only: projects one already-parsed tree into column-oriented tables. Production code goes
// through ProjectionSession; this exists so projection unit tests can assert on plain columns.
export const projectTree = (
  compiled: CompiledProjection,
  root: unknown,
  provenance: ProvenanceResolver,
): ProjectedTable[] => {
  const columnsByTable = new Map<string, Record<string, unknown[]>>(
    compiled.tables.map((table) => [
      table.name,
      Object.fromEntries(Object.keys(tableOutputTypes(table)).map((name) => [name, []])),
    ]),
  );
  for (const segmentsTable of compiled.segmentsTables) {
    columnsByTable.set(
      segmentsTable.name,
      Object.fromEntries(
        Object.keys(streamSegmentsOutputTypes(segmentsTable.feedKeyColumn)).map((name) => [name, []]),
      ),
    );
  }
  const sink: RowSink = {
    push(tableName, row) {
      const columns = columnsByTable.get(tableName)!;
      for (const name of Object.keys(columns)) columns[name]!.push(row[name] ?? null);
    },
  };
  const runtimes = createRuntimes(compiled);
  const streams = createStreamsRuntime(compiled);
  projectInto(compiled, root, provenance, sink, runtimes, null, undefined, streams);
  flushStreams({ compiled, runtimes, sink, streams });
  const tables = compiled.tables.map((table) => {
    const columns = columnsByTable.get(table.name)!;
    const types = tableOutputTypes(table);
    return { name: table.name, columns, types, rowCount: columns[table.key]!.length };
  });
  const segmentsTables = compiled.segmentsTables.map((segmentsTable) => {
    const columns = columnsByTable.get(segmentsTable.name)!;
    const types = streamSegmentsOutputTypes(segmentsTable.feedKeyColumn);
    return { name: segmentsTable.name, columns, types, rowCount: columns.segment_id!.length };
  });
  return [...tables, ...segmentsTables];
};
