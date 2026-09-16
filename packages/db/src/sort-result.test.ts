import {
  Field,
  Int32,
  List,
  RecordBatch,
  Schema,
  Table,
  Utf8,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
} from 'apache-arrow';
import { Table as DuckdbTable, tableFromIPC as duckdbTableFromIPC } from 'apache-arrow-duckdb';
import { describe, expect, it, vi } from 'vitest';

import { QueryPageStore } from './query-pages.js';
import { RESULT_LABEL_METADATA_KEY, resultColumnLabel } from './result-columns.js';
import { ResultSortError, SORT_ORDINAL_COLUMN, type ResultSortProgress } from './result-sort.js';
import { writeSortedResult, type ResultSortDependencies } from './sort-result.js';
import { QUERY_PAGE_ROWS, type QueryPage, type QuerySession } from './types.js';

const page = (values: number[], labels?: string[]): Table =>
  new Table({
    value: vectorFromArray(Int32Array.from(values)),
    label: vectorFromArray(labels ?? values.map((value) => `v${value}`), new Utf8()),
  });

const duplicateLabelPage = (integers: readonly number[], strings: readonly string[]): Table => {
  const built = new Table({
    c0: vectorFromArray(Int32Array.from(integers)),
    c1: vectorFromArray(strings, new Utf8()),
  });
  const label = new Map([[RESULT_LABEL_METADATA_KEY, 'dup']]);
  const schema = new Schema([
    new Field('c0', new Int32(), true, label),
    new Field('c1', new Utf8(), true, label),
  ]);
  return new Table(
    schema,
    built.batches.map((batch) => new RecordBatch(schema, batch.data)),
  );
};

interface FakeBase extends QuerySession {
  readonly reads: number[];
  readonly fetchNextCalls: number;
  readonly cancelCalls: number;
  readonly disposeCalls: number;
}

const fakeBase = (pages: Table[], options: { complete?: boolean; schema?: Schema } = {}): FakeBase => {
  const summaries = pages.map((table, index) => ({
    index: index * 2 + 1,
    startRow: pages.slice(0, index).reduce((rows, previous) => rows + previous.numRows, 0),
    rowCount: table.numRows,
  }));
  const reads: number[] = [];
  const base = {
    reads,
    fetchNextCalls: 0,
    cancelCalls: 0,
    disposeCalls: 0,
    schema: options.schema ?? pages[0]?.schema ?? new Schema(),
    status: () => ({
      loadedRows: summaries.reduce((rows, summary) => rows + summary.rowCount, 0),
      complete: options.complete ?? true,
      elapsedMs: 42,
      storedBytes: 11,
      decodedBytes: 7,
      sendCount: 1,
    }),
    pages: () => summaries,
    readPage: async (index: number): Promise<QueryPage> => {
      const position = summaries.findIndex((summary) => summary.index === index);
      if (position < 0) throw new Error(`missing page ${String(index)}`);
      reads.push(index);
      return { ...summaries[position]!, table: pages[position]! };
    },
    pinPages: vi.fn(),
    materialize: vi.fn(),
    fetchNext: vi.fn(async () => {
      base.fetchNextCalls += 1;
      return null;
    }),
    retryPending: vi.fn(),
    cancel: vi.fn(async () => {
      base.cancelCalls += 1;
      return false;
    }),
    dispose: vi.fn(async () => {
      base.disposeCalls += 1;
    }),
  };
  return base as unknown as FakeBase;
};

/**
 * Turns an Arrow 21 table into the Arrow 17 batches a DuckDB reader would yield. It crosses the
 * version boundary through IPC for the same reason production does: the two packages' Table types
 * are not interchangeable, and casting one to the other hands the wrong prototypes downstream.
 */
const duckdbBatches = (table: Table) => {
  const bridged = duckdbTableFromIPC(tableToIPC(table, 'stream'));
  return { schema: bridged.schema, batches: bridged.batches };
};

interface EnvironmentOptions {
  /** The sorted output the fake DuckDB reader yields, as Arrow 21 tables. */
  readonly output?: Table[];
  readonly gate?: Promise<void>;
}

const environment = (options: EnvironmentOptions = {}) => {
  const statements: string[] = [];
  const registered = new Set<string>();
  const cleanupFailures: Array<{ retry: () => Promise<void>; error: unknown }> = [];
  const stores: QueryPageStore[] = [];
  const files = {
    path: vi.fn((name: string) => `opfs://byteql-exports/tab/sort/${name}`),
    file: vi.fn(),
    createWritable: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const inserted: Array<{ name: string; create: boolean; table: Table }> = [];

  const reader = () => {
    const bridged = (options.output ?? []).map(duckdbBatches);
    const batches = bridged.flatMap((entry) => entry.batches);
    return {
      schema: bridged[0]?.schema ?? duckdbBatches(new Table()).schema,
      async *[Symbol.asyncIterator]() {
        for (const batch of batches) {
          if (options.gate) await options.gate;
          yield batch;
        }
      },
    };
  };

  let signalOrdering!: () => void;
  /** Resolves once the ordering statement has been sent, so a test can abort mid-statement. */
  const orderingStarted = new Promise<void>((resolve) => {
    signalOrdering = resolve;
  });
  const connection = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      return new DuckdbTable();
    }),
    send: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (!sql.startsWith('SELECT')) return { async *[Symbol.asyncIterator]() {} };
      signalOrdering();
      return reader();
    }),
    insertArrowFromIPCStream: vi.fn(async (ipc: Uint8Array, opts: { name: string; create?: boolean }) => {
      inserted.push({
        name: opts.name,
        create: opts.create ?? true,
        table: tableFromIPC(ipc),
      });
    }),
    cancelSent: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const database = {
    registerOPFSFileName: vi.fn(async (path: string) => {
      registered.add(path);
    }),
    dropFile: vi.fn(async (path: string) => {
      registered.delete(path);
      return null;
    }),
  };
  const dependencies: ResultSortDependencies = {
    database,
    connect: vi.fn().mockResolvedValue(connection),
    createFiles: vi.fn().mockResolvedValue(files),
    createStore: vi.fn(async () => {
      const store = new QueryPageStore({ persistence: null });
      stores.push(store);
      return store;
    }),
    onCleanupFailure: (retry, error) => cleanupFailures.push({ retry, error }),
  };
  return {
    dependencies,
    connection,
    database,
    files,
    statements,
    registered,
    inserted,
    stores,
    cleanupFailures,
    orderingStarted,
  };
};

const sortOptions = (overrides: Partial<Parameters<typeof writeSortedResult>[2]> = {}) => {
  const progress: ResultSortProgress[] = [];
  return {
    progress,
    options: {
      sort: { columnIndex: 0, direction: 'asc' as const },
      signal: new AbortController().signal,
      onProgress: (entry: ResultSortProgress) => progress.push(entry),
      ...overrides,
    },
  };
};

const readAll = async (view: Awaited<ReturnType<typeof writeSortedResult>>): Promise<number[]> => {
  const rows: number[] = [];
  for (const summary of view.pages()) {
    rows.push(...Array.from((await view.readPage(summary.index)).table.getChildAt(0)!));
  }
  return rows;
};

describe('writeSortedResult', () => {
  it('never advances, cancels or disposes the base result', async () => {
    const base = fakeBase([page([3, 1]), page([2])]);
    const { options } = sortOptions();
    const view = await writeSortedResult(
      environment({ output: [page([1, 2, 3])] }).dependencies,
      base,
      options,
    );

    expect(base.fetchNextCalls).toBe(0);
    expect(base.cancelCalls).toBe(0);
    expect(base.disposeCalls).toBe(0);
    expect(await readAll(view)).toEqual([1, 2, 3]);
  });

  it('reads each base page exactly once, in summary start-row order', async () => {
    const base = fakeBase([page([3, 1]), page([2]), page([9])]);
    const { options } = sortOptions();
    await writeSortedResult(environment({ output: [page([1, 2, 3, 9])] }).dependencies, base, options);
    expect(base.reads).toEqual([1, 3, 5]);
  });

  it('resolves only once the sorted output has reached EOF', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = fakeBase([page([2, 1])]);
    const { options } = sortOptions();
    const pending = writeSortedResult(
      environment({ output: [page([1, 2])], gate }).dependencies,
      base,
      options,
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await pending;
    expect(settled).toBe(true);
  });

  it('stages each page with a private ordinal and keeps it out of the published pages', async () => {
    const base = fakeBase([page([3, 1]), page([2])]);
    const environments = environment({ output: [page([1, 2, 3])] });
    const { options } = sortOptions();
    const view = await writeSortedResult(environments.dependencies, base, options);

    const appended = environments.inserted.filter((entry) => !entry.create);
    expect(appended).toHaveLength(2);
    expect(appended[0]!.table.schema.fields.map((field) => field.name)).toEqual([
      'c0',
      'c1',
      SORT_ORDINAL_COLUMN,
    ]);
    // The second page's ordinals continue from the first page's start row.
    expect(Array.from(appended[1]!.table.getChild(SORT_ORDINAL_COLUMN)!)).toEqual([2n]);
    for (const summary of view.pages()) {
      const table = (await view.readPage(summary.index)).table;
      expect(table.schema.fields.map((field) => field.name)).toEqual(['value', 'label']);
    }
    expect(view.schema).toBe(base.schema);
  });

  it('sorts a duplicate label by physical position and restores both logical labels', async () => {
    const base = fakeBase([duplicateLabelPage([20, 10, 30], ['alpha', 'zulu', 'mike'])]);
    const environments = environment({
      output: [duplicateLabelPage([20, 30, 10], ['alpha', 'mike', 'zulu'])],
    });
    const { options } = sortOptions({ sort: { columnIndex: 1, direction: 'asc' } });
    const view = await writeSortedResult(environments.dependencies, base, options);
    const restored = await view.materialize();

    expect(environments.statements.find((sql) => sql.startsWith('SELECT'))).toContain(
      'ORDER BY "c1" ASC NULLS LAST',
    );
    expect(restored!.schema.fields.map((field) => field.name)).toEqual(['c0', 'c1']);
    expect(restored!.schema.fields.map(resultColumnLabel)).toEqual(['dup', 'dup']);
    expect(restored!.schema.fields.map((field) => field.type.toString())).toEqual(['Int32', 'Utf8']);
    expect([...restored!.getChildAt(0)!]).toEqual([20, 30, 10]);
    expect([...restored!.getChildAt(1)!]).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('stages through a connection-local TEMP table under a generated seed name', async () => {
    const base = fakeBase([page([2, 1])]);
    const environments = environment({ output: [page([1, 2])] });
    const { options } = sortOptions();
    await writeSortedResult(environments.dependencies, base, options);

    const seed = environments.inserted.find((entry) => entry.create)!.name;
    expect(seed).toMatch(/^__byteql_sort_seed_[0-9a-f]{32}$/u);
    expect(environments.statements).toContain(
      `CREATE TEMP TABLE "__byteql_sort_page" AS SELECT * FROM "${seed}" WHERE false`,
    );
    expect(environments.statements).toContain(`DROP TABLE "${seed}"`);
    expect(environments.statements).toContain('TRUNCATE "__byteql_sort_page"');
  });

  it('bounds every stored page at QUERY_PAGE_ROWS even for one huge reader batch', async () => {
    const rows = QUERY_PAGE_ROWS * 2 + 5;
    const values = Array.from({ length: rows }, (_, index) => index);
    const base = fakeBase([page(values)]);
    const { options } = sortOptions();
    const view = await writeSortedResult(environment({ output: [page(values)] }).dependencies, base, options);

    const summaries = view.pages();
    expect(summaries.every((summary) => summary.rowCount <= QUERY_PAGE_ROWS)).toBe(true);
    expect(summaries.reduce((total, summary) => total + summary.rowCount, 0)).toBe(rows);
    expect(view.status().loadedRows).toBe(rows);
    expect(await readAll(view)).toEqual(values);
  });

  it('reports staging, sorting and storing progress against the real total', async () => {
    const base = fakeBase([page([3, 1]), page([2])]);
    const { options, progress } = sortOptions();
    await writeSortedResult(environment({ output: [page([1, 2, 3])] }).dependencies, base, options);

    expect(progress.filter((entry) => entry.phase === 'staging').at(-1)).toEqual({
      phase: 'staging',
      rows: 3,
      totalRows: 3,
    });
    expect(progress.some((entry) => entry.phase === 'sorting')).toBe(true);
    expect(progress.filter((entry) => entry.phase === 'storing').at(-1)).toEqual({
      phase: 'storing',
      rows: 3,
      totalRows: 3,
    });
  });

  it('releases the connection, the registered paths and the scratch files on success', async () => {
    const base = fakeBase([page([2, 1])]);
    const environments = environment({ output: [page([1, 2])] });
    const { options } = sortOptions();
    await writeSortedResult(environments.dependencies, base, options);

    expect(environments.connection.close).toHaveBeenCalledTimes(1);
    expect(environments.registered.size).toBe(0);
    expect(environments.files.dispose).toHaveBeenCalledTimes(1);
    expect(environments.cleanupFailures).toEqual([]);
  });

  it('rejects an incomplete base before acquiring anything', async () => {
    const base = fakeBase([page([1])], { complete: false });
    const environments = environment();
    const { options } = sortOptions();
    await expect(writeSortedResult(environments.dependencies, base, options)).rejects.toMatchObject({
      code: 'SORT_FAILED',
    });
    expect(environments.dependencies.createFiles).not.toHaveBeenCalled();
    expect(environments.dependencies.connect).not.toHaveBeenCalled();
  });

  it('rejects an unsupported field anywhere in the schema, by code', async () => {
    const schema = new Schema([
      new Field('value', new Int32(), true),
      new Field('details', new List(new Field('item', new Int32(), true)), true),
    ]);
    const base = fakeBase([page([1])], { schema });
    const environments = environment();
    const { options } = sortOptions();
    await expect(writeSortedResult(environments.dependencies, base, options)).rejects.toMatchObject({
      code: 'SORT_UNSUPPORTED_TYPE',
    });
    expect(environments.dependencies.connect).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range sort column before acquiring anything', async () => {
    const base = fakeBase([page([1])]);
    const environments = environment();
    const { options } = sortOptions({ sort: { columnIndex: 9, direction: 'asc' } });
    await expect(writeSortedResult(environments.dependencies, base, options)).rejects.toBeInstanceOf(
      ResultSortError,
    );
    expect(environments.dependencies.createFiles).not.toHaveBeenCalled();
  });

  it('fails and disposes the candidate when the sorted row count disagrees with the base', async () => {
    const base = fakeBase([page([3, 1]), page([2])]);
    const environments = environment({ output: [page([1, 2])] });
    const { options } = sortOptions();
    await expect(writeSortedResult(environments.dependencies, base, options)).rejects.toMatchObject({
      code: 'SORT_FAILED',
    });
    expect(environments.stores).toHaveLength(1);
    expect(() => environments.stores[0]!.get(0)).toThrow(/disposed/iu);
    expect(environments.registered.size).toBe(0);
    expect(environments.files.dispose).toHaveBeenCalled();
    expect(base.disposeCalls).toBe(0);
  });

  it.each([
    ['createFiles', 'createFiles'],
    ['connect', 'connect'],
    ['createStore', 'createStore'],
  ])('cleans up when %s fails', async (_label, failing) => {
    const base = fakeBase([page([1])]);
    const environments = environment({ output: [page([1])] });
    (environments.dependencies as Record<string, unknown>)[failing] = vi
      .fn()
      .mockRejectedValue(new Error('acquisition failed'));
    const { options } = sortOptions();
    await expect(writeSortedResult(environments.dependencies, base, options)).rejects.toMatchObject({
      code: 'SORT_FAILED',
    });
    expect(base.disposeCalls).toBe(0);
    expect(environments.registered.size).toBe(0);
  });

  it('maps a storage quota failure onto SORT_STORAGE_FULL', async () => {
    const base = fakeBase([page([1])]);
    const environments = environment({ output: [page([1])] });
    environments.dependencies.createStore = vi.fn(async () => {
      const store = new QueryPageStore({ persistence: null });
      environments.stores.push(store);
      vi.spyOn(store, 'put').mockRejectedValue(
        new Error('RESULT_SPILL_QUOTA_EXCEEDED: failed to persist a page.'),
      );
      return store;
    });
    const { options } = sortOptions();
    await expect(writeSortedResult(environments.dependencies, base, options)).rejects.toMatchObject({
      code: 'SORT_STORAGE_FULL',
    });
  });

  it('maps an unavailable origin-private file system onto SORT_UNAVAILABLE', async () => {
    const base = fakeBase([page([1])]);
    const environments = environment();
    environments.dependencies.createFiles = vi
      .fn()
      .mockRejectedValue(new DOMException('no opfs', 'NotSupportedError'));
    const { options } = sortOptions();
    await expect(writeSortedResult(environments.dependencies, base, options)).rejects.toMatchObject({
      code: 'SORT_UNAVAILABLE',
    });
  });

  it('reports a cleanup failure separately and hands over a retry', async () => {
    const base = fakeBase([page([2, 1])]);
    const environments = environment({ output: [page([1, 2])] });
    const failure = new Error('handle still open');
    environments.files.dispose = vi.fn().mockRejectedValue(failure);
    const { options } = sortOptions();
    await expect(writeSortedResult(environments.dependencies, base, options)).rejects.toMatchObject({
      code: 'SORT_CLEANUP_FAILED',
    });
    expect(environments.cleanupFailures).toHaveLength(1);
    expect(environments.cleanupFailures[0]!.error).toBe(failure);
    await expect(environments.cleanupFailures[0]!.retry()).rejects.toBe(failure);
  });

  it('attempts every cleanup even when the connection refuses to close', async () => {
    const base = fakeBase([page([2, 1])]);
    const environments = environment({ output: [page([1, 2])] });
    environments.connection.close = vi.fn().mockRejectedValue(new Error('close failed'));
    const { options } = sortOptions();
    await expect(writeSortedResult(environments.dependencies, base, options)).rejects.toMatchObject({
      code: 'SORT_CLEANUP_FAILED',
    });
    expect(environments.registered.size).toBe(0);
    expect(environments.files.dispose).toHaveBeenCalled();
  });

  describe('cancellation', () => {
    it('rejects before acquiring anything when the signal is already aborted', async () => {
      const base = fakeBase([page([1])]);
      const environments = environment();
      const controller = new AbortController();
      controller.abort(new DOMException('cancelled', 'AbortError'));
      const { options } = sortOptions({ signal: controller.signal });
      await expect(writeSortedResult(environments.dependencies, base, options)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(environments.dependencies.createFiles).not.toHaveBeenCalled();
    });

    it.each([0, 1, 2])('aborts during page read %i and releases everything', async (stopAfter) => {
      const base = fakeBase([page([3]), page([1]), page([2])]);
      const environments = environment({ output: [page([1, 2, 3])] });
      const controller = new AbortController();
      let reads = 0;
      const originalRead = base.readPage.bind(base);
      base.readPage = async (index: number) => {
        const result = await originalRead(index);
        if (reads++ === stopAfter) controller.abort(new DOMException('cancelled', 'AbortError'));
        return result;
      };
      const { options } = sortOptions({ signal: controller.signal });
      await expect(writeSortedResult(environments.dependencies, base, options)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(environments.registered.size).toBe(0);
      expect(environments.files.dispose).toHaveBeenCalled();
      // Disposal, not emptiness: a store that was never disposed also reports zero bytes.
      for (const store of environments.stores) {
        expect(() => store.pin([])).toThrow(/disposed/iu);
      }
      expect(base.cancelCalls).toBe(0);
      expect(base.disposeCalls).toBe(0);
    });

    it('cancels only its own connection when aborted during the ordering statement', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const base = fakeBase([page([2, 1])]);
      const environments = environment({ output: [page([1, 2])], gate });
      const controller = new AbortController();
      const { options } = sortOptions({ signal: controller.signal });
      const pending = writeSortedResult(environments.dependencies, base, options);
      await environments.orderingStarted;
      controller.abort(new DOMException('cancelled', 'AbortError'));
      release();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(environments.connection.cancelSent).toHaveBeenCalled();
      expect(environments.connection.close).toHaveBeenCalled();
      expect(base.cancelCalls).toBe(0);
    });
  });
});
