import {
  Binary,
  Bool,
  DateDay,
  Decimal,
  Dictionary,
  Field,
  Float64,
  Int8,
  Int32,
  Int64,
  LargeUtf8,
  List,
  makeData,
  makeVector,
  RecordBatch,
  Schema,
  Struct,
  Table,
  tableFromArrays,
  tableFromIPC,
  tableToIPC,
  TimeMicrosecond,
  TimestampMicrosecond,
  TimestampNanosecond,
  Uint64,
  Utf8,
  vectorFromArray,
} from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import { withResultLabels } from '../../test-support/result-columns';
import { csvChunks } from './csv';

const decode = (chunks: Iterable<Uint8Array>): string =>
  Array.from(chunks)
    .map((chunk) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(chunk))
    .join('');

describe('csvChunks', () => {
  it.each([new Utf8(), new LargeUtf8(), new Dictionary(new Utf8(), new Int8())])(
    'preserves leading and BOM-only text cells in %s independently of the file BOM',
    (type) => {
      const table = new Table({ text: vectorFromArray(['\uFEFFkeep', '\uFEFF', ''], type) });

      expect(decode(csvChunks(table, [0], true))).toBe('\uFEFF"text"\r\n"\uFEFFkeep"\r\n"\uFEFF"\r\n""\r\n');
      expect(decode(csvChunks(table, [0], false))).toBe('"\uFEFFkeep"\r\n"\uFEFF"\r\n""\r\n');
    },
  );

  it('preserves quoted text, null, and empty strings', () => {
    const table = tableFromArrays({ text: ['a,"b"\n', '', null] });
    const text = decode(csvChunks(table, [0], true));

    expect(text).toBe('\uFEFF"text"\r\n"a,""b""\n"\r\n""\r\n\r\n');
  });

  it('formats exact numeric, temporal, boolean, text, and binary scalars by Arrow type', () => {
    const scaled = new Decimal(3, 12);
    const negativeScale = new Decimal(-2, 12);
    const table = new Table({
      uint64: vectorFromArray([18_446_744_073_709_551_615n], new Uint64()),
      int64: vectorFromArray([-9_223_372_036_854_775_808n], new Int64()),
      decimal: makeVector(
        makeData({ type: scaled, data: decimalWords(-12_345n, scaled.bitWidth), length: 1 }),
      ),
      negative_scale: makeVector(
        makeData({
          type: negativeScale,
          data: decimalWords(123n, negativeScale.bitWidth),
          length: 1,
        }),
      ),
      before_epoch_us: makeVector(
        makeData({ type: new TimestampMicrosecond(), data: BigInt64Array.of(-1n), length: 1 }),
      ),
      before_epoch_ns_utc: makeVector(
        makeData({
          type: new TimestampNanosecond('UTC'),
          data: BigInt64Array.of(-1n),
          length: 1,
        }),
      ),
      far_date: makeVector(makeData({ type: new DateDay(), data: Int32Array.of(100_000_001), length: 1 })),
      time_us: makeVector(
        makeData({
          type: new TimeMicrosecond(),
          data: BigInt64Array.of(45_296_789_123n),
          length: 1,
        }),
      ),
      boolean: vectorFromArray([true], new Bool()),
      formula: tableFromArrays({ formula: ['=1+1'] }).getChildAt(0)!,
      binary: vectorFromArray([Uint8Array.of(0x00, 0xff)], new Binary()),
    });

    expect(
      decode(
        csvChunks(
          table,
          table.schema.fields.map((_, index) => index),
          false,
        ),
      ),
    ).toBe(
      '18446744073709551615,-9223372036854775808,-12.345,12300,' +
        '1969-12-31T23:59:59.999999,1969-12-31T23:59:59.999999999Z,' +
        '+275760-09-14,12:34:56.789123,true,"=1+1",0x00ff\r\n',
    );
  });

  it('renders source ranges as start-end pairs and an empty field for a null list', () => {
    const rangesType = new List(
      new Field(
        'item',
        new Struct([new Field('start', new Uint64(), true), new Field('end', new Uint64(), true)]),
        true,
      ),
    );
    const ranges = vectorFromArray(
      [
        [
          { start: 10n, end: 20n },
          { start: 50n, end: 60n },
        ],
        null,
      ],
      rangesType,
    );
    const table = new Table({ ranges });

    expect(decode(csvChunks(table, [0], false))).toBe('"10-20;50-60"\r\n\r\n');
  });

  it('uses the canonical spellings for floating-point special values', () => {
    const table = new Table({
      value: vectorFromArray([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY], new Float64()),
    });

    expect(decode(csvChunks(table, [0], false))).toBe('NaN\r\nInfinity\r\n-Infinity\r\n');
  });

  it('reads dictionary temporal values and sliced fixed-width values without losing offsets', () => {
    const timestampType = new TimestampNanosecond('UTC');
    const dictionary = makeVector(
      makeData({
        type: timestampType,
        data: BigInt64Array.of(-1n, 123n),
        length: 2,
      }),
    );
    const dictionaryType = new Dictionary(timestampType, new Int8());
    const timestamps = makeVector(
      makeData({
        type: dictionaryType,
        data: Int8Array.of(0, 1),
        dictionary,
        length: 2,
      }),
    );
    const sliced = makeVector(
      makeData({
        type: new TimestampMicrosecond(),
        data: BigInt64Array.of(1_111_111n, -1n, 2_000_001n),
        nullBitmap: Uint8Array.of(0b0000_0101),
        length: 3,
      }),
    ).slice(1, 3);
    const table = new Table({ timestamps, sliced });

    expect(decode(csvChunks(table, [0, 1], false))).toBe(
      '1969-12-31T23:59:59.999999999Z,\r\n' + '1970-01-01T00:00:00.000000123Z,1970-01-01T00:00:02.000001\r\n',
    );
  });

  it('emits independently decodable UTF-8 chunks no larger than 64 KiB for huge text cells', () => {
    const value = `a${'🙂'.repeat(300_000)}`;
    const chunks = Array.from(csvChunks(tableFromArrays({ value: [value] }), [0], false));

    expect(chunks.every((chunk) => chunk.byteLength <= 64 * 1024)).toBe(true);
    expect(decode(chunks)).toBe(`"${value}"\r\n`);
  });

  it('writes the selected quoted schema for a header-only result', () => {
    const table = tableFromArrays({ 'name,"quoted"': [] });

    expect(decode(csvChunks(table, [0], true))).toBe('\uFEFF"name,""quoted"""\r\n');
  });

  it('preserves duplicate CSV headers without renaming them', () => {
    const fields = [new Field('value', new Int32()), new Field('value', new Int32())];
    const schema = new Schema(fields);
    const batch = new RecordBatch(
      schema,
      makeData({
        type: new Struct(fields),
        length: 1,
        children: [vectorFromArray([1], new Int32()).data[0]!, vectorFromArray([2], new Int32()).data[0]!],
      }),
    );
    const table = new Table(schema, [batch]);

    expect(decode(csvChunks(table, [0, 1], true))).toBe('\uFEFF"value","value"\r\n1,2\r\n');
  });

  it('uses logical result labels exactly after an IPC round-trip', () => {
    const source = tableFromArrays({
      c0: Int32Array.from([10]),
      c1: ['ten'],
      c2: ['quoted'],
      c3: ['empty'],
      c4: ['\uFEFFbom'],
    });
    const table = tableFromIPC(
      tableToIPC(withResultLabels(source, ['dup', 'dup', 'name,"quoted"', '', 'label']), 'stream'),
    );

    expect(decode(csvChunks(table, [0, 1, 2, 3, 4], true))).toBe(
      '\uFEFF"dup","dup","name,""quoted""","","label"\r\n' + '10,"ten","quoted","empty","\uFEFFbom"\r\n',
    );
  });

  it('uses logical labels for an empty mixed-type result', () => {
    const source = new Table(
      new Schema([new Field('c0', new Int32(), true), new Field('c1', new Utf8(), true)]),
    );
    const table = tableFromIPC(tableToIPC(withResultLabels(source, ['dup', 'dup']), 'stream'));

    expect(decode(csvChunks(table, [0, 1], true))).toBe('\uFEFF"dup","dup"\r\n');
  });

  it('emits the BOM and header exactly once across concatenated pages', () => {
    const firstPage = tableFromArrays({ value: [1] });
    const secondPage = tableFromArrays({ value: [2] });
    const chunks = [...csvChunks(firstPage, [0], true), ...csvChunks(secondPage, [0], false)];

    expect(decode(chunks)).toBe('\uFEFF"value"\r\n1\r\n2\r\n');
  });
});

function decimalWords(value: bigint, bitWidth: number): Uint32Array {
  const modulus = 1n << BigInt(bitWidth);
  let unsigned = value < 0n ? modulus + value : value;
  const words = new Uint32Array(bitWidth / 32);
  for (let index = 0; index < words.length; index += 1) {
    words[index] = Number(unsigned & 0xffff_ffffn);
    unsigned >>= 32n;
  }
  return words;
}
