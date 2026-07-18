export const BYTEQL_CORE_VERSION = '0.1' as const;

export { ipcToTable, projectedTableToArrow, tableToIpc } from './arrow/build.js';
export { TableBatchBuilder } from './arrow/batch.js';
export type { BatchBuilderOptions } from './arrow/batch.js';
export type {
  BatchTransfer,
  FormatCapability,
  FormatPack,
  OpenOptions,
  PackQuery,
  ParseIssue,
  ParseProgress,
  ParseResult,
  RecordSource,
  SourceFinish,
  TableColumn,
  TableSchema,
  TableTransfer,
} from './protocol.js';

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
  DissectChainLinkSpec,
  DissectSpec,
  ParentKeySpec,
  ProjectionColumnSpec,
  ProjectionSpec,
  ProjectionStateSpec,
  TableSpec,
} from './projection/spec.js';
export { compileAnchor, traverseAnchor } from './projection/anchors.js';
export type { AnchorMatch, AnchorStep, CompiledAnchor } from './projection/anchors.js';
export type { ParsedRecord, ParserRegistry, RecordParser } from './projection/parsers.js';
export { compileProjection, projectTree } from './projection/project.js';
export type {
  CompiledChainLink,
  CompiledDissect,
  CompiledProjection,
  ProjectedTable,
  ProvenanceResolver,
  SourceRange,
} from './projection/project.js';
export { createProjectionSession } from './projection/session.js';
export type {
  FinishedTable,
  ProjectCallOptions,
  ProjectionSession,
  ProjectionSessionOptions,
} from './projection/session.js';
