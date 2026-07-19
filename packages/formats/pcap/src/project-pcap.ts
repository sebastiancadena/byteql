/**
 * End-to-end pcap projection: wires the incremental framer (`createPcapFramer`), the
 * dissect parser registry, and the bundled projection spec into a pull-driven
 * `RecordSource`. One `ProjectionSession` spans the whole capture; each framed packet is
 * projected once, and the dissect cascade (eth → ip → l4 → app) fans out into the child
 * tables the spec declares.
 *
 * `openPcapSource` pumps the framer + session incrementally: it frames and projects
 * packets until either `flushRowThreshold` pending rows have accumulated (draining early
 * via `session.drain()`) or the framer reaches EOF (finishing via `session.finish()`,
 * which also flushes streams). Each pump emits zero or more `BatchTransfer`s per call,
 * so a single table can arrive across many `nextBatch()` calls — callers (the worker, or
 * `parseAndProjectPcap` below) are responsible for merging same-named batches back
 * together if they need one logical table.
 *
 * The projection root MUST use the snake_case field names the spec's `packets`
 * columns reference (`ts_sec`, `ts_frac_us`, `incl_len`, `orig_len`), NOT the
 * camelCase names the framer emits (`tsSec`, `tsFracUs`, ...). `compileProjection`
 * does not validate field names against data, so a mismatch silently yields NULL
 * columns — hence the explicit remap below.
 */

import {
  IssueCollector,
  compileProjection,
  createProjectionSession,
  ipcToTable,
  memoryByteSource,
  parseProjectionSpec,
  projectedTableToArrow,
  tableToIpc,
  type BatchTransfer,
  type ByteSource,
  type FinishedTable,
  type OpenOptions,
  type ParseProgress,
  type ParseResult,
  type ProvenanceResolver,
  type RecordSource,
  type SourceFinish,
  type TableTransfer,
} from '@byteql/core';
import { Table } from 'apache-arrow';

import type { PcapFramer, PcapPacket } from './container.js';
import { createPcapFramer } from './container.js';
import { pcapParserRegistry } from './parsers.js';
import pcapQueries from './pcap-queries.generated.js';
import tablesYaml from './pcap-tables.generated.js';
import { pcapStreamRegistries } from './streams.js';

const compiledProjection = compileProjection(
  parseProjectionSpec(tablesYaml),
  pcapParserRegistry,
  pcapStreamRegistries,
);

export type PcapProgressCallback = (progress: ParseProgress) => void;

/**
 * Columns projected as nullable: automatic provenance (`_src_*`) plus the
 * version-specific and optional dissect columns that are absent for many packets
 * (e.g. `sni` only exists on a TLS ClientHello, `query_name` only on a DNS query).
 */
export const pcapNullability: Readonly<Record<string, ReadonlySet<string>>> = {
  packets: new Set(['_src_start', '_src_end']),
  ip: new Set(['_src_start', '_src_end', 'hop_limit']),
  tcp: new Set(['_src_start', '_src_end']),
  udp: new Set(['_src_start', '_src_end']),
  dns: new Set(['_src_start', '_src_end', 'query_name', 'query_type', 'stream_id']),
  icmp: new Set(['_src_start', '_src_end', 'echo_id', 'echo_seq']),
  icmpv6: new Set(['_src_start', '_src_end', 'echo_id', 'echo_seq']),
  tls: new Set(['_src_start', '_src_end', 'sni', 'stream_id']),
  streams: new Set(['_src_start', '_src_end']),
  stream_segments: new Set(['_src_start', '_src_end', 'tcp_id']),
  errors: new Set(['record', '_src_start', '_src_end']),
};

/** The snake_case projection root the spec's `packets` columns read from. */
const packetRoot = (packet: PcapPacket) => ({
  ts_sec: packet.tsSec,
  ts_frac_us: packet.tsFracUs,
  incl_len: packet.inclLen,
  orig_len: packet.origLen,
  linktype: packet.linktype,
  body: packet.body,
});

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return;
  signal.throwIfAborted();
  throw new DOMException('The operation was aborted.', 'AbortError');
};

const yieldToWorker = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Formats a byte count in MB with two decimal places, for progress labels. */
const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(2);

/** Maps finished tables to wire batches, always sizing `rowCount` off `arrow.numRows` —
 * the only value that is correct for both a `drain()` batch (where it already equals
 * `rowCount`) and a `finish()` residual (where `FinishedTable.rowCount` is cumulative
 * across the whole session and would overcount). */
const toBatches = (finished: readonly FinishedTable[]): BatchTransfer[] =>
  finished.map((table) => ({
    table: table.name,
    ipc: tableToIpc(table.arrow),
    rowCount: table.arrow.numRows,
  }));

export interface PcapOpenTuning {
  /** Bytes per chunk the framer reads from `source`; forwarded to `createPcapFramer`. */
  chunkBytes?: number;
  /** Total pending rows (across all tables) that triggers an early `session.drain()`. */
  flushRowThreshold?: number;
}

/**
 * Pull-driven pcap `RecordSource`: frames and projects packets incrementally, draining
 * the session early whenever `flushRowThreshold` pending rows accumulate and finishing
 * it (flushing streams, sealing the errors table) once the framer is exhausted. `tuning`
 * is exposed for tests only — `pcapFormatPack.open` uses the defaults.
 */
export function openPcapSource(
  source: ByteSource,
  opts: OpenOptions,
  tuning: PcapOpenTuning = {},
): RecordSource {
  const threshold = tuning.flushRowThreshold ?? 65_536;

  let framer: PcapFramer | null = null;
  let collector: IssueCollector | null = null;
  let session: ReturnType<typeof createProjectionSession> | null = null;
  let pending: BatchTransfer[] = [];
  let tailEmitted = false;
  let drained = false;
  let failed = false;
  let failure: unknown;

  const ensureStarted = async (): Promise<{
    framer: PcapFramer;
    session: ReturnType<typeof createProjectionSession>;
    collector: IssueCollector;
  }> => {
    if (framer && session && collector) return { framer, session, collector };
    // An unrecognized magic throws here; Task 9 turns that into a fatal, errors-only result.
    framer = await createPcapFramer(source, tuning.chunkBytes);
    collector = new IssueCollector({ ordinalColumn: 'record' });
    session = createProjectionSession(compiledProjection, {
      issues: collector,
      flushRowThreshold: threshold,
    });
    return { framer, session, collector };
  };

  const reportProgress = (currentFramer: PcapFramer): void => {
    const completed = currentFramer.bytesConsumed();
    opts.onProgress?.({
      stage: 'projecting',
      completed,
      total: source.size,
      label: `${mb(completed)} of ${mb(source.size)} MB`,
    });
  };

  /** Frames + projects packets until enough rows have accumulated to drain, or EOF. */
  const pump = async (): Promise<void> => {
    const state = await ensureStarted();
    for (;;) {
      throwIfAborted(opts.signal);
      const packet = await state.framer.next();
      if (packet === null) {
        // Seed framing issues before materializing the errors table.
        for (const issue of state.framer.issues()) {
          state.collector.report({
            stage: 'framing',
            code: issue.code,
            message: issue.message,
            recoverable: true,
            sourceStart: issue.sourceStart,
            sourceEnd: issue.sourceEnd,
          });
        }
        // session.finish() must run before collector.table(): finish() -> flushStreams is
        // where flush-time stream issues (STREAM_GAP, stall STREAM_ERROR) are reported, and
        // the errors table has to include them.
        const finished = state.session.finish();
        const errors = state.collector.table();
        const errorsFinished: FinishedTable = {
          name: errors.name,
          arrow: projectedTableToArrow(errors),
          rowCount: errors.rowCount,
        };
        // Residual tables with no rows simply never appear as a batch (downstream
        // consumers read empty-table schemas from `pack.schemas()`); the errors table is
        // always emitted, even with zero rows, so it materializes for every capture.
        const residual = finished.filter((table) => table.arrow.numRows > 0);
        pending = [...toBatches(residual), ...toBatches([errorsFinished])];
        tailEmitted = true;
        reportProgress(state.framer);
        return;
      }

      // `packets` is the sole rootTable, so provenance is only ever asked for it at
      // the top level; dissected child tables use the engine's payload-extent
      // default. The closure supplies a total function anyway.
      const resolver: ProvenanceResolver = {
        resolve: (table) =>
          table === 'packets'
            ? { start: packet.recordStart, end: packet.bodyEnd }
            : { start: packet.body.start, end: packet.body.start + packet.body.bytes.length },
      };
      state.session.project(packetRoot(packet), resolver);
      await yieldToWorker();
      throwIfAborted(opts.signal);
      reportProgress(state.framer);

      if (state.session.pendingRowCount() >= threshold) {
        pending = toBatches(state.session.drain());
        return;
      }
    }
  };

  return {
    async nextBatch(): Promise<BatchTransfer | null> {
      if (failed) throw failure;
      try {
        while (pending.length === 0 && !tailEmitted) await pump();
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      }
      const next = pending.shift();
      if (next) return next;
      drained = true;
      return null;
    },
    finish(): SourceFinish {
      if (failed) throw failure;
      if (!drained) {
        throw new Error('RECORD_SOURCE_NOT_DRAINED: call nextBatch() until null before finish()');
      }
      return { issues: collector?.issues() ?? [], capabilities: {} };
    },
  };
}

const toTransfer = (name: string, arrow: Table, rowCount: number): TableTransfer => {
  const nullableColumns = pcapNullability[name] ?? new Set<string>();
  return {
    name,
    ipc: tableToIpc(arrow),
    rowCount,
    columns: arrow.schema.fields.map((field) => ({
      name: field.name,
      type: field.type.toString(),
      nullable: nullableColumns.has(field.name),
    })),
  };
};

/**
 * Every compiled table (plus stream segment tables and `errors`) as an empty Arrow
 * table with the right schema — computed via a throwaway session that never projects
 * anything. `openPcapSource` never emits a batch for a table that stayed empty for the
 * whole capture (see the tail-filtering note above), so `parseAndProjectPcap` uses this
 * to backfill zero-row entries for those tables, matching the pre-Task-5 one-shot output.
 */
const emptyProjectionTables = (): Map<string, Table> => {
  const collector = new IssueCollector({ ordinalColumn: 'record' });
  const session = createProjectionSession(compiledProjection, { issues: collector });
  const finished = session.finish();
  const errors = collector.table();
  const map = new Map(finished.map((table) => [table.name, table.arrow]));
  map.set(errors.name, projectedTableToArrow(errors));
  return map;
};

/**
 * Drains an incremental pcap `RecordSource` and merges same-named batches into one
 * `ParseResult`, byte-identical to the pre-Task-5 one-shot projection: every compiled
 * table appears exactly once, including tables that never accumulated a row (backfilled
 * as empty tables) — this is what lets the existing regression suite keep asserting
 * one-shot table values unchanged.
 *
 * @internal test helper
 */
export async function parseAndProjectPcap(
  bytes: Uint8Array,
  signal: AbortSignal,
  onProgress?: PcapProgressCallback,
): Promise<ParseResult> {
  const opts: OpenOptions = onProgress === undefined ? { signal } : { signal, onProgress };
  const source = openPcapSource(memoryByteSource(bytes), opts);

  const batches: BatchTransfer[] = [];
  for (let batch = await source.nextBatch(); batch !== null; batch = await source.nextBatch()) {
    batches.push(batch);
  }
  const finish = source.finish();

  const byTable = new Map<string, BatchTransfer[]>();
  for (const batch of batches) {
    const parts = byTable.get(batch.table) ?? [];
    parts.push(batch);
    byTable.set(batch.table, parts);
  }

  const tables: TableTransfer[] = [...byTable.entries()].map(([name, parts]) => {
    const arrow =
      parts.length === 1
        ? ipcToTable(parts[0]!.ipc)
        : new Table(parts.flatMap((part) => ipcToTable(part.ipc).batches));
    const rowCount = parts.reduce((sum, part) => sum + part.rowCount, 0);
    return toTransfer(name, arrow, rowCount);
  });

  for (const [name, arrow] of emptyProjectionTables()) {
    if (byTable.has(name)) continue;
    tables.push(toTransfer(name, arrow, 0));
  }

  return {
    format: { id: 'pcap', title: 'PCAP capture' },
    tables,
    issues: finish.issues,
    queries: pcapQueries,
    capabilities: finish.capabilities,
  };
}
