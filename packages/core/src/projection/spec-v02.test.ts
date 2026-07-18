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

  it('parses an unquoted numeric version: 0.2 the same as the quoted string', () => {
    const yaml = baseYaml.replace("version: '0.2'", 'version: 0.2');
    const compiled = compileProjection(parseProjectionSpec(yaml), registry);
    expect(compiled.dissectByFrom.get('records')).toHaveLength(1);
  });

  it('rejects dissect under version 0.1', () => {
    const yaml = baseYaml.replace("version: '0.2'", "version: '0.1'");
    expect(() => parseProjectionSpec(yaml)).toThrowError(/PROJECTION_VERSION_REQUIRED/u);
  });

  it('rejects parent_key under version 0.1 even without a dissect block', () => {
    // parent_key is a version-0.2 feature on its own, independent of whether a dissect block
    // is present — this pins the second (parent_key-scanning) branch of parseProjectionSpec's
    // version-0.1 guard, distinct from the dissect-block branch covered above.
    const yaml = `
version: '0.1'
format: plain
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
`;
    expect(() => parseProjectionSpec(yaml)).toThrowError(/PROJECTION_VERSION_REQUIRED/u);
  });

  it('rejects a parent_key.table that names an undeclared table', () => {
    const yaml = baseYaml.replace('table: records, column: record_id', 'table: nowhere, column: record_id');
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(
      /PROJECTION_PARENT_KEY_INVALID/u,
    );
  });

  it('rejects a table that declares parent_key but is not fed by any dissect chain link', () => {
    // Unlike "rejects a chain table without parent_key" above (inner keeps its chain slot but
    // loses parent_key), this drops the chain's `table: inner` reference while inner keeps its
    // parent_key — rule 3's dissect-fed check, not rule 2's parent_key-shape check.
    const yaml = baseYaml.replace(', table: inner', '');
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(
      /PROJECTION_DISSECT_INVALID/u,
    );
  });

  it('rejects a state-like identifier referenced in a dissect payload or when', () => {
    // Dissect payload/when expressions always compile against an empty declared-state set
    // (compileProjection passes `new Set()` for both), so any bare identifier that isn't a
    // context name (_, _root, _parent) is treated as an undeclared state reference — this
    // pins that existing branch and records which code it actually throws.
    const yaml = baseYaml.replace("when: '_.kind == 0x01'", "when: '_.kind == 0x01 && counter == 1'");
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(
      /EXPRESSION_STATE_UNDECLARED/u,
    );
  });

  it('rejects _index in a parser-rooted dissect when clause', () => {
    // A dissect entry chained off a parser id (from: inner_parser) evaluates its when/payload
    // against a bare { _, _root } context with no anchor match, so _index has nothing to read.
    const yaml = `${baseYaml}  - from: inner_parser
    payload: _.next
    chain:
      - { when: '_index(0) == 0', parser: deep_parser }
`;
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(
      /PROJECTION_DISSECT_INVALID/u,
    );
  });

  it('allows _parent and _index in a table-rooted dissect when clause', () => {
    // from: records is a declared table, so its chain fires from emitRow's full row context,
    // where _parent and _index are legitimate — the guard must not reject this shape.
    const yaml = baseYaml.replace(
      "when: '_.kind == 0x01'",
      "when: '_.kind == 0x01 && _index(0) == 0 && _parent == null'",
    );
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).not.toThrow();
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

  it('rejects a parent_key on a table only reachable through a chain-fed sibling, not through a parser id (rule 7 matches runtime reachability)', () => {
    // `inner` is chain-fed via `inner_parser` (from: records), and `deep` chains off
    // `from: inner_parser` itself. At runtime, fireDissect's `deeper` loop for entries keyed
    // off a parser id runs with the OUTER keysByTable, which never gained inner's row key
    // (only chains keyed `from: inner` — a table — would extend keysByTable with it via
    // emitRow). So deep.parent_key pointing at inner must be rejected at compile time, even
    // though inner is fed by the same dissect graph.
    const yaml =
      baseYaml.replace(
        'dissect:',
        `  - name: deep
    rows: $.parts[*]
    key: deep_id
    parent_key: { table: inner, column: inner_id }
    columns:
      flag: { expr: '_.flag', type: bool }
dissect:`,
      ) +
      `  - from: inner_parser
    payload: _.trailer
    chain:
      - { when: 'true', parser: deep_parser, table: deep }
`;
    expect(() => compileProjection(parseProjectionSpec(yaml), registry)).toThrowError(
      /PROJECTION_PARENT_KEY_INVALID/u,
    );
  });
});
