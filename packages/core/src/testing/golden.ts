import { DataType, type Table, type Vector } from 'apache-arrow';

import { ipcToTable } from '../arrow/build.js';
import type { ParseResult } from '../protocol.js';

/** Rows shown verbatim in a golden; the rest are covered by `sha256`. */
const HEAD_ROWS = 10;

const hex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;

const canonical = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Uint8Array) return hex(value);
  // Struct rows are proxies whose `has` trap only recognizes field names (see apache-arrow's
  // `row/struct.js`), so `'toJSON' in value` is always false there — check for the method
  // directly (the proxy's `get` trap does forward it) instead, and check it before `toArray`
  // (a StructRow also defines `toArray`, over its own JSON, which would drop field names).
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    return Object.values((value as { toJSON(): Record<string, unknown> }).toJSON()).map(canonical);
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toArray?: unknown }).toArray === 'function'
  ) {
    return Array.from((value as { toArray(): unknown[] }).toArray(), canonical);
  }
  return value;
};

/** Exact int64 µs for a timestamp cell, read from the raw BigInt64Array (get() is lossy ms). */
const timestampCell = (vector: Vector, row: number): string | null => {
  if (!vector.isValid(row)) return null;
  let remaining = row;
  for (const data of vector.data) {
    if (remaining < data.length) {
      const values = data.values as BigInt64Array;
      return `${values[data.offset + remaining]!}us`;
    }
    remaining -= data.length;
  }
  return null;
};

const tableRows = (table: Table): unknown[][] => {
  const columns = table.schema.fields.map((field, index) => ({
    vector: table.getChildAt(index)!,
    timestamp: DataType.isTimestamp(field.type),
  }));
  const rows: unknown[][] = [];
  for (let row = 0; row < table.numRows; row += 1) {
    rows.push(
      columns.map(({ vector, timestamp }) =>
        timestamp ? timestampCell(vector, row) : canonical(vector.get(row)),
      ),
    );
  }
  return rows;
};

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Stable, reviewable golden for a ParseResult: per table, the Arrow field names and type
 * strings, the row count, the first rows verbatim, and a SHA-256 over every row's canonical
 * encoding. Tables are sorted by name (batch arrival order is not part of the contract).
 */
export const goldenText = async (result: ParseResult): Promise<string> => {
  const tables: Record<string, unknown> = {};
  for (const transfer of [...result.tables].sort((a, b) => a.name.localeCompare(b.name))) {
    const table = ipcToTable(transfer.ipc);
    const rows = tableRows(table);
    tables[transfer.name] = {
      fields: table.schema.fields.map((field) => ({ name: field.name, type: String(field.type) })),
      rowCount: table.numRows,
      sha256: await sha256(JSON.stringify(rows)),
      head: rows.slice(0, HEAD_ROWS),
    };
  }
  return `${JSON.stringify({ tables, issues: result.issues, capabilities: result.capabilities }, null, 2)}\n`;
};

export const schemaSnapshotText = (
  schemas: readonly { name: string; columns: readonly { name: string; type: string; nullable: boolean }[] }[],
): string =>
  `${JSON.stringify(
    [...schemas].sort((a, b) => a.name.localeCompare(b.name)),
    null,
    2,
  )}\n`;
