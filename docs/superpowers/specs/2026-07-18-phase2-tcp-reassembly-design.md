# TCP stream reassembly — Phase-2 engine capability design

Date: 2026-07-18
Status: approved design, pre-implementation

## Context

The pcap pack scoped TLS and DNS-over-TCP to "fits in one segment" (`wrappers.ts` guards; PRD Risks
names full reassembly a Phase-2+ engine feature). This slice builds that engine feature: a generic,
declarative **stream reassembly** capability in `@byteql/core`, and its first consumer — the pcap
pack's multi-segment TLS ClientHello and DNS-over-TCP dissection.

The engine today is strictly per-record: each packet is projected independently and dissect parsers
are pure functions of one payload's bytes. The only cross-record state is `ProjectionSession`'s
runtimes (monotonic keys, state registers). Reassembly is inherently cross-record, per-flow state —
so it becomes an engine concept, not pack machinery.

## Scope decisions (settled)

- **Placement: generic engine capability.** The projection spec gains a declarative `streams:`
  section, compile-time validated like `dissect:`; the two inherently-code pieces (flow-key
  extraction, message framing) are registered code hooks in the same registry pattern as parsers.
  (Rejected: a pack-local assembler — not reusable, abandons the declarative thesis; a fully
  declarative flow key — would force an `_up` ancestor-expression concept into the same slice.)
- **TCP correctness: standard forensic.** Out-of-order segments reordered by sequence number;
  exact-duplicate retransmissions dropped silently; a stream with an unfilled gap stops emitting
  past the gap. No partial-overlap reconciliation, no 32-bit sequence wraparound, no FIN/RST
  teardown semantics.
- **Provenance: coarse span + link table.** A reassembled row's `_src_start/_src_end` is the
  first-to-last span over its contributing segments; exact per-segment ranges live in a
  `stream_segments` link table the hex UI can join through. The single-range reserved-column
  contract is unchanged.
- **A first-class `streams` table**: one row per reassembled TCP flow direction (endpoints, counts,
  status), flushed at `finish()`.
- **Memory: cap + truncate.** Per-stream buffer cap (spec-declared, pcap default 1 MiB). On
  overflow the stream stops reassembling, is marked `truncated`, keeps already-emitted messages.

## Non-goals (still deferred)

- Partial-overlap reconciliation, sequence wraparound, FIN/RST teardown (4-tuple reuse within one
  capture merges into one stream — documented limitation).
- TLS handshake messages spanning multiple TLS **records** (multi-**segment** single-record now
  works; the single-record ClientHello assumption stays).
- Bidirectional stream pairing (each direction is its own stream/flow row).
- pcapng; HTTP or any new app-layer protocol.

## Design

### Spec surface (v0.3) and registries

Spec version bumps to `0.3`; `0.2` specs stay valid (no streams). Two additions:

**1. A dissect chain link may target a stream instead of a parser.** Guard machinery unchanged,
first match wins:

```yaml
dissect:
  - from: tcp_segment
    payload: _.body
    chain:
      - { when: _.dst_port == 443 or _.src_port == 443, stream: tls_stream }
      - { when: _.dst_port == 53 or _.src_port == 53, stream: dns_tcp_stream }
```

**2. A top-level `streams:` section**, one declaration per protocol (two declarations feeding the
same flow table is precedented — ipv4/ipv6 both feed `ip`):

```yaml
streams:
  - name: tls_stream
    key: tcp_flow_key          # registered key-extractor (code)
    offset: _.seq_num          # expression, evaluated in the feeding link's context
    framer: tls_record         # registered framer (code)
    table: streams             # flow rows, flushed at finish()
    segments_table: stream_segments   # engine-synthesized link table
    max_buffer: 1048576        # per-stream cap, bytes
    messages:                  # ordinary chain, fired once per framed message
      - { when: _.offset == 0, parser: tls_client_hello, table: tls }
```

`compileProjection` gains an optional third argument `{ keyExtractors, framers }`. Contracts:

- **Key extractor** — `(ctx: { node, ancestors }) => { key, root } | null`. `ancestors` is the
  stack of enclosing parse roots (new, cheap plumbing through `fireDissect`) — how a TCP-level link
  reaches the IP layer's addresses. `key` is the directional flow key
  (`"10.0.0.1:443→10.0.0.2:5555"`); `root` is flow metadata merged into the flow row's projection
  root (first contribution wins). `null` → segment skipped with an issue.
- **Framer** — `(buffer: Uint8Array) => number | null`. Byte length of the first complete message
  at position 0, or `null` if more data is needed. The engine loops it over the contiguous prefix.

**Message chain context**: `when` sees `{ offset, length }` (stream-relative), so TLS guards
`_.offset == 0` instead of framing-parsing every app-data record; the parser receives the framed
message bytes.

**Compile-time validation** extends the dissect rules: stream names must not collide with tables or
parsers; `table`/`segments_table` must be parent-key-free and are excluded from root tables (like
dissect-fed tables); message-chain tables follow the existing parent-key reachability rules; the
acyclicity check covers stream nodes.

### Engine runtime

**Contribution.** When a `stream:` link matches, the engine evaluates the link's payload as usual,
then evaluates `offset` in the same context, calls the key extractor with node + ancestor stack,
and appends `{ streamOffset, bytes, absoluteRange, keysSnapshot }` to the per-`(declaration, key)`
buffer. `keysSnapshot` is the current `keysByTable` — this is what makes parent keys work later
with zero new machinery. A new flow eagerly reserves the next `streams`-table key, so `stream_id`
exists from first contribution. Empty payloads (pure ACKs, SYN/FIN) contribute nothing.

**Ordering and dedup.** The first contribution's offset is the stream base; offsets become
base-relative. Contributions insert sorted by offset. Exact duplicates (same offset + length) drop
silently. A below-base segment or a partial overlap marks the stream `error` (one issue row,
reassembly stops, emitted messages kept). Cap overflow stops the stream with status `truncated`.

**Framing loop.** After each contribution, run the framer over the unconsumed contiguous prefix:
while it returns a length, cut the message, advance the consumed watermark, fire the `messages`
chain. A framer throw or a non-positive/over-cap length marks the stream `error`.

**Message emission.** Framed messages run the ordinary chain-link path (`projectChildTable`) with
two twists: the parent-key context is the **completing contribution's** `keysSnapshot` — the packet
whose arrival allowed framing, matching Wireshark's "reassembled in frame N" (including the
out-of-order case where an earlier-offset segment completes) — and the engine injects a `stream_id`
int64 column into every message-fed table (same mechanism as the `parent_key` column injection).
`dns` is also fed from the UDP path, so `stream_id` is null on UDP rows.

**Provenance.** Each contribution's absolute file range is kept, so a message spanning `[s, e)` in
stream space maps back to exact per-segment ranges. The message row's `_src_start/_src_end` is the
coarse first-to-last span over its contributing segments; for a single-segment message this
degenerates to the exact range (existing single-segment expectations stay meaningful).

**Link table.** One row per contributed segment, emitted at contribution time into the
engine-synthesized `segments_table`: `{ segment_id, stream_id, <feed-table>_id (e.g. tcp_id),
offset, _src_start, _src_end }`. The hex UI joins through it for precise multi-range highlighting.

**Flush.** `finish()` first flushes one flow row per stream into the declared `table`, projected
from a synthetic root: the key extractor's metadata plus engine counters — `segment_count`,
`byte_count`, `message_count`, `pending_bytes` (contiguous-but-unframed remainder, e.g. capture cut
mid-message), and `status` (`ok` | `gap` | `truncated` | `error`; `gap` = a discontiguity that
never filled). Flow rows use the eagerly-reserved keys; their `_src_*` is the flow's coarse span.
Then the existing finish path runs.

### pcap pack changes

- **`pcap.tables.yaml`**: the two single-segment `from: tcp_segment` chain links are **replaced**
  by the stream links above — single-segment is the degenerate case (first contribution frames
  immediately), so the old path would be dead code. Two stream declarations (`tls_stream`,
  `dns_tcp_stream`) share the flow table. Two new tables: `streams` (`stream_id` key; `src_addr`,
  `src_port`, `dst_addr`, `dst_port`, `segment_count`, `byte_count`, `message_count`,
  `pending_bytes`, `status` — plain expressions over the synthetic flow root) and `stream_segments`
  (engine-synthesized schema, only named in the stream declarations).
- **Code hooks** (new `src/streams.ts`, registered beside the parser registry):
  - `tcpFlowKey`: walks `ancestors` to the IP-layer root (the node with `is_v4`), formats
    addresses with the same helpers the expression functions use, returns the directional key plus
    `{ src_addr, src_port, dst_addr, dst_port }`. Null if no IP ancestor.
  - `tlsRecord`: reads the 5-byte record header → `5 + length`; throws on impossible record
    types/lengths (→ stream `error`).
  - `dnsTcp`: reads the 2-byte prefix → `2 + length`; throws on a zero-length prefix.
- **Reused wrappers**: `tlsClientHello` unchanged as the message parser; `dnsTcpMessage` reused —
  its "declared length doesn't fit" guard becomes unreachable (the framer guarantees completeness)
  and stays as a defensive check with the comment updated.
- **Plumbing**: `parsers.ts` grows the two extra registries; `pcapNullability` gains `streams`,
  `stream_segments`, and nullable `stream_id` on `tls`/`dns`; `queries.yaml` gains one flow
  overview query. The tls(443)-before-dns(53) first-match quirk carries over identically; still no
  fix warranted.

## Error handling

New issue codes, all `recoverable: true`, through the existing `IssueCollector`, each with a source
range so the errors table stays hex-navigable:

- `STREAM_KEY_INVALID` — key extractor returned null or threw; segment not contributed.
- `STREAM_GAP` — reported once at `finish()` for a discontiguity that never filled.
- `STREAM_TRUNCATED` — cap exceeded; reported once at overflow.
- `STREAM_ERROR` — below-base segment, partial overlap, or framer failure; reported once.
- Message parsers that throw keep using `DISSECT_PARSE_FAILED` with the message's coarse span.

Silent by design (not errors): exact-duplicate retransmissions, empty payloads, trailing incomplete
messages (surfaced as `pending_bytes`).

## Testing

**Engine (`core`, TDD like the dissect suite):**

- Compile-time: name collisions, `parent_key` on a stream table, unknown framer/extractor, cycle
  detection through stream nodes.
- Runtime, against a tiny synthetic spec + fixed-length framer: in-order and out-of-order assembly;
  dedup; gap-at-finish; partial overlap → `error`; cap → `truncated`; framing loop cutting multiple
  messages from one contribution; completion attribution (message parented to the completing
  packet's snapshot, including the out-of-order case where an earlier segment completes);
  `stream_id` injection and nullness on non-stream rows; link-table rows; eager key reservation
  matching flushed flow rows; provenance spans (multi-segment coarse span, single-segment exact
  range).

**Pack (hand-built fixtures in the existing `build-pcap.ts` style):**

- DNS-over-TCP response split across two segments.
- TLS ClientHello split across three segments arriving out of order.
- A retransmitted (duplicate) segment; a gap stream.
- The e2e open-and-query test extended to assert a `streams` row and a reassembled `dns` row with
  its `stream_segments` join.
- **Regression guard**: existing single-segment fixtures keep passing with unchanged row values —
  proof the replacement path is equivalent.

Full-suite: existing pcap tests, MIDI suite, `pnpm -r check`, `check:bundle`, e2e stay green.

## Risks & notes

- **Biggest engine change since Phase 1a.** The mitigations are the registry pattern (code hooks
  mirror parsers exactly) and reuse of existing machinery: chain links for `messages`, `keysByTable`
  snapshots for attribution, `projectChildTable` for emission, parent-key column injection for
  `stream_id`.
- **Eager key reservation** means the `streams` table runtime assigns keys at first contribution
  and `finish()` must emit flow rows under those specific keys (not auto-increment order) — an
  engine-internal detail to get right, covered by a dedicated test.
- **Ancestor-stack plumbing** through `fireDissect` is new but cheap (push/pop per level); it is
  exposed only to key extractors, deliberately not to spec expressions (no `_up` this slice).
- **Provenance of single-segment messages** may shift slightly for TLS (previously the whole tcp
  payload extent; now the framed record `[0, 5 + len)`) — typically identical bytes; the dns path
  is unchanged (framed message = full payload). Any test churn is confined to `tls` `_src_*`.
- **Port-reuse merging** (no FIN/RST teardown) and **wraparound streams** degrade to `gap`/`error`
  status rather than corrupting output — graceful, visible in the `streams` table.
