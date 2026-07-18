import type { Table } from 'apache-arrow';
import { projectedTableToArrow } from '../arrow/build.js';
import type { ArrowTypeName } from './spec.js';
import { projectTree, type CompiledProjection, type ProjectedTable, type ProvenanceResolver } from './project.js';

export interface ProjectCallOptions {
  readonly tables?: readonly string[];
}

export interface FinishedTable {
  readonly name: string;
  readonly arrow: Table;
  readonly rowCount: number;
}

export interface ProjectionSession {
  project(root: unknown, resolver: ProvenanceResolver, options?: ProjectCallOptions): void;
  finish(): FinishedTable[];
}

interface Accumulator {
  readonly key: string;
  columns: Record<string, unknown[]> | null; // null until first append fixes the schema
  types: Record<string, ArrowTypeName> | null;
  rowCount: number;
  nextKey: bigint;
}

export const createProjectionSession = (compiled: CompiledProjection): ProjectionSession => {
  const accumulators = new Map<string, Accumulator>(
    compiled.tables.map((table) => [
      table.name,
      { key: table.key, columns: null, types: null, rowCount: 0, nextKey: 1n },
    ]),
  );

  const append = (target: Accumulator, source: ProjectedTable): void => {
    if (!target.columns || !target.types) {
      target.columns = Object.fromEntries(Object.keys(source.columns).map((name) => [name, []]));
      target.types = { ...source.types };
    }
    for (const [name, values] of Object.entries(source.columns)) {
      const output = target.columns[name];
      if (!output) throw new Error(`PROJECTION_SCHEMA_MISMATCH: ${source.name}.${name}`);
      if (name === target.key) {
        for (let index = 0; index < values.length; index += 1) {
          output.push(target.nextKey);
          target.nextKey += 1n;
        }
      } else {
        output.push(...values);
      }
    }
    target.rowCount += source.rowCount;
  };

  return {
    project(root, resolver, options) {
      const subset = options?.tables === undefined ? null : new Set(options.tables);
      const projected = projectTree(compiled, root, resolver);
      for (const table of projected) {
        if (subset && !subset.has(table.name)) continue;
        append(accumulators.get(table.name)!, table);
      }
    },
    finish() {
      return compiled.tables.map((table) => {
        const accumulator = accumulators.get(table.name)!;
        const projected: ProjectedTable = accumulator.columns
          ? { name: table.name, columns: accumulator.columns, types: accumulator.types!, rowCount: accumulator.rowCount }
          : emptyTable(compiled, table.name);
        return { name: table.name, arrow: projectedTableToArrow(projected), rowCount: projected.rowCount };
      });
    },
  };
};

const emptyTable = (compiled: CompiledProjection, name: string): ProjectedTable =>
  projectTree(compiled, {}, { resolve: () => ({ start: 0, end: 0 }) }).find((table) => table.name === name)!;
