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

export interface ParseResult {
  format: { id: 'standard_midi_file'; title: 'Standard MIDI file' };
  tables: readonly TableTransfer[];
  issues: readonly ParseIssue[];
  capabilities: { audio: { enabled: boolean; reason: string | null } };
}
