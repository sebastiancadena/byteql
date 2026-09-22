import type { RowProvenance } from '../hex/coverage.js';

export interface SourceRange {
  file: string;
  start: number;
  /** Exclusive, as everywhere else in the engine. Only the display subtracts one. */
  end: number;
}

export type TraceSummary =
  | { kind: 'empty' | 'unselected' | 'outside-window' | 'unlinked' | 'unavailable'; message: string }
  | { kind: 'linked'; row: number; range: SourceRange; label: string };

export interface TraceInput {
  hasResult: boolean;
  selectedGlobalRow: number | null;
  /** Null when the selected global row sits outside the decoded window. */
  selectedLocalRow: number | null;
  provenance: RowProvenance | null;
  files: readonly { name: string; size: number }[];
}

/**
 * The one place a byte range becomes text. Ranges stay end-exclusive internally; the label
 * shows the last included byte, so `[12, 20)` reads as `0x0000000c–0x00000013`.
 * Returns null for anything that cannot describe real bytes.
 */
export function formatByteRange(start: number, end: number): string | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
  const hex = (n: number): string => `0x${n.toString(16).padStart(8, '0')}`;
  return `${hex(start)}–${hex(end - 1)} · ${end - start} bytes`;
}

/**
 * Turns the current selection into exactly one honest statement. A row is only "linked" when a
 * known source file actually contains the range: an aggregate, a row outside the loaded window
 * and a missing file each get their own message rather than a borrowed or invented range.
 */
export function buildTraceSummary(input: TraceInput): TraceSummary {
  if (!input.hasResult) return { kind: 'empty', message: 'Run a query to inspect source bytes.' };
  if (input.selectedGlobalRow === null) {
    return { kind: 'unselected', message: 'Select a row to trace its source bytes.' };
  }
  if (input.selectedLocalRow === null) {
    return { kind: 'outside-window', message: 'Selected row is outside the loaded window.' };
  }
  if (!input.provenance) return { kind: 'unlinked', message: 'This row has no source byte range.' };

  const range = input.provenance;
  const file = input.files.find((candidate) => candidate.name === range.file);
  const boundingLabel = formatByteRange(range.start, range.end);
  if (!file || !boundingLabel || range.end > file.size) {
    return { kind: 'unavailable', message: 'Source bytes are unavailable for this row.' };
  }
  const label = range.ranges.length > 1 ? `${boundingLabel} · ${range.ranges.length} ranges` : boundingLabel;
  return {
    kind: 'linked',
    row: input.selectedGlobalRow + 1,
    range: { file: range.file, start: range.start, end: range.end },
    label,
  };
}
