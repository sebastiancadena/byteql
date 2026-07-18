export interface TableTransfer {
  name: string;
  ipc: Uint8Array;
  rowCount: number;
  columns: readonly { name: string; type: string; nullable: boolean }[];
}

export interface ParseIssue {
  stage: 'framing' | 'normalizing' | 'parsing' | 'projecting';
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
