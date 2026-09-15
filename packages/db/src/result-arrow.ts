import {
  DataType as DuckdbDataType,
  makeData as duckdbMakeData,
  RecordBatch as DuckdbRecordBatch,
  Schema as DuckdbSchema,
  Struct as DuckdbStruct,
  util as duckdbUtil,
} from 'apache-arrow-duckdb';

import { RESULT_LABEL_METADATA_KEY } from './result-columns.js';

/** Arrow 17's comparator omits decimal parameters, also inside nested/dictionary types. */
export function sameDuckdbResultType(left: DuckdbDataType, right: DuckdbDataType): boolean {
  if (!duckdbUtil.compareTypes(left, right)) return false;
  if (DuckdbDataType.isDecimal(left) && DuckdbDataType.isDecimal(right)) {
    return (
      left.scale === right.scale && left.precision === right.precision && left.bitWidth === right.bitWidth
    );
  }
  if (DuckdbDataType.isDictionary(left) && DuckdbDataType.isDictionary(right)) {
    return sameDuckdbResultType(left.dictionary, right.dictionary);
  }
  return (left.children ?? []).every((field, index) =>
    sameDuckdbResultType(field.type, right.children[index]!.type),
  );
}

/** Give every top-level result column a positional identity before Arrow can match it by name. */
export function normalizeDuckdbResultSchema(schema: DuckdbSchema): DuckdbSchema {
  const fields = schema.fields.map((field, index) =>
    field.clone({
      name: `c${index}`,
      metadata: new Map(field.metadata).set(RESULT_LABEL_METADATA_KEY, field.name),
    }),
  );
  return new DuckdbSchema(fields, new Map(schema.metadata));
}

export function normalizeDuckdbResultBatch(
  batch: DuckdbRecordBatch,
  sourceSchema: DuckdbSchema,
): DuckdbRecordBatch {
  // Arrow 17's RecordBatch constructor assigns schema fields by name. With duplicates its
  // public schema may already contain the last field's type/metadata at the first position.
  // The original parent Struct fields and child Data remain positional, including for the
  // reader's zero-row placeholder. Use those fields when the cursor schema is provisional.
  const fields = sourceSchema.fields.length ? sourceSchema.fields : batch.data.type.children;
  const children = batch.data.children;
  if (fields.length !== children.length || batch.schema.fields.length !== children.length) {
    throw new Error('Result column count does not match the cursor schema.');
  }
  const normalizedFields = fields.map((field, index) => {
    const child = children[index]!;
    if (!sameDuckdbResultType(field.type, child.type)) {
      throw new Error(`Result type does not match the cursor schema at column ${index}.`);
    }
    if (child.length !== batch.numRows) {
      throw new Error(`Result row count does not match at column ${index}.`);
    }
    return field.clone({
      name: `c${index}`,
      type: child.type,
      metadata: new Map(field.metadata).set(RESULT_LABEL_METADATA_KEY, field.name),
    });
  });
  const schema = new DuckdbSchema(
    normalizedFields,
    new Map(sourceSchema.fields.length ? sourceSchema.metadata : batch.schema.metadata),
  );
  const data = duckdbMakeData({
    type: new DuckdbStruct(normalizedFields),
    length: batch.numRows,
    children,
  });
  return new DuckdbRecordBatch(schema, data);
}
