import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { RecordBatch, Schema, Table, tableToIPC } from 'apache-arrow';

import { createExportFiles, type ExportFiles } from './export-files.js';
import {
  isSupportedParquetType,
  type ParquetArtifact,
  type ParquetExportOptions,
  unsupportedParquetTypeMessage,
} from './export-types.js';
import type { QueryResultView } from './types.js';

const PAGE_TABLE = '__byteql_export_page';
const RESULT_FILE = 'result.parquet';

export interface ParquetWriterDependencies {
  readonly database: Pick<AsyncDuckDB, 'registerOPFSFileName' | 'dropFile'>;
  connect(): Promise<AsyncDuckDBConnection>;
  createFiles(): Promise<ExportFiles>;
}

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const quoteString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const selectedFields = (result: QueryResultView, columns: readonly number[]) => {
  if (columns.length === 0) throw new Error('At least one column must be selected for Parquet export.');
  return columns.map((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= result.schema.fields.length) {
      throw new RangeError(`Parquet export column index is out of range: ${String(index)}.`);
    }
    const field = result.schema.fields[index]!;
    if (!isSupportedParquetType(field.type)) {
      throw new Error(unsupportedParquetTypeMessage(field.name, field.type));
    }
    return field;
  });
};

const renameSelectedColumns = (table: Table, columns: readonly number[]): Table => {
  const selected = table.selectAt([...columns]);
  const fields = selected.schema.fields.map((field, index) => field.clone({ name: `c${index}` }));
  const schema = new Schema(fields, selected.schema.metadata);
  return new Table(
    schema,
    selected.batches.map((batch) => new RecordBatch(schema, batch.data)),
  );
};

const combineErrors = (primary: unknown, cleanup: readonly unknown[], message: string): unknown => {
  if (cleanup.length === 0) return primary;
  return new AggregateError([primary, ...cleanup], message, { cause: primary });
};

class ParquetWriter {
  private readonly registeredPaths: string[] = [];

  constructor(
    private readonly dependencies: ParquetWriterDependencies,
    private readonly connection: AsyncDuckDBConnection,
    private readonly files: ExportFiles,
    private readonly result: QueryResultView,
    private readonly options: ParquetExportOptions,
  ) {}

  async write(): Promise<ParquetArtifact> {
    const shards: string[] = [];
    const pages = this.result.pages();
    if (pages.length === 0) {
      const empty = new Table(this.result.schema);
      shards.push(await this.writeShard(empty, this.options.columns, 0));
    } else {
      for (const page of pages) {
        this.options.signal.throwIfAborted();
        const stored = await this.result.readPage(page.index);
        shards.push(await this.writeShard(stored.table, this.options.columns, page.index));
        this.options.onProgress(page.startRow + page.rowCount);
      }
    }

    this.options.signal.throwIfAborted();
    const output = await this.register(RESULT_FILE);
    const projection = selectedFields(this.result, this.options.columns)
      .map((field, index) => `${quoteIdentifier(`c${index}`)} AS ${quoteIdentifier(field.name)}`)
      .join(', ');
    const paths = shards.map(quoteString).join(', ');
    await this.runStatement(
      `COPY (SELECT ${projection} FROM parquet_scan([${paths}])) TO ${quoteString(output)} ` +
        '(FORMAT PARQUET, COMPRESSION SNAPPY)',
    );

    const cleanupErrors = await this.releaseHandles();
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'Parquet output was written but its DuckDB handles could not be released.',
      );
    }
    this.options.signal.throwIfAborted();
    const file = await this.files.file(RESULT_FILE);
    this.options.signal.throwIfAborted();
    return { file, dispose: () => this.files.dispose() };
  }

  async fail(primary: unknown): Promise<never> {
    const cleanupErrors = await this.releaseHandles();
    try {
      await this.files.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    throw combineErrors(primary, cleanupErrors, 'Parquet export failed and cleanup was incomplete.');
  }

  private async writeShard(table: Table, columns: readonly number[], index: number): Promise<string> {
    this.options.signal.throwIfAborted();
    const selected = renameSelectedColumns(table, columns);
    const copy = tableToIPC(selected, 'stream').slice();
    await this.connection.insertArrowFromIPCStream(copy, { name: PAGE_TABLE, create: true });
    const path = await this.register(`shard-${index}.parquet`);
    let primary: unknown = null;
    try {
      await this.runStatement(
        `COPY ${quoteIdentifier(PAGE_TABLE)} TO ${quoteString(path)} (FORMAT PARQUET, COMPRESSION SNAPPY)`,
      );
    } catch (error) {
      primary = error;
    }
    let cleanupError: unknown = null;
    try {
      await this.connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(PAGE_TABLE)}`);
    } catch (error) {
      cleanupError = error;
    }
    if (primary !== null && cleanupError !== null) {
      throw new AggregateError(
        [primary, cleanupError],
        'Parquet shard COPY and temporary-table cleanup failed.',
        { cause: primary },
      );
    }
    if (cleanupError !== null) throw cleanupError;
    if (primary !== null) throw primary;
    return path;
  }

  private async register(name: string): Promise<string> {
    const path = this.files.path(name);
    await this.dependencies.database.registerOPFSFileName(path);
    this.registeredPaths.push(path);
    return path;
  }

  private async runStatement(sql: string): Promise<void> {
    this.options.signal.throwIfAborted();
    let cancel: Promise<boolean> | null = null;
    const abort = () => {
      cancel ??= this.connection.cancelSent();
    };
    this.options.signal.addEventListener('abort', abort, { once: true });
    let primary: unknown = null;
    try {
      const reader = await this.connection.send(sql, true);
      for await (const batch of reader) void batch;
      this.options.signal.throwIfAborted();
    } catch (error) {
      primary = error;
    } finally {
      this.options.signal.removeEventListener('abort', abort);
    }
    if (cancel) {
      try {
        await cancel;
      } catch (error) {
        if (primary !== null) {
          throw new AggregateError([primary, error], 'Parquet statement cancellation failed.', {
            cause: error,
          });
        }
        throw error;
      }
    }
    if (primary !== null) throw primary;
  }

  private async releaseHandles(): Promise<unknown[]> {
    const errors: unknown[] = [];
    try {
      await this.connection.close();
    } catch (error) {
      errors.push(error);
    }
    for (const path of this.registeredPaths) {
      try {
        await this.dependencies.database.dropFile(path);
      } catch (error) {
        errors.push(error);
      }
    }
    this.registeredPaths.length = 0;
    return errors;
  }
}

export async function writeParquet(
  dependencies: ParquetWriterDependencies,
  result: QueryResultView,
  options: ParquetExportOptions,
): Promise<ParquetArtifact> {
  selectedFields(result, options.columns);
  options.signal.throwIfAborted();
  const files = await dependencies.createFiles();
  let connection: AsyncDuckDBConnection;
  try {
    connection = await dependencies.connect();
  } catch (error) {
    try {
      await files.dispose();
    } catch (cleanupError) {
      throw combineErrors(error, [cleanupError], 'Parquet export setup failed and cleanup was incomplete.');
    }
    throw error;
  }
  const writer = new ParquetWriter(dependencies, connection, files, result, options);
  try {
    return await writer.write();
  } catch (error) {
    return writer.fail(error);
  }
}

export const defaultParquetWriterDependencies = (database: AsyncDuckDB): ParquetWriterDependencies => ({
  database,
  connect: () => database.connect(),
  createFiles: createExportFiles,
});
