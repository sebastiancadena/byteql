import type { CompiledProjection } from '../projection/project.js';
import type { TableSchema } from '../protocol.js';

/** Every table a session over `compiled` can emit, in emit order: a view of `compiled.outputs`. */
export const projectionSchemas = (compiled: CompiledProjection): TableSchema[] =>
  compiled.outputs.map((output) => ({
    name: output.name,
    columns: output.columns.map((column) => ({ ...column })),
  }));
