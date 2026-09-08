import { AsyncDuckDB, VoidLogger, selectBundle } from '@duckdb/duckdb-wasm';
import {
  Table,
  Utf8,
  tableFromArrays,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
  type Schema,
} from 'apache-arrow';
import { RecordBatchStreamWriter } from 'apache-arrow-duckdb';

import { LOCAL_BUNDLES } from './browser.js';
import type { ExportFiles } from './export-files.js';
import { writeParquet } from './export-parquet.js';
import type { ParquetArtifact } from './export-types.js';
import type { QuerySession } from './types.js';

export interface ExportProbeReport {
  variant: 'mvp' | 'eh';
  rows: number;
  inputIpcBytes: number;
  ordered: boolean;
  exactTypes: boolean;
  emptySchema: boolean;
  releasedFileReadable: boolean;
  cancellationPreservesResult: boolean;
  peakWasmBytes: number;
  peakJsBytes: number | null;
  peakTemporaryBytes: number;
  requestsAfterReady: string[];
  diagnostics: string[];
  deniedOutsideAllowlist: boolean;
  measurements: Array<{ phase: string; wasmBytes: number; mainJsBytes: number | null }>;
  parquetTypes: string[];
  comparedRows: number;
  cancellationAccepted: boolean;
  readyAtEpochMs: number | null;
  productionWriter: { ordered: boolean; exactTypes: boolean; emptySchema: boolean };
}

export interface ExportArtifactInput {
  format: 'csv' | 'parquet';
  bytes: number[];
  csvColumns?: Array<{ name: string; type: string }>;
}

export interface ExportArtifactReadback {
  columns: string[];
  types: string[];
  rows: Array<Array<string | number | boolean | null>>;
  externalAccess: boolean;
  configurationLocked: boolean;
}

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const PAGE_ROWS = 8192;

const normalizeReadbackValue = (value: unknown): string | number | boolean | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) {
    return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

const safeCsvType = (type: string): string => {
  if (!/^(?:U?BIGINT|U?INTEGER|U?SMALLINT|U?TINYINT|DOUBLE|FLOAT|BOOLEAN|VARCHAR|BLOB)$/iu.test(type)) {
    throw new Error(`Unsupported E2E CSV readback type: ${type}`);
  }
  return type.toUpperCase();
};

const prepareReadbackModule = async (moduleUrl: string): Promise<{ url: string; release(): void }> => {
  if (!moduleUrl.endsWith('.gz')) return { url: moduleUrl, release: () => undefined };
  const response = await fetch(moduleUrl);
  if (!response.ok || !response.body)
    throw new Error('The local DuckDB readback module could not be loaded.');
  const url = URL.createObjectURL(
    await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).blob(),
  );
  return { url, release: () => URL.revokeObjectURL(url) };
};

/** E2E-only independent readback of bytes captured from the browser's download event. */
export async function readExportArtifact(input: ExportArtifactInput): Promise<ExportArtifactReadback> {
  const owner = crypto.randomUUID();
  const root = await navigator.storage.getDirectory();
  const exportsRoot = await root.getDirectoryHandle('byteql-exports', { create: true });
  const owned = await exportsRoot.getDirectoryHandle(owner, { create: true });
  const filename = `input.${input.format}`;
  const handle = await owned.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  await writable.write(Uint8Array.from(input.bytes));
  await writable.close();
  const path = `opfs://byteql-exports/${owner}/${filename}`;
  const bundle = await selectBundle(LOCAL_BUNDLES);
  if (!bundle.mainWorker) throw new Error('DuckDB-WASM did not select a readback worker.');
  const worker = new Worker(bundle.mainWorker);
  const database = new AsyncDuckDB(new VoidLogger(), worker);
  const module = await prepareReadbackModule(bundle.mainModule);
  let connection: Awaited<ReturnType<AsyncDuckDB['connect']>> | null = null;
  let registered = false;
  try {
    await database.instantiate(module.url, bundle.pthreadWorker);
    connection = await database.connect();
    const variant = bundle.mainModule.includes('mvp') ? 'mvp' : 'eh';
    const extension = new URL(
      `/duckdb-extensions/v1.5.4/wasm_${variant}/parquet.duckdb_extension.wasm`,
      location.origin,
    ).href;
    await connection.query(`LOAD ${quote(extension)}`);
    for (const statement of [
      "SET allowed_directories = ['opfs://byteql-exports/']",
      'SET enable_external_access = false',
      'SET autoinstall_known_extensions = false',
      'SET autoload_known_extensions = false',
      'SET allow_community_extensions = false',
      'SET lock_configuration = true',
    ]) {
      await connection.query(statement);
    }
    await database.registerOPFSFileName(path);
    registered = true;
    if (input.format === 'csv' && (!input.csvColumns || input.csvColumns.length === 0)) {
      throw new Error('CSV readback requires explicit column types.');
    }
    const relation =
      input.format === 'parquet'
        ? `parquet_scan(${quote(path)})`
        : `read_csv(${quote(path)}, header = true, auto_detect = false, ` +
          `columns = {${input
            .csvColumns!.map(({ name, type }) => `${quote(name)}: ${quote(safeCsvType(type))}`)
            .join(', ')}}, nullstr = '', allow_quoted_nulls = false)`;
    const described = await connection.query(`DESCRIBE SELECT * FROM ${relation}`);
    const table = await connection.query(`SELECT * FROM ${relation}`);
    const fields = table.schema.fields;
    const typeColumn = described.getChild('column_type');
    const settings = await connection.query(
      "SELECT current_setting('enable_external_access') AS external, " +
        "current_setting('lock_configuration') AS locked",
    );
    return {
      columns: fields.map((field) => field.name),
      types: Array.from({ length: described.numRows }, (_, row) => String(typeColumn?.get(row))),
      rows: Array.from({ length: table.numRows }, (_, row) =>
        fields.map((_field, column) => normalizeReadbackValue(table.getChildAt(column)?.get(row))),
      ),
      externalAccess: settings.getChild('external')?.get(0) === true,
      configurationLocked: settings.getChild('locked')?.get(0) === true,
    };
  } finally {
    if (connection) await connection.close().catch(() => undefined);
    if (registered) await database.dropFile(path).catch(() => undefined);
    await database.terminate().catch(() => undefined);
    worker.terminate();
    module.release();
    await exportsRoot.removeEntry(owner, { recursive: true }).catch(() => undefined);
  }
}

/** E2E experiment only. It owns its database and UUID directory; no app state is mutated. */
export async function probeResultsExport(variant: 'mvp' | 'eh', rows: number): Promise<ExportProbeReport> {
  const report: ExportProbeReport = {
    variant,
    rows,
    inputIpcBytes: 0,
    ordered: false,
    exactTypes: false,
    emptySchema: false,
    releasedFileReadable: false,
    cancellationPreservesResult: false,
    peakWasmBytes: 0,
    peakJsBytes: null,
    peakTemporaryBytes: 0,
    requestsAfterReady: [],
    diagnostics: [],
    deniedOutsideAllowlist: false,
    measurements: [],
    parquetTypes: [],
    comparedRows: 0,
    cancellationAccepted: false,
    readyAtEpochMs: null,
    productionWriter: { ordered: false, exactTypes: false, emptySchema: false },
  };
  const bundle = LOCAL_BUNDLES[variant]!;
  const owner = crypto.randomUUID();
  const directory = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle('byteql-exports', { create: true });
  const owned = await directory.getDirectoryHandle(owner, { create: true });
  const prefix = `opfs://byteql-exports/${owner}/`;
  const deniedDirectory = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle('byteql-export-probe-denied', { create: true });
  const deniedOwned = await deniedDirectory.getDirectoryHandle(owner, { create: true });
  const deniedPath = `opfs://byteql-export-probe-denied/${owner}/sentinel.parquet`;
  // Observe real linear-memory allocations/growth. This is an allocator high-water mark,
  // not live DuckDB buffers. No test branch is added to production worker code.
  const workerSource = `
    const originalMemory = WebAssembly.Memory;
    const memories = [];
    function sample() {
      postMessage({ byteqlExportMemory: memories.reduce((n, m) => n + m.buffer.byteLength, 0) });
    }
    WebAssembly.Memory = new Proxy(originalMemory, {
      construct(target, args) { const memory = new target(...args); memories.push(memory); sample(); return memory; }
    });
    const originalGrow = originalMemory.prototype.grow;
    originalMemory.prototype.grow = function(...args) {
      const result = originalGrow.apply(this, args); sample(); return result;
    };
    setInterval(sample, 100);
    importScripts(${JSON.stringify(new URL(bundle.mainWorker!, location.href).href)});
  `;
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl);
  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data as { byteqlExportMemory?: number };
    if (typeof message.byteqlExportMemory === 'number') {
      report.peakWasmBytes = Math.max(report.peakWasmBytes, message.byteqlExportMemory);
      event.stopImmediatePropagation();
    }
  });
  const db = new AsyncDuckDB(new VoidLogger(), worker);
  const registered = new Set<string>();
  const artifacts: ParquetArtifact[] = [];
  let moduleUrl = new URL(bundle.mainModule, location.href).href;
  const sample = (phase: string): void => {
    const heap =
      (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
    report.measurements.push({ phase, wasmBytes: report.peakWasmBytes, mainJsBytes: heap });
    if (heap !== null) report.peakJsBytes = Math.max(report.peakJsBytes ?? 0, heap);
  };
  const file = async (name: string): Promise<File> => (await owned.getFileHandle(name)).getFile();
  const registerOPFSPath = async (path: string): Promise<void> => {
    await db.registerOPFSFileName(path);
    registered.add(path);
  };
  const register = async (name: string): Promise<string> => {
    const path = prefix + name;
    await registerOPFSPath(path);
    return path;
  };
  const release = async (name: string): Promise<void> => {
    await db.dropFile(prefix + name);
    registered.delete(prefix + name);
  };
  const countDisk = async (): Promise<void> => {
    let total = 0;
    for await (const handle of (
      owned as FileSystemDirectoryHandle & {
        values(): AsyncIterableIterator<FileSystemFileHandle>;
      }
    ).values())
      total += (await (handle as FileSystemFileHandle).getFile()).size;
    report.peakTemporaryBytes = Math.max(report.peakTemporaryBytes, total);
  };
  const querySession = (tables: readonly Table[], schema: Schema): QuerySession => {
    const pages = tables.map((table, index) => ({
      index,
      startRow: tables.slice(0, index).reduce((total, page) => total + page.numRows, 0),
      rowCount: table.numRows,
    }));
    return {
      schema,
      status: () => ({
        loadedRows: pages.reduce((total, page) => total + page.rowCount, 0),
        complete: true,
        elapsedMs: 0,
        storedBytes: 0,
        decodedBytes: 0,
        sendCount: 1,
      }),
      pages: () => pages,
      readPage: async (index) => ({ ...pages[index]!, table: tables[index]! }),
      fetchNext: async () => null,
      retryPending: async () => {
        throw new Error('No pending probe page.');
      },
      pinPages: () => undefined,
      materialize: async () => null,
      cancel: async () => false,
      dispose: async () => undefined,
    };
  };
  const storedQuerySession = (schema: Schema, pageCount: number): QuerySession => {
    const pages = Array.from({ length: pageCount }, (_, index) => ({
      index,
      startRow: index * PAGE_ROWS,
      rowCount: Math.min(PAGE_ROWS, rows - index * PAGE_ROWS),
    }));
    return {
      schema,
      status: () => ({
        loadedRows: rows,
        complete: true,
        elapsedMs: 0,
        storedBytes: report.inputIpcBytes,
        decodedBytes: 0,
        sendCount: 1,
      }),
      pages: () => pages,
      readPage: async (index) => ({
        ...pages[index]!,
        table: tableFromIPC(new Uint8Array(await (await file(`${index}.arrow`)).arrayBuffer())),
      }),
      fetchNext: async () => null,
      retryPending: async () => {
        throw new Error('No pending probe page.');
      },
      pinPages: () => undefined,
      materialize: async () => null,
      cancel: async () => false,
      dispose: async () => undefined,
    };
  };
  const productionFiles = async (name: string): Promise<ExportFiles> => {
    const root = await owned.getDirectoryHandle(name, { create: true });
    let disposed = false;
    const assertOpen = () => {
      if (disposed) throw new Error('Probe export files are disposed.');
    };
    return {
      path(fileName) {
        assertOpen();
        return `${prefix}${name}/${fileName}`;
      },
      async file(fileName) {
        assertOpen();
        return (await root.getFileHandle(fileName)).getFile();
      },
      async createWritable(fileName) {
        assertOpen();
        return (await root.getFileHandle(fileName, { create: true })).createWritable();
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        await owned.removeEntry(name, { recursive: true });
      },
    };
  };
  const productionDependencies = (name: string) => ({
    database: {
      async registerOPFSFileName(path: string) {
        await db.registerOPFSFileName(path);
        registered.add(path);
      },
      async dropFile(path: string) {
        await db.dropFile(path);
        registered.delete(path);
        return null;
      },
    },
    connect: () => db.connect(),
    createFiles: () => productionFiles(name),
  });
  let observer: PerformanceObserver | undefined;
  try {
    if (moduleUrl.endsWith('.gz')) {
      const response = await fetch(moduleUrl);
      if (!response.ok || !response.body) throw new Error('Local WASM fetch failed');
      moduleUrl = URL.createObjectURL(
        await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).blob(),
      );
    }
    await Promise.race([
      db.instantiate(moduleUrl),
      new Promise<never>((_, reject) => {
        worker.addEventListener('error', (event) => reject(new Error(event.message)), { once: true });
      }),
    ]);
    const conn = await db.connect();
    try {
      const extension = new URL(
        `/duckdb-extensions/v1.5.4/wasm_${variant}/parquet.duckdb_extension.wasm`,
        location.origin,
      ).href;
      await conn.query(`LOAD ${quote(extension)}`);
      // First prove this exact, owned path works before hardening. After locking, a
      // rejected overwrite must leave its bytes identical even if MVP loses error text.
      await db.registerOPFSFileName(deniedPath);
      registered.add(deniedPath);
      await conn.query(`COPY (SELECT 41 AS sentinel) TO ${quote(deniedPath)} (FORMAT PARQUET)`);
      await db.dropFile(deniedPath);
      registered.delete(deniedPath);
      const sentinel = new Uint8Array(
        await (await (await deniedOwned.getFileHandle('sentinel.parquet')).getFile()).arrayBuffer(),
      );
      await db.registerOPFSFileName(deniedPath);
      registered.add(deniedPath);
      for (const statement of [
        "SET allowed_directories = ['opfs://byteql-exports/']",
        'SET enable_external_access = false',
        'SET autoinstall_known_extensions = false',
        'SET autoload_known_extensions = false',
        'SET allow_community_extensions = false',
        'SET lock_configuration = true',
      ])
        await conn.query(statement);
      const ready = performance.now();
      report.readyAtEpochMs = Date.now();
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime >= ready && /^https?:/.test(entry.name)) {
            report.requestsAfterReady.push(entry.name);
          }
        }
      });
      observer.observe({ type: 'resource' });
      sample('ready');
      let denied = false;
      try {
        await conn.query(`COPY (SELECT 42 AS sentinel) TO ${quote(deniedPath)} (FORMAT PARQUET)`);
      } catch (error) {
        denied = true;
        report.diagnostics.push(`Outside allowlist: ${String(error)}`);
      }
      await db.dropFile(deniedPath);
      registered.delete(deniedPath);
      const afterDenied = new Uint8Array(
        await (await (await deniedOwned.getFileHandle('sentinel.parquet')).getFile()).arrayBuffer(),
      );
      const settings = await conn.query(`SELECT current_setting('enable_external_access') AS external,
        current_setting('lock_configuration') AS locked, 6 * 7 AS usable`);
      report.deniedOutsideAllowlist =
        denied &&
        sentinel.length === afterDenied.length &&
        sentinel.every((byte, i) => byte === afterDenied[i]) &&
        settings.getChild('external')!.get(0) === false &&
        settings.getChild('locked')!.get(0) === true &&
        settings.getChild('usable')!.get(0) === 42;
      report.diagnostics.push(
        `Denied path bytes unchanged and configuration locked: ${report.deniedOutsideAllowlist}`,
      );
      // Warm up the same writer before resource measurements.
      const warmup = await register('warmup.parquet');
      await conn.query(`COPY (SELECT 1 a) TO ${quote(warmup)} (FORMAT PARQUET, COMPRESSION SNAPPY)`);
      await release('warmup.parquet');
      await owned.removeEntry('warmup.parquet');
      sample('warmup');
      const shards: string[] = [];
      let sequenceSchema: Schema | null = null;
      for (let start = 0; start < rows; start += PAGE_ROWS) {
        const count = Math.min(PAGE_ROWS, rows - start);
        const keys = new Int32Array(count);
        const payloads: string[] = [];
        for (let i = 0; i < count; i++) {
          // Odd multiplier permutes power-of-two domains; deliberately non-sorted sequence.
          const key = ((start + i) * 104729) % 2147483647;
          keys[i] = key;
          payloads.push(
            Array.from({ length: 8 }, (_, j) =>
              ((key * (j * 2 + 3)) % 2147483647).toString(16).padStart(16, '0'),
            ).join(''),
          );
        }
        const pageTable = new Table({
          key: tableFromArrays({ key: keys }).getChild('key')!,
          payload: vectorFromArray(payloads, new Utf8()),
        });
        sequenceSchema ??= pageTable.schema;
        const ipc = tableToIPC(pageTable, 'stream');
        report.inputIpcBytes += ipc.byteLength;
        const page = start / PAGE_ROWS;
        const writable = await (
          await owned.getFileHandle(`${page}.arrow`, { create: true })
        ).createWritable();
        await writable.write(ipc as Uint8Array<ArrayBuffer>);
        await writable.close();
        await conn.insertArrowFromIPCStream(ipc.slice(), { name: '__export_page', create: true });
        const shard = await register(`${page}.parquet`);
        await conn.query(`COPY __export_page TO ${quote(shard)} (FORMAT PARQUET, COMPRESSION SNAPPY)`);
        await conn.query('DROP TABLE __export_page');
        await release(`${page}.parquet`);
        shards.push(shard);
        if (page % 16 === 0) sample(`page-${page}`);
      }
      await countDisk();
      sample('shards-complete');
      for (let page = 0; page < shards.length; page++) await register(`${page}.parquet`);
      const output = await register('result.parquet');
      await conn.query(`COPY (SELECT * FROM parquet_scan([${shards.map(quote).join(',')}]))
        TO ${quote(output)} (FORMAT PARQUET, COMPRESSION SNAPPY)`);
      sample('final-copy');
      await release('result.parquet');
      report.releasedFileReadable = (await file('result.parquet')).size > 0;
      for (let page = 0; page < shards.length; page++) await release(`${page}.parquet`);
      await countDisk();
      await register('result.parquet');
      const reader = await conn.send(`SELECT * FROM parquet_scan(${quote(output)})`, true);
      let expectedPage = -1;
      let expected: Table | undefined;
      let mismatch = false;
      for await (const batch of reader) {
        for (let row = 0; row < batch.numRows; row++) {
          const page = Math.floor(report.comparedRows / PAGE_ROWS);
          if (page !== expectedPage) {
            expected = tableFromIPC(new Uint8Array(await (await file(`${page}.arrow`)).arrayBuffer()));
            expectedPage = page;
          }
          const index = report.comparedRows % PAGE_ROWS;
          for (let column = 0; column < 2; column++) {
            if (batch.getChildAt(column)!.get(row) !== expected!.getChildAt(column)!.get(index)) {
              if (!mismatch)
                report.diagnostics.push(`Readback mismatch row ${report.comparedRows}, column ${column}`);
              mismatch = true;
            }
          }
          report.comparedRows++;
        }
      }
      report.ordered = !mismatch && report.comparedRows === rows;
      const sequenceResult = storedQuerySession(sequenceSchema!, Math.ceil(rows / PAGE_ROWS));
      const productionSequence = await writeParquet(
        productionDependencies('production-sequence'),
        sequenceResult,
        {
          columns: [0, 1],
          signal: new AbortController().signal,
          onProgress: () => undefined,
        },
      );
      artifacts.push(productionSequence);
      report.releasedFileReadable = report.releasedFileReadable && productionSequence.file.size > 0;
      const productionSequencePath = `${prefix}production-sequence/result.parquet`;
      await registerOPFSPath(productionSequencePath);
      const productionReader = await conn.send(
        `SELECT * FROM parquet_scan(${quote(productionSequencePath)})`,
        true,
      );
      let productionRows = 0;
      let productionMismatch = false;
      let productionExpectedPage = -1;
      let productionExpected: Table | undefined;
      for await (const batch of productionReader) {
        for (let row = 0; row < batch.numRows; row++) {
          const page = Math.floor(productionRows / PAGE_ROWS);
          if (page !== productionExpectedPage) {
            productionExpected = tableFromIPC(
              new Uint8Array(await (await file(`${page}.arrow`)).arrayBuffer()),
            );
            productionExpectedPage = page;
          }
          const index = productionRows % PAGE_ROWS;
          for (let column = 0; column < 2; column++) {
            if (batch.getChildAt(column)!.get(row) !== productionExpected!.getChildAt(column)!.get(index)) {
              productionMismatch = true;
            }
          }
          productionRows++;
        }
      }
      report.productionWriter.ordered = !productionMismatch && productionRows === rows;
      report.ordered = report.ordered && report.productionWriter.ordered;
      sample('readback-complete');
      // Capture a native typed result, bridge Arrow 17 -> IPC -> Arrow 21 -> IPC -> DuckDB.
      // SQL equality operates on exact values, avoiding timestamp .get()'s Number conversion.
      await conn.query(`CREATE TABLE __typed_original AS SELECT
        (-128)::TINYINT i8, (-32768)::SMALLINT i16, (-2147483647 - 1)::INTEGER i32,
        (-9223372036854775807 - 1)::BIGINT i64, 255::UTINYINT u8,
        65535::USMALLINT u16, 4294967295::UINTEGER u32,
        18446744073709551615::UBIGINT u64, 3.25::FLOAT f32, (-4.5)::DOUBLE f64,
        12345678901234567890.123456789::DECIMAL(38,9) d, true::BOOLEAN flag,
        ''::VARCHAR s, '\\x00\\xff'::BLOB b, DATE '2026-09-04' date_day,
        TIME '01:02:03.123456' time_us,
        TIMESTAMP '2026-09-04 01:02:03.123456' ts_us,
        TIMESTAMP_NS '2026-09-04 01:02:03.123456789' ts_ns,
        TIMESTAMPTZ '2026-09-04 01:02:03.123456+00' ts_tz
        UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
        NULL,NULL,''::BLOB,NULL,NULL,NULL,NULL,NULL`);
      const original = await conn.query('SELECT * FROM __typed_original');
      const typedIpc = tableToIPC(
        tableFromIPC(await RecordBatchStreamWriter.writeAll(original).toUint8Array()),
        'stream',
      );
      const typedTable = tableFromIPC(typedIpc);
      const typedResult = querySession([typedTable], typedTable.schema);
      const productionTypes = await writeParquet(productionDependencies('production-types'), typedResult, {
        columns: typedTable.schema.fields.map((_, index) => index),
        signal: new AbortController().signal,
        onProgress: () => undefined,
      });
      artifacts.push(productionTypes);
      const typedPath = `${prefix}production-types/result.parquet`;
      await registerOPFSPath(typedPath);
      const originalTypes = await conn.query('DESCRIBE __typed_original');
      const readTypes = await conn.query(`DESCRIBE SELECT * FROM parquet_scan(${quote(typedPath)})`);
      report.parquetTypes = Array.from({ length: readTypes.numRows }, (_, i) =>
        String(readTypes.getChild('column_type')!.get(i)),
      );
      const identicalTypes = report.parquetTypes.every(
        (type, i) => type === originalTypes.getChild('column_type')!.get(i),
      );
      const diff = await conn.query(`SELECT count(*) FROM (
        (SELECT * FROM __typed_original EXCEPT ALL SELECT * FROM parquet_scan(${quote(typedPath)}))
        UNION ALL
        (SELECT * FROM parquet_scan(${quote(typedPath)}) EXCEPT ALL SELECT * FROM __typed_original))`);
      report.exactTypes = identicalTypes && Number(diff.getChildAt(0)!.get(0)) === 0;
      report.productionWriter.exactTypes = report.exactTypes;
      if (!report.exactTypes)
        report.diagnostics.push(
          `Type roundtrip: types=${identicalTypes}, differing rows=${diff.getChildAt(0)!.get(0)}`,
        );
      const empty = await conn.query('SELECT * FROM __typed_original LIMIT 0');
      const emptyTable = tableFromIPC(await RecordBatchStreamWriter.writeAll(empty).toUint8Array());
      const emptyResult = querySession([], emptyTable.schema);
      const productionEmpty = await writeParquet(productionDependencies('production-empty'), emptyResult, {
        columns: emptyTable.schema.fields.map((_, index) => index),
        signal: new AbortController().signal,
        onProgress: () => undefined,
      });
      artifacts.push(productionEmpty);
      const emptyPath = `${prefix}production-empty/result.parquet`;
      await registerOPFSPath(emptyPath);
      const emptyRead = await conn.query(`SELECT * FROM parquet_scan(${quote(emptyPath)})`);
      const expectedEmptyFields = empty.schema.fields.map((field) => ({
        name: field.name,
        type: field.type.toString(),
        nullable: field.nullable,
      }));
      const actualEmptyFields = emptyRead.schema.fields.map((field) => ({
        name: field.name,
        type: field.type.toString(),
        nullable: field.nullable,
      }));
      report.emptySchema =
        emptyRead.numRows === 0 &&
        actualEmptyFields.length === expectedEmptyFields.length &&
        actualEmptyFields.every(
          (field, i) =>
            field.name === expectedEmptyFields[i]!.name &&
            field.type === expectedEmptyFields[i]!.type &&
            field.nullable === expectedEmptyFields[i]!.nullable,
        );
      report.productionWriter.emptySchema = report.emptySchema;
      if (!report.emptySchema)
        report.diagnostics.push(
          `Empty schema mismatch: rows=${emptyRead.numRows}, expected=${JSON.stringify(expectedEmptyFields)}, actual=${JSON.stringify(actualEmptyFields)}`,
        );
      // COPY must still be running when cancelled; send() makes the statement cooperative.
      const cancelPath = await register('cancel.parquet');
      sample('before-cancellation');
      const cancellation = conn.send(`COPY (SELECT a.* FROM parquet_scan(${quote(output)}) a, range(1000))
        TO ${quote(cancelPath)} (FORMAT PARQUET, COMPRESSION SNAPPY)`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      report.cancellationAccepted = await conn.cancelSent();
      let interrupted = false;
      try {
        for await (const batch of await cancellation) {
          void batch; // Consume COPY's count response if it finishes before interruption.
        }
      } catch (error) {
        interrupted = /interrupt|cancel/i.test(String(error));
        report.diagnostics.push(`Cancellation: ${String(error)}`);
      }
      const preserved = await conn.query(`SELECT count(*) FROM parquet_scan(${quote(output)})`);
      report.cancellationPreservesResult =
        report.cancellationAccepted && interrupted && Number(preserved.getChildAt(0)!.get(0)) === rows;
      sample('done');
    } finally {
      await conn.close();
    }
  } catch (error) {
    report.diagnostics.push(String(error));
  } finally {
    observer?.disconnect();
    for (const path of registered) {
      try {
        await db.dropFile(path);
      } catch {
        /* termination releases remaining handles */
      }
    }
    for (const artifact of artifacts) {
      try {
        await artifact.dispose();
      } catch (error) {
        report.diagnostics.push(`Production artifact cleanup: ${String(error)}`);
      }
    }
    await countDisk();
    await db.terminate();
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
    if (moduleUrl !== bundle.mainModule) URL.revokeObjectURL(moduleUrl);
    try {
      await directory.removeEntry(owner, { recursive: true });
      await deniedDirectory.removeEntry(owner, { recursive: true });
    } catch (error) {
      report.diagnostics.push(`Owned-directory cleanup: ${String(error)}`);
    }
  }
  report.diagnostics.push(
    'JS heap figures cover the main realm only; worker JS heap is unavailable here. WASM is allocated linear memory, not live buffers.',
  );
  return report;
}
