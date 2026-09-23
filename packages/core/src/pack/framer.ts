import type { AnchorMatch } from '../projection/anchors.js';
import type { SourceRange } from '../projection/project.js';
import type { ByteSource, FormatCapability, ParseProgress } from '../protocol.js';

export interface FramerIssue {
  stage?: string; // default 'framing'
  code: string;
  message: string;
  recoverable?: boolean; // default true
  ordinal?: number | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
}

export interface FramedRecord {
  root: object;
  provenance: SourceRange | ((table: string, match: AnchorMatch) => SourceRange);
  tables?: readonly string[];
  ordinal?: number;
  /** Map a projection throw for this record to an issue; default PROJECTION_FAILED. */
  onError?: (error: unknown) => FramerIssue;
}

export interface FramerContext {
  readonly signal: AbortSignal;
  readonly chunkBytes: number | undefined; // tuning passthrough (pcap)
  report(issue: FramerIssue): void;
  progress(progress: ParseProgress): void; // forwarded immediately
  bytes(consumed: number): void; // byte progress, emitted at yield cadence + at end
}

export interface FramerSummary {
  capabilities?: Readonly<Record<string, FormatCapability>>;
}

export type Framer = (
  source: ByteSource,
  ctx: FramerContext,
) => AsyncGenerator<FramedRecord, FramerSummary | void, undefined>;

/** The one fatal path: input the container cannot read at all (bad magic after probing). */
export class PackFatalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PackFatalError';
  }
}

export interface DriverTuning {
  chunkBytes?: number;
  flushRowThreshold?: number;
  yieldInterval?: number;
}

export interface DriverOptions extends DriverTuning {
  ordinalColumn: string;
  strictFields?: boolean;
}
