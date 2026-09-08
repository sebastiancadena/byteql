import { isSupportedParquetType, unsupportedParquetTypeMessage } from '@byteql/db';
import { DataType, type Schema } from 'apache-arrow';

export type ExportFormat = 'csv' | 'parquet';

export type ExportOptions = {
  format: ExportFormat;
  includeProvenance: boolean;
};

export function selectExportColumns(schema: Schema, options: ExportOptions): number[] {
  const columns = schema.fields
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => options.includeProvenance || !field.name.startsWith('_'));

  if (columns.length === 0) {
    throw new Error('At least one column must be selected for export.');
  }

  for (const { field } of columns) {
    const supported =
      options.format === 'parquet' ? isSupportedParquetType(field.type) : isSupportedCsvScalar(field.type);
    if (!supported) {
      if (options.format === 'parquet') {
        throw new Error(unsupportedParquetTypeMessage(field.name, field.type));
      }
      throw new Error(
        `Column "${field.name}" has unsupported type ${field.type}; cast it explicitly in SQL before exporting.`,
      );
    }
  }

  if (options.format === 'parquet') {
    const names = new Map<string, string>();
    for (const { field } of columns) {
      const comparable = duckDbIdentifierKey(field.name);
      const previous = names.get(comparable);
      if (previous !== undefined) {
        throw new Error(
          `Parquet cannot export duplicate column name "${field.name}" (also "${previous}"); alias one in SQL.`,
        );
      }
      names.set(comparable, field.name);
    }
  }

  return columns.map(({ index }) => index);
}

export function exportFilename(names: readonly string[], format: ExportFormat): string {
  if (names.length !== 1) {
    return `byteql-results.${format}`;
  }

  const component = names[0]?.split(/[\\/]/).at(-1) ?? '';
  const extensionIndex = component.lastIndexOf('.');
  const withoutExtension = extensionIndex > 0 ? component.slice(0, extensionIndex) : component;
  const sanitized = Array.from(withoutExtension, (character) => (isPathInvalid(character) ? '_' : character))
    .slice(0, 120)
    .join('');

  return `${sanitized || 'byteql'}-results.${format}`;
}

function isSupportedCsvScalar(type: DataType): boolean {
  if (DataType.isDictionary(type)) {
    return isSupportedCsvScalar(type.dictionary);
  }

  return (
    DataType.isNull(type) ||
    DataType.isInt(type) ||
    DataType.isFloat(type) ||
    DataType.isDecimal(type) ||
    DataType.isBool(type) ||
    DataType.isUtf8(type) ||
    DataType.isLargeUtf8(type) ||
    DataType.isBinary(type) ||
    DataType.isLargeBinary(type) ||
    DataType.isFixedSizeBinary(type) ||
    DataType.isDate(type) ||
    DataType.isTime(type) ||
    DataType.isTimestamp(type)
  );
}

function duckDbIdentifierKey(name: string): string {
  return name.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function isPathInvalid(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || '<>:"/\\|?*'.includes(character);
}
