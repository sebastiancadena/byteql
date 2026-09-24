import { IssueCollector } from '../issues.js';
import {
  streamSegmentsOutputTypes,
  tableOutputTypes,
  type CompiledProjection,
  type CompiledProjectionTable,
} from '../projection/project.js';
import { specVersionAtLeast } from '../projection/spec.js';
import type { TableSchema } from '../protocol.js';

export interface ProjectionSchemaOptions {
  ordinalColumn: string;
}

const ENGINE_NULLABLE = new Set(['stream_id', '_src_ranges']);

const tableSchema = (table: CompiledProjectionTable, legacy: boolean): TableSchema => {
  const declared = new Map(table.columns.map((column) => [column.name, column.nullable === true]));
  return {
    name: table.name,
    columns: Object.entries(tableOutputTypes(table)).map(([name, type]) => ({
      name,
      type,
      nullable:
        name === table.key || name === table.parentKey?.column || name === '_src_start' || name === '_src_end'
          ? false
          : ENGINE_NULLABLE.has(name) && !declared.has(name)
            ? true
            : legacy || (declared.get(name) ?? false),
    })),
  };
};

/**
 * Every table a session over `compiled` can emit, in engine column order, with v0.4
 * nullability (pre-0.4 specs: every spec column nullable). See the pack-kit design's
 * "Derived schemas" rules.
 */
export const projectionSchemas = (
  compiled: CompiledProjection,
  options: ProjectionSchemaOptions,
): TableSchema[] => {
  const legacy = !specVersionAtLeast(compiled.specVersion, '0.4');
  const errors = new IssueCollector({ ordinalColumn: options.ordinalColumn }).table();
  return [
    ...compiled.tables.map((table) => tableSchema(table, legacy)),
    ...compiled.segmentsTables.map((segments) => ({
      name: segments.name,
      columns: Object.entries(streamSegmentsOutputTypes(segments.feedKeyColumn)).map(([name, type]) => ({
        name,
        type,
        nullable: name === segments.feedKeyColumn,
      })),
    })),
    {
      name: errors.name,
      columns: Object.entries(errors.types).map(([name, type]) => ({
        name,
        type,
        nullable: name === options.ordinalColumn || name === '_src_start' || name === '_src_end',
      })),
    },
  ];
};
