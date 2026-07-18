import type { AnchorMatch } from './anchors.js';
import type { SourceRange } from './project.js';

export interface ParsedRecord {
  root: unknown;
  resolve?: (table: string, match: AnchorMatch) => SourceRange; // payload-relative offsets
}

export type RecordParser = (bytes: Uint8Array) => ParsedRecord;

export type ParserRegistry = ReadonlyMap<string, RecordParser>;
