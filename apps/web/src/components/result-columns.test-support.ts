import { Field, Int32, RecordBatch, Schema, Table, Utf8, tableFromArrays } from 'apache-arrow';
import { RESULT_LABEL_METADATA_KEY } from '@byteql/db/result-columns';

const resultField = (name: string, type: Int32 | Utf8, label: string): Field =>
  new Field(name, type, true, new Map([[RESULT_LABEL_METADATA_KEY, label]]));

export const withResultLabels = (source: Table, labels: readonly string[]): Table => {
  if (source.schema.fields.length !== labels.length) {
    throw new Error('Result labels must match the source column count.');
  }
  const schema = new Schema(
    source.schema.fields.map(
      (field, index) =>
        new Field(
          field.name,
          field.type,
          field.nullable,
          new Map([...field.metadata, [RESULT_LABEL_METADATA_KEY, labels[index]!]]),
        ),
    ),
  );
  return new Table(
    schema,
    source.batches.map((batch) => new RecordBatch(schema, batch.data)),
  );
};

/** A real result-shaped table: unique physical fields with repeated SQL labels. */
export const mixedDuplicateResultTable = (): Table => {
  const source = tableFromArrays({
    c0: Int32Array.from([10]),
    c1: ['ten'],
  });
  const schema = new Schema([resultField('c0', new Int32(), 'dup'), resultField('c1', new Utf8(), 'dup')]);
  const batch = new RecordBatch(schema, source.batches[0]!.data);
  return new Table(batch.schema, [batch]);
};

export const sameTypeDuplicateResultTable = (): Table => {
  const source = tableFromArrays({
    c0: Int32Array.from([10]),
    c1: Int32Array.from([20]),
  });
  const schema = new Schema([resultField('c0', new Int32(), 'dup'), resultField('c1', new Int32(), 'dup')]);
  const batch = new RecordBatch(schema, source.batches[0]!.data);
  return new Table(batch.schema, [batch]);
};

export const emptyLabelResultTable = (): Table => {
  const source = tableFromArrays({ c0: Int32Array.from([10]) });
  const schema = new Schema([resultField('c0', new Int32(), '')]);
  const batch = new RecordBatch(schema, source.batches[0]!.data);
  return new Table(batch.schema, [batch]);
};
