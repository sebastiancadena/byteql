import {
  Dictionary,
  Field,
  FixedSizeBinary,
  Float16,
  Int8,
  Int32,
  IntervalDayTime,
  LargeUtf8,
  List,
  Null,
  Schema,
  Table,
  TimeSecond,
  TimestampMillisecond,
  Utf8,
  tableFromArrays,
} from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import { withResultLabels } from '../../test-support/result-columns';
import { exportFilename, selectExportColumns } from './options';

const schema = (...fields: Array<[string, Field['type']]>) =>
  new Schema(fields.map(([name, type]) => new Field(name, type, true)));

describe('selectExportColumns', () => {
  it('includes every column by default and excludes every grid-hidden name when unchecked', () => {
    const resultSchema = schema(['value', new Int32()], ['_custom', new Utf8()], ['_src_start', new Int32()]);

    expect(selectExportColumns(resultSchema, { format: 'csv', includeProvenance: true })).toEqual([0, 1, 2]);
    expect(selectExportColumns(resultSchema, { format: 'csv', includeProvenance: false })).toEqual([0]);
  });

  it('rejects an export with no selected columns', () => {
    const resultSchema = schema(['_custom', new Utf8()]);

    expect(() => selectExportColumns(resultSchema, { format: 'csv', includeProvenance: false })).toThrow(
      /at least one column/i,
    );
  });

  it('rejects unsupported nested and interval types with the column name and cast guidance', () => {
    const nestedSchema = schema(['events', new List(new Field('item', new Int32(), true))]);
    const intervalSchema = schema(['elapsed', new IntervalDayTime()]);

    expect(() => selectExportColumns(nestedSchema, { format: 'csv', includeProvenance: true })).toThrow(
      /events.*cast/i,
    );
    expect(() => selectExportColumns(intervalSchema, { format: 'csv', includeProvenance: true })).toThrow(
      /elapsed.*cast/i,
    );
  });

  it('selects duplicate logical labels for both export formats', () => {
    const resultSchema = withResultLabels(
      tableFromArrays({ c0: Int32Array.from([1]), c1: Int32Array.from([2]) }),
      ['Value', 'value'],
    ).schema;

    expect(selectExportColumns(resultSchema, { format: 'csv', includeProvenance: true })).toEqual([0, 1]);
    expect(selectExportColumns(resultSchema, { format: 'parquet', includeProvenance: true })).toEqual([0, 1]);
  });

  it('filters hidden columns and reports unsupported types by logical label', () => {
    const hidden = withResultLabels(tableFromArrays({ c0: Int32Array.from([1]), c1: Int32Array.from([2]) }), [
      'visible',
      '_src_start',
    ]).schema;
    const unsupported = withResultLabels(
      new Table(schema(['c0', new List(new Field('item', new Int32(), true))])),
      ['events'],
    ).schema;

    expect(selectExportColumns(hidden, { format: 'csv', includeProvenance: false })).toEqual([0]);
    expect(() => selectExportColumns(unsupported, { format: 'parquet', includeProvenance: true })).toThrow(
      /events.*cast/i,
    );
    expect(() => selectExportColumns(unsupported, { format: 'csv', includeProvenance: true })).toThrow(
      /events.*cast/i,
    );
  });

  it('keeps the broader CSV scalar policy while Parquet rejects unproven variants', () => {
    const variants = [
      new Null(),
      new Float16(),
      new LargeUtf8(),
      new FixedSizeBinary(2),
      new TimeSecond(),
      new Dictionary(new Utf8(), new Int8()),
    ];

    for (const [index, type] of variants.entries()) {
      const resultSchema = schema([`variant_${index}`, type]);
      expect(selectExportColumns(resultSchema, { format: 'csv', includeProvenance: true })).toEqual([0]);
      expect(() => selectExportColumns(resultSchema, { format: 'parquet', includeProvenance: true })).toThrow(
        new RegExp(`variant_${index}.*cast`, 'i'),
      );
    }
  });

  it('recommends exact DuckDB timestamp targets for schema-normalizing units', () => {
    const resultSchema = schema(['observed_at', new TimestampMillisecond()]);

    expect(() => selectExportColumns(resultSchema, { format: 'parquet', includeProvenance: true })).toThrow(
      /observed_at.*TIMESTAMP or TIMESTAMP_NS/i,
    );
  });
});

describe('exportFilename', () => {
  it('uses the final path component, removes only the last extension, and sanitizes it', () => {
    expect(exportFilename(['C:\\captures\\sales:west.final.pcap'], 'csv')).toBe(
      'sales_west.final-results.csv',
    );
  });

  it('uses the generic filename for empty and multi-file results', () => {
    expect(exportFilename([], 'csv')).toBe('byteql-results.csv');
    expect(exportFilename(['one.mid', 'two.mid'], 'parquet')).toBe('byteql-results.parquet');
  });

  it('limits the sanitized source stem to 120 Unicode code points', () => {
    const stem = `${'a'.repeat(119)}🙂🙂`;
    const filename = exportFilename([`${stem}.pcap`], 'csv');

    expect(Array.from(filename.slice(0, -'-results.csv'.length))).toHaveLength(120);
    expect(filename).toBe(`${'a'.repeat(119)}🙂-results.csv`);
  });
});
