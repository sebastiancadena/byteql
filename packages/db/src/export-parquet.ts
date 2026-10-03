import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { Table } from 'apache-arrow';

import { createExportFiles, type ExportFiles } from './export-files.js';
import { snapshotPage } from './result-snapshot.js';
import { parquetColumnNames, resultColumnLabel } from './result-columns.js';
import {
  isSupportedParquetType,
  type ParquetArtifact,
  type ParquetExportOptions,
  unsupportedParquetTypeMessage,
} from './export-types.js';
import { combineErrors, ShardWorkspace } from './shard-workspace.js';
import { quoteIdentifier, quoteString } from './sql.js';
import type { QueryResultView } from './types.js';

const PAGE_TABLE = '__byteql_export_page';
const RESULT_FILE = 'result.parquet';
/** Relation alias for the shard scan, so the ordering reference can be qualified. */
const SOURCE_ALIAS = '__byteql_export_src';
/**
 * Private ordinal recording each row's position in the COMMITTED DISPLAY order. A parallel scan
 * over the shards is free to return them in any order, so the final COPY orders by this rather
 * than trusting shard names or scan order. It never appears in the exported file.
 */
const EXPORT_ORDINAL_COLUMN = '__byteql_export_ordinal';

export interface ParquetWriterDependencies {
  readonly database: Pick<AsyncDuckDB, 'registerOPFSFileName' | 'dropFile'>;
  connect(): Promise<AsyncDuckDBConnection>;
  createFiles(): Promise<ExportFiles>;
}

const selectedFields = (result: QueryResultView, columns: readonly number[]) => {
  if (columns.length === 0) throw new Error('At least one column must be selected for Parquet export.');
  return columns.map((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= result.schema.fields.length) {
      throw new RangeError(`Parquet export column index is out of range: ${String(index)}.`);
    }
    const field = result.schema.fields[index]!;
    if (!isSupportedParquetType(field.type)) {
      throw new Error(unsupportedParquetTypeMessage(resultColumnLabel(field), field.type));
    }
    return field;
  });
};

/**
 * Selects the exported columns, renames them to generated positional aliases so no user column
 * name reaches a generated statement, and appends the display ordinal.
 */
const stageSelectedColumns = (table: Table, columns: readonly number[], startRow: number): Table =>
  snapshotPage(table.selectAt([...columns]), startRow, EXPORT_ORDINAL_COLUMN);

/** Stages every page as a shard, then orders the shards into one file by display ordinal. */
async function writeShardsAndResult(
  workspace: ShardWorkspace,
  result: QueryResultView,
  options: ParquetExportOptions,
): Promise<ParquetArtifact> {
  const shards: string[] = [];
  const pages = result.pages();
  if (pages.length === 0) {
    const empty = stageSelectedColumns(new Table(result.schema), options.columns, 0);
    shards.push(await workspace.writeShard(empty, 'shard-0.parquet'));
  } else {
    for (const page of pages) {
      options.signal.throwIfAborted();
      const stored = await result.readPage(page.index);
      // The ordinal comes from the page's position in the DISPLAY, which is what the file must
      // reproduce — not from the page index, which need not be contiguous.
      const staged = stageSelectedColumns(stored.table, options.columns, page.startRow);
      shards.push(await workspace.writeShard(staged, `shard-${page.index}.parquet`));
      options.onProgress(page.startRow + page.rowCount);
    }
  }

  options.signal.throwIfAborted();
  const output = await workspace.register(RESULT_FILE);
  const projection = options.columnNames
    .map((name, index) => `${quoteIdentifier(`c${index}`)} AS ${quoteIdentifier(name)}`)
    .join(', ');
  const paths = shards.map(quoteString).join(', ');
  // The projection names only the user's columns, so the private ordinal orders the rows and
  // then disappears. The ordering reference is QUALIFIED: a bare one binds to a SELECT-list
  // alias first, so a user column named like the ordinal would otherwise silently order the
  // file by that column instead of by display position.
  await workspace.runStatement(
    `COPY (SELECT ${projection} FROM parquet_scan([${paths}]) AS ${quoteIdentifier(SOURCE_ALIAS)} ` +
      `ORDER BY ${quoteIdentifier(SOURCE_ALIAS)}.${quoteIdentifier(EXPORT_ORDINAL_COLUMN)} ASC) ` +
      `TO ${quoteString(output)} (FORMAT PARQUET, COMPRESSION SNAPPY)`,
  );

  const cleanupErrors = await workspace.releaseHandles();
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      'Parquet output was written but its DuckDB handles could not be released.',
    );
  }
  options.signal.throwIfAborted();
  const { files } = workspace;
  const file = await files.file(RESULT_FILE);
  options.signal.throwIfAborted();
  // Ownership of the scratch files transfers to the artifact here and nowhere earlier.
  return { file, dispose: () => files.dispose() };
}

export async function writeParquet(
  dependencies: ParquetWriterDependencies,
  result: QueryResultView,
  options: ParquetExportOptions,
): Promise<ParquetArtifact> {
  selectedFields(result, options.columns);
  const expectedNames = parquetColumnNames(result.schema, options.columns).map(({ name }) => name);
  if (
    options.columnNames.length !== expectedNames.length ||
    expectedNames.some((name, index) => name !== options.columnNames[index])
  ) {
    throw new Error('Parquet column names no longer match the selected result.');
  }
  options.signal.throwIfAborted();
  // Export keeps one freshly created table per shard rather than sort's reused TEMP table: its
  // tests pin a `create: true` import and a DROP per page.
  const workspace = await ShardWorkspace.open(dependencies, {
    staging: { kind: 'table-per-shard', table: PAGE_TABLE },
    label: 'Parquet export',
    signal: options.signal,
  });
  try {
    await workspace.connect();
  } catch (error) {
    throw combineErrors(
      error,
      await workspace.release(),
      'Parquet export setup failed and cleanup was incomplete.',
    );
  }
  try {
    return await writeShardsAndResult(workspace, result, options);
  } catch (error) {
    throw combineErrors(
      error,
      await workspace.release(),
      'Parquet export failed and cleanup was incomplete.',
    );
  }
}

export const defaultParquetWriterDependencies = (database: AsyncDuckDB): ParquetWriterDependencies => ({
  database,
  connect: () => database.connect(),
  createFiles: createExportFiles,
});
