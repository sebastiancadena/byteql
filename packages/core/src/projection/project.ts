// Entry point for the projection engine. The implementation is split along its seams:
// compile.ts (spec -> CompiledProjection, graph validation, output schemas), emit.ts (row
// emission and dissect chains), and stream-runtime.ts (stream reassembly and flush). Other
// modules keep importing from here.
export {
  compileProjection,
  streamSegmentsOutputTypes,
  tableOutputTypes,
  type CompileOptions,
  type CompiledChainLink,
  type CompiledDissect,
  type CompiledProjection,
  type CompiledProjectionTable,
  type CompiledStream,
  type OutputColumn,
  type OutputTable,
} from './compile.js';
export {
  ProjectionFieldError,
  createRuntimes,
  projectInto,
  type EmitContext,
  type ProjectedTable,
  type ProvenanceResolver,
  type RowSink,
  type SourceRange,
} from './emit.js';
export { createStreamsRuntime, flushStreams, type StreamsRuntime } from './stream-runtime.js';
