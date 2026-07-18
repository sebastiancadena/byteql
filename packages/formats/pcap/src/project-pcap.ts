/**
 * End-to-end pcap projection: wires the framer (`parsePcapContainer`), the
 * dissect parser registry, and the bundled projection spec into one
 * `ParseResult`. One `ProjectionSession` spans the whole capture; each framed
 * packet is projected once, and the dissect cascade (eth → ip → l4 → app)
 * fans out into the child tables the spec declares.
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
  parseProjectionSpec,
  projectedTableToArrow,
  tableToIpc,
  type FinishedTable,
  type ParseProgress,
  type ParseResult,
  type ProvenanceResolver,
  type TableTransfer,
} from '@byteql/core';

import type { PcapPacket } from './container.js';
import { parsePcapContainer } from './container.js';
import { pcapParserRegistry } from './parsers.js';
import pcapQueries from './pcap-queries.generated.js';
import tablesYaml from './pcap-tables.generated.js';

const compiledProjection = compileProjection(parseProjectionSpec(tablesYaml), pcapParserRegistry);

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
  dns: new Set(['_src_start', '_src_end', 'query_name', 'query_type']),
  icmp: new Set(['_src_start', '_src_end', 'echo_id', 'echo_seq']),
  tls: new Set(['_src_start', '_src_end', 'sni']),
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

const toTransfer = (finished: FinishedTable): TableTransfer => {
  const nullableColumns = pcapNullability[finished.name] ?? new Set<string>();
  return {
    name: finished.name,
    ipc: tableToIpc(finished.arrow),
    rowCount: finished.rowCount,
    columns: finished.arrow.schema.fields.map((field) => ({
      name: field.name,
      type: field.type.toString(),
      nullable: nullableColumns.has(field.name),
    })),
  };
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return;
  signal.throwIfAborted();
  throw new DOMException('The operation was aborted.', 'AbortError');
};

const yieldToWorker = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function parseAndProjectPcap(
  bytes: Uint8Array,
  signal: AbortSignal,
  onProgress?: PcapProgressCallback,
): Promise<ParseResult> {
  throwIfAborted(signal);
  // An unrecognized magic throws here; Task 9 turns that into a fatal, errors-only result.
  const container = parsePcapContainer(bytes);

  const collector = new IssueCollector({ ordinalColumn: 'record' });
  for (const issue of container.issues) {
    collector.report({
      stage: 'framing',
      code: issue.code,
      message: issue.message,
      recoverable: true,
      sourceStart: issue.sourceStart,
      sourceEnd: issue.sourceEnd,
    });
  }

  const session = createProjectionSession(compiledProjection, { issues: collector });
  const total = container.packets.length;
  for (const packet of container.packets) {
    throwIfAborted(signal);
    // `packets` is the sole rootTable, so provenance is only ever asked for it at
    // the top level; dissected child tables use the engine's payload-extent
    // default. The closure supplies a total function anyway.
    const resolver: ProvenanceResolver = {
      resolve: (table) =>
        table === 'packets'
          ? { start: packet.recordStart, end: packet.bodyEnd }
          : { start: packet.body.start, end: packet.body.start + packet.body.bytes.length },
    };
    session.project(packetRoot(packet), resolver);
    await yieldToWorker();
    throwIfAborted(signal);
    onProgress?.({
      stage: 'projecting',
      completed: packet.index + 1,
      total,
      label: `Projected packet ${packet.index + 1} of ${total}`,
    });
  }

  throwIfAborted(signal);
  const errors = collector.table();
  const tables = [
    ...session.finish(),
    { name: errors.name, arrow: projectedTableToArrow(errors), rowCount: errors.rowCount },
  ].map(toTransfer);

  return {
    format: { id: 'pcap', title: 'PCAP capture' },
    tables,
    issues: collector.issues(),
    queries: pcapQueries,
    capabilities: {},
  };
}
