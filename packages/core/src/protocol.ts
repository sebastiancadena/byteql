export interface TableColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TableTransfer {
  name: string;
  ipc: Uint8Array;
  rowCount: number;
  columns: readonly TableColumn[];
}

export interface TableSchema {
  name: string;
  columns: readonly TableColumn[];
}

export interface ParseIssue {
  /** Well-known values: 'framing', 'normalizing', 'parsing', 'projecting', 'dissecting'. */
  stage: string;
  track: number | null;
  code: string;
  message: string;
  recoverable: boolean;
  sourceStart: number | null;
  sourceEnd: number | null;
}

export interface PackQuery {
  id: string;
  title: string;
  kind: 'grid' | 'playback';
  sql: string;
}

export interface FormatCapability {
  enabled: boolean;
  reason: string | null;
}

export interface ParseResult {
  format: { id: string; title: string };
  tables: readonly TableTransfer[];
  issues: readonly ParseIssue[];
  queries: readonly PackQuery[];
  capabilities: Readonly<Record<string, FormatCapability>>;
}

export interface ParseProgress {
  stage: string;
  completed: number;
  total: number;
  label: string;
}

export interface OpenOptions {
  signal: AbortSignal;
  onProgress?: (progress: ParseProgress) => void;
}

export interface BatchTransfer {
  table: string;
  ipc: Uint8Array;
  rowCount: number;
}

export interface SourceFinish {
  issues: readonly ParseIssue[];
  capabilities: Readonly<Record<string, FormatCapability>>;
}

export interface RecordSource {
  nextBatch(): Promise<BatchTransfer | null>;
  finish(): SourceFinish; // only valid after nextBatch() returned null
}

export interface FormatPack {
  readonly id: string;
  readonly title: string;
  probe(head: Uint8Array): number | null; // sniff confidence 0..1
  schemas(): readonly TableSchema[];
  open(bytes: Uint8Array, opts: OpenOptions): RecordSource;
  readonly queries: readonly PackQuery[];
}
