export const BYTEQL_CORE_VERSION = '0.1' as const;

export { ProjectionCompileError, compileExpression, evaluateExpression } from './projection/expression.js';
export type {
  CompiledExpression,
  ExpressionContext,
  ProjectionCompileErrorCode,
} from './projection/expression.js';
export { parseProjectionSpec } from './projection/spec.js';
export type { ArrowTypeName, ProjectionSpec, TableSpec } from './projection/spec.js';
