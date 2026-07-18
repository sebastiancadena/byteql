import { compileAnchor, isAnchorPrefix, type AnchorMatch, type CompiledAnchor } from './anchors.js';
import {
  ProjectionCompileError,
  compileExpression,
  evaluateExpression,
  getExpressionStateReferences,
  type CompiledExpression,
} from './expression.js';
import type { ArrowTypeName, ProjectionSpec } from './spec.js';
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
}

export interface CompiledProjection {
  readonly format: string;
  readonly tables: readonly CompiledProjectionTable[];
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

export const compileProjection = (spec: ProjectionSpec): CompiledProjection => {
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
    });
  });

  return Object.freeze({ format: spec.format, tables: Object.freeze(tables) });
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

const emitRow = (
  table: CompiledProjectionTable,
  runtime: TableRuntime,
  match: AnchorMatch,
  root: unknown,
  provenance: ProvenanceResolver,
  sink: RowSink,
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

  const row: Record<string, unknown> = { [table.key]: runtime.nextKey };
  runtime.nextKey += 1n;
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
};

export const tableOutputTypes = (table: CompiledProjectionTable): Record<string, ArrowTypeName> => {
  const types: Record<string, ArrowTypeName> = { [table.key]: 'int64' };
  for (const column of table.columns) {
    if (column.name === table.key || column.name === '_src_start' || column.name === '_src_end') continue;
    types[column.name] = column.type;
  }
  types._src_start = 'uint64';
  types._src_end = 'uint64';
  return types;
};

export const projectInto = (
  compiled: CompiledProjection,
  root: unknown,
  provenance: ProvenanceResolver,
  sink: RowSink,
  runtimes: Map<string, TableRuntime>,
  subset: ReadonlySet<string> | null,
): void => {
  const active = compiled.tables.filter((table) => !subset || subset.has(table.name));
  const matcher = buildMatcher(active.map((table) => table.rows));
  walkMatcher(root, matcher, (anchorIndex, match) => {
    const table = active[anchorIndex]!;
    emitRow(table, runtimes.get(table.name)!, match, root, provenance, sink);
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
