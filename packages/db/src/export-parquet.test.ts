import {
  Binary,
  Bool,
  DateDay,
  DateMillisecond,
  Decimal,
  Dictionary,
  Field,
  FixedSizeBinary,
  Float16,
  Float32,
  Float64,
  Int8,
  Int16,
  Int32,
  Int64,
  LargeBinary,
  LargeUtf8,
  List,
  Null,
  Schema,
  Struct,
  Table,
  TimeMicrosecond,
  TimeNanosecond,
  TimeSecond,
  TimestampMicrosecond,
  TimestampMillisecond,
  TimestampNanosecond,
  TimestampSecond,
  Uint8,
  Uint16,
  Uint32,
  Uint64,
  Utf8,
  tableFromIPC,
  vectorFromArray,
} from 'apache-arrow';
import { describe, expect, it, vi } from 'vitest';

import { writeParquet } from './export-parquet.js';
import { isSupportedParquetType } from './export-types.js';
import { parquetColumnNames } from './result-columns.js';
import type { QuerySession } from './types.js';
import { withResultLabels } from '../test-support/result-columns.js';

const asyncReader = () => ({
  async *[Symbol.asyncIterator]() {
    yield new Table();
  },
});

const querySession = (tables: readonly Table[], schema = tables[0]?.schema ?? new Schema()): QuerySession => {
  const pages = tables.map((table, index) => ({
    index: index * 2 + 1,
    startRow: tables.slice(0, index).reduce((rows, page) => rows + page.numRows, 0),
    rowCount: table.numRows,
  }));
  return {
    schema,
    status: () => ({
      loadedRows: tables.reduce((rows, table) => rows + table.numRows, 0),
      complete: true,
      elapsedMs: 1,
      storedBytes: 1,
      decodedBytes: 1,
      sendCount: 1,
    }),
    pages: () => pages,
    fetchNext: vi.fn(),
    retryPending: vi.fn(),
    readPage: vi.fn(async (index: number) => {
      const position = pages.findIndex((page) => page.index === index);
      if (position < 0) throw new Error(`missing page ${index}`);
      return { ...pages[position]!, table: tables[position]! };
    }),
    pinPages: vi.fn(),
    materialize: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
};

const parquetOptions = (
  result: QuerySession,
  columns: readonly number[],
  overrides: Partial<{ signal: AbortSignal; onProgress(rows: number): void }> = {},
) => ({
  columns,
  columnNames: parquetColumnNames(result.schema, columns).map(({ name }) => name),
  signal: overrides.signal ?? new AbortController().signal,
  onProgress: overrides.onProgress ?? vi.fn(),
});

const environment = () => {
  const files = {
    path: vi.fn((name: string) => `opfs://byteql-exports/tab/export/${name}`),
    file: vi.fn(async (name: string) => new File(['parquet'], name)),
    createWritable: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const connection = {
    query: vi.fn().mockResolvedValue(new Table()),
    send: vi.fn().mockResolvedValue(asyncReader()),
    insertArrowFromIPCStream: vi.fn().mockResolvedValue(undefined),
    cancelSent: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const database = {
    registerOPFSFileName: vi.fn().mockResolvedValue(undefined),
    dropFile: vi.fn().mockResolvedValue(null),
  };
  return {
    files,
    connection,
    database,
    dependencies: {
      database,
      connect: vi.fn().mockResolvedValue(connection),
      createFiles: vi.fn().mockResolvedValue(files),
    },
  };
};

describe('writeParquet', () => {
  it('imports selected columns as cN shards in captured page order and restores original aliases', async () => {
    const first = new Table({
      ignored: vectorFromArray([90, 91], new Int32()),
      'quoted"name': vectorFromArray(['first', 'second'], new Utf8()),
      value: vectorFromArray([10, 11], new Int32()),
    });
    const second = new Table({
      ignored: vectorFromArray([92], new Int32()),
      'quoted"name': vectorFromArray(['third'], new Utf8()),
      value: vectorFromArray([12], new Int32()),
    });
    const result = querySession([first, second]);
    const { dependencies, connection, database, files } = environment();
    const progress = vi.fn();

    const artifact = await writeParquet(
      dependencies,
      result,
      parquetOptions(result, [2, 1], { onProgress: progress }),
    );

    expect(result.readPage).toHaveBeenCalledTimes(2);
    expect(result.fetchNext).not.toHaveBeenCalled();
    const imports = connection.insertArrowFromIPCStream.mock.calls.map(([ipc, options]) => ({
      table: tableFromIPC(ipc as Uint8Array),
      options,
    }));
    expect(imports.map(({ table }) => table.schema.fields.map((field) => field.name))).toEqual([
      ['c0', 'c1', '__byteql_export_ordinal'],
      ['c0', 'c1', '__byteql_export_ordinal'],
    ]);
    // Ordinals follow the DISPLAY start row of each page, not the page index, so a parallel scan
    // over the shards can still be put back into the order the user is looking at.
    expect(imports.map(({ table }) => Array.from(table.getChild('__byteql_export_ordinal')!))).toEqual([
      [0n, 1n],
      [2n],
    ]);
    expect(imports.map(({ table }) => Array.from(table.getChild('c0')!))).toEqual([[10, 11], [12]]);
    expect(imports.map(({ table }) => Array.from(table.getChild('c1')!))).toEqual([
      ['first', 'second'],
      ['third'],
    ]);
    expect(imports.map(({ options }) => options)).toEqual([
      { name: '__byteql_export_page', create: true },
      { name: '__byteql_export_page', create: true },
    ]);
    expect(progress.mock.calls).toEqual([[2], [3]]);

    const sent = connection.send.mock.calls.map(([sql, allowStreamResult]) => ({
      sql: String(sql),
      allowStreamResult,
    }));
    expect(sent).toHaveLength(3);
    expect(sent.every(({ allowStreamResult }) => allowStreamResult === true)).toBe(true);
    expect(sent[2]!.sql).toContain(
      "parquet_scan(['opfs://byteql-exports/tab/export/shard-1.parquet', 'opfs://byteql-exports/tab/export/shard-3.parquet'])",
    );
    expect(sent[2]!.sql).toContain('SELECT "c0" AS "value", "c1" AS "quoted""name"');
    // The final scan is explicitly ordered, and the private ordinal is not among the columns the
    // file ends up carrying.
    expect(sent[2]!.sql).toContain('ORDER BY "__byteql_export_src"."__byteql_export_ordinal" ASC');
    expect(sent[2]!.sql.split('FROM parquet_scan')[0]).not.toContain('__byteql_export_ordinal');
    expect(database.registerOPFSFileName.mock.calls.map(([path]) => path)).toEqual([
      'opfs://byteql-exports/tab/export/shard-1.parquet',
      'opfs://byteql-exports/tab/export/shard-3.parquet',
      'opfs://byteql-exports/tab/export/result.parquet',
    ]);
    expect(connection.close).toHaveBeenCalledOnce();
    expect(database.dropFile).toHaveBeenCalledTimes(3);
    expect(files.file).toHaveBeenCalledWith('result.parquet');
    expect(artifact.file.name).toBe('result.parquet');
    expect(files.dispose).not.toHaveBeenCalled();
    await artifact.dispose();
    expect(files.dispose).toHaveBeenCalledOnce();
  });

  it('imports the selected empty schema and emits a readable zero-row final file', async () => {
    const schema = new Schema([
      new Field('ignored', new Int32(), false),
      new Field('label', new Utf8(), true),
    ]);
    const result = querySession([], schema);
    const { dependencies, connection } = environment();

    await writeParquet(dependencies, result, parquetOptions(result, [1]));

    expect(connection.insertArrowFromIPCStream).toHaveBeenCalledOnce();
    const imported = tableFromIPC(connection.insertArrowFromIPCStream.mock.calls[0]![0] as Uint8Array);
    expect(imported.numRows).toBe(0);
    expect(
      imported.schema.fields.map((field) => ({
        name: field.name,
        type: field.type.toString(),
        nullable: field.nullable,
      })),
    ).toEqual([
      { name: 'c0', type: 'Utf8', nullable: true },
      { name: '__byteql_export_ordinal', type: 'Uint64', nullable: false },
    ]);
  });

  it('orders by display position when pages start late and their indexes are not contiguous', async () => {
    // A sorted view's pages are contiguous by start row but need not be by index; an export must
    // follow the start rows.
    const table = new Table({ value: vectorFromArray([7, 8, 9], new Int32()) });
    const pages = [
      { index: 4, startRow: 0, rowCount: 1 },
      { index: 9, startRow: 1, rowCount: 2 },
    ];
    const result = {
      schema: table.schema,
      status: () => ({
        loadedRows: 3,
        complete: true,
        elapsedMs: 1,
        storedBytes: 1,
        decodedBytes: 1,
        sendCount: 1,
      }),
      pages: () => pages,
      readPage: async (index: number) => ({
        ...pages.find((page) => page.index === index)!,
        table: index === 4 ? table.slice(0, 1) : table.slice(1, 3),
      }),
      pinPages: vi.fn(),
      materialize: vi.fn(),
      dispose: vi.fn(),
    } as unknown as QuerySession;
    const { dependencies, connection, database } = environment();

    await writeParquet(dependencies, result, parquetOptions(result, [0]));

    const imports = connection.insertArrowFromIPCStream.mock.calls.map(([ipc]) =>
      Array.from(tableFromIPC(ipc as Uint8Array).getChild('__byteql_export_ordinal')!),
    );
    expect(imports).toEqual([[0n], [1n, 2n]]);
    expect(database.registerOPFSFileName.mock.calls.map(([path]) => path)).toEqual([
      'opfs://byteql-exports/tab/export/shard-4.parquet',
      'opfs://byteql-exports/tab/export/shard-9.parquet',
      'opfs://byteql-exports/tab/export/result.parquet',
    ]);
  });

  it('keeps a user column named like the private ordinal separate from it', async () => {
    const table = new Table({
      __byteql_export_ordinal: vectorFromArray(['a', 'b'], new Utf8()),
      value: vectorFromArray([5, 6], new Int32()),
    });
    const result = querySession([table]);
    const { dependencies, connection } = environment();

    await writeParquet(dependencies, result, parquetOptions(result, [0, 1]));

    const imported = tableFromIPC(connection.insertArrowFromIPCStream.mock.calls[0]![0] as Uint8Array);
    // The user's column is staged positionally as c0; only the appended ordinal carries the
    // private name, so nothing collides and nothing is dropped.
    expect(imported.schema.fields.map((field) => field.name)).toEqual([
      'c0',
      'c1',
      '__byteql_export_ordinal',
    ]);
    expect(Array.from(imported.getChild('c0')!)).toEqual(['a', 'b']);
    expect(Array.from(imported.getChild('__byteql_export_ordinal')!)).toEqual([0n, 1n]);
    const sent = connection.send.mock.calls.map(([sql]) => String(sql));
    expect(sent.at(-1)).toContain('"c0" AS "__byteql_export_ordinal"');
    // The ordering must bind to the scanned shard column, never to the identically named output
    // alias, or the file would come out in the user column's order instead of the display's.
    expect(sent.at(-1)).toContain('ORDER BY "__byteql_export_src"."__byteql_export_ordinal" ASC');
  });

  it('writes the validated deterministic names for collisions, quotes, empty labels, and the ordinal name', async () => {
    const table = withResultLabels(
      new Table({
        c0: vectorFromArray([1], new Int32()),
        c1: vectorFromArray([2], new Int32()),
        c2: vectorFromArray([3], new Int32()),
        c3: vectorFromArray([4], new Int32()),
        c4: vectorFromArray([5], new Int32()),
        c5: vectorFromArray([6], new Int32()),
      }),
      ['dup', 'DUP', 'dup_2', 'quoted"name', '__byteql_export_ordinal', ''],
    );
    const result = querySession([table]);
    const { dependencies, connection } = environment();
    const options = parquetOptions(result, [0, 1, 2, 3, 4, 5]);

    expect(options.columnNames).toEqual([
      'dup',
      'DUP_3',
      'dup_2',
      'quoted"name',
      '__byteql_export_ordinal',
      'column_6',
    ]);
    await writeParquet(dependencies, result, options);

    expect(String(connection.send.mock.calls.at(-1)?.[0])).toContain(
      'SELECT "c0" AS "dup", "c1" AS "DUP_3", "c2" AS "dup_2", ' +
        '"c3" AS "quoted""name", "c4" AS "__byteql_export_ordinal", "c5" AS "column_6"',
    );
  });

  it.each([
    ['a length mismatch', ['dup']],
    ['reordered names', ['dup_3', 'dup', 'dup_2']],
    ['duplicate names', ['dup', 'dup', 'dup_2']],
    ['stale names', ['dup', 'dup_2', 'dup_3']],
  ])('rejects %s before allocating export resources', async (_case, columnNames) => {
    const table = withResultLabels(
      new Table({
        c0: vectorFromArray([1], new Int32()),
        c1: vectorFromArray([2], new Int32()),
        c2: vectorFromArray([3], new Int32()),
      }),
      ['dup', 'dup', 'dup_2'],
    );
    const result = querySession([table]);
    const { dependencies, connection, database } = environment();

    await expect(
      writeParquet(dependencies, result, {
        columns: [0, 1, 2],
        columnNames,
        signal: new AbortController().signal,
        onProgress: vi.fn(),
      }),
    ).rejects.toThrow('Parquet column names no longer match the selected result.');
    expect(dependencies.createFiles).not.toHaveBeenCalled();
    expect(dependencies.connect).not.toHaveBeenCalled();
    expect(connection.send).not.toHaveBeenCalled();
    expect(database.registerOPFSFileName).not.toHaveBeenCalled();
  });

  it('rejects unsupported selected columns before acquiring export resources', async () => {
    const schema = new Schema([new Field('events', new List(new Field('item', new Int32(), true)), true)]);
    const result = querySession([], schema);
    const { dependencies } = environment();

    await expect(writeParquet(dependencies, result, parquetOptions(result, [0]))).rejects.toThrow(
      /events.*unsupported.*cast/i,
    );
    expect(dependencies.createFiles).not.toHaveBeenCalled();
    expect(dependencies.connect).not.toHaveBeenCalled();
  });

  it('gives exact temporal cast guidance when timestamp units would be normalized', async () => {
    const schema = new Schema([new Field('observed_at', new TimestampMillisecond(), true)]);
    const result = querySession([], schema);
    const { dependencies } = environment();

    await expect(writeParquet(dependencies, result, parquetOptions(result, [0]))).rejects.toThrow(
      /observed_at.*TIMESTAMP or TIMESTAMP_NS/i,
    );
    expect(dependencies.createFiles).not.toHaveBeenCalled();
  });

  it('settles a failed COPY then closes only export-owned handles and reports cleanup failure', async () => {
    const result = querySession([new Table({ value: vectorFromArray([1], new Int32()) })]);
    const { dependencies, connection, database, files } = environment();
    const copyFailure = new Error('COPY failed');
    const cleanupFailure = new Error('owned directory cleanup failed');
    connection.send.mockRejectedValueOnce(copyFailure);
    files.dispose.mockRejectedValueOnce(cleanupFailure);

    const failure = await writeParquet(dependencies, result, parquetOptions(result, [0])).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([copyFailure, cleanupFailure]);
    expect(connection.close).toHaveBeenCalledOnce();
    expect(database.dropFile).toHaveBeenCalledOnce();
    expect(files.dispose).toHaveBeenCalledOnce();
  });

  it('preserves the COPY failure when dropping its temporary table also fails', async () => {
    const result = querySession([new Table({ value: vectorFromArray([1], new Int32()) })]);
    const { dependencies, connection } = environment();
    const copyFailure = new Error('COPY failed');
    const dropFailure = new Error('temporary table drop failed');
    connection.send.mockRejectedValueOnce(copyFailure);
    connection.query.mockRejectedValueOnce(dropFailure);

    const failure = await writeParquet(dependencies, result, parquetOptions(result, [0])).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([copyFailure, dropFailure]);
    expect((failure as AggregateError).cause).toBe(copyFailure);
  });

  it('cancels the export connection statement and waits for it to settle before cleanup', async () => {
    const result = querySession([new Table({ value: vectorFromArray([1], new Int32()) })]);
    const { dependencies, connection, database } = environment();
    const controller = new AbortController();
    let rejectCopy!: (error: unknown) => void;
    connection.send.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectCopy = reject;
        }),
    );
    connection.cancelSent.mockImplementationOnce(async () => {
      rejectCopy(new DOMException('query was canceled', 'AbortError'));
      return true;
    });

    const exportPromise = writeParquet(
      dependencies,
      result,
      parquetOptions(result, [0], { signal: controller.signal }),
    );
    await vi.waitFor(() => expect(connection.send).toHaveBeenCalledOnce());
    controller.abort();
    await expect(exportPromise).rejects.toMatchObject({ name: 'AbortError' });

    expect(connection.cancelSent).toHaveBeenCalledOnce();
    expect(connection.cancelSent.mock.invocationCallOrder[0]).toBeLessThan(
      connection.close.mock.invocationCallOrder[0]!,
    );
    expect(connection.close.mock.invocationCallOrder[0]).toBeLessThan(
      database.dropFile.mock.invocationCallOrder[0]!,
    );
  });

  it('rejects and disposes owned files when cancellation arrives during the final file handoff', async () => {
    const result = querySession([new Table({ value: vectorFromArray([1], new Int32()) })]);
    const { dependencies, files } = environment();
    const controller = new AbortController();
    let resolveFile!: (file: File) => void;
    files.file.mockImplementationOnce(
      () =>
        new Promise<File>((resolve) => {
          resolveFile = resolve;
        }),
    );

    const exporting = writeParquet(
      dependencies,
      result,
      parquetOptions(result, [0], { signal: controller.signal }),
    );
    await vi.waitFor(() => expect(files.file).toHaveBeenCalledOnce());
    controller.abort();
    resolveFile(new File(['complete'], 'result.parquet'));

    await expect(exporting).rejects.toMatchObject({ name: 'AbortError' });
    expect(files.dispose).toHaveBeenCalledOnce();
  });
});

describe('isSupportedParquetType', () => {
  it('accepts every ordinary DuckDB scalar width and temporal unit covered by browser readback', () => {
    const supported = [
      new Int8(),
      new Int16(),
      new Int32(),
      new Int64(),
      new Uint8(),
      new Uint16(),
      new Uint32(),
      new Uint64(),
      new Float32(),
      new Float64(),
      new Decimal(9, 38, 128),
      new Bool(),
      new Utf8(),
      new Binary(),
      new DateDay(),
      new TimeMicrosecond(),
      new TimestampMicrosecond(),
      new TimestampNanosecond(),
      new TimestampMicrosecond('UTC'),
    ];

    expect(supported.every(isSupportedParquetType)).toBe(true);
  });

  it('rejects unproven or lossy Arrow variants instead of inheriting the broader CSV policy', () => {
    const unsupported = [
      new Null(),
      new Float16(),
      new Decimal(9, 38, 256),
      new LargeUtf8(),
      new LargeBinary(),
      new FixedSizeBinary(2),
      new DateMillisecond(),
      new TimeSecond(),
      new TimeNanosecond(),
      new TimestampSecond(),
      new TimestampMillisecond(),
      new Dictionary(new Utf8(), new Int8()),
    ];

    expect(unsupported.every((type) => !isSupportedParquetType(type))).toBe(true);
  });

  it('admits the source ranges shape for Parquet export', () => {
    const type = new List(
      new Field(
        'item',
        new Struct([new Field('start', new Uint64(), true), new Field('end', new Uint64(), true)]),
        true,
      ),
    );
    expect(isSupportedParquetType(type)).toBe(true);
    expect(isSupportedParquetType(new List(new Field('item', new Uint64(), true)))).toBe(false);
  });
});
