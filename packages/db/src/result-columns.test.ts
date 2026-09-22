import { Field, Int32, Int64, List, Schema, Struct, Uint32, Uint64, Utf8 } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import {
  RESULT_LABEL_METADATA_KEY,
  isSourceRangesType,
  parquetColumnNames,
  resultColumnIndex,
  resultColumnLabel,
} from './result-columns.js';

const schemaOf = (labels: readonly string[]): Schema =>
  new Schema(
    labels.map(
      (label, index) =>
        new Field(`c${index}`, new Int32(), true, new Map([[RESULT_LABEL_METADATA_KEY, label]])),
    ),
  );

describe('resultColumnLabel and resultColumnIndex', () => {
  it('preserves repeated and empty labels while refusing an ambiguous lookup', () => {
    const schema = schemaOf(['dup', 'dup', '']);

    expect(schema.fields.map(resultColumnLabel)).toEqual(['dup', 'dup', '']);
    expect(resultColumnIndex(schema, 'dup')).toBeNull();
    expect(resultColumnIndex(schema, '')).toBe(2);
    expect(resultColumnIndex(schema, 'missing')).toBeNull();
  });

  it('falls back to physical field names and matches labels exactly', () => {
    const schema = new Schema([
      new Field('Name', new Int32(), true),
      new Field('name', new Int32(), true),
      new Field('unlabelled', new Int32(), true, new Map()),
    ]);

    expect(schema.fields.map(resultColumnLabel)).toEqual(['Name', 'name', 'unlabelled']);
    expect(resultColumnIndex(schema, 'Name')).toBe(0);
    expect(resultColumnIndex(schema, 'name')).toBe(1);
    expect(resultColumnIndex(schema, 'unlabelled')).toBe(2);
  });
});

describe('parquetColumnNames', () => {
  it('reserves existing suffixed names before assigning repeated names', () => {
    const schema = schemaOf(['dup', 'dup', 'dup_2']);

    expect(parquetColumnNames(schema, [0, 1, 2])).toEqual([
      { columnIndex: 0, label: 'dup', name: 'dup' },
      { columnIndex: 1, label: 'dup', name: 'dup_3' },
      { columnIndex: 2, label: 'dup_2', name: 'dup_2' },
    ]);
  });

  it.each([
    {
      label: 'treats case-only collisions as the same export name',
      labels: ['dup', 'DUP'],
      columns: [0, 1],
      expected: [
        { columnIndex: 0, label: 'dup', name: 'dup' },
        { columnIndex: 1, label: 'DUP', name: 'DUP_2' },
      ],
    },
    {
      label: 'assigns suffixes for three repeated labels',
      labels: ['name', 'name', 'name'],
      columns: [0, 1, 2],
      expected: [
        { columnIndex: 0, label: 'name', name: 'name' },
        { columnIndex: 1, label: 'name', name: 'name_2' },
        { columnIndex: 2, label: 'name', name: 'name_3' },
      ],
    },
    {
      label: 'uses a positional fallback when an empty label collides with an original label',
      labels: ['', 'column_1', ''],
      columns: [0, 1, 2],
      expected: [
        { columnIndex: 0, label: '', name: 'column_1_2' },
        { columnIndex: 1, label: 'column_1', name: 'column_1' },
        { columnIndex: 2, label: '', name: 'column_3' },
      ],
    },
    {
      label: 'preserves quotes, Unicode, and a byte-order mark in names',
      labels: ['quoted"name', 'naïve', '\uFEFFstart'],
      columns: [0, 1, 2],
      expected: [
        { columnIndex: 0, label: 'quoted"name', name: 'quoted"name' },
        { columnIndex: 1, label: 'naïve', name: 'naïve' },
        { columnIndex: 2, label: '\uFEFFstart', name: '\uFEFFstart' },
      ],
    },
    {
      label: 'uses the selected result positions for reordered and filtered exports',
      labels: ['first', 'second', 'third'],
      columns: [2, 0],
      expected: [
        { columnIndex: 2, label: 'third', name: 'third' },
        { columnIndex: 0, label: 'first', name: 'first' },
      ],
    },
  ])('$label', ({ labels, columns, expected }) => {
    const schema = schemaOf(labels);

    expect(parquetColumnNames(schema, columns)).toEqual(expected);
  });

  it('does not mutate labels or field metadata', () => {
    const schema = schemaOf(['dup', 'dup', '']);
    const before = schema.fields.map((field) => [...field.metadata.entries()]);

    const names = parquetColumnNames(schema, [0, 1, 2]);

    expect(names.map((column) => column.label)).toEqual(['dup', 'dup', '']);
    expect(schema.fields.map(resultColumnLabel)).toEqual(['dup', 'dup', '']);
    expect(schema.fields.map((field) => [...field.metadata.entries()])).toEqual(before);
  });

  it.each([
    { label: 'an empty selection', columns: [] },
    { label: 'a negative index', columns: [-1] },
    { label: 'an index after the schema', columns: [3] },
    { label: 'a fractional index', columns: [1.5] },
    { label: 'an unsafe integer index', columns: [Number.MAX_SAFE_INTEGER + 1] },
    { label: 'a repeated index', columns: [1, 1] },
  ])('rejects $label', ({ columns }) => {
    const schema = schemaOf(['first', 'second', 'third']);

    expect(() => parquetColumnNames(schema, columns)).toThrow();
  });
});

const piece = (startType = new Uint64(), endType = new Uint64(), names = ['start', 'end']) =>
  new Struct([new Field(names[0]!, startType, true), new Field(names[1]!, endType, true)]);
const listOf = (item: Struct) => new List(new Field('item', item, true));

describe('isSourceRangesType', () => {
  it('accepts List<Struct<start: Uint64, end: Uint64>>', () => {
    expect(isSourceRangesType(listOf(piece()))).toBe(true);
  });
  it('rejects wrong field names, order, widths, signedness, and non-list types', () => {
    expect(isSourceRangesType(listOf(piece(undefined, undefined, ['end', 'start'])))).toBe(false);
    expect(isSourceRangesType(listOf(piece(undefined, undefined, ['s', 'e'])))).toBe(false);
    expect(isSourceRangesType(listOf(piece(new Uint32(), new Uint64())))).toBe(false);
    expect(isSourceRangesType(listOf(piece(new Int64(), new Int64())))).toBe(false);
    expect(isSourceRangesType(new List(new Field('item', new Utf8(), true)))).toBe(false);
    expect(isSourceRangesType(piece())).toBe(false);
    expect(isSourceRangesType(new Uint64())).toBe(false);
  });
  it('rejects a struct with an extra field', () => {
    const three = new Struct([
      new Field('start', new Uint64(), true),
      new Field('end', new Uint64(), true),
      new Field('x', new Uint64(), true),
    ]);
    expect(isSourceRangesType(listOf(three))).toBe(false);
  });
});
