// Row emission and dissect chains: emitRow, fireDissect, projectChildTable, and the
// projectInto entry point. Mutually recursive with stream-runtime.ts (a dissect chain's stream
// link contributes to a stream; a framed stream message projects rows and fires deeper dissects
// back through this module). The cycle is call-time only — neither module touches the other's
// exports while it is being evaluated.
import { traverseAnchor, type AnchorMatch } from './anchors.js';
import { evaluateExpression, type ExpressionContext } from './expression.js';
import type { IssueCollector } from '../issues.js';
import type { CompiledDissect, CompiledProjection, CompiledProjectionTable } from './compile.js';
import type { ParsedRecord } from './parsers.js';
import type { ArrowTypeName } from './spec.js';
import { contributeToStream, type InheritedProvenance, type StreamsRuntime } from './stream-runtime.js';
import { buildMatcher, walkMatcher } from './walk.js';

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface ProvenanceResolver {
  resolve(table: string, anchor: AnchorMatch): SourceRange;
}

export interface ProjectedTable {
  readonly name: string;
  readonly columns: Record<string, readonly unknown[]>;
  readonly types: Record<string, ArrowTypeName>;
  readonly rowCount: number;
}

// Thrown from a column `expr` evaluation (only) when `ProjectionSessionOptions.strictFields` is
// set and the expression reads a field absent on the node it's evaluated against — a likely
// typo/naming mismatch the engine would otherwise silently paper over as null. `when`, `where`,
// state updates, dissect payloads, and stream expressions never throw this: see EmitContext's
// `strictFields` doc and emitRow's column loop.
export class ProjectionFieldError extends Error {
  constructor(
    readonly table: string,
    readonly column: string,
    readonly field: string,
    readonly keys: string[],
  ) {
    super(
      `PROJECTION_FIELD_MISSING: ${table}.${column} reads "${field}", absent on a node with keys [${keys.join(', ')}]`,
    );
    this.name = 'ProjectionFieldError';
  }
}

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
  readonly streams: StreamsRuntime | null;
  readonly issues?: IssueCollector;
  // Set only while emitStreamMessage is emitting a message's rows: every row projected beneath it
  // (message tables and deeper dissect tables alike) inherits the message's provenance instead
  // of composing offsets against the span start, which is meaningless once the span has gaps.
  inherited?: InheritedProvenance | null;
  // From ProjectionSessionOptions.strictFields: when true, emitRow's column-expr evaluation
  // (only) throws ProjectionFieldError instead of silently reading null for a missing field.
  // Every EmitContext literal built while a strict session is running (projectInto and
  // session.finish's flushStreams call alike) must carry this so stream-flushed rows are
  // strict too.
  readonly strictFields?: boolean;
}

// One row emission's inputs. Everything shared across a whole projection (compiled spec,
// runtimes, sink, streams, issues) lives on EmitContext instead.
export interface RowFrame {
  readonly table: CompiledProjectionTable;
  readonly runtime: TableRuntime;
  readonly match: AnchorMatch;
  readonly root: unknown;
  readonly provenance: ProvenanceResolver;
  readonly keysByTable: ReadonlyMap<string, bigint>;
  // Absolute file offset of the coordinate space `root` (and thus this row's dissect
  // payload expressions) are evaluated in: 0 for the file tree, or the enclosing payload's
  // absolute start for a child parse tree. See asPayloadRange / fireDissect.
  readonly baseOffset: number;
  // Byte length of the payload buffer `root` was parsed from, or null at the file root
  // (unchecked — see fireDissect's containment check). Threaded through unchanged to this
  // row's own outgoing dissects: `table`'s rows live inside the same buffer as `root`
  // itself, whether `table` is a root table (null) or was itself dissected out of a parent
  // payload (that payload's byte length).
  readonly enclosingLength: number | null;
  // Ancestor threading invariant: parse-tree roots strictly ABOVE `root` (does not include
  // `root` itself) — projectInto's root-level call passes [], projectChildTable threads its
  // own `ancestors` through unchanged (see that function's doc), and flushStreams also passes
  // [] since a flushed flow row has no enclosing parse tree at all.
  readonly ancestors: readonly unknown[];
  readonly parentKey?: { name: string; value: bigint | null };
  readonly extraColumns?: Readonly<Record<string, unknown>> | undefined;
  // Set by flushStreams to force a flow row onto its eagerly-reserved streamId (reserved at
  // first contribution, long before the flow row itself is emitted) instead of drawing a
  // fresh key from the table runtime.
  readonly forcedKey?: bigint;
}

export const emitRow = (frame: RowFrame, emitContext: EmitContext): void => {
  const {
    table,
    runtime,
    match,
    root,
    provenance,
    keysByTable,
    baseOffset,
    enclosingLength,
    ancestors,
    parentKey,
    extraColumns,
    forcedKey,
  } = frame;
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

  const key = forcedKey ?? runtime.nextKey;
  if (forcedKey === undefined) runtime.nextKey += 1n;
  const row: Record<string, unknown> = { [table.key]: key };
  if (parentKey) row[parentKey.name] = parentKey.value;
  if (extraColumns) Object.assign(row, extraColumns);
  for (const column of table.columns) {
    // Only the column `expr` is strict — `when` above always uses the plain `context` (row-time
    // evaluation there still returns null, never throws).
    const columnContext = emitContext.strictFields
      ? {
          ...context,
          onMissingMember: (field: string, node: object) => {
            throw new ProjectionFieldError(table.name, column.name, field, Object.keys(node));
          },
        }
      : context;
    row[column.name] =
      column.when && !evaluateExpression(column.when, context)
        ? null
        : (evaluateExpression(column.expr, columnContext) ?? null);
  }
  const range = provenance.resolve(table.name, match);
  row._src_start = BigInt(range.start);
  row._src_end = BigInt(range.end);
  emitContext.sink.push(table.name, row);

  const childKeys = new Map(keysByTable);
  childKeys.set(table.name, key);
  for (const dissect of emitContext.compiled.dissectByFrom.get(table.name) ?? []) {
    // Ancestor threading invariant: fireDissect's ancestors end with the firing tree's own
    // root as their LAST element — here that's `root`, the tree this row was matched from.
    fireDissect(dissect, context, childKeys, emitContext, range, baseOffset, enclosingLength, [
      ...ancestors,
      root,
    ]);
  }
};

export interface PayloadRange {
  readonly bytes: Uint8Array;
  // Relative to the coordinate space `dissect.payload` was evaluated in: absolute (file
  // offset) for chains fired from the file tree, payload-relative for chains evaluated
  // against a child parse tree. Callers must add the enclosing `baseOffset` to get an
  // absolute file offset — see fireDissect.
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

export const fireDissect = (
  dissect: CompiledDissect,
  context: ExpressionContext,
  keysByTable: ReadonlyMap<string, bigint>,
  emitContext: EmitContext,
  parentRange: SourceRange,
  // Absolute file offset of the coordinate space `context` (and thus dissect.payload) was
  // evaluated in. 0 for dissects fired from the file tree; the enclosing absolute payload
  // start for dissects evaluated against a child parse tree.
  baseOffset: number,
  // Byte length of the payload buffer `context` was built from, or null when `context` is
  // the file root. A root-table dissect's own payload is a file-absolute offset the engine
  // never validates — it has no idea how long the file is, so `null` here means "unchecked".
  // A dissect fired from a child parse tree (a "deeper" chain, below) DOES know its bound:
  // the byte length of the payload that produced that tree. `payload.start` is relative to
  // that same payload (see PayloadRange), so a range this dissect's own `payload` evaluates
  // to that runs past `enclosingLength` is provably broken, not merely suspicious.
  enclosingLength: number | null,
  // Ancestor threading invariant: this list's LAST element is the firing tree's own root (the
  // tree `context` was built from — see emitRow, which appends `root` here, and the "deeper"
  // recursion below, which appends `parsed.root`). Consumers needing "ancestors strictly above
  // the current tree" (projectChildTable, the stream key extractor) slice that last element off.
  ancestors: readonly unknown[],
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

  const payloadEnd = payload.start + payload.bytes.length;
  if (enclosingLength !== null && payloadEnd > enclosingLength) {
    emitContext.issues?.report({
      stage: 'dissecting',
      code: 'DISSECT_PAYLOAD_INVALID',
      recoverable: true,
      message: `dissect from ${JSON.stringify(dissect.from)}: payload [${payload.start}, ${payloadEnd}) overruns the enclosing ${enclosingLength}-byte payload`,
      sourceStart: parentRange.start,
      sourceEnd: parentRange.end,
    });
    return;
  }

  // The engine composes absolute provenance here: `payload.start` is only ever meaningful
  // relative to the coordinate space `context` was evaluated in (see PayloadRange), so it
  // must be added to the enclosing `baseOffset` before it means anything file-absolute.
  const absoluteStart = baseOffset + payload.start;

  for (const link of dissect.chain) {
    if (!evaluateExpression(link.when, context)) continue;

    if (link.stream) {
      // Rule 1: a stream link matched in fireDissect contributes and returns — first match
      // wins exactly like a parser link, it just never produces a table row of its own here.
      contributeToStream(
        link.stream,
        context,
        payload,
        absoluteStart,
        keysByTable,
        emitContext,
        ancestors,
        parentRange,
      );
      return;
    }

    const parser = link.parser;
    if (!parser) continue; // unreachable: chainLinkSpec requires exactly one of parser/stream

    let parsed: ParsedRecord;
    try {
      parsed = parser(payload.bytes);
    } catch (error) {
      emitContext.issues?.report({
        stage: 'dissecting',
        code: 'DISSECT_PARSE_FAILED',
        recoverable: true,
        message: error instanceof Error ? error.message : String(error),
        sourceStart: absoluteStart,
        sourceEnd: absoluteStart + payload.bytes.length,
      });
      return;
    }

    if (link.table)
      projectChildTable(
        link.table,
        parsed,
        payload.bytes,
        absoluteStart,
        keysByTable,
        emitContext,
        ancestors,
      );

    const childContext: ExpressionContext = { _: parsed.root, _root: parsed.root };
    // Invariant: parserId is set whenever parser is (both null together for stream links,
    // both non-null for parser links) — the flat CompiledChainLink shape doesn't let TS narrow
    // parserId from the parser check above, so this reflects that pairing directly.
    for (const deeper of emitContext.compiled.dissectByFrom.get(link.parserId as string) ?? []) {
      // The deeper chain's payload is evaluated against `parsed.root` — a tree the child
      // parser built purely from `payload.bytes` — so its own payload.start (if any) is
      // relative to *this* payload; that's `absoluteStart`, not `baseOffset`. Likewise, this
      // payload's own byte length is now the enclosing bound for whatever it dissects.
      // Ancestor threading invariant: extend with `parsed.root`, the tree this recursion fires
      // against.
      fireDissect(
        deeper,
        childContext,
        keysByTable,
        emitContext,
        { start: absoluteStart, end: absoluteStart + payload.bytes.length },
        absoluteStart,
        payload.bytes.length,
        [...ancestors, parsed.root],
      );
    }
    return; // first matching guard wins
  }
};

export const projectChildTable = (
  table: CompiledProjectionTable,
  parsed: ParsedRecord,
  payloadBytes: Uint8Array,
  absolutePayloadStart: number,
  keysByTable: ReadonlyMap<string, bigint>,
  emitContext: EmitContext,
  // Ancestor threading invariant: ancestors strictly above `parsed.root` — received unchanged
  // from the caller (fireDissect passes its own `ancestors`; emitStreamMessage passes [] since
  // a framed message is a fresh top-level tree, like the file root).
  ancestors: readonly unknown[],
  // Set only for a stream `messages[].table` link — see the resolver override below.
  streamMeta?: { streamId: bigint; span: SourceRange; ranges: InheritedProvenance['ranges'] },
): void => {
  // A message's exact provenance is inherited two ways: `streamMeta` for the message's own
  // `messages[].table` row (set by emitStreamMessage, carries streamId too), or
  // `emitContext.inherited` for a table reached by a DEEPER dissect chained off that message's
  // parser (emitStreamMessage sets it for the whole fireDissect recursion beneath the message,
  // and this function is that recursion's leaf). Either way, `inherited` here is the same
  // { span, ranges } the message computed once, up front.
  const inherited = streamMeta ?? emitContext.inherited ?? null;
  const resolver: ProvenanceResolver = inherited
    ? {
        // A reassembled stream buffer is discontiguous with the source file — byte N of
        // `messageBytes` has no fixed relationship to any single file offset, so a parser's
        // `resolve` (which reports offsets relative to the buffer it was handed) cannot be
        // mapped back through it, at any dissect depth beneath the message. Every row from a
        // message-fed table, or a table dissected deeper from it, shares the exact span the
        // framing loop already computed for the whole message instead.
        resolve: () => inherited.span,
      }
    : {
        resolve(tableName, match) {
          if (!parsed.resolve) {
            return { start: absolutePayloadStart, end: absolutePayloadStart + payloadBytes.length };
          }
          const relative = parsed.resolve(tableName, match);
          return { start: absolutePayloadStart + relative.start, end: absolutePayloadStart + relative.end };
        },
      };
  // stream_id is only ever set on the message's own table (streamMeta); a deeper dissect table
  // reached from emitContext.inherited alone has no stream_id column to fill. _src_ranges is
  // set from the inherited pieces whenever this table actually reserves the column
  // (boundedProvenance) — compile marks every message-fed table boundedProvenance, so
  // streamMeta's own table always does, but a deeper table only sometimes does, hence the
  // explicit boundedProvenance check on that branch.
  const extraColumns: Record<string, unknown> | undefined = streamMeta
    ? { stream_id: streamMeta.streamId, _src_ranges: streamMeta.ranges }
    : inherited && table.boundedProvenance
      ? { _src_ranges: inherited.ranges }
      : undefined;
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
    // The child rows' own dissect chains (if any) evaluate against `parsed.root`, so they
    // need this payload's absolute start as their base — this is how chains fired from a
    // chain-fed table compose correctly. `payloadBytes.length` is likewise their enclosing
    // bound: `parsed.root` was built purely from this buffer.
    emitRow(
      {
        table,
        runtime,
        match,
        root: parsed.root,
        provenance: resolver,
        keysByTable,
        baseOffset: absolutePayloadStart,
        enclosingLength: payloadBytes.length,
        ancestors,
        parentKey: { name: table.parentKey!.column, value: parentKeyValue },
        extraColumns,
      },
      emitContext,
    );
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
  streams: StreamsRuntime | null = null,
  strictFields = false,
): void => {
  const active = compiled.rootTables.filter((table) => !subset || subset.has(table.name));
  const matcher = buildMatcher(active.map((table) => table.rows));
  const emitContext: EmitContext = {
    compiled,
    runtimes,
    sink,
    streams,
    ...(issues ? { issues } : {}),
    ...(strictFields ? { strictFields } : {}),
  };
  const emptyKeys: ReadonlyMap<string, bigint> = new Map();
  walkMatcher(root, matcher, (anchorIndex, match) => {
    const table = active[anchorIndex]!;
    // The file tree is the root coordinate space: base offset 0, so payload.start is
    // absolute unchanged for chains fired directly off root-table rows. enclosingLength is
    // null here — the engine never sees the file's byte length, so root-level dissect
    // payloads are unchecked; only payloads nested inside another payload can be validated.
    // Ancestor threading invariant: a root-table row has no ancestors of its own.
    emitRow(
      {
        table,
        runtime: runtimes.get(table.name)!,
        match,
        root,
        provenance,
        keysByTable: emptyKeys,
        baseOffset: 0,
        enclosingLength: null,
        ancestors: [],
      },
      emitContext,
    );
  });
};
