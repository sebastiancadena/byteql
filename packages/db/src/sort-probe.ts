import { AsyncDuckDB, VoidLogger, type AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { Table, tableFromIPC, tableToIPC, type Schema } from 'apache-arrow';
import { RecordBatchStreamWriter, Table as DuckdbTable } from 'apache-arrow-duckdb';

import { LOCAL_BUNDLES } from './browser.js';
import { buildResultSortSql, resultSortRuntimeSupported, SORT_ORDINAL_COLUMN } from './result-sort.js';
import { restoreResultSchema, snapshotPage } from './result-snapshot.js';

const PAGE_ROWS = 8_192;
const PROBE_ROWS = 20_000;
const SORT_PAGE_TABLE = '__byteql_sort_page';
const NULL_KEY = '\u0000null';

export interface ResultSortProbeReport {
  variant: 'mvp' | 'eh';
  /** Whether production offers sorting at all on this bundle. */
  bundleSupportsSorting: boolean;
  /** Times the sorted result's own SQL was sent. Sorting must never resend it. */
  originalSendCount: number;
  /** Whether every staging/ordering statement stayed off the original result's connection. */
  sortConnectionIsolated: boolean;
  rowCount: number;
  valuesPreserved: boolean;
  schemaPreserved: boolean;
  tiesStable: boolean;
  nullsLast: boolean;
  cancellationSettled: boolean;
  resourcesReleased: boolean;
  externalAccessDenied: boolean;
  /** Per-fixture outcome for the typed round-trip gate; every entry must be `true`. */
  typedFixtures: Record<string, boolean>;
  /**
   * Whether the pinned runtime can ORDER BY a full-range signed key at all, measured WITHOUT any
   * of the snapshot machinery: in memory, and over a plain Parquet file it wrote itself.
   */
  runtimeOrderBy: { inMemory: boolean; parquet: boolean };
  requestsAfterReady: string[];
  readyAtEpochMs: number | null;
  diagnostics: string[];
}

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** The exact Arrow 17 writer -> IPC -> Arrow 21 reader bridge the query path uses. */
const convert = async (connection: AsyncDuckDBConnection, sql: string): Promise<Table[]> => {
  const reader = await connection.send(sql);
  const iterator = reader[Symbol.asyncIterator]();
  const pages: Table[] = [];
  let batches: unknown[] = [];
  const flush = async (): Promise<void> => {
    const writer = RecordBatchStreamWriter.writeAll(new DuckdbTable(reader.schema, batches as never[]));
    pages.push(tableFromIPC(await writer.toUint8Array()));
    batches = [];
  };
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) break;
    batches.push(next.value);
    const staged = batches.reduce<number>(
      (total, batch) => total + (batch as { numRows: number }).numRows,
      0,
    );
    if (staged >= PAGE_ROWS) await flush();
  }
  if (batches.length > 0 || pages.length === 0) await flush();
  return pages;
};

const valueKey = (value: unknown): string => {
  if (value === null || value === undefined) return NULL_KEY;
  if (typeof value === 'bigint') return `b${value.toString()}`;
  if (typeof value === 'number') return Object.is(value, -0) ? 'n-0' : `n${String(value)}`;
  if (value instanceof Uint8Array) {
    return `x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  if (value instanceof Date) return `d${value.toISOString()}`;
  return `s${String(value)}`;
};

const columnKeys = (table: Table, column: number): string[] => {
  const child = table.getChildAt(column)!;
  const keys = new Array<string>(table.numRows);
  for (let row = 0; row < table.numRows; row++) keys[row] = valueKey(child.get(row));
  return keys;
};

/**
 * Proves the whole snapshot-sorting path against the pinned DuckDB-WASM build, under the exact
 * hardening production applies: Arrow pages -> private Parquet shards -> typed ORDER BY -> paged
 * Arrow output, with no resend of the original SQL.
 *
 * Exported solely so the instrumented e2e harness can import it; nothing in production calls it.
 */
export async function probeResultSort(variant: 'mvp' | 'eh'): Promise<ResultSortProbeReport> {
  const report: ResultSortProbeReport = {
    variant,
    bundleSupportsSorting: false,
    originalSendCount: 0,
    sortConnectionIsolated: false,
    rowCount: 0,
    valuesPreserved: false,
    schemaPreserved: false,
    tiesStable: false,
    nullsLast: false,
    cancellationSettled: false,
    resourcesReleased: false,
    externalAccessDenied: false,
    typedFixtures: {},
    runtimeOrderBy: { inMemory: false, parquet: false },
    requestsAfterReady: [],
    readyAtEpochMs: null,
    diagnostics: [],
  };

  const bundle = LOCAL_BUNDLES[variant]!;
  report.bundleSupportsSorting = resultSortRuntimeSupported(bundle.mainModule);
  const owner = crypto.randomUUID();
  const exportsRoot = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle('byteql-exports', { create: true });
  const owned = await exportsRoot.getDirectoryHandle(owner, { create: true });
  const prefix = `opfs://byteql-exports/${owner}/`;
  const deniedRoot = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle('byteql-sort-probe-denied', { create: true });
  const deniedOwned = await deniedRoot.getDirectoryHandle(owner, { create: true });
  const deniedPath = `opfs://byteql-sort-probe-denied/${owner}/sentinel.parquet`;

  const worker = new Worker(new URL(bundle.mainWorker!, location.href).href);
  const database = new AsyncDuckDB(new VoidLogger(), worker);
  const registered = new Set<string>();
  let observer: PerformanceObserver | undefined;
  let primary: AsyncDuckDBConnection | null = null;
  let sorter: AsyncDuckDBConnection | null = null;

  const registerPath = async (name: string): Promise<string> => {
    const path = prefix + name;
    await database.registerOPFSFileName(path);
    registered.add(path);
    return path;
  };
  const dropPath = async (path: string): Promise<void> => {
    await database.dropFile(path);
    registered.delete(path);
  };
  /** Every statement issued on the original result's connection, in order. */
  const primarySends: string[] = [];
  /** Every ordering statement generated for a snapshot sort. */
  const sortStatements: string[] = [];
  const originalSend = async (sql: string): Promise<Table[]> => {
    primarySends.push(sql);
    return convert(primary!, sql);
  };

  try {
    let moduleUrl = new URL(bundle.mainModule, location.href).href;
    if (moduleUrl.endsWith('.gz')) {
      const response = await fetch(moduleUrl);
      if (!response.ok || !response.body) throw new Error('Local WASM fetch failed');
      moduleUrl = URL.createObjectURL(
        await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).blob(),
      );
    }
    await database.instantiate(moduleUrl);
    primary = await database.connect();

    const extension = new URL(
      `/duckdb-extensions/v1.5.4/wasm_${variant}/parquet.duckdb_extension.wasm`,
      location.origin,
    ).href;
    await primary.query(`LOAD ${quote(extension)}`);

    // Prove the denied path is writable BEFORE hardening, so a later refusal is attributable to
    // the allowlist rather than to a path that never worked.
    await database.registerOPFSFileName(deniedPath);
    registered.add(deniedPath);
    await primary.query(`COPY (SELECT 41 AS sentinel) TO ${quote(deniedPath)} (FORMAT PARQUET)`);
    await dropPath(deniedPath);
    const sentinel = new Uint8Array(
      await (await (await deniedOwned.getFileHandle('sentinel.parquet')).getFile()).arrayBuffer(),
    );
    await database.registerOPFSFileName(deniedPath);
    registered.add(deniedPath);

    for (const statement of [
      "SET allowed_directories = ['opfs://byteql-exports/']",
      'SET enable_external_access = false',
      'SET autoinstall_known_extensions = false',
      'SET autoload_known_extensions = false',
      'SET allow_community_extensions = false',
      'SET lock_configuration = true',
    ]) {
      await primary.query(statement);
    }

    const ready = performance.now();
    report.readyAtEpochMs = Date.now();
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime >= ready && /^https?:/u.test(entry.name)) {
          report.requestsAfterReady.push(entry.name);
        }
      }
    });
    observer.observe({ type: 'resource' });

    // --- Privacy: no OPFS path outside the allowlist, no external URL. ---
    let deniedOpfs = false;
    try {
      await primary.query(`COPY (SELECT 42 AS sentinel) TO ${quote(deniedPath)} (FORMAT PARQUET)`);
    } catch (error) {
      deniedOpfs = true;
      report.diagnostics.push(`Denied OPFS path: ${String(error)}`);
    }
    await dropPath(deniedPath);
    const afterDenied = new Uint8Array(
      await (await (await deniedOwned.getFileHandle('sentinel.parquet')).getFile()).arrayBuffer(),
    );
    let deniedExternal = false;
    try {
      await primary.query(
        `SELECT * FROM parquet_scan(${quote('https://example.invalid/byteql-sort.parquet')})`,
      );
    } catch (error) {
      deniedExternal = true;
      report.diagnostics.push(`Denied external URL: ${String(error)}`);
    }
    report.externalAccessDenied =
      deniedOpfs &&
      deniedExternal &&
      sentinel.length === afterDenied.length &&
      sentinel.every((byte, index) => byte === afterDenied[index]);

    sorter = await database.connect();
    let lastSortStep = 'none';

    /**
     * Stages Arrow pages as owned Parquet shards through a connection-local TEMP table, then
     * orders them on the dedicated connection. This mirrors the production ownership sequence, so
     * a failure here is a real blocked gate rather than probe-only glue.
     */
    const sortPages = async (
      pages: readonly Table[],
      schema: Schema,
      columnIndex: number,
      direction: 'asc' | 'desc',
      label: string,
      signal?: AbortSignal,
    ): Promise<Table> => {
      const shards: string[] = [];
      const seed = `__byteql_sort_seed_${crypto.randomUUID().replaceAll('-', '')}`;
      let startRow = 0;
      let temporaryReady = false;
      // Names the sub-step in flight so a bundle that cannot surface DuckDB's own message still
      // attributes the failure.
      const step = (name: string): void => {
        lastSortStep = `${label}:${name}`;
      };
      try {
        for (const [index, page] of pages.entries()) {
          signal?.throwIfAborted();
          step(`snapshot-${index}`);
          const staged = snapshotPage(page, startRow, SORT_ORDINAL_COLUMN);
          startRow += page.numRows;
          const ipc = tableToIPC(staged, 'stream').slice();
          if (!temporaryReady) {
            // Establish the exact column types once from a zero-row insert, move them into a
            // connection-local TEMP table, then append into that table for every page.
            step('seed-insert');
            const empty = tableToIPC(staged.slice(0, 0), 'stream').slice();
            await sorter!.insertArrowFromIPCStream(empty, { name: seed, create: true });
            step('create-temp');
            await sorter!.query(
              `CREATE TEMP TABLE ${quoteIdentifier(SORT_PAGE_TABLE)} AS ` +
                `SELECT * FROM ${quoteIdentifier(seed)} WHERE false`,
            );
            await sorter!.query(`DROP TABLE ${quoteIdentifier(seed)}`);
            temporaryReady = true;
          }
          step(`append-${index}`);
          await sorter!.insertArrowFromIPCStream(ipc, { name: SORT_PAGE_TABLE, create: false });
          step(`copy-${index}`);
          // Owned before the COPY runs: a failed COPY can still have created the file, and the
          // cleanup below only removes shards it knows about.
          const shard = await registerPath(`${label}-shard-${index}.parquet`);
          shards.push(shard);
          await sorter!.query(
            `COPY ${quoteIdentifier(SORT_PAGE_TABLE)} TO ${quote(shard)} ` +
              '(FORMAT PARQUET, COMPRESSION SNAPPY)',
          );
          step(`truncate-${index}`);
          await sorter!.query(`TRUNCATE ${quoteIdentifier(SORT_PAGE_TABLE)}`);
        }
        signal?.throwIfAborted();

        const sql = buildResultSortSql(shards, schema, { columnIndex, direction });
        sortStatements.push(sql);
        step('order-by');
        const reader = await sorter!.send(sql, true);
        const iterator = reader[Symbol.asyncIterator]();
        const batches: unknown[] = [];
        let cancelled: Promise<boolean> | null = null;
        const abort = (): void => {
          cancelled ??= sorter!.cancelSent();
        };
        /** Joins the cancellation signal, if the abort listener ever raised one. */
        const joinCancellation = async (): Promise<void> => {
          if (cancelled) await cancelled.catch(() => false);
        };
        signal?.addEventListener('abort', abort, { once: true });
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done === true) break;
            batches.push(next.value);
            signal?.throwIfAborted();
          }
        } finally {
          signal?.removeEventListener('abort', abort);
          await joinCancellation();
          try {
            await iterator.return?.();
          } catch {
            // The reader is already finished or cancelled; cleanup must not mask that.
          }
        }
        step('convert');
        const writer = RecordBatchStreamWriter.writeAll(new DuckdbTable(reader.schema, batches as never[]));
        return restoreResultSchema(tableFromIPC(await writer.toUint8Array()), schema);
      } finally {
        for (const shard of shards) await dropPath(shard).catch(() => undefined);
        for (const shard of shards) {
          await owned.removeEntry(shard.slice(prefix.length), { recursive: false }).catch(() => undefined);
        }
        if (temporaryReady) {
          await sorter!
            .query(`DROP TABLE IF EXISTS ${quoteIdentifier(SORT_PAGE_TABLE)}`)
            .catch(() => undefined);
        }
        await sorter!.query(`DROP TABLE IF EXISTS ${quoteIdentifier(seed)}`).catch(() => undefined);
      }
    };

    // --- Main gate: 20,000 rows with ties and nulls straddling page boundaries. ---
    const mainSql =
      'SELECT i AS id, ' +
      'CASE WHEN i % 1000 = 0 THEN NULL ELSE ((i * 104729) % 97)::INTEGER END AS sort_key, ' +
      "('row-' || i::VARCHAR) AS payload " +
      `FROM range(${PROBE_ROWS}) t(i)`;
    const pages = await originalSend(mainSql);
    const schema = pages[0]!.schema;
    report.rowCount = pages.reduce((total, page) => total + page.numRows, 0);

    const originalIds: number[] = [];
    const originalPayloadById = new Map<number, string>();
    const originalKeyById = new Map<number, string>();
    for (const page of pages) {
      const ids = page.getChild('id')!;
      const keys = columnKeys(page, 1);
      const payloads = page.getChild('payload')!;
      for (let row = 0; row < page.numRows; row++) {
        const id = Number(ids.get(row));
        originalIds.push(id);
        originalPayloadById.set(id, String(payloads.get(row)));
        originalKeyById.set(id, keys[row]!);
      }
    }
    const ordinalById = new Map(originalIds.map((id, ordinal) => [id, ordinal]));

    const sorted = await sortPages(pages, schema, 1, 'desc', 'main');
    // The whole point of retaining pages: the sorted view must come from them, never from a
    // second execution of the user's SQL.
    report.originalSendCount = primarySends.filter((sent) => sent === mainSql).length;
    const sortedIds = sorted.getChild('id')!;
    const sortedKeys = columnKeys(sorted, 1);
    const sortedPayloads = sorted.getChild('payload')!;

    let valuesPreserved = sorted.numRows === report.rowCount;
    let tiesStable = true;
    let nullsLast = true;
    let sawNull = false;
    let previousOrdinal = -1;
    for (let row = 0; row < sorted.numRows; row++) {
      const id = Number(sortedIds.get(row));
      if (originalPayloadById.get(id) !== String(sortedPayloads.get(row))) valuesPreserved = false;
      if (originalKeyById.get(id) !== sortedKeys[row]) valuesPreserved = false;
      const isNull = sortedKeys[row] === NULL_KEY;
      if (isNull) sawNull = true;
      else if (sawNull) nullsLast = false;
      const ordinal = ordinalById.get(id) ?? -1;
      if (row > 0 && sortedKeys[row] === sortedKeys[row - 1] && ordinal <= previousOrdinal) {
        tiesStable = false;
      }
      previousOrdinal = ordinal;
    }
    // A descending sort over the fixture's ties must actually be descending.
    let descending = true;
    for (let row = 1; row < sorted.numRows; row++) {
      const left = sortedKeys[row - 1]!;
      const right = sortedKeys[row]!;
      if (left === NULL_KEY || right === NULL_KEY) continue;
      if (Number(left.slice(1)) < Number(right.slice(1))) descending = false;
    }
    report.valuesPreserved = valuesPreserved && descending;
    report.tiesStable = tiesStable;
    report.nullsLast = nullsLast && sawNull;
    report.schemaPreserved =
      sorted.schema.fields.length === schema.fields.length &&
      sorted.schema.fields.every(
        (field, index) =>
          field.name === schema.fields[index]!.name &&
          field.type.toString() === schema.fields[index]!.type.toString(),
      );
    report.diagnostics.push(
      `main: rows=${sorted.numRows} descending=${String(descending)} ties=${String(tiesStable)}`,
    );

    // --- Typed fixtures: every value family the eligibility policy admits. ---
    const fixtures: Array<{ name: string; sql: string; columnIndex: number }> = [
      {
        // Full-range extremes included deliberately: this is the case the pinned mvp bundle's
        // parquet ORDER BY cannot take, which is why sorting is refused there outright.
        name: 'integer-widths',
        sql:
          'SELECT * FROM (VALUES ' +
          '(1, (-128)::TINYINT, (-32768)::SMALLINT, (-2147483648)::INTEGER, ' +
          '9007199254740993::BIGINT, 255::UTINYINT, 65535::USMALLINT, 4294967295::UINTEGER, ' +
          '18446744073709551615::UBIGINT), ' +
          '(2, 127::TINYINT, 32767::SMALLINT, 2147483647::INTEGER, ' +
          '(-9007199254740993)::BIGINT, 0::UTINYINT, 0::USMALLINT, 0::UINTEGER, ' +
          '9223372036854775809::UBIGINT)) ' +
          't(ord, i8, i16, i32, i64, u8, u16, u32, u64)',
        columnIndex: 3,
      },
      {
        name: 'floating-specials',
        sql:
          'SELECT * FROM (VALUES ' +
          "(1, 'nan'::DOUBLE, (-0.0)::DOUBLE, 'inf'::FLOAT), " +
          "(2, 1.5::DOUBLE, 0.0::DOUBLE, '-inf'::FLOAT), " +
          '(3, (-2.25)::DOUBLE, 3.125::DOUBLE, 0.5::FLOAT)) t(ord, d, z, f)',
        columnIndex: 1,
      },
      {
        name: 'decimal128',
        sql:
          'SELECT * FROM (VALUES ' +
          '(1, 12345678901234567890123456789.123456789::DECIMAL(38,9)), ' +
          '(2, (-0.000000001)::DECIMAL(38,9)), ' +
          '(3, 0::DECIMAL(38,9))) t(ord, amount)',
        columnIndex: 1,
      },
      {
        name: 'strings-and-blobs',
        sql:
          'SELECT * FROM (VALUES ' +
          "(1, '', 'a'::BLOB), " +
          "(2, chr(65279) || 'bom' || chr(233) || chr(20013), '\\x00\\x01\\xFF'::BLOB), " +
          "(3, 'plain', ''::BLOB)) t(ord, text, blob)",
        columnIndex: 1,
      },
      {
        name: 'temporal',
        sql:
          'SELECT * FROM (VALUES ' +
          "(1, DATE '2026-09-14', TIME '23:59:59.999999', " +
          "TIMESTAMP '2026-09-14 12:00:00.123456', TIMESTAMP_NS '2026-09-14 12:00:00.123456789'), " +
          "(2, DATE '1970-01-01', TIME '00:00:00', " +
          "TIMESTAMP '1969-12-31 23:59:59.999999', TIMESTAMP_NS '1677-09-21 00:12:44.000000001')) " +
          't(ord, d, t, ts, tsns)',
        columnIndex: 3,
      },
      {
        // SQL-looking and quote-bearing aliases must never reach a generated statement. Duplicate
        // aliases are deliberately absent: Arrow matches schema fields by name when a RecordBatch
        // is built, so a duplicate-named DuckDB result already fails in the Arrow bridge before any
        // result exists to sort. See docs/result-column-sorting-compatibility.md.
        name: 'hostile-aliases',
        sql:
          'SELECT 1 AS ord, 10 AS "x""; DROP TABLE events; --", ' +
          "'ten' AS \"parquet_scan([''evil''])\" " +
          "UNION ALL SELECT 2, 20, 'twenty'",
        columnIndex: 1,
      },
      {
        name: 'boolean',
        sql: 'SELECT * FROM (VALUES (1, true), (2, false), (3, NULL)) t(ord, flag)',
        columnIndex: 1,
      },
    ];

    for (const fixture of fixtures) {
      let phase = 'query';
      try {
        const fixturePages = await originalSend(fixture.sql);
        phase = 'sort';
        const fixtureSchema = fixturePages[0]!.schema;
        const before = fixtureSchema.fields.map((_field, column) =>
          fixturePages.flatMap((page) => columnKeys(page, column)),
        );
        const after = await sortPages(fixturePages, fixtureSchema, fixture.columnIndex, 'asc', fixture.name);
        const afterKeys = fixtureSchema.fields.map((_field, column) => columnKeys(after, column));
        const rows = before[0]!.length;
        // Values must be preserved as a permutation: every original row still exists exactly once,
        // with every one of its columns unchanged.
        const rowKey = (source: string[][], row: number): string =>
          source.map((column) => column[row]!).join('\u0001');
        const originalRows = Array.from({ length: rows }, (_, row) => rowKey(before, row)).sort();
        const sortedRows = Array.from({ length: after.numRows }, (_, row) => rowKey(afterKeys, row)).sort();
        const typesPreserved = after.schema.fields.every(
          (field, index) =>
            field.name === fixtureSchema.fields[index]!.name &&
            field.type.toString() === fixtureSchema.fields[index]!.type.toString(),
        );
        report.typedFixtures[fixture.name] =
          typesPreserved &&
          after.numRows === rows &&
          originalRows.length === sortedRows.length &&
          originalRows.every((value, index) => value === sortedRows[index]);
        if (!report.typedFixtures[fixture.name]) {
          report.diagnostics.push(
            `${fixture.name}: types=${String(typesPreserved)} rows=${after.numRows}/${rows} ` +
              `${JSON.stringify(originalRows)} vs ${JSON.stringify(sortedRows)}`,
          );
        }
      } catch (error) {
        report.typedFixtures[fixture.name] = false;
        // Attribute the failure: a fixture whose own SELECT fails is a runtime limitation of the
        // pinned bundle, not a defect in the sorting path.
        report.diagnostics.push(
          `${fixture.name} failed during ${phase} (step ${lastSortStep}): ${String(error)}`,
        );
      }
    }

    // --- Runtime baseline: is ORDER BY over a full-range signed key usable at all here? ---
    // Deliberately free of snapshot staging, positional aliases and the ordinal, so a failure is
    // attributable to the pinned bundle rather than to this feature.
    const baselineValues = '(VALUES (1, (-32768)::SMALLINT), (2, 32767::SMALLINT)) t(ord, v)';
    try {
      const inMemory = await primary.query(`SELECT v FROM ${baselineValues} ORDER BY v ASC NULLS LAST`);
      report.runtimeOrderBy.inMemory = inMemory.numRows === 2;
    } catch (error) {
      report.diagnostics.push(`runtime in-memory ORDER BY failed: ${String(error)}`);
    }
    const baselinePath = await registerPath('runtime-baseline.parquet');
    try {
      await primary.query(
        `COPY (SELECT * FROM ${baselineValues}) TO ${quote(baselinePath)} (FORMAT PARQUET)`,
      );
      const scanned = await primary.query(
        `SELECT v FROM parquet_scan(${quote(baselinePath)}) ORDER BY v ASC NULLS LAST`,
      );
      report.runtimeOrderBy.parquet = scanned.numRows === 2;
    } catch (error) {
      report.diagnostics.push(`runtime parquet ORDER BY failed: ${String(error)}`);
    } finally {
      await dropPath(baselinePath).catch(() => undefined);
      await owned.removeEntry('runtime-baseline.parquet').catch(() => undefined);
    }

    // --- Cancellation mid-statement, then cleanup. ---
    const controller = new AbortController();
    const cancelPages = await originalSend(
      `SELECT i AS id, ((i * 7919) % 1000003)::BIGINT AS k FROM range(${PROBE_ROWS * 5}) t(i)`,
    );
    const cancelling = sortPages(cancelPages, cancelPages[0]!.schema, 1, 'asc', 'cancel', controller.signal);
    queueMicrotask(() => controller.abort(new DOMException('probe abort', 'AbortError')));
    try {
      await cancelling;
      report.cancellationSettled = true;
      report.diagnostics.push('cancellation: the sort finished before the abort took effect');
    } catch (error) {
      report.cancellationSettled = true;
      report.diagnostics.push(`cancellation settled: ${String(error)}`);
    }
    // Nothing the sort does may touch the connection that owns the original cursor. Compared by
    // exact statement rather than by substring: a user column can legitimately be ALIASED
    // 'parquet_scan(...)', and a textual match would read that alias as a leak.
    report.sortConnectionIsolated =
      sortStatements.length > 0 && !primarySends.some((sent) => sortStatements.includes(sent));

    // The dedicated connection must still be usable after a cancelled statement.
    const usable = await sorter.query('SELECT 6 * 7 AS answer');
    if (Number(usable.getChild('answer')!.get(0)) !== 42) {
      report.cancellationSettled = false;
      report.diagnostics.push('cancellation: the sorting connection was unusable afterwards');
    }
  } catch (error) {
    report.diagnostics.push(`probe failed: ${String(error)}`);
  } finally {
    observer?.disconnect();
    for (const path of [...registered]) {
      await database.dropFile(path).catch(() => undefined);
      registered.delete(path);
    }
    await sorter?.close().catch(() => undefined);
    await primary?.close().catch(() => undefined);
    await database.terminate().catch(() => undefined);
    worker.terminate();

    const leftovers: string[] = [];
    for await (const [name] of (
      owned as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries()) {
      leftovers.push(name);
    }
    report.resourcesReleased = registered.size === 0 && leftovers.length === 0;
    if (leftovers.length > 0) {
      report.diagnostics.push(`leftover scratch files: ${leftovers.join(', ')}`);
    }
    await exportsRoot.removeEntry(owner, { recursive: true }).catch(() => undefined);
    await deniedRoot.removeEntry(owner, { recursive: true }).catch(() => undefined);
  }

  return report;
}
