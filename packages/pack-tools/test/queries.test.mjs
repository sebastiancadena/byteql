import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lintQueries } from '../src/queries.mjs';

const lint = (sql) =>
  lintQueries(
    {
      version: '0.1',
      queries: [{ id: 'q', title: 'Q', kind: 'grid', sql }],
    },
    { tables: new Set(['rec']), capabilities: [], file: 'queries.yaml' },
  );

test('table functions with a table-valued call are not mistaken for unknown table names', () => {
  assert.doesNotThrow(() => lint('select * from range(10)'));
  assert.doesNotThrow(() => lint('select * from unnest([1,2])'));
});

test('a lateral join with a parenthesized subquery is not mistaken for an unknown table name', () => {
  assert.doesNotThrow(() => lint('select * from rec join lateral (select 1) as t on true'));
});

test('a quoted table identifier is still checked against known tables', () => {
  assert.doesNotThrow(() => lint('select * from "rec"'));
  assert.throws(() => lint('select * from "nope"'), /unknown table "nope"/u);
});

test('an unknown bare table name is still rejected', () => {
  assert.throws(() => lint('select * from nope'), /unknown table "nope"/u);
});

test('an unexpected top-level key is rejected with a clear queries.yaml error', () => {
  assert.throws(
    () =>
      lintQueries(
        { version: '0.1', format: 'demo', queries: [] },
        { tables: new Set(), capabilities: [], file: 'queries.yaml' },
      ),
    /queries\.yaml: unexpected key "format"/u,
  );
});
