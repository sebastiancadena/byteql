import type {
  BatchTransfer,
  FormatPack,
  OpenOptions,
  ParseResult,
  RecordSource,
  SourceFinish,
  TableColumn,
  TableSchema,
} from '@byteql/core';

import pcapQueries from './pcap-queries.generated.js';
import { parseAndProjectPcap, pcapNullability } from './project-pcap.js';

const column = (table: string, name: string, type: string): TableColumn => ({
  name,
  type,
  nullable: (pcapNullability[table] ?? new Set<string>()).has(name),
});

const columns = (table: string, entries: readonly (readonly [string, string])[]): TableSchema => ({
  name: table,
  columns: entries.map(([name, type]) => column(table, name, type)),
});

// Column order mirrors the projection engine's output: key, parent key (when the table
// declares parent_key), spec columns in pcap.tables.yaml order, then provenance.
const PCAP_TABLE_SCHEMAS: readonly TableSchema[] = [
  columns('packets', [
    ['packet_id', 'int64'],
    ['ts', 'timestamp_us'],
    ['caplen', 'uint32'],
    ['len', 'uint32'],
    ['linktype', 'uint32'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('ip', [
    ['ip_id', 'int64'],
    ['packet_id', 'int64'],
    ['version', 'int8'],
    ['src_addr', 'utf8'],
    ['dst_addr', 'utf8'],
    ['proto', 'int16'],
    ['hop_limit', 'int16'],
    ['length', 'uint32'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('tcp', [
    ['tcp_id', 'int64'],
    ['packet_id', 'int64'],
    ['src_port', 'uint16'],
    ['dst_port', 'uint16'],
    ['seq', 'int64'],
    ['ack', 'int64'],
    ['flags', 'utf8'],
    ['window', 'uint16'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('udp', [
    ['udp_id', 'int64'],
    ['packet_id', 'int64'],
    ['src_port', 'uint16'],
    ['dst_port', 'uint16'],
    ['length', 'uint16'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('dns', [
    ['dns_id', 'int64'],
    ['packet_id', 'int64'],
    ['tx_id', 'uint16'],
    ['qr', 'int8'],
    ['query_name', 'utf8'],
    ['query_type', 'int16'],
    ['qd_count', 'uint16'],
    ['an_count', 'uint16'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('icmp', [
    ['icmp_id', 'int64'],
    ['packet_id', 'int64'],
    ['type', 'int16'],
    ['echo_id', 'uint16'],
    ['echo_seq', 'uint16'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('icmpv6', [
    ['icmpv6_id', 'int64'],
    ['packet_id', 'int64'],
    ['type', 'int16'],
    ['code', 'int16'],
    ['echo_id', 'uint16'],
    ['echo_seq', 'uint16'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('tls', [
    ['tls_id', 'int64'],
    ['packet_id', 'int64'],
    ['tls_version', 'utf8'],
    ['sni', 'utf8'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
  columns('errors', [
    ['error_id', 'int64'],
    ['stage', 'utf8'],
    ['record', 'int32'],
    ['code', 'utf8'],
    ['message', 'utf8'],
    ['recoverable', 'bool'],
    ['_src_start', 'uint64'],
    ['_src_end', 'uint64'],
  ]),
];

// (`type` strings are the spec's `ArrowTypeName` values — informational at this boundary; the
// worker derives display types from the real Arrow schema.)

// The four pcap magic numbers, one per (byte order, timestamp resolution) combination.
const PCAP_MAGICS: readonly (readonly [number, number, number, number])[] = [
  [0xa1, 0xb2, 0xc3, 0xd4], // big-endian, microsecond timestamps
  [0xa1, 0xb2, 0x3c, 0x4d], // big-endian, nanosecond timestamps
  [0xd4, 0xc3, 0xb2, 0xa1], // little-endian, microsecond timestamps
  [0x4d, 0x3c, 0xb2, 0xa1], // little-endian, nanosecond timestamps
];

const matchesMagic = (head: Uint8Array, magic: readonly [number, number, number, number]): boolean =>
  head[0] === magic[0] && head[1] === magic[1] && head[2] === magic[2] && head[3] === magic[3];

export const pcapFormatPack: FormatPack = {
  id: 'pcap',
  title: 'PCAP capture',
  probe: (head) =>
    head.byteLength >= 4 && PCAP_MAGICS.some((magic) => matchesMagic(head, magic)) ? 1 : null,
  schemas: () => PCAP_TABLE_SCHEMAS,
  queries: pcapQueries,
  open(bytes: Uint8Array, opts: OpenOptions): RecordSource {
    let parsed: Promise<ParseResult> | null = null;
    let cursor = 0;
    let result: ParseResult | null = null;
    let drained = false;
    let failure: unknown;
    let failed = false;
    return {
      async nextBatch(): Promise<BatchTransfer | null> {
        parsed ??= parseAndProjectPcap(bytes, opts.signal, opts.onProgress).catch((error: unknown) => {
          failed = true;
          failure = error;
          throw error;
        });
        result ??= await parsed;
        if (cursor >= result.tables.length) {
          drained = true;
          return null;
        }
        const table = result.tables[cursor]!;
        cursor += 1;
        return { table: table.name, ipc: table.ipc, rowCount: table.rowCount };
      },
      finish(): SourceFinish {
        if (failed) throw failure;
        if (!drained || !result)
          throw new Error('RECORD_SOURCE_NOT_DRAINED: call nextBatch() until null before finish()');
        return { issues: result.issues, capabilities: result.capabilities };
      },
    };
  },
};
