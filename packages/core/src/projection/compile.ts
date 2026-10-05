// Spec compilation: ProjectionSpec -> CompiledProjection, including every load-time graph
// validation rule (errors throw ProjectionCompileError here, never per row), plus the output
// schemas derived from the compiled tables.
import { compileAnchor, isAnchorPrefix, type CompiledAnchor } from './anchors.js';
import {
  ProjectionCompileError,
  compileExpression,
  getExpressionContextReferences,
  getExpressionStateReferences,
  type CompiledExpression,
} from './expression.js';
import type { ParserRegistry, RecordParser } from './parsers.js';
import type { ArrowTypeName, ProjectionSpec, TableSpec } from './spec.js';
import type { StreamFramer, StreamKeyExtractor, StreamRegistries } from './streams.js';

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
  readonly nullable: boolean;
}

export interface CompiledProjectionTable {
  readonly name: string;
  readonly rows: CompiledAnchor;
  readonly where?: CompiledExpression;
  readonly key: string;
  readonly state: readonly CompiledState[];
  readonly columns: readonly CompiledColumn[];
  readonly parentKey: { table: string; column: string } | null;
  // Fed by a stream `messages` link (see spec v0.3's streams:) rather than a plain dissect
  // chain link — tableOutputTypes injects a synthetic `stream_id` column for these.
  readonly streamFed: boolean;
  // Rows may carry a bounding span: stream-fed message tables, stream flow tables, and every
  // table a dissect chain reaches from a message parser or message table. tableOutputTypes
  // appends the engine-owned `_src_ranges` column for these.
  readonly boundedProvenance: boolean;
}

export interface CompiledStreamMessageLink {
  readonly when: CompiledExpression;
  readonly parserId: string;
  readonly parser: RecordParser;
  readonly table: CompiledProjectionTable | null;
}

export interface CompiledStream {
  readonly name: string;
  readonly keyExtractor: StreamKeyExtractor;
  readonly offset: CompiledExpression;
  readonly framer: StreamFramer;
  readonly maxBuffer: number;
  readonly flowTable: CompiledProjectionTable;
  readonly segmentsTable: string;
  readonly feedTable: string;
  readonly feedKeyColumn: string;
  readonly messages: readonly CompiledStreamMessageLink[];
  readonly open: CompiledExpression | null;
  readonly close: CompiledExpression | null;
  readonly reset: CompiledExpression | null;
  readonly offsetBits: number | null;
}

export interface CompiledChainLink {
  readonly when: CompiledExpression;
  readonly parserId: string | null;
  readonly parser: RecordParser | null;
  readonly table: CompiledProjectionTable | null;
  readonly stream: CompiledStream | null;
}

export interface CompiledDissect {
  readonly from: string;
  readonly payload: CompiledExpression;
  readonly chain: readonly CompiledChainLink[];
}

export interface CompiledProjection {
  readonly specVersion: ProjectionSpec['version'];
  readonly format: string;
  readonly tables: readonly CompiledProjectionTable[];
  readonly rootTables: readonly CompiledProjectionTable[];
  readonly dissectByFrom: ReadonlyMap<string, readonly CompiledDissect[]>;
  readonly streams: readonly CompiledStream[];
  readonly segmentsTables: readonly { name: string; feedKeyColumn: string }[];
}

const reservedOutputNames = new Set(['_src_start', '_src_end', '_src_ranges', '_src_file']);

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

// A dissect entry chained off a parser id (rather than a declared table) evaluates its
// payload/when against a bare `{ _, _root }` context (see fireDissect's childContext):
// there is no anchor match to source `_parent` or `indexes` from, so both would silently
// read as null/undefined at runtime. Table-rooted entries fire from emitRow's full row
// context, where both are legitimate, so this guard only applies to the parser-rooted case.
const rejectContextReferences = (expression: CompiledExpression, path: string): void => {
  const references = getExpressionContextReferences(expression);
  if (references.size === 0) return;
  throw new ProjectionCompileError(
    'PROJECTION_DISSECT_INVALID',
    path,
    `${[...references].join(' and ')} ${references.size === 1 ? 'is' : 'are'} not available in a parser-rooted dissect expression (no row context)`,
  );
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
  streamRegistries: StreamRegistries = {},
): CompiledProjection => {
  const specTableByName = new Map(spec.tables.map((table) => [table.name, table]));
  // Rule 8/10 pre-scan: a table named as a stream `messages[].table` is stream-fed. Tables are
  // compiled (and frozen) before streams exist, so this must be known up front — both to reject
  // a declared `stream_id` column/key (rule 10) and to drive tableOutputTypes' synthetic column.
  const streamFedNames = new Set(
    (spec.streams ?? []).flatMap((stream) =>
      stream.messages.flatMap((message) => (message.table !== undefined ? [message.table] : [])),
    ),
  );
  // Bounded-provenance pre-scan: a row has exact (not merely bounding-span) provenance when it
  // originates from a reassembled stream message, or from anything a dissect chain reaches
  // starting from a message parser id or message table — plus the stream's own flow table.
  // Computed from the raw spec (parser ids and table names share one namespace here) before
  // tables are compiled, for the same reason as streamFedNames above.
  const boundedProvenanceNames = (() => {
    const streams = spec.streams ?? [];
    const reached = new Set<string>();
    const queue: string[] = [];
    const visit = (name: string | undefined) => {
      if (name === undefined || reached.has(name)) return;
      reached.add(name);
      queue.push(name);
    };
    for (const stream of streams) {
      for (const message of stream.messages) {
        visit(message.parser);
        visit(message.table);
      }
    }
    while (queue.length > 0) {
      const from = queue.shift()!;
      for (const entry of spec.dissect ?? []) {
        if (entry.from !== from) continue;
        for (const link of entry.chain) {
          visit(link.parser);
          visit(link.table);
        }
      }
    }
    for (const stream of streams) reached.add(stream.table);
    return reached;
  })();
  const tables = spec.tables.map((table, tableIndex): CompiledProjectionTable => {
    const tablePath = `tables.${tableIndex}`;
    const streamFed = streamFedNames.has(table.name);
    if (reservedOutputNames.has(table.key)) {
      throw new ProjectionCompileError(
        'PROJECTION_SPEC_INVALID',
        `${tablePath}.key`,
        `key ${JSON.stringify(table.key)} is reserved for automatic provenance`,
      );
    }
    if (streamFed && table.key === 'stream_id') {
      throw new ProjectionCompileError(
        'PROJECTION_SPEC_INVALID',
        `${tablePath}.key`,
        `key "stream_id" is reserved for stream-fed tables`,
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
      if (streamFed && name === 'stream_id') {
        throw new ProjectionCompileError(
          'PROJECTION_SPEC_INVALID',
          `${tablePath}.columns.${name}`,
          `column "stream_id" is reserved for stream-fed tables`,
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
        nullable: column.nullable ?? false,
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
      streamFed,
      boundedProvenance: boundedProvenanceNames.has(table.name),
    });
  });

  const tableByName = new Map(tables.map((table) => [table.name, table]));

  // Parser ids that legitimately appear as a chain link's `parser` somewhere in the graph —
  // both plain dissect chain links AND stream `messages[].parser` links (a deeper dissect entry
  // may chain off a message parser id, e.g. rule 11's cycle test), so both contribute here.
  const dissectParserIds = new Set(
    (spec.dissect ?? []).flatMap((entry) =>
      entry.chain.flatMap((link) => (link.parser !== undefined ? [link.parser] : [])),
    ),
  );
  const messageParserIds = new Set(
    (spec.streams ?? []).flatMap((stream) => stream.messages.map((m) => m.parser)),
  );
  const chainedParserIds = new Set([...dissectParserIds, ...messageParserIds]);
  // Used for name-collision checks (rules 4 and 7): a stream/segments_table name must not
  // collide with a table name, a registered parser id, or one actually used in a chain.
  const collidableParserIds = new Set([...registry.keys(), ...chainedParserIds]);
  const streamNames = new Set((spec.streams ?? []).map((stream) => stream.name));

  const dissectTables = new Set<string>();

  interface MutableCompiledStream {
    name: string;
    keyExtractor: StreamKeyExtractor;
    offset: CompiledExpression;
    framer: StreamFramer;
    maxBuffer: number;
    flowTable: CompiledProjectionTable;
    segmentsTable: string;
    feedTable: string | null;
    feedKeyColumn: string | null;
    messages: CompiledStreamMessageLink[];
    open: CompiledExpression | null;
    close: CompiledExpression | null;
    reset: CompiledExpression | null;
    offsetBits: number | null;
  }

  // Streams are built as mutable records before the dissect chains are compiled: chain links
  // resolve `stream:` references against this map (rules 1-2), and fill in feedTable/
  // feedKeyColumn (rule 3) as the dissect loop discovers which table feeds each stream. The
  // records are frozen in place after the dissect loop, so CompiledChainLink.stream (captured
  // by reference below) ends up frozen too — no separate reconstruction needed.
  const streamByName = new Map<string, MutableCompiledStream>();
  for (const [streamIndex, entry] of (spec.streams ?? []).entries()) {
    const path = `streams.${streamIndex}`;

    // Rule 4: a stream name must not collide with a declared table or a registered/chained
    // parser id.
    if (tableByName.has(entry.name) || collidableParserIds.has(entry.name)) {
      throw new ProjectionCompileError(
        'PROJECTION_STREAM_INVALID',
        `${path}.name`,
        `stream name ${JSON.stringify(entry.name)} collides with a declared table or parser id`,
      );
    }

    // Rule 5: key extractor and framer ids must be registered.
    const keyExtractor = streamRegistries.keyExtractors?.get(entry.key);
    if (!keyExtractor) {
      throw new ProjectionCompileError(
        'PROJECTION_STREAM_INVALID',
        `${path}.key`,
        `key extractor ${JSON.stringify(entry.key)} is not registered`,
      );
    }
    const framer = streamRegistries.framers?.get(entry.framer);
    if (!framer) {
      throw new ProjectionCompileError(
        'PROJECTION_STREAM_INVALID',
        `${path}.framer`,
        `framer ${JSON.stringify(entry.framer)} is not registered`,
      );
    }

    // Rule 6: the flow table must be declared, must not itself declare parent_key, and its
    // rows anchor must be the file root ($) — flow tables hold whole assembled messages, not
    // rows walked out of an existing parse tree. (The "also dissect/message-fed" half of this
    // rule is checked later, once dissectTables is fully populated.)
    const flowTable = tableByName.get(entry.table);
    if (!flowTable) {
      throw new ProjectionCompileError(
        'PROJECTION_STREAM_INVALID',
        `${path}.table`,
        `table ${JSON.stringify(entry.table)} is not declared`,
      );
    }
    if (flowTable.parentKey) {
      throw new ProjectionCompileError(
        'PROJECTION_STREAM_INVALID',
        `${path}.table`,
        `flow table ${JSON.stringify(entry.table)} must not declare parent_key`,
      );
    }
    if (specTableByName.get(entry.table)!.rows !== '$') {
      throw new ProjectionCompileError(
        'PROJECTION_STREAM_INVALID',
        `${path}.table`,
        `flow table ${JSON.stringify(entry.table)}'s rows anchor must be "$"`,
      );
    }

    // Rule 7 (immediate half): segments_table must not collide with a declared table, stream,
    // or parser id. (The "shared segments_table implies shared feed table" half is checked
    // later, once every stream's feedTable is known.)
    if (
      tableByName.has(entry.segments_table) ||
      streamNames.has(entry.segments_table) ||
      collidableParserIds.has(entry.segments_table)
    ) {
      throw new ProjectionCompileError(
        'PROJECTION_STREAM_INVALID',
        `${path}.segments_table`,
        `segments_table ${JSON.stringify(entry.segments_table)} collides with a declared table, stream, or parser id`,
      );
    }

    // Rule 12 (stream half): offset compiles against an empty declared-state set; row-context
    // references (_parent/indexes) are legitimate since offset always runs against the feed
    // table's own row context.
    const offset = compileCheckedExpression(entry.offset, new Set(), `${path}.offset`);

    const lifecycle = (source: string | undefined, field: 'open' | 'close' | 'reset') =>
      source === undefined ? null : compileCheckedExpression(source, new Set(), `${path}.${field}`);
    const open = lifecycle(entry.open, 'open');
    const close = lifecycle(entry.close, 'close');
    const reset = lifecycle(entry.reset, 'reset');

    // Rule 8/12 (message half): message links compile exactly like dissect chain links rooted
    // off a parser id — same PROJECTION_PARSER_UNKNOWN / PROJECTION_DISSECT_INVALID texts, and
    // `when` always rejects context references (messages fire against a bare parsed-record
    // context, never a row match).
    const messages = entry.messages.map((message, messageIndex): CompiledStreamMessageLink => {
      const linkPath = `${path}.messages.${messageIndex}`;
      const parser = registry.get(message.parser);
      if (!parser) {
        throw new ProjectionCompileError(
          'PROJECTION_PARSER_UNKNOWN',
          `${linkPath}.parser`,
          `parser ${JSON.stringify(message.parser)} is not registered`,
        );
      }
      let table: CompiledProjectionTable | null = null;
      if (message.table !== undefined) {
        table = tableByName.get(message.table) ?? null;
        if (!table) {
          throw new ProjectionCompileError(
            'PROJECTION_DISSECT_INVALID',
            `${linkPath}.table`,
            `table ${JSON.stringify(message.table)} is not declared`,
          );
        }
        if (!table.parentKey) {
          throw new ProjectionCompileError(
            'PROJECTION_DISSECT_INVALID',
            `${linkPath}.table`,
            `table ${JSON.stringify(message.table)} must declare parent_key to receive dissected rows`,
          );
        }
        dissectTables.add(message.table); // message-fed tables count as dissect-fed (rule 3, rule 8)
      }
      const when = compileCheckedExpression(message.when, new Set(), `${linkPath}.when`);
      rejectContextReferences(when, `${linkPath}.when`);
      return Object.freeze({ when, parserId: message.parser, parser, table });
    });

    streamByName.set(entry.name, {
      name: entry.name,
      keyExtractor,
      offset,
      framer,
      maxBuffer: entry.max_buffer,
      flowTable,
      segmentsTable: entry.segments_table,
      feedTable: null,
      feedKeyColumn: null,
      messages,
      open,
      close,
      reset,
      offsetBits: entry.offset_bits ?? null,
    });
  }

  const dissects = (spec.dissect ?? []).map((entry, entryIndex): CompiledDissect => {
    const path = `dissect.${entryIndex}`;
    const fromIsTable = tableByName.has(entry.from);
    if (!fromIsTable && !chainedParserIds.has(entry.from)) {
      throw new ProjectionCompileError(
        'PROJECTION_DISSECT_INVALID',
        `${path}.from`,
        `from ${JSON.stringify(entry.from)} is neither a declared table nor a chained parser`,
      );
    }
    const chain = entry.chain.map((link, linkIndex): CompiledChainLink => {
      const linkPath = `${path}.chain.${linkIndex}`;

      if (link.stream !== undefined) {
        // Rule 1: the referenced stream must be declared.
        const stream = streamByName.get(link.stream);
        if (!stream) {
          throw new ProjectionCompileError(
            'PROJECTION_STREAM_INVALID',
            `${linkPath}.stream`,
            `stream ${JSON.stringify(link.stream)} is not declared`,
          );
        }
        // Rule 2: a stream link must be rooted at a declared table (fires from emitRow's row
        // context), never at a parser id.
        if (!fromIsTable) {
          throw new ProjectionCompileError(
            'PROJECTION_STREAM_INVALID',
            `${linkPath}.stream`,
            `stream link ${JSON.stringify(link.stream)} must be rooted at a declared table, not parser ${JSON.stringify(entry.from)}`,
          );
        }
        // A stream must not be fed from a table whose own rows already carry bounded
        // provenance (a reassembled message table or a flow table) — reassembling a stream
        // from already-reassembled bytes has no coherent source byte range to report.
        if (boundedProvenanceNames.has(entry.from)) {
          throw new ProjectionCompileError(
            'PROJECTION_STREAM_INVALID',
            `${linkPath}.stream`,
            `stream ${JSON.stringify(link.stream)} cannot be fed from ${JSON.stringify(entry.from)}: its rows have bounded provenance`,
          );
        }
        // Rule 3: every entry feeding a stream must agree on the feed table.
        if (stream.feedTable === null) {
          stream.feedTable = entry.from;
          stream.feedKeyColumn = tableByName.get(entry.from)!.key;
        } else if (stream.feedTable !== entry.from) {
          throw new ProjectionCompileError(
            'PROJECTION_STREAM_INVALID',
            `${linkPath}.stream`,
            `stream ${JSON.stringify(link.stream)} is fed from both ${JSON.stringify(
              stream.feedTable,
            )} and ${JSON.stringify(entry.from)}`,
          );
        }
        const when = compileCheckedExpression(link.when, new Set(), `${linkPath}.when`);
        // stream is the same mutable record streamByName holds; feedTable/feedKeyColumn are
        // filled in above (possibly by an earlier link) and the record is frozen into a real
        // CompiledStream once every dissect entry has been compiled — see the freeze step below.
        return Object.freeze({
          when,
          parserId: null,
          parser: null,
          table: null,
          stream: stream as unknown as CompiledStream,
        });
      }

      if (link.parser === undefined) {
        // Unreachable: spec.ts's chainLinkSpec requires exactly one of parser/stream.
        throw new ProjectionCompileError(
          'PROJECTION_DISSECT_INVALID',
          linkPath,
          'chain link must declare exactly one of parser or stream',
        );
      }

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
      const when = compileCheckedExpression(link.when, new Set(), `${linkPath}.when`);
      if (!fromIsTable) rejectContextReferences(when, `${linkPath}.when`);
      return Object.freeze({
        when,
        parserId: link.parser,
        parser,
        table,
        stream: null,
      });
    });
    const payload = compileCheckedExpression(entry.payload, new Set(), `${path}.payload`);
    if (!fromIsTable) rejectContextReferences(payload, `${path}.payload`);
    return Object.freeze({
      from: entry.from,
      payload,
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

  // Rule 5 (extended by rule 11): the graph over nodes (table names ∪ parser ids ∪ stream
  // names) must be acyclic. Beyond the classic `from -> chain[].parser` edge, a chain/message
  // link's `table` also gets an edge from its parser id: at runtime, a row landing in that
  // table immediately triggers dissectByFrom(table) (fireDissect from emitRow), which is the
  // same recursion hazard a `from: <table>` entry represents — so a parser feeding a table is
  // graph-equivalent to that parser's downstream continuing through the table's own chains.
  // Streams add two more edges: `fromTable -> streamName` (a stream link) and
  // `streamName -> message parserId` (each of that stream's messages).
  const edges = new Map<string, string[]>();
  const addEdge = (from: string, to: string): void => {
    const list = edges.get(from) ?? [];
    list.push(to);
    edges.set(from, list);
  };
  for (const entry of dissects) {
    for (const link of entry.chain) {
      if (link.parserId !== null) {
        addEdge(entry.from, link.parserId);
        if (link.table) addEdge(link.parserId, link.table.name);
      } else if (link.stream) {
        addEdge(entry.from, link.stream.name);
      }
    }
  }
  for (const stream of streamByName.values()) {
    for (const message of stream.messages) {
      addEdge(stream.name, message.parserId);
      if (message.table) addEdge(message.parserId, message.table.name);
    }
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

  // Parent-key reachability (rules 7 and 9) is computed in one fixpoint pass over the (now
  // acyclic) graph, then checked twice: rule 7 against each dissect entry's reachable set, and
  // rule 9 (further below, after the stream checks) against each stream's reachable set.
  //
  // `reachableAtEntry(entry)` is the set of tables whose row key is observable when `entry`
  // fires: its `from` table (when table-rooted) plus whatever that table inherited, or what its
  // `from` parser id inherited. Every chain link folds its entry's set into what it feeds: its
  // parser id, its table, or its stream. A chain link's own table is deliberately NOT added to
  // its parser's set: at runtime, dissect entries keyed off a PARSER id run in fireDissect's
  // `deeper` loop with the OUTER keysByTable, so they never observe the row key of a sibling
  // link's table. Admitting a chain-fed table there would accept specs whose parent_key the
  // runtime can only fill with null. The still-legitimate way to parent a table onto an
  // intermediate table's per-row key is to chain `from: <table>` instead of `from: <parser>` —
  // chains fired from emitRow extend keysByTable with that table's own key before dispatching,
  // so that table (and its ancestors) are genuinely reachable.
  //
  // Streams hop their set onto each of their message parser ids: a message-rooted deeper
  // dissect (`from: <message parser id>`) fires at runtime with the SAME keysByTable the stream
  // contribution captured (see contributeToStream's `keysByTable` / emitStreamMessage's
  // `completingKeys`), so whatever was reachable at the feed table is equally reachable from
  // one of the stream's own message parsers. There is deliberately no second hop onto message
  // tables: rule 9 reads only the per-stream sets, which are fed exclusively by the stream's
  // feed table — a table without bounded provenance (a bounded feed table is rejected while
  // compiling the dissect chains above), and therefore unreachable from any message parser or
  // message table, so no stream hop can change its set. A hop onto message tables would only
  // widen rule 7 for entries rooted at a message table, accepting specs it rejects today.
  const reachableByParser = new Map<string, Set<string>>();
  const reachableByTable = new Map<string, Set<string>>();
  const reachableByStream = new Map<string, Set<string>>();
  const reachableAtEntry = (entry: CompiledDissect): ReadonlySet<string> => {
    if (tableByName.has(entry.from)) {
      const own = new Set([entry.from]);
      for (const value of reachableByTable.get(entry.from) ?? []) own.add(value);
      return own;
    }
    return reachableByParser.get(entry.from) ?? new Set();
  };
  // Unions `values` into map[name]; true when the set grew.
  const fold = (map: Map<string, Set<string>>, name: string, values: Iterable<string>): boolean => {
    const existing = map.get(name) ?? new Set<string>();
    const before = existing.size;
    for (const value of values) existing.add(value);
    map.set(name, existing);
    return existing.size !== before;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of dissects) {
      const entryReachable = reachableAtEntry(entry);
      for (const link of entry.chain) {
        if (link.parserId !== null) {
          if (fold(reachableByParser, link.parserId, entryReachable)) changed = true;
          if (link.table && fold(reachableByTable, link.table.name, entryReachable)) changed = true;
        } else if (link.stream) {
          if (fold(reachableByStream, link.stream.name, entryReachable)) changed = true;
        }
      }
    }
    for (const stream of streamByName.values()) {
      const streamReachable = reachableByStream.get(stream.name) ?? new Set<string>();
      for (const message of stream.messages) {
        if (fold(reachableByParser, message.parserId, streamReachable)) changed = true;
      }
    }
  }

  // Rule 7: for each chain link with a table, that table's parent_key.table must be reachable
  // from the dissect entry, so the key value exists at runtime.
  for (const [entryIndex, entry] of dissects.entries()) {
    const entryReachable = reachableAtEntry(entry);
    for (const [linkIndex, link] of entry.chain.entries()) {
      if (!link.table?.parentKey) continue;
      if (!entryReachable.has(link.table.parentKey.table)) {
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

  // Rule 3 (stream half) / rule 6 (remaining half): a stream must be fed by at least one chain
  // link, and its flow table must not also be dissect-fed or message-fed.
  for (const [streamIndex, entry] of (spec.streams ?? []).entries()) {
    const stream = streamByName.get(entry.name)!;
    const path = `streams.${streamIndex}`;
    if (stream.feedTable === null) {
      throw new ProjectionCompileError(
        'PROJECTION_STREAM_INVALID',
        path,
        `stream ${JSON.stringify(entry.name)} is not fed by any dissect chain link`,
      );
    }
    if (dissectTables.has(stream.flowTable.name)) {
      throw new ProjectionCompileError(
        'PROJECTION_STREAM_INVALID',
        `${path}.table`,
        `flow table ${JSON.stringify(entry.table)} must not also be dissect-fed or message-fed`,
      );
    }
  }

  // Rule 7 (segments_table half): two streams may share a segments_table only if they also
  // share the feed table (their segment rows must key onto the same feedKeyColumn).
  const segmentsTableFeedTable = new Map<string, string>();
  for (const [streamIndex, entry] of (spec.streams ?? []).entries()) {
    const stream = streamByName.get(entry.name)!;
    const existingFeed = segmentsTableFeedTable.get(stream.segmentsTable);
    if (existingFeed === undefined) {
      segmentsTableFeedTable.set(stream.segmentsTable, stream.feedTable!);
    } else if (existingFeed !== stream.feedTable) {
      throw new ProjectionCompileError(
        'PROJECTION_STREAM_INVALID',
        `streams.${streamIndex}.segments_table`,
        `segments_table ${JSON.stringify(stream.segmentsTable)} is shared by streams with different feed tables`,
      );
    }
    // Rule 7 (key half): the feed table's key becomes a segments-table column next to the
    // fixed segment_id/stream_id/offset columns (streamSegmentsOutputTypes). A feed key
    // named like any of them would collapse into that column in the schema object literal —
    // the segments table would lose a fixed column and its join key would carry the wrong
    // values, with no error at load or runtime.
    if (streamSegmentsFixedColumns.has(stream.feedKeyColumn!)) {
      throw new ProjectionCompileError(
        'PROJECTION_STREAM_INVALID',
        `streams.${streamIndex}.segments_table`,
        `feed table ${JSON.stringify(stream.feedTable)}'s key ${JSON.stringify(
          stream.feedKeyColumn,
        )} collides with a fixed column of segments table ${JSON.stringify(stream.segmentsTable)}`,
      );
    }
  }

  // Rule 9: a message link's table parents onto a key observable when the stream's messages
  // fire — the stream's reachable set from the fixpoint above, since messages fire once a
  // stream's assembled buffer is framed off the feed table's row.
  for (const [streamIndex, entry] of (spec.streams ?? []).entries()) {
    const stream = streamByName.get(entry.name)!;
    const streamReachable = reachableByStream.get(stream.name) ?? new Set<string>();
    for (const [messageIndex, message] of stream.messages.entries()) {
      if (!message.table?.parentKey) continue;
      if (!streamReachable.has(message.table.parentKey.table)) {
        throw new ProjectionCompileError(
          'PROJECTION_PARENT_KEY_INVALID',
          `streams.${streamIndex}.messages.${messageIndex}.table`,
          `table ${JSON.stringify(message.table.name)}'s parent_key.table ${JSON.stringify(
            message.table.parentKey.table,
          )} is not reachable from stream ${JSON.stringify(entry.name)}`,
        );
      }
    }
  }

  // Every validation that could still fail has run — freeze the mutable stream records in
  // place (see the comment above streamByName) and derive the public arrays from them.
  const streams: readonly CompiledStream[] = Object.freeze(
    (spec.streams ?? []).map((entry): CompiledStream => {
      const stream = streamByName.get(entry.name)!;
      Object.freeze(stream.messages);
      // feedTable/feedKeyColumn are guaranteed non-null past the "never fed" check above.
      return Object.freeze(stream) as CompiledStream;
    }),
  );
  const segmentsTables: readonly { name: string; feedKeyColumn: string }[] = Object.freeze(
    streams.reduce<{ name: string; feedKeyColumn: string }[]>((list, stream) => {
      if (!list.some((entry) => entry.name === stream.segmentsTable)) {
        list.push({ name: stream.segmentsTable, feedKeyColumn: stream.feedKeyColumn });
      }
      return list;
    }, []),
  );

  const flowTableNames = new Set(streams.map((stream) => stream.flowTable.name));
  const rootTables = tables.filter(
    (table) => !dissectTables.has(table.name) && !flowTableNames.has(table.name),
  );
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
    specVersion: spec.version,
    format: spec.format,
    tables: Object.freeze(tables),
    rootTables: Object.freeze(rootTables),
    dissectByFrom,
    streams,
    segmentsTables,
  });
};

export const tableOutputTypes = (table: CompiledProjectionTable): Record<string, ArrowTypeName> => {
  const types: Record<string, ArrowTypeName> = { [table.key]: 'int64' };
  if (table.parentKey) types[table.parentKey.column] = 'int64';
  if (table.streamFed) types.stream_id = 'int64';
  for (const column of table.columns) {
    types[column.name] = column.type;
  }
  types._src_start = 'uint64';
  types._src_end = 'uint64';
  if (table.boundedProvenance) types._src_ranges = 'src_ranges';
  return types;
};

// Fixed segments-table columns, which the feed table's key column is placed next to — see
// streamSegmentsOutputTypes. A feed key with any of these names would collide in that object
// literal, so the compile rejects them (rule 7, key half).
const streamSegmentsFixedColumns = new Set(['segment_id', 'stream_id', 'offset']);

// Segment rows recorded for a stream's assembler buffer: one row per contiguous byte range
// folded into the reassembled stream, keyed onto the feed table's own row (feedKeyColumn).
export const streamSegmentsOutputTypes = (feedKeyColumn: string): Record<string, ArrowTypeName> => ({
  segment_id: 'int64',
  stream_id: 'int64',
  [feedKeyColumn]: 'int64',
  offset: 'int64',
  _src_start: 'uint64',
  _src_end: 'uint64',
});
