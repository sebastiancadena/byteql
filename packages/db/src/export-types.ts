import { DataType, DateUnit, Precision, TimeUnit } from 'apache-arrow';

export interface ParquetExportOptions {
  readonly columns: readonly number[];
  readonly signal: AbortSignal;
  onProgress(rows: number): void;
}

export interface ParquetArtifact {
  readonly file: File;
  dispose(): Promise<void>;
}

/**
 * Arrow types whose logical type and value are preserved by the pinned DuckDB-WASM Parquet path.
 * Keep this narrower than CSV: dictionary encoding, null-only columns, large/fixed-width binary
 * variants, and non-DuckDB temporal representations are not proven lossless.
 */
export const isSupportedParquetType = (type: DataType): boolean =>
  DataType.isInt(type) ||
  (DataType.isFloat(type) && (type.precision === Precision.SINGLE || type.precision === Precision.DOUBLE)) ||
  (DataType.isDecimal(type) && type.bitWidth === 128) ||
  DataType.isBool(type) ||
  DataType.isUtf8(type) ||
  DataType.isBinary(type) ||
  (DataType.isDate(type) && type.unit === DateUnit.DAY) ||
  (DataType.isTime(type) && type.unit === TimeUnit.MICROSECOND) ||
  (DataType.isTimestamp(type) && (type.unit === TimeUnit.MICROSECOND || type.unit === TimeUnit.NANOSECOND));

const parquetCastTarget = (type: DataType): string => {
  if (DataType.isTimestamp(type)) return 'TIMESTAMP or TIMESTAMP_NS';
  if (DataType.isTime(type)) return 'TIME';
  if (DataType.isDate(type)) return 'DATE';
  if (DataType.isFloat(type)) return 'FLOAT or DOUBLE';
  if (DataType.isDecimal(type)) return 'a DECIMAL with precision at most 38';
  if (DataType.isLargeBinary(type) || DataType.isFixedSizeBinary(type)) return 'BLOB';
  if (DataType.isLargeUtf8(type) || DataType.isDictionary(type) || DataType.isNull(type)) {
    return 'VARCHAR or another supported DuckDB scalar type';
  }
  return 'a supported DuckDB scalar type';
};

export const unsupportedParquetTypeMessage = (column: string, type: DataType): string =>
  `Column "${column}" has unsupported Parquet type ${type}; ` +
  `cast it to ${parquetCastTarget(type)} in SQL before exporting.`;
