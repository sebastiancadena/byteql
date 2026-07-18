import { describe, expect, it } from 'vitest';
import { compileProjection } from './project.js';
import { parseProjectionSpec } from './spec.js';
import type { ParserRegistry } from './parsers.js';

const registry: ParserRegistry = new Map([
  ['inner_parser', () => ({ root: {} })],
  ['deep_parser', () => ({ root: {} })],
]);

const baseYaml = `
version: '0.2'
format: envelope
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      kind: { expr: '_.kind', type: uint8 }
  - name: inner
    rows: $.items[*]
    key: inner_id
    parent_key: { table: records, column: record_id }
    columns:
      label: { expr: '_.label', type: utf8 }
dissect:
  - from: records
    payload: _.body
    chain:
      - { when: '_.kind == 0x01', parser: inner_parser, table: inner }
`;

describe('spec v0.2', () => {
  it('parses and compiles a valid dissect spec', () => {
    const compiled = compileProjection(parseProjectionSpec(baseYaml), registry);
    expect(compiled.rootTables.map((table) => table.name)).toEqual(['records']);
    expect(compiled.dissectByFrom.get('records')).toHaveLength(1);
    expect(compiled.tables.find((table) => table.name === 'inner')!.parentKey).toEqual({
      table: 'records',
      column: 'record_id',
    });
  });

  it('rejects dissect under version 0.1', () => {
    const yaml = baseYaml.replace("version: '0.2'", "version: '0.1'");
    expect(() => parseProjectionSpec(yaml)).toThrowError(/PROJECTION_VERSION_REQUIRED/u);
  });

  it('rejects a parent_key column that is not the parent key', () => {
    const yaml = baseYaml.replace('column: record_id', 'column: wrong_id');
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(
      /PROJECTION_PARENT_KEY_INVALID/u,
    );
  });

  it('rejects a chain table without parent_key', () => {
    const yaml = baseYaml.replace(/ {4}parent_key: .*\n/u, '');
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(
      /PROJECTION_DISSECT_INVALID/u,
    );
  });

  it('rejects an unknown from reference', () => {
    const yaml = baseYaml.replace('from: records', 'from: nowhere');
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(
      /PROJECTION_DISSECT_INVALID/u,
    );
  });

  it('rejects an unregistered parser', () => {
    expect(() => compileProjection(parseProjectionSpec(baseYaml), new Map())).toThrowError(
      /PROJECTION_PARSER_UNKNOWN/u,
    );
  });

  it('rejects a cyclic dissect graph', () => {
    const yaml = `${baseYaml}  - from: inner_parser
    payload: _.next
    chain:
      - { when: 'true', parser: inner_parser }
`;
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(
      /PROJECTION_DISSECT_CYCLE/u,
    );
  });

  it('keeps version 0.1 specs compiling without a registry', () => {
    const yaml = `
version: '0.1'
format: plain
tables:
  - name: rows
    rows: $.rows[*]
    key: row_id
    columns:
      value: { expr: '_.value', type: int32 }
`;
    expect(() => compileProjection(parseProjectionSpec(yaml))).not.toThrow();
  });

  it('rejects a parent_key whose table is unreachable from the dissect ancestor chain (self-reference)', () => {
    const yaml = baseYaml.replace(
      'parent_key: { table: records, column: record_id }',
      'parent_key: { table: inner, column: inner_id }',
    );
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(
      /PROJECTION_PARENT_KEY_INVALID/u,
    );
  });

  it('rejects a parent_key that points at a table outside the dissect ancestor chain (rule 7)', () => {
    // `bystander` is a valid, distinct root table whose key legitimately matches inner's
    // parent_key.column, so rules 2 and 3 both pass. It is never an ancestor of the `records`
    // dissect entry that feeds `inner`, though, so only rule 7's fixpoint reachability check
    // can catch this.
    const yaml = `
version: '0.2'
format: envelope
tables:
  - name: records
    rows: $.records[*]
    key: record_id
    columns:
      kind: { expr: '_.kind', type: uint8 }
  - name: bystander
    rows: $.bystanders[*]
    key: bystander_id
    columns:
      note: { expr: '_.note', type: utf8 }
  - name: inner
    rows: $.items[*]
    key: inner_id
    parent_key: { table: bystander, column: bystander_id }
    columns:
      label: { expr: '_.label', type: utf8 }
dissect:
  - from: records
    payload: _.body
    chain:
      - { when: '_.kind == 0x01', parser: inner_parser, table: inner }
`;
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(
      /PROJECTION_PARENT_KEY_INVALID/u,
    );
  });
});
