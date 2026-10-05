import { describe, expect, it } from 'vitest';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import type { ParserRegistry } from './parsers.js';
import type { StreamRegistries } from './streams.js';

const parsers: ParserRegistry = new Map([
  ['px', () => ({ root: {} })],
  ['leaf_parser', () => ({ root: {} })],
  ['chunk_parser', () => ({ root: {} })],
  ['msg_parser', () => ({ root: {} })],
  ['word_parser', () => ({ root: {} })],
]);
const streams: StreamRegistries = {
  keyExtractors: new Map([['chunk_key', () => ({ key: 'k', root: {} })]]),
  framers: new Map([['len_framer', () => null]]),
};
const compile = (yaml: string) => compileProjection(parseProjectionSpec(yaml), parsers, streams);

// A parser fed from two root tables; a leaf under it parents onto only one of them.
const sharedParser = (parentTable: string) => `
version: '0.4'
format: probe
tables:
  - name: top
    rows: $
    key: top_id
    columns: { n: { expr: '_.n', type: uint8, nullable: true } }
  - name: a
    rows: $.a[*]
    key: a_id
    parent_key: { table: top, column: top_id }
    columns: { n: { expr: '_.n', type: uint8 } }
  - name: b
    rows: $.b[*]
    key: b_id
    parent_key: { table: top, column: top_id }
    columns: { n: { expr: '_.n', type: uint8 } }
  - name: leaf
    rows: $
    key: leaf_id
    parent_key: { table: ${parentTable}, column: ${parentTable}_id }
    columns: { n: { expr: '_.n', type: uint8 } }
dissect:
  - from: top
    payload: _.body
    chain:
      - { when: 'true', parser: chunk_parser, table: a }
      - { when: 'true', parser: msg_parser, table: b }
  - from: a
    payload: _.body
    chain:
      - { when: 'true', parser: px }
  - from: b
    payload: _.body
    chain:
      - { when: 'true', parser: px }
  - from: px
    payload: _.inner
    chain:
      - { when: 'true', parser: leaf_parser, table: leaf }
`;

describe('parent-key must-reach', () => {
  it('rejects a parent_key reachable on only one path into a shared parser', () => {
    expect(() => compile(sharedParser('a'))).toThrowError(
      /PROJECTION_PARENT_KEY_INVALID[\s\S]*"a" is not reachable from "px"/u,
    );
  });

  it('accepts a parent_key every path into the shared parser carries', () => {
    expect(() => compile(sharedParser('top'))).not.toThrow();
  });
});
