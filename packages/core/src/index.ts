export const BYTEQL_CORE_VERSION = '0.1' as const;

export { ipcToTable, projectedTableToArrow, tableToIpc } from './arrow/build.js';
export { TableBatchBuilder } from './arrow/batch.js';
export type { BatchBuilderOptions } from './arrow/batch.js';
export type { FormatCapability, PackQuery, ParseIssue, ParseResult, TableTransfer } from './protocol.js';

export { IssueCollector } from './issues.js';
export type { IssueCollectorOptions, IssueReport } from './issues.js';

export { ProjectionCompileError, compileExpression, evaluateExpression } from './projection/expression.js';
export type {
  CompiledExpression,
  ExpressionContext,
  ProjectionCompileErrorCode,
} from './projection/expression.js';
export { parseProjectionSpec } from './projection/spec.js';
export type {
  ArrowTypeName,
  ProjectionColumnSpec,
  ProjectionSpec,
  ProjectionStateSpec,
  TableSpec,
} from './projection/spec.js';
export { compileAnchor, traverseAnchor } from './projection/anchors.js';
export type { AnchorMatch, AnchorStep, CompiledAnchor } from './projection/anchors.js';
export { compileProjection, projectTree } from './projection/project.js';
export type {
  CompiledProjection,
  ProjectedTable,
  ProvenanceResolver,
  SourceRange,
} from './projection/project.js';
export { createProjectionSession } from './projection/session.js';
export type { FinishedTable, ProjectCallOptions, ProjectionSession } from './projection/session.js';
