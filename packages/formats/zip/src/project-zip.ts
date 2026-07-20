import {
  IssueCollector,
  compileProjection,
  createProjectionSession,
  parseProjectionSpec,
  projectedTableToArrow,
  tableToIpc,
  type ByteSource,
  type FinishedTable,
  type ParseProgress,
  type ParseResult,
  type ProvenanceResolver,
  type TableTransfer,
} from '@byteql/core';

import { readZipContainer, type ZipRange } from './container.js';
import zipQueries from './zip-queries.generated.js';
import tablesYaml from './zip-tables.generated.js';

const compiledProjection = compileProjection(parseProjectionSpec(tablesYaml));

export type ZipProgressCallback = (progress: ParseProgress) => void;

export const zipNullability: Readonly<Record<string, ReadonlySet<string>>> = {
  local_files: new Set(['_src_start', '_src_end', 'mod_time']),
  central_dir_entries: new Set(['_src_start', '_src_end', 'mod_time']),
  end_of_central_dir: new Set(['_src_start', '_src_end']),
  errors: new Set(['record', '_src_start', '_src_end']),
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return;
  signal.throwIfAborted();
  throw new DOMException('The operation was aborted.', 'AbortError');
};

const toTransfer = (finished: FinishedTable): TableTransfer => {
  const nullableColumns = zipNullability[finished.name] ?? new Set<string>();
  return {
    name: finished.name,
    ipc: tableToIpc(finished.arrow),
    rowCount: finished.rowCount,
    columns: finished.arrow.schema.fields.map((field) => ({
      name: field.name,
      type: field.type.toString(),
      nullable: nullableColumns.has(field.name),
    })),
  };
};

/** Each projected node carries `_range`; the resolver returns it for per-row provenance. */
const provenance: ProvenanceResolver = {
  resolve: (_table, match) => (match.node as { _range: ZipRange })._range,
};

export async function parseAndProjectZip(
  source: ByteSource,
  signal: AbortSignal,
  onProgress?: ZipProgressCallback,
): Promise<ParseResult> {
  throwIfAborted(signal);
  onProgress?.({ stage: 'projecting', completed: 0, total: source.size, label: 'Reading ZIP structure' });

  const container = await readZipContainer(source);
  throwIfAborted(signal);

  const collector = new IssueCollector({ ordinalColumn: 'record' });
  for (const issue of container.issues) {
    collector.report({
      stage: 'framing',
      code: issue.code,
      message: issue.message,
      recoverable: true,
      sourceStart: issue.sourceStart,
      sourceEnd: issue.sourceEnd,
    });
  }

  const session = createProjectionSession(compiledProjection, { issues: collector });
  // `end_of_central_dir`'s anchor is `$.end_of_central_dir` (a single object, not `[*]`), so the
  // walker matches it even when the value is `null` — an explicit `null` property still yields a
  // row (with a null `match.node`, which the provenance resolver below cannot service). Omitting
  // the key entirely when the EOCD is missing makes the property lookup miss instead, so no row
  // is emitted and the table comes back genuinely empty (finish() still reports it — see below).
  const root: {
    local_files: typeof container.localFiles;
    central_dir_entries: typeof container.centralDirEntries;
    end_of_central_dir?: NonNullable<typeof container.endOfCentralDir>;
  } = {
    local_files: container.localFiles,
    central_dir_entries: container.centralDirEntries,
  };
  if (container.endOfCentralDir) root.end_of_central_dir = container.endOfCentralDir;
  session.project(root, provenance);
  const finished = session.finish();

  const errors = collector.table();
  const tables: TableTransfer[] = finished.map(toTransfer);
  tables.push(
    toTransfer({ name: errors.name, arrow: projectedTableToArrow(errors), rowCount: errors.rowCount }),
  );

  onProgress?.({
    stage: 'projecting',
    completed: source.size,
    total: source.size,
    label: 'Projected ZIP structure',
  });

  return {
    format: { id: 'zip', title: 'ZIP archive' },
    tables,
    issues: collector.issues(),
    queries: zipQueries,
    capabilities: {},
  };
}
