import {
  compileAnchor,
  isAnchorPrefix,
  traverseAnchor,
  type AnchorMatch,
  type CompiledAnchor,
} from './anchors.js';
import {
  ProjectionCompileError,
  compileExpression,
  evaluateExpression,
  getExpressionStateReferences,
  type CompiledExpression,
  type ExpressionContext,
} from './expression.js';
import type { IssueCollector } from '../issues.js';
import type { ParsedRecord, ParserRegistry, RecordParser } from './parsers.js';
import type { ArrowTypeName, ProjectionSpec, TableSpec } from './spec.js';
import { buildMatcher, walkMatcher } from './walk.js';

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface ProvenanceResolver {
  resolve(table: string, anchor: AnchorMatch): SourceRange;
}

interface CompiledState {
  readonly name: string;
  readonly scope: CompiledAnchor;
  readonly init: number;
  readonly update: CompiledExpression;
}

interface CompiledColumn {
  readonly name: string;
  readonly expr: CompiledExpression;
  readonly type: ArrowTypeName;
  readonly when?: CompiledExpression;
}

interface CompiledProjectionTable {
  readonly name: string;
  readonly rows: CompiledAnchor;
  readonly where?: CompiledExpression;
  readonly key: string;
  readonly state: readonly CompiledState[];
  readonly columns: readonly CompiledColumn[];
  readonly parentKey: { table: string; column: string } | null;
}

export interface CompiledChainLink {
  readonly when: CompiledExpression;
  readonly parserId: string;
  readonly parser: RecordParser;
  readonly table: CompiledProjectionTable | null;
}

export interface CompiledDissect {
  readonly from: string;
  readonly payload: CompiledExpression;
  readonly chain: readonly CompiledChainLink[];
}

export interface CompiledProjection {
  readonly format: string;
  readonly tables: readonly CompiledProjectionTable[];
  readonly rootTables: readonly CompiledProjectionTable[];
  readonly dissectByFrom: ReadonlyMap<string, readonly CompiledDissect[]>;
}

export interface ProjectedTable {
  readonly name: string;
  readonly columns: Record<string, readonly unknown[]>;
  readonly types: Record<string, ArrowTypeName>;
  readonly rowCount: number;
}

const reservedOutputNames = new Set(['_src_start', '_src_end']);

const compileAtPath = (source: string, path: string): CompiledExpression => {
  try {
    return compileExpression(source);
  } catch (error) {
    if (!(error instanceof ProjectionCompileError)) throw error;
    throw new ProjectionCompileError(error.code, path, error.message);
  }
};

const requireDeclaredState = (
  expression: CompiledExpression,
  declaredState: ReadonlySet<string>,
  path: string,
): void => {
  for (const reference of getExpressionStateReferences(expression)) {
    if (!declaredState.has(reference)) {
      throw new ProjectionCompileError(
        'EXPRESSION_STATE_UNDECLARED',
        path,
        `state ${JSON.stringify(reference)} is not declared by this table`,
      );
    }
  }
};

const compileCheckedExpression = (
  source: string,
  declaredState: ReadonlySet<string>,
  path: string,
): CompiledExpression => {
  const expression = compileAtPath(source, path);
  requireDeclaredState(expression, declaredState, path);
  return expression;
};

const validateParentKey = (
  table: TableSpec,
  tablePath: string,
  specTableByName: ReadonlyMap<string, TableSpec>,
): { table: string; column: string } | null => {
  if (!table.parent_key) return null;
  const parentTable = specTableByName.get(table.parent_key.table);
  if (!parentTable) {
    throw new ProjectionCompileError(
      'PROJECTION_PARENT_KEY_INVALID',
      `${tablePath}.parent_key.table`,
      `table ${JSON.stringify(table.parent_key.table)} is not declared`,
    );
  }
  if (table.parent_key.column !== parentTable.key) {
    throw new ProjectionCompileError(
      'PROJECTION_PARENT_KEY_INVALID',
      `${tablePath}.parent_key.column`,
      `column ${JSON.stringify(table.parent_key.column)} must equal parent table ${JSON.stringify(
        table.parent_key.table,
      )}'s key ${JSON.stringify(parentTable.key)}`,
    );
  }
  if (table.key === table.parent_key.column) {
    throw new ProjectionCompileError(
      'PROJECTION_PARENT_KEY_INVALID',
      `${tablePath}.key`,
      `key ${JSON.stringify(table.key)} collides with parent_key.column ${JSON.stringify(table.parent_key.column)}`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(table.columns, table.parent_key.column)) {
    throw new ProjectionCompileError(
      'PROJECTION_PARENT_KEY_INVALID',
      `${tablePath}.columns.${table.parent_key.column}`,
      `column ${JSON.stringify(table.parent_key.column)} collides with parent_key.column`,
    );
  }
  return { table: table.parent_key.table, column: table.parent_key.column };
};

export const compileProjection = (
  spec: ProjectionSpec,
  registry: ParserRegistry = new Map(),
): CompiledProjection => {
  const specTableByName = new Map(spec.tables.map((table) => [table.name, table]));
  const tables = spec.tables.map((table, tableIndex): CompiledProjectionTable => {
    const tablePath = `tables.${tableIndex}`;
    if (reservedOutputNames.has(table.key)) {
      throw new ProjectionCompileError(
        'PROJECTION_SPEC_INVALID',
        `${tablePath}.key`,
        `key ${JSON.stringify(table.key)} is reserved for automatic provenance`,
      );
    }
    for (const name of Object.keys(table.columns)) {
      if (name === table.key) {
        throw new ProjectionCompileError(
          'PROJECTION_SPEC_INVALID',
          `${tablePath}.columns.${name}`,
          `column ${JSON.stringify(name)} collides with the table's synthetic key`,
        );
      }
      if (reservedOutputNames.has(name)) {
        throw new ProjectionCompileError(
          'PROJECTION_SPEC_INVALID',
          `${tablePath}.columns.${name}`,
          `column ${JSON.stringify(name)} is reserved for automatic provenance`,
        );
      }
    }
    const rows = compileAnchor(table.rows, `${tablePath}.rows`);
    const declaredState = new Set(Object.keys(table.state ?? {}));
    const state = Object.entries(table.state ?? {}).map(([name, stateSpec]): CompiledState => {
      const path = `${tablePath}.state.${name}`;
      const scope = compileAnchor(stateSpec.scope, `${path}.scope`);
      if (!isAnchorPrefix(scope, rows)) {
        throw new ProjectionCompileError(
          'PROJECTION_STATE_SCOPE_INVALID',
          `${path}.scope`,
          `scope ${JSON.stringify(stateSpec.scope)} must be an exact prefix of rows ${JSON.stringify(table.rows)}`,
        );
      }
      return Object.freeze({
        name,
        scope,
        init: stateSpec.init,
        update: compileCheckedExpression(stateSpec.update, declaredState, `${path}.update`),
      });
    });
    const columns = Object.entries(table.columns).map(([name, column]): CompiledColumn => {
      const path = `${tablePath}.columns.${name}`;
      return Object.freeze({
        name,
        expr: compileCheckedExpression(column.expr, declaredState, `${path}.expr`),
        type: column.type,
        ...(column.when === undefined
          ? {}
          : { when: compileCheckedExpression(column.when, declaredState, `${path}.when`) }),
      });
    });

    return Object.freeze({
      name: table.name,
      rows,
      ...(table.where === undefined
        ? {}
        : { where: compileCheckedExpression(table.where, declaredState, `${tablePath}.where`) }),
      key: table.key,
      state: Object.freeze(state),
      columns: Object.freeze(columns),
      parentKey: validateParentKey(table, tablePath, specTableByName),
    });
  });

  const tableByName = new Map(tables.map((table) => [table.name, table]));
  const parserIds = new Set((spec.dissect ?? []).flatMap((entry) => entry.chain.map((link) => link.parser)));
  const dissectTables = new Set<string>();
  const dissects = (spec.dissect ?? []).map((entry, entryIndex): CompiledDissect => {
    const path = `dissect.${entryIndex}`;
    if (!tableByName.has(entry.from) && !parserIds.has(entry.from)) {
      throw new ProjectionCompileError(
        'PROJECTION_DISSECT_INVALID',
        `${path}.from`,
        `from ${JSON.stringify(entry.from)} is neither a declared table nor a chained parser`,
      );
    }
    const chain = entry.chain.map((link, linkIndex): CompiledChainLink => {
      const linkPath = `${path}.chain.${linkIndex}`;
      const parser = registry.get(link.parser);
      if (!parser) {
        throw new ProjectionCompileError(
          'PROJECTION_PARSER_UNKNOWN',
          `${linkPath}.parser`,
          `parser ${JSON.stringify(link.parser)} is not registered`,
        );
      }
      let table: CompiledProjectionTable | null = null;
      if (link.table !== undefined) {
        table = tableByName.get(link.table) ?? null;
        if (!table) {
          throw new ProjectionCompileError(
            'PROJECTION_DISSECT_INVALID',
            `${linkPath}.table`,
            `table ${JSON.stringify(link.table)} is not declared`,
          );
        }
        if (!table.parentKey) {
          throw new ProjectionCompileError(
            'PROJECTION_DISSECT_INVALID',
            `${linkPath}.table`,
            `table ${JSON.stringify(link.table)} must declare parent_key to receive dissected rows`,
          );
        }
        dissectTables.add(link.table); // multiple links may feed the same table (pcap: ipv4 and ipv6 -> ip)
      }
      return Object.freeze({
        when: compileCheckedExpression(link.when, new Set(), `${linkPath}.when`),
        parserId: link.parser,
        parser,
        table,
      });
    });
    return Object.freeze({
      from: entry.from,
      payload: compileCheckedExpression(entry.payload, new Set(), `${path}.payload`),
      chain: Object.freeze(chain),
    });
  });

  // Rule 3: every table with parent_key must be fed by at least one chain link, and is
  // therefore dissect-only (excluded from rootTables).
  for (const [tableIndex, table] of tables.entries()) {
    if (table.parentKey && !dissectTables.has(table.name)) {
      throw new ProjectionCompileError(
        'PROJECTION_DISSECT_INVALID',
        `tables.${tableIndex}.parent_key`,
        `table ${JSON.stringify(table.name)} declares parent_key but is not fed by any dissect chain link`,
      );
    }
  }

  // Rule 5: the graph over nodes (table names ∪ parser ids) with edges from -> chain[].parser
  // must be acyclic.
  const edges = new Map<string, string[]>();
  for (const entry of dissects) {
    const parserList = edges.get(entry.from) ?? [];
    for (const link of entry.chain) parserList.push(link.parserId);
    edges.set(entry.from, parserList);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const detectCycle = (node: string): void => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      throw new ProjectionCompileError(
        'PROJECTION_DISSECT_CYCLE',
        'dissect',
        `dissect graph has a cycle involving ${JSON.stringify(node)}`,
      );
    }
    visiting.add(node);
    for (const next of edges.get(node) ?? []) detectCycle(next);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of edges.keys()) detectCycle(node);

  // Rule 7: for each chain link with a table, that table's parent_key.table must be reachable
  // by walking from-ancestors of the dissect entry, so the key value exists at runtime.
  // Ancestors are computed as a fixpoint over the (now acyclic) from -> parser graph: a parser
  // id's ancestors are the union, over every entry whose chain contains it, of that entry's
  // ancestors, plus that entry's `from` when it is a table (folded in by ancestorsOfEntry below).
  // A chain link's own table is deliberately NOT added to its parser's ancestor set: at runtime,
  // dissect entries keyed off a PARSER id run in fireDissect's `deeper` loop with the OUTER
  // keysByTable, so they never observe the row key of a sibling link's table. Admitting a
  // chain-fed table here would accept specs whose parent_key the runtime can only fill with
  // null. The still-legitimate way to parent a table onto an intermediate table's per-row key is
  // to chain `from: <table>` instead of `from: <parser>` — chains fired from emitRow extend
  // keysByTable with that table's own key before dispatching, so that table (and its ancestors)
  // are genuinely reachable.
  const ancestorsByParser = new Map<string, Set<string>>();
  const ancestorsOfEntry = (entry: CompiledDissect): ReadonlySet<string> => {
    if (tableByName.has(entry.from)) return new Set([entry.from]);
    return ancestorsByParser.get(entry.from) ?? new Set();
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of dissects) {
      const entryAncestors = ancestorsOfEntry(entry);
      for (const link of entry.chain) {
        const existing = ancestorsByParser.get(link.parserId) ?? new Set<string>();
        const before = existing.size;
        for (const ancestor of entryAncestors) existing.add(ancestor);
        if (existing.size !== before) changed = true;
        ancestorsByParser.set(link.parserId, existing);
      }
    }
  }
  for (const [entryIndex, entry] of dissects.entries()) {
    const entryAncestors = ancestorsOfEntry(entry);
    for (const [linkIndex, link] of entry.chain.entries()) {
      if (!link.table?.parentKey) continue;
      if (!entryAncestors.has(link.table.parentKey.table)) {
        throw new ProjectionCompileError(
          'PROJECTION_PARENT_KEY_INVALID',
          `dissect.${entryIndex}.chain.${linkIndex}.table`,
          `table ${JSON.stringify(link.table.name)}'s parent_key.table ${JSON.stringify(
            link.table.parentKey.table,
          )} is not reachable from ${JSON.stringify(entry.from)}`,
        );
      }
    }
  }

  const rootTables = tables.filter((table) => !dissectTables.has(table.name));
  const dissectListsByFrom = new Map<string, CompiledDissect[]>();
  for (const entry of dissects) {
    const list = dissectListsByFrom.get(entry.from) ?? [];
    list.push(entry);
    dissectListsByFrom.set(entry.from, list);
  }
  const dissectByFrom: ReadonlyMap<string, readonly CompiledDissect[]> = new Map(
    [...dissectListsByFrom].map(([from, list]) => [from, Object.freeze(list)]),
  );

  return Object.freeze({
    format: spec.format,
    tables: Object.freeze(tables),
    rootTables: Object.freeze(rootTables),
    dissectByFrom,
  });
};

const sameIndexes = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const expressionContext = (match: AnchorMatch, root: unknown, state: Readonly<Record<string, unknown>>) => ({
  _: match.node,
  _root: root,
  _parent: match.parents.length === 0 ? null : match.parents[match.parents.length - 1],
  indexes: match.indexes,
  state,
});

export interface RowSink {
  push(table: string, row: Record<string, unknown>): void;
}

export interface TableRuntime {
  nextKey: bigint;
  readonly stateValues: Record<string, unknown>;
  readonly scopeIndexes: Map<string, readonly number[]>;
}

export const createRuntimes = (compiled: CompiledProjection): Map<string, TableRuntime> =>
  new Map(
    compiled.tables.map((table) => [
      table.name,
      { nextKey: 1n, stateValues: Object.create(null) as Record<string, unknown>, scopeIndexes: new Map() },
    ]),
  );

export interface EmitContext {
  readonly compiled: CompiledProjection;
  readonly runtimes: Map<string, TableRuntime>;
  readonly sink: RowSink;
  readonly issues?: IssueCollector;
}

const emitRow = (
  table: CompiledProjectionTable,
  runtime: TableRuntime,
  match: AnchorMatch,
  root: unknown,
  provenance: ProvenanceResolver,
  sink: RowSink,
  keysByTable: ReadonlyMap<string, bigint>,
  emitContext: EmitContext,
  parentKey?: { name: string; value: bigint | null },
): void => {
  for (const register of table.state) {
    const currentScope = match.indexes.slice(0, register.scope.wildcardCount);
    const previousScope = runtime.scopeIndexes.get(register.name);
    if (!previousScope || !sameIndexes(previousScope, currentScope)) {
      runtime.stateValues[register.name] = register.init;
      runtime.scopeIndexes.set(register.name, currentScope);
    }
  }
  for (const register of table.state) {
    runtime.stateValues[register.name] = evaluateExpression(
      register.update,
      expressionContext(match, root, runtime.stateValues),
    );
  }

  const context = expressionContext(match, root, runtime.stateValues);
  if (table.where && !evaluateExpression(table.where, context)) return;

  const key = runtime.nextKey;
  const row: Record<string, unknown> = { [table.key]: key };
  runtime.nextKey += 1n;
  if (parentKey) row[parentKey.name] = parentKey.value;
  for (const column of table.columns) {
    if (column.name === table.key || column.name === '_src_start' || column.name === '_src_end') continue;
    row[column.name] =
      column.when && !evaluateExpression(column.when, context)
        ? null
        : (evaluateExpression(column.expr, context) ?? null);
  }
  const range = provenance.resolve(table.name, match);
  row._src_start = BigInt(range.start);
  row._src_end = BigInt(range.end);
  sink.push(table.name, row);

  const childKeys = new Map(keysByTable);
  childKeys.set(table.name, key);
  for (const dissect of emitContext.compiled.dissectByFrom.get(table.name) ?? []) {
    fireDissect(dissect, context, childKeys, emitContext, range);
  }
};

export const tableOutputTypes = (table: CompiledProjectionTable): Record<string, ArrowTypeName> => {
  const types: Record<string, ArrowTypeName> = { [table.key]: 'int64' };
  if (table.parentKey) types[table.parentKey.column] = 'int64';
  for (const column of table.columns) {
    if (column.name === table.key || column.name === '_src_start' || column.name === '_src_end') continue;
    types[column.name] = column.type;
  }
  types._src_start = 'uint64';
  types._src_end = 'uint64';
  return types;
};

interface PayloadRange {
  readonly bytes: Uint8Array;
  readonly start: number;
}

const asPayloadRange = (value: unknown): PayloadRange | null => {
  if (value === null || typeof value !== 'object') return null;
  const bytes = (value as { bytes?: unknown }).bytes;
  const start = (value as { start?: unknown }).start;
  if (
    !(bytes instanceof Uint8Array) ||
    typeof start !== 'number' ||
    !Number.isSafeInteger(start) ||
    start < 0
  ) {
    return null;
  }
  return { bytes, start };
};

const fireDissect = (
  dissect: CompiledDissect,
  context: ExpressionContext,
  keysByTable: ReadonlyMap<string, bigint>,
  emitContext: EmitContext,
  parentRange: SourceRange,
): void => {
  const payload = asPayloadRange(evaluateExpression(dissect.payload, context));
  if (!payload) {
    emitContext.issues?.report({
      stage: 'dissecting',
      code: 'DISSECT_PAYLOAD_INVALID',
      recoverable: true,
      message: `dissect from ${JSON.stringify(dissect.from)}: payload did not evaluate to { bytes, start }`,
      sourceStart: parentRange.start,
      sourceEnd: parentRange.end,
    });
    return;
  }

  for (const link of dissect.chain) {
    if (!evaluateExpression(link.when, context)) continue;

    let parsed: ParsedRecord;
    try {
      parsed = link.parser(payload.bytes);
    } catch (error) {
      emitContext.issues?.report({
        stage: 'dissecting',
        code: 'DISSECT_PARSE_FAILED',
        recoverable: true,
        message: error instanceof Error ? error.message : String(error),
        sourceStart: payload.start,
        sourceEnd: payload.start + payload.bytes.length,
      });
      return;
    }

    if (link.table) projectChildTable(link.table, parsed, payload, keysByTable, emitContext);

    const childContext: ExpressionContext = { _: parsed.root, _root: parsed.root };
    for (const deeper of emitContext.compiled.dissectByFrom.get(link.parserId) ?? []) {
      fireDissect(deeper, childContext, keysByTable, emitContext, {
        start: payload.start,
        end: payload.start + payload.bytes.length,
      });
    }
    return; // first matching guard wins
  }
};

const projectChildTable = (
  table: CompiledProjectionTable,
  parsed: ParsedRecord,
  payload: PayloadRange,
  keysByTable: ReadonlyMap<string, bigint>,
  emitContext: EmitContext,
): void => {
  const resolver: ProvenanceResolver = {
    resolve(tableName, match) {
      if (!parsed.resolve) return { start: payload.start, end: payload.start + payload.bytes.length };
      const relative = parsed.resolve(tableName, match);
      return { start: payload.start + relative.start, end: payload.start + relative.end };
    },
  };
  const parentKeyValue = keysByTable.get(table.parentKey!.table) ?? null;
  const runtime = emitContext.runtimes.get(table.name)!;
  // Each dissected payload is a fresh document: every scope ancestor for this table's state
  // registers has just advanced (a new parent row fired this dissect), so state must restart
  // from `init` on the first match, matching the DSL's scope-reset semantics. `nextKey` is left
  // untouched — keys stay globally monotonic per table across every dissected payload.
  for (const register of table.state) {
    runtime.scopeIndexes.delete(register.name);
    delete runtime.stateValues[register.name];
  }
  for (const match of traverseAnchor(table.rows, parsed.root)) {
    emitRow(table, runtime, match, parsed.root, resolver, emitContext.sink, keysByTable, emitContext, {
      name: table.parentKey!.column,
      value: parentKeyValue,
    });
  }
};

export const projectInto = (
  compiled: CompiledProjection,
  root: unknown,
  provenance: ProvenanceResolver,
  sink: RowSink,
  runtimes: Map<string, TableRuntime>,
  subset: ReadonlySet<string> | null,
  issues?: IssueCollector,
): void => {
  const active = compiled.rootTables.filter((table) => !subset || subset.has(table.name));
  const matcher = buildMatcher(active.map((table) => table.rows));
  const emitContext: EmitContext = { compiled, runtimes, sink, ...(issues ? { issues } : {}) };
  const emptyKeys: ReadonlyMap<string, bigint> = new Map();
  walkMatcher(root, matcher, (anchorIndex, match) => {
    const table = active[anchorIndex]!;
    emitRow(table, runtimes.get(table.name)!, match, root, provenance, sink, emptyKeys, emitContext);
  });
};

export const projectTree = (
  compiled: CompiledProjection,
  root: unknown,
  provenance: ProvenanceResolver,
): ProjectedTable[] => {
  const columnsByTable = new Map<string, Record<string, unknown[]>>(
    compiled.tables.map((table) => [
      table.name,
      Object.fromEntries(Object.keys(tableOutputTypes(table)).map((name) => [name, []])),
    ]),
  );
  const sink: RowSink = {
    push(tableName, row) {
      const columns = columnsByTable.get(tableName)!;
      for (const name of Object.keys(columns)) columns[name]!.push(row[name] ?? null);
    },
  };
  projectInto(compiled, root, provenance, sink, createRuntimes(compiled), null);
  return compiled.tables.map((table) => {
    const columns = columnsByTable.get(table.name)!;
    const types = tableOutputTypes(table);
    return { name: table.name, columns, types, rowCount: columns[table.key]!.length };
  });
};
