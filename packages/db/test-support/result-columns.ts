import { Field, Int32, RecordBatch, Schema, Table, Utf8, vectorFromArray } from 'apache-arrow';

import { RESULT_LABEL_METADATA_KEY } from '../src/result-columns.js';

/** Canonical mixed-type result fixture with unique physical names and repeated SQL labels. */
export const duplicateResultTable = (integers: readonly number[], strings: readonly string[]): Table => {
  const built = new Table({
    c0: vectorFromArray(Int32Array.from(integers)),
    c1: vectorFromArray(strings, new Utf8()),
  });
  const label = new Map([[RESULT_LABEL_METADATA_KEY, 'dup']]);
  const schema = new Schema([
    new Field('c0', new Int32(), true, label),
    new Field('c1', new Utf8(), true, label),
  ]);
  return new Table(
    schema,
    built.batches.map((batch) => new RecordBatch(schema, batch.data)),
  );
};
