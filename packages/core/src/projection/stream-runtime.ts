// Stream reassembly runtime: per-flow state, contributions from dissect stream links, message
// framing and emission, and the end-of-session flush. Mutually recursive with emit.ts — see the
// note at the top of that module.
import { traverseAnchor } from './anchors.js';
import { evaluateExpression, type CompiledExpression, type ExpressionContext } from './expression.js';
import type { CompiledProjection, CompiledStream } from './compile.js';
import {
  emitRow,
  fireDissect,
  projectChildTable,
  type EmitContext,
  type PayloadRange,
  type ProvenanceResolver,
  type SourceRange,
} from './emit.js';
import type { ParsedRecord } from './parsers.js';
import { StreamAssembler, normalizeRanges, unwrapOffset } from './streams.js';
import type { StreamKeyResult, SourcePiece } from './streams.js';

// One ACCEPTED ('added'/'rebased') contribution to a flow's assembler, recorded at contribution
// time but deliberately NOT yet translated to a base-relative `offset` — the base can still
// shift under a later rebase, which would silently invalidate an offset computed too early (see
// StreamRuntimeEntry.segments doc). `absOffset` is the (already-unwrapped, for a wraparound
// stream) offset value passed to `assembler.add`, in absolute (never-rebased) offset space;
// `feedKeyValue` is the feed table's key captured at contribution time (the feed row is long
// gone by flush).
export interface StreamSegmentRecord {
  readonly absOffset: number;
  readonly srcStart: number;
  readonly srcEnd: number;
  readonly feedKeyValue: bigint | null;
}

// The exact provenance a stream message's rows inherit — computed once, in
// emitStreamMessage, and threaded through every row projected beneath that message (its own
// `messages[].table` row and any deeper dissect fired from the parsed message tree alike).
// `ranges` is already in column form (bigint pairs), so it can be assigned to `_src_ranges`
// without another pass through normalizeRanges/toColumnRanges.
export interface InheritedProvenance {
  readonly span: SourceRange;
  readonly ranges: readonly { start: bigint; end: bigint }[] | null;
}

// SourcePiece -> _src_ranges column form: bigint pairs, or null when there's nothing to widen
// _src_start/_src_end with (normalizeRanges already collapsed a single covering piece to null).
const toColumnRanges = (pieces: readonly SourcePiece[] | null): InheritedProvenance['ranges'] =>
  pieces?.map((piece) => ({ start: BigInt(piece.start), end: BigInt(piece.end) })) ?? null;

// Per-flow runtime state for one stream's reassembly, keyed by the stream key extractor's
// `key` string within StreamsRuntime.flows.get(stream.name). `status` starts 'ok' and only
// ever moves forward: 'truncated'/'error' are terminal (contributions silently drop once
// reached); 'gap' is flush-only (assigned in flushStreams, never during contribution). Since
// Task 8, overlapping and below-base contributions are reconciled instead of failing the flow
// (see contributeToStream's AssemblerAddOutcome handling), so 'error' now only comes from a
// stalled framer and invalid offsets/frame lengths, never from an overlap or a below-base byte.
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
  // Set only when a contribution is rejected as 'truncated' while the assembler still holds
  // zero stored segments — i.e. the flow's very FIRST contribution was already, by itself,
  // larger than max_buffer. That contribution's assembler.add() call returns before ever
  // storing a segment, so the flow never stores a segment (segments never gets a single
  // entry) and flushStreams would otherwise fall back to the meaningless {0, 0}. Reachability:
  // a first add() can only ever return 'added' or 'truncated' — 'duplicate'/'overlap' both
  // require an existing stored segment to collide with, and 'below_base' requires an already-set
  // base to fall under — so this is the only path that can leave a flow entry with no stored
  // segment. Once any segment IS stored, the span comes from the segments (segments only grow),
  // so this field only ever needs to remember the rejected FIRST contribution.
  fallbackSpan: SourceRange | null;
  // Lifecycle (v0.5): true once an `open` signal has been observed for this generation — sticky,
  // never reverts. `openOffset` is that segment's (already-unwrapped) offset (used by Task 5's
  // join test against a retransmitted SYN). `closedBy` follows the reset-takes-precedence rule: a
  // later `close` never overwrites `'reset'`, a later `reset` always overwrites `'close'`.
  opened: boolean;
  openOffset: number | null;
  closedBy: 'close' | 'reset' | null;
  // Fix B (FIN-beyond-data gap, ROADMAP #5 review): the highest offset any `close` signal has
  // carried on this entry — latched, never reset and never lowered (unlike closedBy, `reset`
  // never touches this field; see contributeToStream). Null until the first `close`.
  // flushStreams compares it against the reassembled data end (base + contiguousEnd, or the
  // anchor base when there is no data) to report 'gap' when the FIN arrived past the last byte
  // actually captured, even though the assembler itself sees no internal gap.
  closeOffset: number | null;
  // 1-based; bumped by Task 5's generation-splitting logic. Distinct generations of the same
  // (stream, key) each get their own entry, all retained in `ordered` for flush.
  generation: number;
  // Incremented once per conflicting overlap (Task 6); status stays 'ok' when it fires.
  conflictCount: number;
  // De-dupes the one-per-flow STREAM_BELOW_BASE issue (Task 6): true once that issue has been
  // reported for this entry.
  belowBaseReported: boolean;
  // Count of ACCEPTED data (non-control) contributions only — segments.length also counts
  // control segments, so this is the exact-and-only source for a data-only segment count
  // (Task 8 switches the flow root's `segment_count` to this field).
  dataSegmentCount: number;
  // Wraparound (Task 9): the highest extended offset seen so far in this generation (an offset,
  // or an offset + payload length for a data contribution) — null until this generation's first
  // contribution. `contributeToStream` passes it as `unwrapOffset`'s `reference` so later raw
  // offsets resolve to the epoch closest to what this generation has already seen. A fresh
  // generation gets its own null reference (see the "starts a new generation" branch), so
  // unwrapping always restarts from that generation's own first offset.
  unwrapReference: number | null;
}

export interface StreamsRuntime {
  // Outer key: stream name (compiled.streams[].name). Inner key: the stream key extractor's
  // `key` string. Holds the LIVE generation per (stream, key) only — a retired generation
  // (Task 5) is removed here but stays in `ordered` for flush.
  readonly current: Map<string, Map<string, StreamRuntimeEntry>>;
  // Every entry ever created for a stream, in creation order, including retired generations —
  // this is what flushStreams iterates, since `current` alone would drop a retired generation's
  // final row.
  readonly ordered: Map<string, StreamRuntimeEntry[]>;
  // segments_table name -> next segment_id to assign (mirrors TableRuntime.nextKey, but keyed
  // by table name rather than living on a per-table runtime since segments tables have no
  // CompiledProjectionTable of their own).
  readonly segmentKeys: Map<string, bigint>;
}

export const createStreamsRuntime = (compiled: CompiledProjection): StreamsRuntime => ({
  current: new Map(compiled.streams.map((stream) => [stream.name, new Map<string, StreamRuntimeEntry>()])),
  ordered: new Map(compiled.streams.map((stream) => [stream.name, []])),
  segmentKeys: new Map(compiled.segmentsTables.map((table) => [table.name, 1n])),
});

// Reserves the flow's stream_id, registers the entry in both `current` and `ordered`, and
// initializes the lifecycle fields to their neutral values. `generation` is passed in rather
// than computed here: Task 4 always creates generation 1; Task 5's join/split decision picks
// the generation before calling this.
const createFlowEntry = (
  stream: CompiledStream,
  keyResult: StreamKeyResult,
  emitContext: EmitContext,
  generation: number,
): StreamRuntimeEntry => {
  const streams = emitContext.streams!;
  // Eager streamId reservation: the flow's row key is claimed from the flow table's own
  // runtime at first contribution (not at flush time), so message rows — emitted mid-stream,
  // long before the flow row itself is ever built — can already carry a stable stream_id.
  const flowRuntime = emitContext.runtimes.get(stream.flowTable.name)!;
  const streamId = flowRuntime.nextKey;
  flowRuntime.nextKey += 1n;
  const entry: StreamRuntimeEntry = {
    assembler: new StreamAssembler(stream.maxBuffer),
    streamId,
    flowRoot: { ...keyResult.root }, // first contribution wins; later ones do not overwrite
    messageCount: 0,
    framingStalled: false,
    stallMessage: null,
    status: 'ok',
    segments: [],
    fallbackSpan: null,
    opened: false,
    openOffset: null,
    closedBy: null,
    closeOffset: null,
    generation,
    conflictCount: 0,
    belowBaseReported: false,
    dataSegmentCount: 0,
    unwrapReference: null,
  };
  streams.current.get(stream.name)!.set(keyResult.key, entry);
  streams.ordered.get(stream.name)!.push(entry);
  return entry;
};

// Reads a lifecycle signal (`open`/`close`/`reset`), which follows the same never-throw
// row-time-evaluation contract as every other expression: no expression declared (null) or a
// non-true result both count as false.
const signal = (expression: CompiledExpression | null, context: ExpressionContext): boolean =>
  expression !== null && evaluateExpression(expression, context) === true;

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

// Spec "Lifecycle semantics -> Generations": an open joins the current generation when it
// repeats that generation's recorded open offset (a retransmitted SYN), or when the generation
// has no open yet, is not closed, and the offset lands exactly on the assembler's base (a SYN
// captured after that connection's first data — the mid-stream flow is adopted). Anything else
// is a new connection reusing the same (stream, key) tuple.
const startsNewGeneration = (entry: StreamRuntimeEntry, offset: number): boolean => {
  if (entry.openOffset !== null) return entry.openOffset !== offset;
  if (entry.closedBy !== null) return true;
  return entry.assembler.base !== offset;
};

export const contributeToStream = (
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
  // The feeding row's own source range (fireDissect's `parentRange`) — used as a control
  // segment's provenance, since it has no payload bytes of its own to point at (see the
  // design's "Control segments are recorded" section).
  feedRange: SourceRange,
): void => {
  const streams = emitContext.streams;
  if (!streams) return; // no StreamsRuntime wired in (projectInto called without one)

  // What reaches the engine: non-empty payload (as before), OR any lifecycle signal on an
  // otherwise-empty payload (a SYN/FIN/RST carried with no data). A pure ACK — empty payload,
  // no signal — still contributes nothing.
  const open = signal(stream.open, context);
  const close = signal(stream.close, context);
  const reset = signal(stream.reset, context);
  const isControl = payload.bytes.length === 0;
  if (isControl && !open && !close && !reset) return; // pure ACK: nothing to record

  const srcStart = isControl ? feedRange.start : absoluteStart;
  const srcEnd = isControl ? feedRange.end : absoluteStart + payload.bytes.length;

  const raw = toSafeOffset(evaluateExpression(stream.offset, context));
  if (raw === null) {
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

  const current = streams.current.get(stream.name)!.get(keyResult.key);
  // Wraparound (Task 9): a stream declaring offset_bits maps the raw modular offset into a
  // monotonic extended offset, relative to the live generation's own unwrapReference (or epoch 1
  // for a generation's first contribution) — see unwrapOffset. Streams without offset_bits pass
  // the raw value through unchanged. Everything downstream of this point (the generation check,
  // anchor, assembler.add, and the recorded segment) uses the extended `offset`, never `raw`.
  const unwrap = (reference: number | null) =>
    stream.offsetBits === null ? raw : unwrapOffset(raw, stream.offsetBits, reference);
  let offset = unwrap(current?.unwrapReference ?? null);
  // Generation join/split (see startsNewGeneration): an `open` that doesn't join the current
  // generation retires it (it stays in `ordered` for flush) and reserves a fresh entry one
  // generation higher. A non-open contribution always joins whatever generation is current.
  let entry: StreamRuntimeEntry;
  if (!current) {
    entry = createFlowEntry(stream, keyResult, emitContext, 1);
  } else if (open && startsNewGeneration(current, offset)) {
    entry = createFlowEntry(stream, keyResult, emitContext, current.generation + 1);
    offset = unwrap(null); // a new generation restarts unwrapping from its own first offset
  } else {
    entry = current;
  }

  // Wraparound-reference hardening (ROADMAP #5 review fix A): entry.unwrapReference must never
  // drift on rejected or inactive input — only an ACTUALLY ACCEPTED contribution may move it
  // forward, and never by more than what was accepted. Previously every contribution (including
  // a data segment later rejected as truncated/dropped/duplicate/conflict, even on an
  // already-inactive flow) advanced the reference unconditionally and before the inactive check
  // below; a flood of crafted segments each landing near the current reference plus payload
  // length could walk it forward without bound across millions of packets, eventually
  // overflowing Number.MAX_SAFE_INTEGER — see stream-lifecycle.test.ts's "keeps the wraparound
  // reference bounded when rejected segments jump forward on an inactive flow". Every candidate
  // reaching this helper was itself computed via `unwrap(reference)` against the CURRENT
  // (pre-this-call) reference, which already guarantees it lands within half the modulus by
  // construction (RFC 1982 serial arithmetic); the half-modulus check below enforces that as an
  // invariant rather than trusting it implicitly.
  const advanceUnwrapReference = (candidate: number): void => {
    if (stream.offsetBits === null) return; // unwrap() never consults the reference for this stream
    if (entry.unwrapReference === null) {
      entry.unwrapReference = candidate;
      return;
    }
    const half = 2 ** (stream.offsetBits - 1);
    if (Math.abs(candidate - entry.unwrapReference) <= half) {
      entry.unwrapReference = Math.max(entry.unwrapReference, candidate);
    }
  };

  // Lifecycle updates happen BEFORE the inactive-status check below: a late RST/FIN (or a SYN
  // adopting a mid-stream flow) after the assembler has already gone terminal still needs to be
  // recorded — see the design's "Segments without open always go to the current generation,
  // including after it has closed" and this task's "keeps tracking lifecycle after the stream
  // goes inactive" test.
  if (open && !entry.opened) {
    entry.opened = true;
    entry.openOffset = offset;
    advanceUnwrapReference(offset); // an open that anchors the flow also anchors the reference
    // The open segment anchors the base even with an empty payload, with the same rebase rules
    // as `add` (allowed only while nothing has been consumed) — see StreamAssembler.anchor.
    if (entry.assembler.anchor(offset) === 'rebased') {
      entry.framingStalled = false;
      entry.stallMessage = null;
    }
  }
  // reset always wins, even over an already-'reset' entry
  if (reset) entry.closedBy = 'reset';
  else if (close && entry.closedBy === null) entry.closedBy = 'close';
  // Fix B (FIN-beyond-data gap): the highest offset any `close` signal has carried on this entry,
  // latched — never reset, never lowered by a smaller/later close. flushStreams compares it
  // against the reassembled data end to catch a FIN that closes the connection past the last byte
  // actually captured (see flushStreams's STREAM_GAP branch).
  if (close) entry.closeOffset = entry.closeOffset === null ? offset : Math.max(entry.closeOffset, offset);

  if (isControl) {
    // No payload bytes to fold into the assembler: record the control segment (so
    // stream_segments stays the complete packet-to-connection map) and stop — control segments
    // never reach the assembler and never contribute to message provenance.
    advanceUnwrapReference(offset);
    entry.segments.push({
      absOffset: offset,
      srcStart,
      srcEnd,
      feedKeyValue: keysByTable.get(stream.feedTable) ?? null,
    });
    return;
  }

  if (entry.status === 'truncated' || entry.status === 'error') return; // inactive: drop silently

  const outcome = entry.assembler.add(offset, payload.bytes, srcStart);
  const flow = `stream ${JSON.stringify(stream.name)} flow ${JSON.stringify(keyResult.key)}`;
  if (outcome.conflicted) {
    entry.conflictCount += 1;
    emitContext.issues?.report({
      stage: 'reassembling',
      code: 'STREAM_OVERLAP_CONFLICT',
      recoverable: true,
      message: `${flow}: retransmitted bytes at offset ${raw} differ from the first-arrived bytes (kept)`,
      sourceStart: srcStart,
      sourceEnd: srcEnd,
    });
  }
  if (outcome.trimmedBelowBase && !entry.belowBaseReported) {
    entry.belowBaseReported = true;
    emitContext.issues?.report({
      stage: 'reassembling',
      code: 'STREAM_BELOW_BASE',
      recoverable: true,
      message: `${flow}: bytes before the reassembled start arrived after framing began and were dropped`,
      sourceStart: srcStart,
      sourceEnd: srcEnd,
    });
  }
  if (outcome.status === 'duplicate' || outcome.status === 'conflict' || outcome.status === 'dropped') return;
  if (outcome.status === 'truncated') {
    entry.status = 'truncated';
    // See fallbackSpan's doc: this is the only way a flow entry can end up with no
    // stored segment span at flush — capture this (the first and only) contribution's real file
    // range now, since it will never be recorded as a stored segment.
    if (entry.assembler.segmentCount === 0) entry.fallbackSpan = { start: srcStart, end: srcEnd };
    emitContext.issues?.report({
      stage: 'reassembling',
      code: 'STREAM_TRUNCATED',
      recoverable: true,
      message: `${flow}: buffer exceeded max_buffer (${stream.maxBuffer})`,
      sourceStart: srcStart,
      sourceEnd: srcEnd,
    });
    return;
  }

  // outcome.status is 'added' or 'rebased': the only case that may advance the wraparound
  // reference (fix A) — an actually-accepted contribution, by the full extent it added.
  advanceUnwrapReference(offset + payload.bytes.length);
  if (outcome.status === 'rebased') {
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
  entry.dataSegmentCount += 1;

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
  // Piece collection: map messageStart/messageEnd (current-base-relative stream positions)
  // through EACH contributing segment's own linear offset <-> file-offset relationship and clip
  // to the part of that segment the message actually overlaps. Each clipped piece is kept (not
  // just folded into a min/max), because a reassembled message spanning more than one segment is
  // discontiguous in the source file — the covering span alone would silently claim bytes the
  // message never contains. `span` (min/max over the pieces) stays the row's _src_start/_src_end
  // exactly as before; `exact`/`inherited.ranges` gives the pieces themselves for _src_ranges,
  // collapsing to null when normalizeRanges finds at most one (single-segment/in-order case,
  // where the span alone is already exact). This is NOT simply first-segment-start/last-segment-
  // end ordered by stream position: under out-of-order capture a segment earlier in stream order
  // can sit at a LATER file offset than one after it (rebase reorders stream position without
  // reordering file position), which would otherwise yield an inverted span (start > end).
  // normalizeRanges sorts by file offset and merges touching/overlapping pieces, so it degrades
  // to the previous exact single-piece span when there is no reordering or gap.
  const boundary = entry.assembler.segmentsOverlapping(messageStart, messageEnd);
  const pieces: SourcePiece[] = boundary.map((s) => ({
    start: s.srcStart + Math.max(0, messageStart - s.start),
    end: s.srcStart + Math.min(s.end - s.start, messageEnd - s.start),
  }));
  const exact = normalizeRanges(pieces);
  let spanStart = Infinity;
  let spanEnd = -Infinity;
  for (const piece of pieces) {
    if (piece.start < spanStart) spanStart = piece.start;
    if (piece.end > spanEnd) spanEnd = piece.end;
  }
  const span: SourceRange = { start: spanStart, end: spanEnd };
  const inherited: InheritedProvenance = { span, ranges: toColumnRanges(exact) };

  const node = { offset: messageStart, length: messageEnd - messageStart };
  const context: ExpressionContext = { _: node, _root: node };

  // Every row projected for this message — its own messages[].table row and any deeper dissect
  // beneath it — must see the SAME exact provenance computed above, not recompute offsets
  // against span.start (meaningless once the span has gaps). emitContext.inherited carries that
  // down through projectChildTable/fireDissect for the duration of this message's rows only,
  // restored (to whatever a possibly-enclosing message already set, or null) once it is done.
  // Nesting would need a stream fed beneath a message, which compile rejects for bounded
  // tables — but restoring `previous` rather than hardcoding null keeps this correct regardless.
  const previous = emitContext.inherited ?? null;
  emitContext.inherited = inherited;
  try {
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
          ranges: inherited.ranges,
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
  } finally {
    emitContext.inherited = previous;
  }
};

// The flow row's provenance span: the min/max over every recorded segment (data AND control —
// entry.segments holds both, see contributeToStream) plus fallbackSpan (the rejected-truncated-
// first-contribution case, which never reaches entry.segments). Falls back to {0, 0} only when
// both are empty — unreachable in practice, since a flow entry is created at first contribution.
const flowSpan = (entry: StreamRuntimeEntry): SourceRange => {
  let start = Infinity;
  let end = -Infinity;
  for (const record of entry.segments) {
    if (record.srcStart < start) start = record.srcStart;
    if (record.srcEnd > end) end = record.srcEnd;
  }
  if (entry.fallbackSpan) {
    if (entry.fallbackSpan.start < start) start = entry.fallbackSpan.start;
    if (entry.fallbackSpan.end > end) end = entry.fallbackSpan.end;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { start: 0, end: 0 };
  return { start, end };
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
    // `ordered` (not `current`): a retired generation (Task 5) is dropped from `current` but
    // must still be flushed to its own final row.
    const entries = streams.ordered.get(stream.name);
    if (!entries) continue;
    const runtime = emitContext.runtimes.get(stream.flowTable.name)!;

    for (const entry of entries) {
      const span = flowSpan(entry);

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
        } else if (
          // Fix B (ROADMAP #5 review): a FIN beyond the reassembled data is a gap too, even
          // though the assembler itself sees no internal hole — the capture is simply missing
          // the tail. Compared in the same extended-offset space as everything else: the
          // assembler's base plus its contiguous fill, or the anchor base alone when no data was
          // ever accepted. Skipped (no data AND no anchor) when that space can't be computed at
          // all, which only happens for a close signal on a generation that never opened or
          // received any data.
          entry.closeOffset !== null &&
          entry.assembler.base !== null &&
          entry.closeOffset > entry.assembler.base + entry.assembler.contiguousEnd
        ) {
          entry.status = 'gap';
          emitContext.issues?.report({
            stage: 'reassembling',
            code: 'STREAM_GAP',
            recoverable: true,
            message: `stream ${JSON.stringify(stream.name)}: closed past the last byte actually reassembled`,
            sourceStart: span.start,
            sourceEnd: span.end,
          });
        }
      }

      const root: Record<string, unknown> = {
        ...entry.flowRoot,
        segment_count: entry.dataSegmentCount,
        byte_count: entry.assembler.byteCount,
        message_count: entry.messageCount,
        pending_bytes: entry.assembler.pendingBytes(),
        status: entry.status,
        opened: entry.opened,
        closed_by: entry.closedBy,
        generation: entry.generation,
        conflict_count: entry.conflictCount,
      };
      const provenance: ProvenanceResolver = { resolve: () => span };
      // Exact provenance for the flow row: every accepted contribution's own file range,
      // normalized (sorted, merged) the same way a message's pieces are. entry.segments holds
      // ACCEPTED contributions only (duplicates are never recorded — see its doc), so this can
      // never double-count a dropped retransmission. Null when at most one contribution landed,
      // same collapse rule as everywhere else _src_ranges is produced.
      const flowRanges = toColumnRanges(
        normalizeRanges(entry.segments.map((record) => ({ start: record.srcStart, end: record.srcEnd }))),
      );
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
          { _src_ranges: flowRanges },
          entry.streamId, // forcedKey: the streamId reserved eagerly at first contribution
        );
      }

      // Segment rows: emitted here, not at contribution time, because the assembler's base is
      // only final now — a contribution recorded early in the flow's life can still be rebased
      // by a later, out-of-order-earlier one (see StreamSegmentRecord doc). segment_id keys are
      // still assigned sequentially, arrival-ordered, from streams.segmentKeys.
      // A control-only flow (no data ever added, so the assembler was never anchored either) has
      // no assembler base at all: fall back to the minimum recorded absOffset among its segments
      // so its offsets are still base-relative instead of raw file-stream offsets. A plain loop,
      // not `Math.min(...spread)`: spreading tens of thousands of segments as call arguments
      // (an RST-storm/scan capture with no SYN can have 100k+ on one tuple) blows the call-stack
      // limit and would take the whole session down with it. `entry.segments` can be empty here
      // (the rejected-truncated-FIRST-contribution case — see fallbackSpan's doc), in which case
      // the loop below over `entry.segments` never runs, so 0 is a safe, inconsequential default.
      let finalBase = entry.assembler.base;
      if (finalBase === null) {
        let min = Infinity;
        for (const record of entry.segments) {
          if (record.absOffset < min) min = record.absOffset;
        }
        finalBase = Number.isFinite(min) ? min : 0;
      }
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
