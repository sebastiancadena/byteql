import { Field, Int64, List, Schema, Struct, TimeUnit, Timestamp, Uint64, Utf8 } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { RESULT_LABEL_METADATA_KEY, resultSortKeyRefusal } from './result-columns.js';
import {
  buildResultSortSql,
  resultSortEligibility,
  ResultSortError,
  resultSortRuntimeSupported,
} from './result-sort.js';

const SHARD = 'opfs://byteql-exports/a/b/shard-0.parquet';

const schemaOf = (...fields: Field[]): Schema => new Schema(fields);

describe('buildResultSortSql', () => {
  it('orders by a positional alias and original ordinal', () => {
    const schema = new Schema([new Field('x"; DROP TABLE events; --', new Int64(), true)]);
    expect(buildResultSortSql([SHARD], schema, { columnIndex: 0, direction: 'desc' })).toBe(
      'SELECT "c0" FROM parquet_scan([\'opfs://byteql-exports/a/b/shard-0.parquet\']) ' +
        'ORDER BY "c0" DESC NULLS LAST, "__byteql_sort_ordinal" ASC',
    );
  });

  it('projects every field positionally and quotes every shard path', () => {
    const schema = schemaOf(
      new Field('a', new Int64(), true),
      new Field('b', new Utf8(), true),
      new Field('c', new Int64(), true),
    );
    expect(
      buildResultSortSql(
        ['opfs://byteql-exports/o/e/shard-0.parquet', "opfs://byteql-exports/o/e/it's-1.parquet"],
        schema,
        { columnIndex: 2, direction: 'asc' },
      ),
    ).toBe(
      'SELECT "c0", "c1", "c2" FROM parquet_scan([' +
        "'opfs://byteql-exports/o/e/shard-0.parquet', 'opfs://byteql-exports/o/e/it''s-1.parquet'" +
        ']) ORDER BY "c2" ASC NULLS LAST, "__byteql_sort_ordinal" ASC',
    );
  });

  it('never interpolates a user column name into the statement', () => {
    const hostile = "'); COPY (SELECT 1) TO 'opfs://evil.parquet'; --";
    const schema = schemaOf(new Field(hostile, new Int64(), true));
    expect(buildResultSortSql([SHARD], schema, { columnIndex: 0, direction: 'asc' })).not.toContain('COPY');
  });

  it.each([
    ['negative', -1],
    ['out of bounds', 2],
    ['fractional', 0.5],
    ['NaN', Number.NaN],
    ['unsafe', Number.MAX_SAFE_INTEGER + 2],
  ])('rejects a %s column index', (_label, columnIndex) => {
    const schema = schemaOf(new Field('a', new Int64(), true), new Field('b', new Int64(), true));
    expect(() => buildResultSortSql([SHARD], schema, { columnIndex, direction: 'asc' })).toThrow(
      ResultSortError,
    );
  });

  it('rejects a direction outside the closed union at runtime', () => {
    const schema = schemaOf(new Field('a', new Int64(), true));
    expect(() =>
      buildResultSortSql([SHARD], schema, {
        columnIndex: 0,
        direction: 'asc; DROP TABLE events' as 'asc',
      }),
    ).toThrow(ResultSortError);
  });

  it('rejects an empty shard list', () => {
    const schema = schemaOf(new Field('a', new Int64(), true));
    expect(() => buildResultSortSql([], schema, { columnIndex: 0, direction: 'asc' })).toThrow(
      ResultSortError,
    );
  });

  it('rejects a schema containing any unsupported field', () => {
    const schema = schemaOf(
      new Field('value', new Int64(), true),
      new Field('details', new List(new Field('item', new Int64(), true)), true),
    );
    expect(() => buildResultSortSql([SHARD], schema, { columnIndex: 0, direction: 'asc' })).toThrow(
      /SORT_UNSUPPORTED_TYPE|unsupported/iu,
    );
  });
});

describe('resultSortEligibility', () => {
  it('accepts a wholly supported scalar schema', () => {
    const schema = schemaOf(
      new Field('a', new Int64(), true),
      new Field('b', new Utf8(), true),
      new Field('c', new Timestamp(TimeUnit.MICROSECOND), true),
    );
    expect(resultSortEligibility(schema)).toEqual({ supported: true });
  });

  it('names the first offending field and its 1-based schema position', () => {
    const schema = schemaOf(
      new Field('value', new Int64(), true),
      new Field('other', new Utf8(), true),
      new Field('details', new List(new Field('item', new Int64(), true)), true),
      new Field('later', new List(new Field('item', new Utf8(), true)), true),
    );
    const eligibility = resultSortEligibility(schema);
    expect(eligibility.supported).toBe(false);
    expect(eligibility.supported === false && eligibility.reason).toBe(
      'Column sorting is unavailable: column 3 “details” has unsupported type ' +
        'List<Int64>. Cast it in SQL and run again.',
    );
  });

  it('names an unsupported field by its SQL label instead of its physical result name', () => {
    const schema = schemaOf(
      new Field(
        'c0',
        new List(new Field('item', new Int64(), true)),
        true,
        new Map([[RESULT_LABEL_METADATA_KEY, 'details']]),
      ),
    );

    expect(resultSortEligibility(schema)).toEqual({
      supported: false,
      reason:
        'Column sorting is unavailable: column 1 “details” has unsupported type ' +
        'List<Int64>. Cast it in SQL and run again.',
    });
  });

  it('rejects a timestamp carrying a timezone even though Parquet export allows it', () => {
    const schema = schemaOf(new Field('at', new Timestamp(TimeUnit.MICROSECOND, 'UTC'), true));
    const eligibility = resultSortEligibility(schema);
    expect(eligibility.supported).toBe(false);
    expect(eligibility.supported === false && eligibility.reason).toContain('column 1 “at”');
  });

  it('accepts a timezone-free timestamp', () => {
    expect(
      resultSortEligibility(schemaOf(new Field('at', new Timestamp(TimeUnit.NANOSECOND), true))),
    ).toEqual({ supported: true });
  });

  it('accepts an empty schema', () => {
    expect(resultSortEligibility(new Schema([]))).toEqual({ supported: true });
  });
});

describe('resultSortRuntimeSupported', () => {
  it('refuses the mvp bundle, whose parquet ORDER BY cannot take a full-range signed key', () => {
    expect(resultSortRuntimeSupported('/assets/duckdb-mvp.wasm')).toBe(false);
    expect(resultSortRuntimeSupported('https://app.example/duckdb-mvp-abc123.wasm.gz')).toBe(false);
  });

  it('accepts the exception-handling bundle every current browser selects', () => {
    expect(resultSortRuntimeSupported('/assets/duckdb-eh.wasm')).toBe(true);
    expect(resultSortRuntimeSupported('https://app.example/duckdb-eh-abc123.wasm.gz')).toBe(true);
  });
});

const rangesField = new Field(
  '_src_ranges',
  new List(
    new Field(
      'item',
      new Struct([new Field('start', new Uint64(), true), new Field('end', new Uint64(), true)]),
      true,
    ),
  ),
  true,
);

describe('source ranges in sorting', () => {
  it('admits a ranges column as a passenger', () => {
    expect(resultSortEligibility(new Schema([new Field('n', new Uint64()), rangesField]))).toEqual({
      supported: true,
    });
  });
  it('refuses a ranges column as the sort key', () => {
    expect(resultSortKeyRefusal(rangesField)).toBe("Byte ranges can't be sorted.");
    expect(resultSortKeyRefusal(new Field('n', new Uint64()))).toBeNull();
  });
});
