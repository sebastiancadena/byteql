import { tableFromIPC, tableToIPC } from 'apache-arrow';
import {
  Decimal,
  Dictionary,
  Field,
  Int8,
  Int32,
  RecordBatch,
  Schema,
  Struct,
  Utf8,
  makeData,
  vectorFromArray,
} from 'apache-arrow-duckdb';
import { describe, expect, it } from 'vitest';

import { convertDuckdbTable } from './arrow-bridge.js';
import { normalizeDuckdbResultBatch, normalizeDuckdbResultSchema } from './result-arrow.js';
import { RESULT_LABEL_METADATA_KEY, resultColumnLabel } from './result-columns.js';

function mixedBatch() {
  const source = new Schema(
    [
      new Field(
        'dup',
        new Int32(),
        true,
        new Map([
          ['owner', 'first'],
          [RESULT_LABEL_METADATA_KEY, 'untrusted'],
        ]),
      ),
      new Field('dup', new Utf8(), true, new Map([['owner', 'second']])),
    ],
    new Map([['schema-owner', 'query']]),
  );
  const children = [
    vectorFromArray([99, 10, null, 30], new Int32()).data[0]!.slice(1, 3),
    vectorFromArray(['skip', 'ten', null, 'thirty'], new Utf8()).data[0]!.slice(1, 3),
  ];
  const batch = new RecordBatch(source, makeData({ type: new Struct(source.fields), length: 3, children }));
  return { source, batch, children };
}

describe('DuckDB result normalization', () => {
  it('recovers mixed duplicate types before slices and IPC without changing the raw buffers', async () => {
    const { source, batch, children } = mixedBatch();
    // The pinned Arrow constructor damages the declared schema, but the positional data survives.
    expect(batch.schema.fields.map((field) => field.type.toString())).toEqual(['Utf8', 'Utf8']);
    expect(batch.getChildAt(0)!.get(0)).toBe(10);
    expect(batch.getChildAt(1)!.get(0)).toBe('ten');
    const originalFields = [...batch.schema.fields];
    const normalized = normalizeDuckdbResultBatch(batch, source);
    expect(normalized.data.children[0]).toBe(children[0]);
    expect(normalized.data.children[1]).toBe(children[1]);
    expect(normalized.data.children.map((child) => child.offset)).toEqual([1, 1]);
    expect(normalized.schema.metadata).toEqual(new Map([['schema-owner', 'query']]));
    expect(normalized.schema.metadata).not.toBe(source.metadata);
    expect(normalized.schema.fields[0]!.metadata).not.toBe(source.fields[0]!.metadata);
    expect(normalized.schema.fields.map((field) => field.metadata.get('owner'))).toEqual(['first', 'second']);
    const table = await convertDuckdbTable(normalized.schema, [normalized.slice(0, 2)]);
    const reloaded = tableFromIPC(tableToIPC(table, 'stream'));
    for (const result of [table, reloaded]) {
      expect(
        result.schema.fields.map((field) => [field.name, resultColumnLabel(field), String(field.type)]),
      ).toEqual([
        ['c0', 'dup', 'Int32'],
        ['c1', 'dup', 'Utf8'],
      ]);
      expect(Array.from(result.getChildAt(0)!)).toEqual([10, null]);
      expect(Array.from(result.getChildAt(1)!)).toEqual(['ten', null]);
    }
    expect(batch.schema.fields).toEqual(originalFields);
    expect(source.fields.map((field) => field.name)).toEqual(['dup', 'dup']);
    expect(source.fields[0]!.metadata.get(RESULT_LABEL_METADATA_KEY)).toBe('untrusted');
  });

  it('preserves all declared mixed duplicate types and labels for schema-only conversion', async () => {
    const { source } = mixedBatch();
    const normalized = normalizeDuckdbResultSchema(source);
    const table = await convertDuckdbTable(normalized, []);
    expect(table.numRows).toBe(0);
    expect(
      table.schema.fields.map((field) => [field.name, resultColumnLabel(field), String(field.type)]),
    ).toEqual([
      ['c0', 'dup', 'Int32'],
      ['c1', 'dup', 'Utf8'],
    ]);
    expect(normalized.fields.every((field, i) => field !== source.fields[i])).toBe(true);
  });

  it('recovers a zero-row placeholder with a provisional cursor schema', async () => {
    const { source } = mixedBatch();
    const raw = new RecordBatch(source, undefined);
    const batch = normalizeDuckdbResultBatch(raw, new Schema());
    const table = await convertDuckdbTable(batch.schema, [batch]);
    expect(table.numRows).toBe(0);
    expect(table.schema.fields.map((field) => [resultColumnLabel(field), String(field.type)])).toEqual([
      ['dup', 'Int32'],
      ['dup', 'Utf8'],
    ]);
  });

  it('preserves nested fields and dictionary identity without rebuilding vectors', async () => {
    const nestedType = new Struct([
      new Field('name', new Utf8(), true),
      new Field('count', new Int32(), true),
    ]);
    const dictionaryType = new Dictionary(new Utf8(), new Int8(), 42, false);
    const source = new Schema([new Field('dup', nestedType, true), new Field('dup', dictionaryType, true)]);
    const children = [
      vectorFromArray([{ name: '音', count: 3 }, null], nestedType).data[0]!,
      vectorFromArray(['one', null], dictionaryType).data[0]!,
    ];
    const raw = new RecordBatch(source, makeData({ type: new Struct(source.fields), children }));
    const normalized = normalizeDuckdbResultBatch(raw, source);
    expect(normalized.data.children).toEqual(children);
    expect(normalized.data.children[1]!.dictionary).toBe(children[1]!.dictionary);
    expect(normalized.schema.fields[1]!.type).toBe(children[1]!.type);
    expect(normalized.schema.dictionaries.has(42)).toBe(true);
    const table = await convertDuckdbTable(normalized.schema, [normalized]);
    expect(table.getChildAt(0)!.get(0)?.toJSON()).toEqual({ name: '音', count: 3 });
    expect(table.getChildAt(0)!.get(1)).toBeNull();
    expect(Array.from(table.getChildAt(1)!)).toEqual(['one', null]);
    expect(String(table.schema.fields[1]!.type)).toBe('Dictionary<Int8, Utf8>');
  });

  it('keeps empty, quoted, Unicode and generated-looking labels exactly', async () => {
    const source = new Schema(['', 'c0', '"音"'].map((label) => new Field(label, new Int32())));
    const table = await convertDuckdbTable(normalizeDuckdbResultSchema(source), []);
    expect(table.schema.fields.map(resultColumnLabel)).toEqual(['', 'c0', '"音"']);
    expect(table.schema.fields.map((field) => field.name)).toEqual(['c0', 'c1', 'c2']);
  });

  it.each([new Decimal(3, 9), new Decimal(2, 10), new Decimal(2, 9, 256)])(
    'rejects decimal parameter drift, including nested fields: %s',
    (declaredDecimal) => {
      for (const nested of [false, true]) {
        const actualDecimal = new Decimal(2, 9);
        const actual = nested ? new Struct([new Field('amount', actualDecimal)]) : actualDecimal;
        const declared = nested ? new Struct([new Field('amount', declaredDecimal)]) : declaredDecimal;
        const raw = new RecordBatch(new Schema([new Field('amount', actual)]), undefined);
        expect(() => normalizeDuckdbResultBatch(raw, new Schema([new Field('amount', declared)]))).toThrow(
          /type.*column 0/i,
        );
      }
    },
  );

  it('rejects a truncated child instead of letting Arrow pad missing values with nulls', () => {
    const { source, batch } = mixedBatch();
    batch.data.children[0] = batch.data.children[0]!.slice(0, 1);
    expect(() => normalizeDuckdbResultBatch(batch, source)).toThrow(/row count.*column 0/i);
  });

  it('rejects cursor field counts and true positional types that disagree with the batch', () => {
    const { source, batch } = mixedBatch();
    expect(() => normalizeDuckdbResultBatch(batch, new Schema([source.fields[0]!]))).toThrow(/column count/i);
    const wrong = new Schema([new Field('dup', new Utf8()), source.fields[1]!]);
    expect(() => normalizeDuckdbResultBatch(batch, wrong)).toThrow(/type.*column 0/i);
  });
});
