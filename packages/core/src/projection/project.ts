import {
  compileAnchor,
  isAnchorPrefix,
  traverseAnchor,
  type AnchorMatch,
  type CompiledAnchor,
} from './anchors.js';
import {
  ProjectionCompileError,
  compileExpression,
  evaluateExpression,
  getExpressionContextReferences,
  getExpressionStateReferences,
  type CompiledExpression,
  type ExpressionContext,
} from './expression.js';
import type { IssueCollector } from '../issues.js';
import type { ParsedRecord, ParserRegistry, RecordParser } from './parsers.js';
import type { ArrowTypeName, ProjectionSpec, TableSpec } from './spec.js';
import { StreamAssembler } from './streams.js';
import type { StreamFramer, StreamKeyExtractor, StreamKeyResult, StreamRegistries } from './streams.js';
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
  readonly parentKey: { table: string; column: string } | null;
  // Fed by a stream `messages` link (see spec v0.3's streams:) rather than a plain dissect
  // chain link — tableOutputTypes injects a synthetic `stream_id` column for these.
  readonly streamFed: boolean;
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
  readonly format: string;
  readonly tables: readonly CompiledProjectionTable[];
  readonly rootTables: readonly CompiledProjectionTable[];
  readonly dissectByFrom: ReadonlyMap<string, readonly CompiledDissect[]>;
  readonly streams: readonly CompiledStream[];
  readonly segmentsTables: readonly { name: string; feedKeyColumn: string }[];
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

  // Rule 7: for each chain link with a table, that table's parent_key.table must be reachable
  // by walking from-ancestors of the dissect entry, so the key value exists at runtime.
  // Ancestors are computed as a fixpoint over the (now acyclic) from -> parser graph: a parser
  // id's ancestors are the union, over every entry whose chain contains it, of that entry's
  // ancestors, plus that entry's `from` when it is a table (folded in by ancestorsOfEntry below).
  // A chain link's own table is deliberately NOT added to its parser's ancestor set: at runtime,
  // dissect entries keyed off a PARSER id run in fireDissect's `deeper` loop with the OUTER
  // keysByTable, so they never observe the row key of a sibling link's table. Admitting a
  // chain-fed table here would accept specs whose parent_key the runtime can only fill with
  // null. The still-legitimate way to parent a table onto an intermediate table's per-row key is
  // to chain `from: <table>` instead of `from: <parser>` — chains fired from emitRow extend
  // keysByTable with that table's own key before dispatching, so that table (and its ancestors)
  // are genuinely reachable.
  const ancestorsByParser = new Map<string, Set<string>>();
  const ancestorsOfEntry = (entry: CompiledDissect): ReadonlySet<string> => {
    if (tableByName.has(entry.from)) return new Set([entry.from]);
    return ancestorsByParser.get(entry.from) ?? new Set();
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of dissects) {
      const entryAncestors = ancestorsOfEntry(entry);
      for (const link of entry.chain) {
        if (link.parserId === null) continue; // stream links have no parser id; unrelated to this fixpoint
        const existing = ancestorsByParser.get(link.parserId) ?? new Set<string>();
        const before = existing.size;
        for (const ancestor of entryAncestors) existing.add(ancestor);
        if (existing.size !== before) changed = true;
        ancestorsByParser.set(link.parserId, existing);
      }
    }
  }
  for (const [entryIndex, entry] of dissects.entries()) {
    const entryAncestors = ancestorsOfEntry(entry);
    for (const [linkIndex, link] of entry.chain.entries()) {
      if (!link.table?.parentKey) continue;
      if (!entryAncestors.has(link.table.parentKey.table)) {
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
  }

  // Rule 9: availability fixpoint. `avail(entry)` is the set of tables whose row key is
  // observable at the point `entry` fires: itself (if table-rooted) plus whatever its upstream
  // already made available. Parser/table/stream availability propagate through the same three
  // maps described in the task brief; a message link's table then inherits its stream's
  // availability, since messages fire once a stream's assembled buffer is framed off the feed
  // table's row.
  const parserAvail = new Map<string, Set<string>>();
  const tableAvail = new Map<string, Set<string>>();
  const streamAvail = new Map<string, Set<string>>();
  const availOfEntry = (entry: CompiledDissect): ReadonlySet<string> => {
    if (tableByName.has(entry.from)) {
      const own = new Set([entry.from]);
      for (const ancestor of tableAvail.get(entry.from) ?? []) own.add(ancestor);
      return own;
    }
    return parserAvail.get(entry.from) ?? new Set();
  };
  let availChanged = true;
  while (availChanged) {
    availChanged = false;
    for (const entry of dissects) {
      const entryAvail = availOfEntry(entry);
      for (const link of entry.chain) {
        if (link.parserId !== null) {
          const existing = parserAvail.get(link.parserId) ?? new Set<string>();
          const before = existing.size;
          for (const value of entryAvail) existing.add(value);
          if (existing.size !== before) availChanged = true;
          parserAvail.set(link.parserId, existing);
          if (link.table) {
            const existingTable = tableAvail.get(link.table.name) ?? new Set<string>();
            const beforeTable = existingTable.size;
            for (const value of entryAvail) existingTable.add(value);
            if (existingTable.size !== beforeTable) availChanged = true;
            tableAvail.set(link.table.name, existingTable);
          }
        } else if (link.stream) {
          const existing = streamAvail.get(link.stream.name) ?? new Set<string>();
          const before = existing.size;
          for (const value of entryAvail) existing.add(value);
          if (existing.size !== before) availChanged = true;
          streamAvail.set(link.stream.name, existing);
        }
      }
    }
    for (const stream of streamByName.values()) {
      const streamValues = streamAvail.get(stream.name) ?? new Set<string>();
      for (const message of stream.messages) {
        if (!message.table) continue;
        const existingTable = tableAvail.get(message.table.name) ?? new Set<string>();
        const beforeTable = existingTable.size;
        for (const value of streamValues) existingTable.add(value);
        if (existingTable.size !== beforeTable) availChanged = true;
        tableAvail.set(message.table.name, existingTable);
      }
    }
  }
  for (const [streamIndex, entry] of (spec.streams ?? []).entries()) {
    const stream = streamByName.get(entry.name)!;
    const streamValues = streamAvail.get(stream.name) ?? new Set<string>();
    for (const [messageIndex, message] of stream.messages.entries()) {
      if (!message.table?.parentKey) continue;
      if (!streamValues.has(message.table.parentKey.table)) {
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
    format: spec.format,
    tables: Object.freeze(tables),
    rootTables: Object.freeze(rootTables),
    dissectByFrom,
    streams,
    segmentsTables,
  });
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

// One ACCEPTED ('added'/'rebased') contribution to a flow's assembler, recorded at contribution
// time but deliberately NOT yet translated to a base-relative `offset` — the base can still
// shift under a later rebase, which would silently invalidate an offset computed too early (see
// StreamRuntimeEntry.segments doc). `absOffset` is the raw offset value passed to
// `assembler.add`, in absolute (never-rebased) offset space; `feedKeyValue` is the feed table's
// key captured at contribution time (the feed row is long gone by flush).
export interface StreamSegmentRecord {
  readonly absOffset: number;
  readonly srcStart: number;
  readonly srcEnd: number;
  readonly feedKeyValue: bigint | null;
}

// Per-flow runtime state for one stream's reassembly, keyed by the stream key extractor's
// `key` string within StreamsRuntime.flows.get(stream.name). `status` starts 'ok' and only
// ever moves forward: 'truncated'/'error' are terminal (contributions silently drop once
// reached); 'gap' is flush-only (assigned in flushStreams, never during contribution).
export interface StreamRuntimeEntry {
  readonly assembler: StreamAssembler;
  readonly streamId: bigint;
  readonly flowRoot: Record<string, unknown>;
  messageCount: number;
  framingStalled: boolean;
  stallMessage: string | null;
  status: 'ok' | 'gap' | 'truncated' | 'error';
  // Every ACCEPTED contribution, in arrival order. `offset` rows are NOT emitted here — a
  // rebase after this contribution would move the base and silently invalidate an
  // already-emitted `offset - base` row (empirically: an out-of-order flow used to yield two
  // segment rows both reading offset=0 instead of the correct 0 and 3). Instead we defer
  // translating `absOffset` into a base-relative `offset` until flushStreams, when the
  // assembler's base is final.
  readonly segments: StreamSegmentRecord[];
}

export interface StreamsRuntime {
  // Outer key: stream name (compiled.streams[].name). Inner key: the stream key extractor's
  // `key` string — one entry per distinct flow observed so far.
  readonly flows: Map<string, Map<string, StreamRuntimeEntry>>;
  // segments_table name -> next segment_id to assign (mirrors TableRuntime.nextKey, but keyed
  // by table name rather than living on a per-table runtime since segments tables have no
  // CompiledProjectionTable of their own).
  readonly segmentKeys: Map<string, bigint>;
}

export const createStreamsRuntime = (compiled: CompiledProjection): StreamsRuntime => ({
  flows: new Map(compiled.streams.map((stream) => [stream.name, new Map<string, StreamRuntimeEntry>()])),
  segmentKeys: new Map(compiled.segmentsTables.map((table) => [table.name, 1n])),
});

export interface EmitContext {
  readonly compiled: CompiledProjection;
  readonly runtimes: Map<string, TableRuntime>;
  readonly sink: RowSink;
  readonly streams: StreamsRuntime | null;
  readonly issues?: IssueCollector;
}

const emitRow = (
  table: CompiledProjectionTable,
  runtime: TableRuntime,
  match: AnchorMatch,
  root: unknown,
  provenance: ProvenanceResolver,
  sink: RowSink,
  keysByTable: ReadonlyMap<string, bigint>,
  emitContext: EmitContext,
  // Absolute file offset of the coordinate space `root` (and thus this row's dissect
  // payload expressions) are evaluated in: 0 for the file tree, or the enclosing payload's
  // absolute start for a child parse tree. See asPayloadRange / fireDissect.
  baseOffset: number,
  // Byte length of the payload buffer `root` was parsed from, or null at the file root
  // (unchecked — see fireDissect's containment check). Threaded through unchanged to this
  // row's own outgoing dissects: `table`'s rows live inside the same buffer as `root`
  // itself, whether `table` is a root table (null) or was itself dissected out of a parent
  // payload (that payload's byte length).
  enclosingLength: number | null,
  // Ancestor threading invariant: parse-tree roots strictly ABOVE `root` (does not include
  // `root` itself) — projectInto's root-level call passes [], projectChildTable threads its
  // own `ancestors` through unchanged (see that function's doc), and flushStreams also passes
  // [] since a flushed flow row has no enclosing parse tree at all.
  ancestors: readonly unknown[],
  parentKey?: { name: string; value: bigint | null },
  extraColumns?: Readonly<Record<string, unknown>>,
  // Set by flushStreams to force a flow row onto its eagerly-reserved streamId (reserved at
  // first contribution, long before the flow row itself is emitted) instead of drawing a
  // fresh key from the table runtime.
  forcedKey?: bigint,
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

  const key = forcedKey ?? runtime.nextKey;
  if (forcedKey === undefined) runtime.nextKey += 1n;
  const row: Record<string, unknown> = { [table.key]: key };
  if (parentKey) row[parentKey.name] = parentKey.value;
  if (extraColumns) Object.assign(row, extraColumns);
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

export const tableOutputTypes = (table: CompiledProjectionTable): Record<string, ArrowTypeName> => {
  const types: Record<string, ArrowTypeName> = { [table.key]: 'int64' };
  if (table.parentKey) types[table.parentKey.column] = 'int64';
  if (table.streamFed) types.stream_id = 'int64';
  for (const column of table.columns) {
    if (column.name === table.key || column.name === '_src_start' || column.name === '_src_end') continue;
    types[column.name] = column.type;
  }
  types._src_start = 'uint64';
  types._src_end = 'uint64';
  return types;
};

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

interface PayloadRange {
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

const fireDissect = (
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
      contributeToStream(link.stream, context, payload, absoluteStart, keysByTable, emitContext, ancestors);
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

// `stream.offset` may legitimately evaluate to a bigint (large/wide file offsets go through
// the same numeric-literal path as everything else in this DSL) — accept it and convert down
// to a plain number as long as it stays representable, since StreamAssembler works in `number`.
const toSafeOffset = (value: unknown): number | null => {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return null;
};

const contributeToStream = (
  stream: CompiledStream,
  context: ExpressionContext,
  payload: PayloadRange,
  absoluteStart: number,
  keysByTable: ReadonlyMap<string, bigint>,
  emitContext: EmitContext,
  // Ancestors strictly above the row that fired this dissect (fireDissect's own list, whose
  // LAST element is that row's root — not meaningful to a key extractor asked about the row
  // node itself, hence the `.slice(0, -1)` below).
  ancestors: readonly unknown[],
): void => {
  if (payload.bytes.length === 0) return; // empty payload: no contribution, no flow creation

  const streams = emitContext.streams;
  if (!streams) return; // no StreamsRuntime wired in (projectInto called without one)

  const srcStart = absoluteStart;
  const srcEnd = absoluteStart + payload.bytes.length;

  const offset = toSafeOffset(evaluateExpression(stream.offset, context));
  if (offset === null) {
    emitContext.issues?.report({
      stage: 'reassembling',
      code: 'STREAM_ERROR',
      recoverable: true,
      message: `stream ${JSON.stringify(stream.name)}: offset did not evaluate to a non-negative safe integer`,
      sourceStart: srcStart,
      sourceEnd: srcEnd,
    });
    return;
  }

  let keyResult: StreamKeyResult | null;
  try {
    // Ancestor threading invariant: the key extractor sees ancestors strictly above the row
    // itself, so the row's own root (fireDissect's ancestors' last element) is dropped here.
    keyResult = stream.keyExtractor({ node: context._, ancestors: ancestors.slice(0, -1) });
  } catch (error) {
    emitContext.issues?.report({
      stage: 'reassembling',
      code: 'STREAM_KEY_INVALID',
      recoverable: true,
      message: error instanceof Error ? error.message : String(error),
      sourceStart: srcStart,
      sourceEnd: srcEnd,
    });
    return;
  }
  if (!keyResult) {
    emitContext.issues?.report({
      stage: 'reassembling',
      code: 'STREAM_KEY_INVALID',
      recoverable: true,
      message: `stream ${JSON.stringify(stream.name)}: key extractor returned null`,
      sourceStart: srcStart,
      sourceEnd: srcEnd,
    });
    return;
  }

  const flowMap = streams.flows.get(stream.name)!;
  let entry = flowMap.get(keyResult.key);
  if (!entry) {
    // Eager streamId reservation: the flow's row key is claimed from the flow table's own
    // runtime at first contribution (not at flush time), so message rows — emitted mid-stream,
    // long before the flow row itself is ever built — can already carry a stable stream_id.
    const flowRuntime = emitContext.runtimes.get(stream.flowTable.name)!;
    const streamId = flowRuntime.nextKey;
    flowRuntime.nextKey += 1n;
    entry = {
      assembler: new StreamAssembler(stream.maxBuffer),
      streamId,
      flowRoot: { ...keyResult.root }, // first contribution wins; later ones do not overwrite
      messageCount: 0,
      framingStalled: false,
      stallMessage: null,
      status: 'ok',
      segments: [],
    };
    flowMap.set(keyResult.key, entry);
  }

  if (entry.status === 'truncated' || entry.status === 'error') return; // inactive: drop silently

  const result = entry.assembler.add(offset, payload.bytes, srcStart, srcEnd);
  if (result === 'duplicate') return;
  if (result === 'below_base' || result === 'overlap') {
    entry.status = 'error';
    emitContext.issues?.report({
      stage: 'reassembling',
      code: 'STREAM_ERROR',
      recoverable: true,
      message: `stream ${JSON.stringify(stream.name)} flow ${JSON.stringify(keyResult.key)}: segment at offset ${offset} ${
        result === 'overlap' ? 'overlaps an already-assembled segment' : 'arrived below the consumed base'
      }`,
      sourceStart: srcStart,
      sourceEnd: srcEnd,
    });
    return;
  }
  if (result === 'truncated') {
    entry.status = 'truncated';
    emitContext.issues?.report({
      stage: 'reassembling',
      code: 'STREAM_TRUNCATED',
      recoverable: true,
      message: `stream ${JSON.stringify(stream.name)} flow ${JSON.stringify(keyResult.key)}: buffer exceeded max_buffer (${stream.maxBuffer})`,
      sourceStart: srcStart,
      sourceEnd: srcEnd,
    });
    return;
  }

  // result is 'added' or 'rebased': fold in the segment row and (re-)attempt framing.
  if (result === 'rebased') {
    entry.framingStalled = false;
    entry.stallMessage = null;
  }

  // Record the contribution, arrival-ordered; the base-relative `offset` and segment_id are
  // both assigned later, at flush (see StreamSegmentRecord doc and flushStreams).
  entry.segments.push({
    absOffset: offset,
    srcStart,
    srcEnd,
    feedKeyValue: keysByTable.get(stream.feedTable) ?? null,
  });

  // completingKeys: the CURRENT contribution's keysByTable — the packet whose arrival framed
  // whatever messages come out of this call, chronologically last even when its own byte
  // offset in the stream is earlier than other already-buffered segments.
  frameStreamMessages(stream, entry, keysByTable, emitContext);
};

const frameStreamMessages = (
  stream: CompiledStream,
  entry: StreamRuntimeEntry,
  completingKeys: ReadonlyMap<string, bigint>,
  emitContext: EmitContext,
): void => {
  while (!entry.framingStalled) {
    const view = entry.assembler.contiguousView();
    if (view.length === 0) break;

    let length: number;
    try {
      const result = stream.framer(view);
      if (result === null) break; // wait: undeterminable with the bytes buffered so far
      length = result;
    } catch (error) {
      entry.framingStalled = true;
      entry.stallMessage = error instanceof Error ? error.message : String(error);
      break;
    }
    if (!Number.isInteger(length) || length <= 0) {
      entry.framingStalled = true;
      entry.stallMessage = `framer returned a non-positive or non-integer length (${length})`;
      break;
    }
    if (length > view.length) break; // wait: message not fully arrived yet

    const messageStart = entry.assembler.consumed;
    const messageEnd = messageStart + length;
    // Copy BEFORE consume: a later rebase can reallocate the assembler's backing buffer, which
    // would leave a bare `subarray` view of `view` pointing at stale/detached memory.
    const messageBytes = Uint8Array.from(view.subarray(0, length));
    entry.assembler.consume(length);
    entry.messageCount += 1;
    emitStreamMessage(stream, entry, messageStart, messageEnd, messageBytes, completingKeys, emitContext);
  }
};

const emitStreamMessage = (
  stream: CompiledStream,
  entry: StreamRuntimeEntry,
  messageStart: number,
  messageEnd: number,
  messageBytes: Uint8Array,
  completingKeys: ReadonlyMap<string, bigint>,
  emitContext: EmitContext,
): void => {
  // Span endpoints: map messageStart/messageEnd (current-base-relative stream positions)
  // through EACH contributing segment's own linear offset <-> file-offset relationship, clip
  // to the part of that segment the message actually overlaps, and take the min/max of the
  // clipped ranges. This is NOT simply first-segment-start/last-segment-end ordered by stream
  // position: under out-of-order capture a segment earlier in stream order can sit at a LATER
  // file offset than one after it (rebase reorders stream position without reordering file
  // position), which would otherwise yield an inverted span (start > end). Clipping and taking
  // min/max over every overlapping segment always yields a proper covering range, and degrades
  // to the previous exact single-segment/in-order-multi-segment span when there is no reordering.
  const boundary = entry.assembler.segmentsOverlapping(messageStart, messageEnd);
  let spanStart = Infinity;
  let spanEnd = -Infinity;
  for (const s of boundary) {
    const clipStart = s.srcStart + Math.max(0, messageStart - s.start);
    const clipEnd = s.srcStart + Math.min(s.end - s.start, messageEnd - s.start);
    if (clipStart < spanStart) spanStart = clipStart;
    if (clipEnd > spanEnd) spanEnd = clipEnd;
  }
  const span: SourceRange = { start: spanStart, end: spanEnd };

  const node = { offset: messageStart, length: messageEnd - messageStart };
  const context: ExpressionContext = { _: node, _root: node };

  for (const link of stream.messages) {
    if (!evaluateExpression(link.when, context)) continue;

    let parsed: ParsedRecord;
    try {
      parsed = link.parser(messageBytes);
    } catch (error) {
      emitContext.issues?.report({
        stage: 'dissecting',
        code: 'DISSECT_PARSE_FAILED',
        recoverable: true,
        message: error instanceof Error ? error.message : String(error),
        sourceStart: span.start,
        sourceEnd: span.end,
      });
      return; // stop: this message is dropped, but framing already advanced past it
    }

    if (link.table) {
      projectChildTable(link.table, parsed, messageBytes, span.start, completingKeys, emitContext, [], {
        streamId: entry.streamId,
        span,
      });
    }

    // Ancestor threading invariant: a framed message is a fresh top-level tree, like the file
    // root at projectInto — it has no ancestors of its own, only the parser's own output root.
    for (const deeper of emitContext.compiled.dissectByFrom.get(link.parserId) ?? []) {
      fireDissect(
        deeper,
        { _: parsed.root, _root: parsed.root },
        completingKeys,
        emitContext,
        span,
        span.start,
        messageBytes.length,
        [parsed.root],
      );
    }
    return; // first matching message link wins
  }
};

const projectChildTable = (
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
  streamMeta?: { streamId: bigint; span: SourceRange },
): void => {
  const resolver: ProvenanceResolver = streamMeta
    ? {
        // A reassembled stream buffer is discontiguous with the source file — byte N of
        // `messageBytes` has no fixed relationship to any single file offset, so a parser's
        // `resolve` (which reports offsets relative to the buffer it was handed) cannot be
        // mapped back through it. Every row from a message-fed table shares the exact span
        // the framing loop already computed for the whole message instead.
        resolve: () => streamMeta.span,
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
      table,
      runtime,
      match,
      parsed.root,
      resolver,
      emitContext.sink,
      keysByTable,
      emitContext,
      absolutePayloadStart,
      payloadBytes.length,
      ancestors,
      { name: table.parentKey!.column, value: parentKeyValue },
      streamMeta ? { stream_id: streamMeta.streamId } : undefined,
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
): void => {
  const active = compiled.rootTables.filter((table) => !subset || subset.has(table.name));
  const matcher = buildMatcher(active.map((table) => table.rows));
  const emitContext: EmitContext = { compiled, runtimes, sink, streams, ...(issues ? { issues } : {}) };
  const emptyKeys: ReadonlyMap<string, bigint> = new Map();
  walkMatcher(root, matcher, (anchorIndex, match) => {
    const table = active[anchorIndex]!;
    // The file tree is the root coordinate space: base offset 0, so payload.start is
    // absolute unchanged for chains fired directly off root-table rows. enclosingLength is
    // null here — the engine never sees the file's byte length, so root-level dissect
    // payloads are unchecked; only payloads nested inside another payload can be validated.
    // Ancestor threading invariant: a root-table row has no ancestors of its own.
    emitRow(
      table,
      runtimes.get(table.name)!,
      match,
      root,
      provenance,
      sink,
      emptyKeys,
      emitContext,
      0,
      null,
      [],
    );
  });
};

// Resolves every stream's flows to their final flow-table row (and clears any resolvable
// error state accumulated during contribution) — see the runtime-semantics contract at
// task-5-brief.md point 9. Idempotent to call is NOT guaranteed: it draws a fresh row per
// flow every time, so callers (session.finish, projectTree) must call it exactly once, after
// every contributing `project`/walk call has already run.
export const flushStreams = (emitContext: EmitContext): void => {
  const streams = emitContext.streams;
  if (!streams) return;

  for (const stream of emitContext.compiled.streams) {
    const flowMap = streams.flows.get(stream.name);
    if (!flowMap) continue;
    const runtime = emitContext.runtimes.get(stream.flowTable.name)!;

    for (const entry of flowMap.values()) {
      const span = entry.assembler.srcSpan ?? { start: 0, end: 0 };

      // Precedence: a stalled framer beats an end-of-stream gap — a stream that both stalled
      // AND still has unresolved gaps behind it reports 'error', not 'gap'. Both checks only
      // run when status is still 'ok': truncated/error from contribution are already terminal.
      if (entry.status === 'ok') {
        if (entry.framingStalled) {
          entry.status = 'error';
          emitContext.issues?.report({
            stage: 'reassembling',
            code: 'STREAM_ERROR',
            recoverable: true,
            message: entry.stallMessage ?? `stream ${JSON.stringify(stream.name)}: framing stalled`,
            sourceStart: span.start,
            sourceEnd: span.end,
          });
        } else if (entry.assembler.hasGap()) {
          entry.status = 'gap';
          emitContext.issues?.report({
            stage: 'reassembling',
            code: 'STREAM_GAP',
            recoverable: true,
            message: `stream ${JSON.stringify(stream.name)}: a gap remains unresolved at flush`,
            sourceStart: span.start,
            sourceEnd: span.end,
          });
        }
      }

      const root: Record<string, unknown> = {
        ...entry.flowRoot,
        segment_count: entry.assembler.segmentCount,
        byte_count: entry.assembler.byteCount,
        message_count: entry.messageCount,
        pending_bytes: entry.assembler.pendingBytes(),
        status: entry.status,
      };
      const provenance: ProvenanceResolver = { resolve: () => span };
      for (const match of traverseAnchor(stream.flowTable.rows, root)) {
        // Ancestor threading invariant: a flushed flow row has no enclosing parse tree at all.
        emitRow(
          stream.flowTable,
          runtime,
          match,
          root,
          provenance,
          emitContext.sink,
          new Map(),
          emitContext,
          span.start,
          null,
          [],
          undefined,
          undefined,
          entry.streamId, // forcedKey: the streamId reserved eagerly at first contribution
        );
      }

      // Segment rows: emitted here, not at contribution time, because the assembler's base is
      // only final now — a contribution recorded early in the flow's life can still be rebased
      // by a later, out-of-order-earlier one (see StreamSegmentRecord doc). segment_id keys are
      // still assigned sequentially, arrival-ordered, from streams.segmentKeys.
      const finalBase = entry.assembler.base ?? 0;
      for (const record of entry.segments) {
        const segmentId = streams.segmentKeys.get(stream.segmentsTable)!;
        streams.segmentKeys.set(stream.segmentsTable, segmentId + 1n);
        emitContext.sink.push(stream.segmentsTable, {
          segment_id: segmentId,
          stream_id: entry.streamId,
          [stream.feedKeyColumn]: record.feedKeyValue,
          offset: BigInt(record.absOffset - finalBase),
          _src_start: BigInt(record.srcStart),
          _src_end: BigInt(record.srcEnd),
        });
      }
    }
  }
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
  for (const segmentsTable of compiled.segmentsTables) {
    columnsByTable.set(
      segmentsTable.name,
      Object.fromEntries(
        Object.keys(streamSegmentsOutputTypes(segmentsTable.feedKeyColumn)).map((name) => [name, []]),
      ),
    );
  }
  const sink: RowSink = {
    push(tableName, row) {
      const columns = columnsByTable.get(tableName)!;
      for (const name of Object.keys(columns)) columns[name]!.push(row[name] ?? null);
    },
  };
  const runtimes = createRuntimes(compiled);
  const streams = createStreamsRuntime(compiled);
  projectInto(compiled, root, provenance, sink, runtimes, null, undefined, streams);
  flushStreams({ compiled, runtimes, sink, streams });
  const tables = compiled.tables.map((table) => {
    const columns = columnsByTable.get(table.name)!;
    const types = tableOutputTypes(table);
    return { name: table.name, columns, types, rowCount: columns[table.key]!.length };
  });
  const segmentsTables = compiled.segmentsTables.map((segmentsTable) => {
    const columns = columnsByTable.get(segmentsTable.name)!;
    const types = streamSegmentsOutputTypes(segmentsTable.feedKeyColumn);
    return { name: segmentsTable.name, columns, types, rowCount: columns.segment_id!.length };
  });
  return [...tables, ...segmentsTables];
};
