import { DataType, DateUnit, TimeUnit, type Data, type Table, Vector } from 'apache-arrow';

const MAX_CHUNK_BYTES = 64 * 1024;
const TEXT_BLOCK_CODE_UNITS = 16 * 1024;

export function* csvChunks(
  table: Table,
  columns: readonly number[],
  includeHeader: boolean,
): Generator<Uint8Array> {
  if (columns.length === 0) {
    throw new Error('CSV export requires at least one selected column.');
  }

  const fields = columns.map((column) => {
    const field = table.schema.fields[column];
    if (!field) {
      throw new Error(`CSV export column index ${column} is out of range.`);
    }
    return field;
  });

  yield* boundedUtf8(
    (function* (): Generator<string> {
      if (includeHeader) {
        yield '\uFEFF';
        for (let column = 0; column < fields.length; column += 1) {
          if (column > 0) yield ',';
          yield* quotedText(fields[column]!.name);
        }
        yield '\r\n';
      }

      for (const batch of table.batches) {
        const vectors = columns.map((column) => batch.getChildAt(column));
        for (let row = 0; row < batch.numRows; row += 1) {
          for (let column = 0; column < vectors.length; column += 1) {
            if (column > 0) yield ',';
            const vector = vectors[column];
            if (!vector) {
              throw new Error(`CSV export column index ${columns[column]} is unavailable.`);
            }
            yield* scalarParts(vector, vector.data[0]!, row);
          }
          yield '\r\n';
        }
      }
    })(),
  );
}

function* scalarParts(vector: Vector, data: Data, index: number): Generator<string> {
  if (!data.getValid(index)) return;

  if (DataType.isDictionary(data.type)) {
    const dictionaryIndex = Number(data.values[index]);
    const dictionary = data.dictionary;
    if (!dictionary) {
      throw new Error('Dictionary scalar has no dictionary values.');
    }
    const located = locateData(dictionary, dictionaryIndex);
    yield* scalarParts(dictionary, located.data, located.index);
    return;
  }

  if (DataType.isUtf8(data.type) || DataType.isLargeUtf8(data.type)) {
    yield* quotedText(readText(data, index));
    return;
  }

  if (DataType.isInt(data.type)) {
    yield `${data.values[index]}`;
    return;
  }

  if (DataType.isFloat(data.type)) {
    const value = new Vector([data]).get(index);
    if (typeof value !== 'number') throw new Error(`Expected a floating-point scalar.`);
    yield formatFloat(value);
    return;
  }

  if (DataType.isDecimal(data.type)) {
    yield formatDecimal(readDecimal(data, index, data.type.bitWidth), data.type.scale);
    return;
  }

  if (DataType.isBool(data.type)) {
    const bit = data.offset + index;
    yield (data.values[bit >> 3]! & (1 << (bit % 8))) === 0 ? 'false' : 'true';
    return;
  }

  if (DataType.isBinary(data.type) || DataType.isLargeBinary(data.type)) {
    yield* binaryParts(readVariableBytes(data, index));
    return;
  }

  if (DataType.isFixedSizeBinary(data.type)) {
    const start = data.stride * index;
    yield* binaryParts(data.values.subarray(start, start + data.stride));
    return;
  }

  if (DataType.isDate(data.type)) {
    const raw = BigInt(data.values[index]!);
    const days = data.type.unit === DateUnit.DAY ? raw : floorDiv(raw, BigInt(24 * 60 * 60 * 1000));
    yield formatCivilDate(days);
    return;
  }

  if (DataType.isTime(data.type)) {
    yield formatTime(BigInt(data.values[index]!), data.type.unit);
    return;
  }

  if (DataType.isTimestamp(data.type)) {
    yield formatTimestamp(BigInt(data.values[index]!), data.type.unit, Boolean(data.type.timezone));
    return;
  }

  if (DataType.isNull(data.type)) return;
  throw new Error(`Unsupported CSV scalar type ${data.type}.`);
}

function locateData(vector: Vector, index: number): { data: Data; index: number } {
  let remaining = index;
  for (const data of vector.data) {
    if (remaining < data.length) return { data, index: remaining };
    remaining -= data.length;
  }
  throw new Error(`Dictionary index ${index} is out of range.`);
}

function* quotedText(text: string): Generator<string> {
  yield '"';
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + TEXT_BLOCK_CODE_UNITS, text.length);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    const block = text.slice(start, end);
    let segmentStart = 0;
    for (let index = 0; index < block.length; index += 1) {
      if (block.charCodeAt(index) !== 0x22) continue;
      if (index > segmentStart) yield block.slice(segmentStart, index);
      yield '""';
      segmentStart = index + 1;
    }
    if (segmentStart < block.length) yield block.slice(segmentStart);
    start = end;
  }
  yield '"';
}

function readText(data: Data, index: number): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(readVariableBytes(data, index));
}

function readVariableBytes(data: Data, index: number): Uint8Array {
  const start = Number(data.valueOffsets[index]);
  const end = Number(data.valueOffsets[index + 1]);
  return data.values.subarray(start, end);
}

function* binaryParts(bytes: Uint8Array): Generator<string> {
  yield '0x';
  const blockBytes = 8 * 1024;
  for (let start = 0; start < bytes.length; start += blockBytes) {
    const end = Math.min(start + blockBytes, bytes.length);
    let hex = '';
    for (let index = start; index < end; index += 1) {
      hex += bytes[index]!.toString(16).padStart(2, '0');
    }
    yield hex;
  }
}

function readDecimal(data: Data, index: number, bitWidth: number): bigint {
  let value = 0n;
  const start = data.stride * index;
  for (let word = data.stride - 1; word >= 0; word -= 1) {
    value = (value << 32n) | BigInt(data.values[start + word]!);
  }
  const bits = BigInt(bitWidth);
  const signBit = 1n << (bits - 1n);
  return (value & signBit) === 0n ? value : value - (1n << bits);
}

function formatDecimal(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const sign = negative ? '-' : '';
  if (scale === 0) return `${sign}${digits}`;
  if (scale < 0) return `${sign}${digits}${'0'.repeat(-scale)}`;
  const padded = digits.padStart(scale + 1, '0');
  return `${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

function formatFloat(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return value.toString();
}

function formatTimestamp(value: bigint, unit: TimeUnit, utc: boolean): string {
  const unitsPerSecond = unitScale(unit);
  const unitsPerDay = unitsPerSecond * 86_400n;
  const days = floorDiv(value, unitsPerDay);
  const withinDay = value - days * unitsPerDay;
  return `${formatCivilDate(days)}T${formatTime(withinDay, unit)}${utc ? 'Z' : ''}`;
}

function formatTime(value: bigint, unit: TimeUnit): string {
  const unitsPerSecond = unitScale(unit);
  const seconds = value / unitsPerSecond;
  const fraction = value % unitsPerSecond;
  const hours = seconds / 3_600n;
  const minutes = (seconds % 3_600n) / 60n;
  const second = seconds % 60n;
  const precision = fractionDigits(unit);
  const suffix = precision === 0 ? '' : `.${fraction.toString().padStart(precision, '0')}`;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(second)}${suffix}`;
}

function unitScale(unit: TimeUnit): bigint {
  switch (unit) {
    case TimeUnit.SECOND:
      return 1n;
    case TimeUnit.MILLISECOND:
      return 1_000n;
    case TimeUnit.MICROSECOND:
      return 1_000_000n;
    case TimeUnit.NANOSECOND:
      return 1_000_000_000n;
  }
}

function fractionDigits(unit: TimeUnit): number {
  switch (unit) {
    case TimeUnit.SECOND:
      return 0;
    case TimeUnit.MILLISECOND:
      return 3;
    case TimeUnit.MICROSECOND:
      return 6;
    case TimeUnit.NANOSECOND:
      return 9;
  }
}

function formatCivilDate(epochDays: bigint): string {
  const shifted = epochDays + 719_468n;
  const era = floorDiv(shifted, 146_097n);
  const dayOfEra = shifted - era * 146_097n;
  const yearOfEra = (dayOfEra - dayOfEra / 1_460n + dayOfEra / 36_524n - dayOfEra / 146_096n) / 365n;
  let year = yearOfEra + era * 400n;
  const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const monthPrime = (5n * dayOfYear + 2n) / 153n;
  const day = dayOfYear - (153n * monthPrime + 2n) / 5n + 1n;
  const month = monthPrime + (monthPrime < 10n ? 3n : -9n);
  if (month <= 2n) year += 1n;
  return `${formatIsoYear(year)}-${pad2(month)}-${pad2(day)}`;
}

function formatIsoYear(year: bigint): string {
  if (year >= 0n && year <= 9_999n) return year.toString().padStart(4, '0');
  const sign = year < 0n ? '-' : '+';
  const magnitude = year < 0n ? -year : year;
  return `${sign}${magnitude.toString().padStart(6, '0')}`;
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

function pad2(value: bigint): string {
  return value.toString().padStart(2, '0');
}

function* boundedUtf8(parts: Iterable<string>): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  let output = new Uint8Array(MAX_CHUNK_BYTES);
  let length = 0;

  for (const part of parts) {
    for (let start = 0; start < part.length;) {
      let end = Math.min(start + TEXT_BLOCK_CODE_UNITS, part.length);
      if (end < part.length && isHighSurrogate(part.charCodeAt(end - 1))) end -= 1;
      const encoded = encoder.encode(part.slice(start, end));
      if (length + encoded.length > MAX_CHUNK_BYTES) {
        yield output.slice(0, length);
        output = new Uint8Array(MAX_CHUNK_BYTES);
        length = 0;
      }
      if (encoded.length === MAX_CHUNK_BYTES) {
        yield encoded;
      } else {
        output.set(encoded, length);
        length += encoded.length;
      }
      start = end;
    }
  }

  if (length > 0) yield output.slice(0, length);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
