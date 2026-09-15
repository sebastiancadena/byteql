import type { Field, Schema } from 'apache-arrow';

export const RESULT_LABEL_METADATA_KEY = 'byteql:result-label:v1';

export interface ParquetColumnName {
  readonly columnIndex: number;
  readonly label: string;
  readonly name: string;
}

export const resultColumnLabel = (field: Field): string =>
  field.metadata.get(RESULT_LABEL_METADATA_KEY) ?? field.name;

export function resultColumnIndex(schema: Schema, label: string): number | null {
  let found: number | null = null;
  for (const [index, field] of schema.fields.entries()) {
    if (resultColumnLabel(field) !== label) continue;
    if (found !== null) return null;
    found = index;
  }
  return found;
}

const key = (name: string): string => name.replace(/[A-Z]/g, (character) => character.toLowerCase());

export function parquetColumnNames(schema: Schema, columns: readonly number[]): readonly ParquetColumnName[] {
  const seen = new Set<number>();
  const selected = columns.map((columnIndex) => {
    if (
      !Number.isSafeInteger(columnIndex) ||
      columnIndex < 0 ||
      columnIndex >= schema.fields.length ||
      seen.has(columnIndex)
    ) {
      throw new RangeError('Invalid or repeated export column index.');
    }
    seen.add(columnIndex);
    return { columnIndex, label: resultColumnLabel(schema.fields[columnIndex]!) };
  });
  if (selected.length === 0) throw new Error('Select at least one export column.');

  const reserved = new Set(
    selected.filter((column) => column.label !== '').map((column) => key(column.label)),
  );
  const used = new Set<string>();
  return selected.map(({ columnIndex, label }) => {
    const base = label || `column_${columnIndex + 1}`;
    let name = base;
    if (used.has(key(name)) || (label === '' && reserved.has(key(name)))) {
      let suffix = 2;
      do {
        name = `${base}_${suffix++}`;
      } while (reserved.has(key(name)) || used.has(key(name)));
    }
    used.add(key(name));
    return { columnIndex, label, name };
  });
}
