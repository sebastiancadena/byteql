import { AsyncDuckDB, VoidLogger, type AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { tableFromIPC, tableToIPC, type Table } from 'apache-arrow';
import type { RecordBatch as DuckdbRecordBatch, Schema as DuckdbSchema } from 'apache-arrow-duckdb';

import { convertDuckdbTable } from './arrow-bridge.js';
import { LOCAL_BUNDLES } from './browser.js';
import { normalizeDuckdbResultBatch, normalizeDuckdbResultSchema } from './result-arrow.js';
import { resultColumnLabel } from './result-columns.js';

export interface ResultColumnsProbeReport {
  variant: 'mvp' | 'eh';
  checks: Record<'mixed' | 'sameType' | 'empty' | 'sliced' | 'ipc' | 'exactValues', boolean>;
  errors: string[];
}

function requireCheck(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

function checkValue(value: unknown, fixture: string, row: number, column: number): void {
  let expected: unknown;
  switch (fixture) {
    case 'exactValues':
      // Arrow decimals expose their exact unscaled integer; the schema check verifies scale 2.
      expected = column === 0 ? 9007199254740993n : '12345';
      if (column === 1) value = String(value);
      break;
    case 'sliced':
      expected = column === 0 ? row : `v${row}`;
      break;
    case 'sameType':
      expected = (column + 1) * 10;
      break;
    default:
      expected = column === 0 ? 10 : 'ten';
  }
  requireCheck(
    value === expected,
    `${fixture}: value at ${row}/${column}: ${String(value)} != ${String(expected)}`,
  );
}

function checkTable(
  table: Table,
  types: readonly string[],
  start: number,
  count: number,
  fixture: string,
): void {
  requireCheck(table.numRows === count, `${fixture}: row count ${table.numRows} != ${count}`);
  requireCheck(table.schema.fields.length === types.length, `${fixture}: column count`);
  for (const [index, type] of types.entries()) {
    const field = table.schema.fields[index]!;
    requireCheck(field.name === `c${index}`, `${fixture}: physical name ${field.name}`);
    requireCheck(resultColumnLabel(field) === 'dup', `${fixture}: label at ${index}`);
    requireCheck(field.type.toString() === type, `${fixture}: type ${index}: ${field.type}`);
    for (let row = 0; row < count; row++) {
      checkValue(table.getChildAt(index)!.get(row), fixture, start + row, index);
    }
  }
}

/** E2E-only execution gate: the real pinned reader, production IPC bridge and hardening. */
export async function probeResultColumns(variant: 'mvp' | 'eh'): Promise<ResultColumnsProbeReport> {
  const report: ResultColumnsProbeReport = {
    variant,
    checks: { mixed: false, sameType: false, empty: false, sliced: false, ipc: false, exactValues: false },
    errors: [],
  };
  const bundle = LOCAL_BUNDLES[variant]!;
  const worker = new Worker(new URL(bundle.mainWorker!, location.href).href);
  const database = new AsyncDuckDB(new VoidLogger(), worker);
  let connection: AsyncDuckDBConnection | undefined;
  let moduleBlob: string | undefined;
  try {
    let moduleUrl = new URL(bundle.mainModule, location.href).href;
    if (moduleUrl.endsWith('.gz')) {
      const response = await fetch(moduleUrl);
      if (!response.ok || !response.body) throw new Error('Local WASM fetch failed');
      moduleUrl = moduleBlob = URL.createObjectURL(
        await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).blob(),
      );
    }
    await database.instantiate(moduleUrl);
    connection = await database.connect();
    const extension = new URL(
      `/duckdb-extensions/v1.5.4/wasm_${variant}/parquet.duckdb_extension.wasm`,
      location.origin,
    ).href;
    for (const statement of [
      `LOAD '${extension.replaceAll("'", "''")}'`,
      "SET allowed_directories = ['opfs://byteql-spill/', 'opfs://byteql-exports/']",
      'SET enable_external_access = false',
      'SET autoinstall_known_extensions = false',
      'SET autoload_known_extensions = false',
      'SET allow_community_extensions = false',
      'SET lock_configuration = true',
    ])
      await connection.query(statement);

    const fixtures = [
      {
        key: 'mixed',
        sql: "select 10::integer as dup, 'ten'::varchar as dup",
        types: ['Int32', 'Utf8'],
        rows: 1,
      },
      {
        key: 'sameType',
        sql: 'select 10::integer as dup, 20::integer as dup, 30::integer as dup',
        types: ['Int32', 'Int32', 'Int32'],
        rows: 1,
      },
      {
        key: 'empty',
        sql: "select 10::integer as dup, 'ten'::varchar as dup where false",
        types: ['Int32', 'Utf8'],
        rows: 0,
      },
      {
        key: 'sliced',
        sql: "select i::integer as dup, ('v' || i)::varchar as dup from range(20001) t(i)",
        types: ['Int32', 'Utf8'],
        rows: 20_001,
      },
      {
        key: 'exactValues',
        sql: 'select 9007199254740993::bigint as dup, 123.45::decimal(9,2) as dup',
        types: ['Int64', 'Decimal[9e+2]'],
        rows: 1,
      },
    ] as const;
    let ipcPassed = 0;
    for (const fixture of fixtures) {
      let iterator: AsyncIterator<DuckdbRecordBatch> | undefined;
      try {
        const reader = await connection.send(fixture.sql);
        iterator = reader[Symbol.asyncIterator]();
        let schema: DuckdbSchema = reader.schema;
        let rows = 0;
        let sawBatch = false;
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          sawBatch = true;
          const raw = next.value;
          requireCheck(raw.data.children.length === fixture.types.length, `${fixture.key}: raw column count`);
          for (const [index, type] of fixture.types.entries()) {
            requireCheck(
              String(raw.data.children[index]!.type) === type,
              `${fixture.key}: raw type ${index}`,
            );
            for (let row = 0; row < raw.numRows; row++) {
              checkValue(raw.getChildAt(index)!.get(row), fixture.key, rows + row, index);
            }
          }
          const batch = normalizeDuckdbResultBatch(raw, reader.schema);
          schema = batch.schema;
          for (let offset = 0; offset < Math.max(1, batch.numRows); offset += 1_024) {
            const count = Math.min(1_024, batch.numRows - offset);
            const slice = batch.slice(offset, offset + count);
            const table = await convertDuckdbTable(schema, [slice]);
            checkTable(table, fixture.types, rows, count, fixture.key);
            checkTable(tableFromIPC(tableToIPC(table, 'stream')), fixture.types, rows, count, fixture.key);
            rows += count;
          }
        }
        if (!sawBatch) {
          const table = await convertDuckdbTable(normalizeDuckdbResultSchema(schema), []);
          checkTable(table, fixture.types, 0, 0, fixture.key);
          checkTable(tableFromIPC(tableToIPC(table, 'stream')), fixture.types, 0, 0, fixture.key);
        }
        requireCheck(rows === fixture.rows, `${fixture.key}: total rows ${rows}`);
        report.checks[fixture.key] = true;
        ipcPassed++;
      } catch (error) {
        report.errors.push(`${fixture.key}: ${String(error)}`);
      } finally {
        try {
          await iterator?.return?.();
        } catch (error) {
          report.errors.push(`reader cleanup: ${String(error)}`);
        }
      }
    }
    report.checks.ipc = ipcPassed === fixtures.length;
  } catch (error) {
    report.errors.push(String(error));
  } finally {
    try {
      await connection?.close();
    } catch (error) {
      report.errors.push(`connection cleanup: ${String(error)}`);
    }
    try {
      await database.terminate();
    } catch (error) {
      report.errors.push(`database cleanup: ${String(error)}`);
    }
    worker.terminate();
    if (moduleBlob) URL.revokeObjectURL(moduleBlob);
  }
  return report;
}
