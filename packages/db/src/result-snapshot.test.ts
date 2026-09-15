import {
  Binary,
  Bool,
  Decimal,
  Field,
  Float64,
  Int32,
  Int64,
  RecordBatch,
  Schema,
  Table,
  TimeUnit,
  Timestamp,
  Uint64,
  Utf8,
  tableFromArrays,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
} from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { SORT_ORDINAL_COLUMN } from './result-sort.js';
import { restoreResultSchema, snapshotPage } from './result-snapshot.js';

const ordinalsOf = (table: Table): bigint[] => [
  ...(table.getChild(SORT_ORDINAL_COLUMN)!.toArray() as BigUint64Array),
];

describe('snapshotPage', () => {
  it('renames every field positionally and appends an exact Uint64 ordinal', () => {
    const table = tableFromArrays({ value: Int32Array.from([7, 8, 9]), other: ['a', 'b', 'c'] });
    const snapshot = snapshotPage(table, 0, SORT_ORDINAL_COLUMN);

    expect(snapshot.schema.fields.map((field) => field.name)).toEqual(['c0', 'c1', SORT_ORDINAL_COLUMN]);
    expect(snapshot.getChild(SORT_ORDINAL_COLUMN)!.type).toBeInstanceOf(Uint64);
    expect(ordinalsOf(snapshot)).toEqual([0n, 1n, 2n]);
    expect([...snapshot.getChild('c0')!]).toEqual([7, 8, 9]);
    expect([...snapshot.getChild('c1')!]).toEqual(['a', 'b', 'c']);
  });

  it('continues ordinals from the page start row across page boundaries', () => {
    const table = tableFromArrays({ value: Int32Array.from([1, 2]) });
    expect(ordinalsOf(snapshotPage(table, 8_192, SORT_ORDINAL_COLUMN))).toEqual([8192n, 8193n]);
    expect(ordinalsOf(snapshotPage(table, 16_384, SORT_ORDINAL_COLUMN))).toEqual([16384n, 16385n]);
  });

  it("stages duplicate-named columns by position, using each column's true type", () => {
    // Arrow matches schema fields by name whenever a RecordBatch is built, so a duplicate-named
    // result declares the LAST duplicate's type for every duplicate while the child vectors keep
    // the true ones. This is the shape DuckDB results actually arrive in; staging must follow the
    // vectors, not the declaration.
    const built = new Table({
      a: vectorFromArray(Int32Array.from([1, 2])),
      b: vectorFromArray(['x', 'y'], new Utf8()),
    });
    const declared = new Schema([new Field('dup', new Int32(), true), new Field('dup', new Utf8(), true)]);
    const batch = new RecordBatch(declared, built.batches[0]!.data);
    const duplicate = new Table(batch.schema, [batch]);
    expect(duplicate.schema.fields.map((field) => field.type.toString())).toEqual(['Utf8', 'Utf8']);

    const snapshot = snapshotPage(duplicate, 0, SORT_ORDINAL_COLUMN);
    expect(snapshot.schema.fields.map((field) => field.name)).toEqual(['c0', 'c1', SORT_ORDINAL_COLUMN]);
    expect(snapshot.schema.fields.map((field) => field.type.toString())).toEqual(['Int32', 'Utf8', 'Uint64']);
    expect([...snapshot.getChild('c0')!]).toEqual([1, 2]);
    expect([...snapshot.getChild('c1')!]).toEqual(['x', 'y']);
  });

  it('stages every page with identical column types regardless of its own null count', () => {
    const withNulls = new Table({ a: vectorFromArray([1, null, 3], new Int32()) });
    const withoutNulls = new Table({ a: vectorFromArray([1, 2, 3], new Int32()) });
    const types = (table: Table): string[] =>
      snapshotPage(table, 0, SORT_ORDINAL_COLUMN).schema.fields.map(
        (field) => `${field.type.toString()}:${String(field.nullable)}`,
      );
    expect(types(withNulls)).toEqual(types(withoutNulls));
    expect(types(withNulls)).toEqual(['Int32:true', 'Uint64:false']);
  });

  it('survives an IPC round trip with a multi-batch page', () => {
    const first = tableFromArrays({ value: Int32Array.from([1, 2]) });
    const second = tableFromArrays({ value: Int32Array.from([3]) });
    const multi = first.concat(second);
    expect(multi.batches.length).toBeGreaterThan(1);
    const snapshot = tableFromIPC(tableToIPC(snapshotPage(multi, 5, SORT_ORDINAL_COLUMN), 'stream'));
    expect([...snapshot.getChild('c0')!]).toEqual([1, 2, 3]);
    expect(ordinalsOf(snapshot)).toEqual([5n, 6n, 7n]);
  });

  it('handles a zero-row page without inventing rows', () => {
    const empty = tableFromArrays({ value: Int32Array.from([1]) }).slice(0, 0);
    const snapshot = snapshotPage(empty, 0, SORT_ORDINAL_COLUMN);
    expect(snapshot.numRows).toBe(0);
    expect(snapshot.schema.fields.map((field) => field.name)).toEqual(['c0', SORT_ORDINAL_COLUMN]);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER],
  ])('rejects a %s start row', (_label, startRow) => {
    const table = tableFromArrays({ value: Int32Array.from([1, 2]) });
    expect(() => snapshotPage(table, startRow, SORT_ORDINAL_COLUMN)).toThrow(RangeError);
  });

  it('rejects an ordinal name that collides with a generated positional alias', () => {
    const table = tableFromArrays({ value: Int32Array.from([1]) });
    expect(() => snapshotPage(table, 0, 'c0')).toThrow(/collide/iu);
  });
});

describe('restoreResultSchema', () => {
  const original = new Schema(
    [new Field('velocity', new Int32(), true), new Field('note', new Utf8(), true)],
    new Map([['byteql.table', 'events']]),
  );
  const sorted = (): Table => {
    const built = new Table({
      c0: vectorFromArray(Int32Array.from([3, 1])),
      c1: vectorFromArray(['c', 'a'], new Utf8()),
    });
    const schema = new Schema(built.schema.fields);
    return new Table(
      schema,
      built.batches.map((batch) => new RecordBatch(schema, batch.data)),
    );
  };

  it('restores names and schema metadata without touching values', () => {
    const restored = restoreResultSchema(sorted(), original);
    expect(restored.schema.fields.map((field) => field.name)).toEqual(['velocity', 'note']);
    expect(restored.schema.metadata.get('byteql.table')).toBe('events');
    expect([...restored.getChildAt(0)!]).toEqual([3, 1]);
    expect([...restored.getChildAt(1)!]).toEqual(['c', 'a']);
  });

  it('restores every record batch, not only the first', () => {
    const table = sorted().concat(sorted());
    const restored = restoreResultSchema(table, original);
    expect(restored.batches.every((batch) => batch.schema.fields[0]!.name === 'velocity')).toBe(true);
    expect([...restored.getChildAt(0)!]).toEqual([3, 1, 3, 1]);
  });

  it('rejects a field-count mismatch', () => {
    expect(() =>
      restoreResultSchema(sorted(), new Schema([new Field('velocity', new Int32(), true)])),
    ).toThrow(/field count/iu);
  });

  it('rejects a physical type mismatch rather than relabelling the buffers', () => {
    const mismatched = new Schema([
      new Field('velocity', new Int64(), true),
      new Field('note', new Utf8(), true),
    ]);
    expect(() => restoreResultSchema(sorted(), mismatched)).toThrow(/type/iu);
  });

  it.each([
    ['decimal scale', new Decimal(9, 38, 128), new Decimal(8, 38, 128)],
    ['timestamp unit', new Timestamp(TimeUnit.MICROSECOND), new Timestamp(TimeUnit.NANOSECOND)],
    ['timestamp zone', new Timestamp(TimeUnit.MICROSECOND), new Timestamp(TimeUnit.MICROSECOND, 'UTC')],
    ['float width', new Float64(), new Int64()],
    ['bool vs binary', new Bool(), new Binary()],
  ])('rejects a %s mismatch', (_label, actual, expected) => {
    const built = new Table({ c0: vectorFromArray([], actual) });
    const schema = new Schema(built.schema.fields);
    const table = new Table(
      schema,
      built.batches.map((batch) => new RecordBatch(schema, batch.data)),
    );
    expect(() => restoreResultSchema(table, new Schema([new Field('x', expected, true)]))).toThrow(/type/iu);
  });

  it('accepts a zero-field schema', () => {
    const restored = restoreResultSchema(new Table(), new Schema([]));
    expect(restored.schema.fields).toEqual([]);
  });
});
