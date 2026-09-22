import { DataType, Field, RecordBatch, Schema, Table, Uint64, Vector, vectorFromArray } from 'apache-arrow';

const POSITIONAL_ALIAS = /^c(?:0|[1-9]\d*)$/u;

const assertSafeOffset = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
};

/** Re-labels a table's batches against `schema` without touching a single value buffer. */
const relabel = (table: Table, schema: Schema): Table =>
  new Table(
    schema,
    table.batches.map((batch) => new RecordBatch(schema, batch.data)),
  );

/**
 * Stages one retained result page for the snapshot sort: user field names are replaced by
 * generated positional aliases (`c0`, `c1`, …) so nothing user-controlled reaches DuckDB, and an
 * exact Uint64 ordinal records each row's position in the original query execution.
 *
 * Existing vectors are aliased, never rebuilt from `.get()` — values keep their Arrow
 * representation, which is what makes >2^53 integers and decimals survive the round trip.
 */
export function snapshotPage(table: Table, startRow: number, ordinalName: string): Table {
  assertSafeOffset(startRow, 'Page start row');
  assertSafeOffset(startRow + table.numRows, 'Page end row');
  if (POSITIONAL_ALIAS.test(ordinalName)) {
    throw new Error(`The sort ordinal name ${ordinalName} would collide with a positional alias.`);
  }

  const columns: Record<string, Vector> = {};
  const fields: Field[] = [];
  table.schema.fields.forEach((_field, index) => {
    let child = table.getChildAt(index)!;
    // A zero-BATCH table (e.g. `new Table(schema)`, as the Parquet writer's empty-result branch
    // builds) hands back a List vector whose buffers apache-arrow's own assembler cannot later
    // serialize once it passes through the Record<string, Vector> constructor below — a rebuilt,
    // genuinely empty vector carries proper offsets/children instead.
    if (table.numRows === 0 && DataType.isList(child.type)) {
      child = vectorFromArray([], child.type);
    }
    columns[`c${index}`] = child;
    // Types come from the CHILD VECTOR, never from the page's declared field. Arrow matches
    // schema fields by name whenever a RecordBatch is built, so a result with duplicate column
    // names declares the last duplicate's type for every duplicate while the vectors keep the
    // true ones. Staging the declaration would hand DuckDB a lie about the buffers.
    //
    // Nullability is stated uniformly rather than inferred per page: a page that happens to hold
    // no nulls must still stage the same column types as one that does, so a single TEMP table
    // accepts every page of the result.
    fields.push(new Field(`c${index}`, child.type, true));
  });
  const ordinals = new BigUint64Array(table.numRows);
  for (let index = 0; index < ordinals.length; index++) {
    ordinals[index] = BigInt(startRow) + BigInt(index);
  }
  // The single-argument typed-array overload maps BigUint64Array to Arrow Uint64 directly.
  columns[ordinalName] = vectorFromArray(ordinals);
  fields.push(new Field(ordinalName, new Uint64(), false));

  // `new Table(Record<string, Vector>)` redistributes differing chunk layouts onto shared batch
  // boundaries; the relabel then restates the generated schema over those same buffers.
  return relabel(new Table(columns), new Schema(fields));
}

const sameType = (left: DataType, right: DataType): boolean => {
  if (left.typeId !== right.typeId) return false;
  if (DataType.isInt(left) && DataType.isInt(right)) {
    return left.bitWidth === right.bitWidth && left.isSigned === right.isSigned;
  }
  if (DataType.isFloat(left) && DataType.isFloat(right)) return left.precision === right.precision;
  if (DataType.isDecimal(left) && DataType.isDecimal(right)) {
    return (
      left.precision === right.precision && left.scale === right.scale && left.bitWidth === right.bitWidth
    );
  }
  if (DataType.isDate(left) && DataType.isDate(right)) return left.unit === right.unit;
  if (DataType.isTime(left) && DataType.isTime(right)) {
    return left.unit === right.unit && left.bitWidth === right.bitWidth;
  }
  if (DataType.isTimestamp(left) && DataType.isTimestamp(right)) {
    return left.unit === right.unit && (left.timezone ?? null) === (right.timezone ?? null);
  }
  if (DataType.isInterval(left) && DataType.isInterval(right)) return left.unit === right.unit;
  if (DataType.isFixedSizeBinary(left) && DataType.isFixedSizeBinary(right)) {
    return left.byteWidth === right.byteWidth;
  }
  const leftChildren = left.children ?? [];
  const rightChildren = right.children ?? [];
  if (leftChildren.length !== rightChildren.length) return false;
  return leftChildren.every((child, index) => sameType(child.type, rightChildren[index]!.type));
};

/**
 * Puts the original query schema — names, metadata, field metadata — back onto a sorted table.
 *
 * Physical compatibility is checked FIRST: a mismatch fails the candidate instead of relabelling
 * buffers that mean something else. Only names and metadata are restored; the ordering DuckDB
 * produced is left exactly as it is.
 */
export function restoreResultSchema(table: Table, schema: Schema): Table {
  if (table.schema.fields.length !== schema.fields.length) {
    throw new Error(
      `Sorted result field count ${table.schema.fields.length} does not match the original ` +
        `${schema.fields.length}.`,
    );
  }
  for (const [index, field] of schema.fields.entries()) {
    const actual = table.schema.fields[index]!;
    if (!sameType(actual.type, field.type)) {
      throw new Error(
        `Sorted result column ${index + 1} has type ${actual.type.toString()}, but the original ` +
          `result declares ${field.type.toString()}.`,
      );
    }
  }
  return relabel(table, schema);
}
