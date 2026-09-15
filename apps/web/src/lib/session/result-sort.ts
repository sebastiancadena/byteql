import type { ResultSort } from '@byteql/db';
import type { Schema } from 'apache-arrow';

import type { SessionState } from './state.js';

const assertColumnIndex = (columnIndex: number): void => {
  if (!Number.isSafeInteger(columnIndex) || columnIndex < 0) {
    throw new RangeError(`Sort column index must be a non-negative safe integer: ${String(columnIndex)}.`);
  }
};

/**
 * The ascending → descending → original-order cycle, addressed by ORIGINAL schema index.
 *
 * Activating a different column always starts that column ascending rather than carrying the
 * previous column's direction across.
 */
export function nextResultSort(current: ResultSort | null, columnIndex: number): ResultSort | null {
  assertColumnIndex(columnIndex);
  if (!current || current.columnIndex !== columnIndex) return { columnIndex, direction: 'asc' };
  return current.direction === 'asc' ? { columnIndex, direction: 'desc' } : null;
}

/** Names a field for a control label, adding its position only when the name is ambiguous. */
export const fieldLabel = (schema: Schema, columnIndex: number): string => {
  const field = schema.fields[columnIndex];
  if (!field) return `column ${columnIndex + 1}`;
  const duplicated = schema.fields.filter((other) => other.name === field.name).length > 1;
  return duplicated ? `${field.name}, column ${columnIndex + 1},` : field.name;
};

/** Describes what activating a header will DO, not what it currently shows. */
export function sortActionLabel(schema: Schema, current: ResultSort | null, columnIndex: number): string {
  const next = nextResultSort(current, columnIndex);
  if (next === null) return 'Restore query order';
  return `Sort ${fieldLabel(schema, columnIndex)} ${next.direction === 'asc' ? 'ascending' : 'descending'}`;
}

/**
 * Whether two schemas describe the same result.
 *
 * Compared structurally rather than by object identity: a cursor-backed result replaces its schema
 * object as pages arrive, so identity would report a change where none happened, while a real
 * change of field count, name, position or type is what actually matters.
 */
export function sameResultSchema(left: Schema, right: Schema): boolean {
  if (left === right) return true;
  if (left.fields.length !== right.fields.length) return false;
  return left.fields.every((field, index) => {
    const other = right.fields[index]!;
    return field.name === other.name && field.type.toString() === other.type.toString();
  });
}

/** Whether a sort is genuinely in flight. A failed operation is over, not running. */
export function isResultSorting(state: SessionState): boolean {
  return state.sorting !== null && state.sorting.phase !== 'failed';
}

/**
 * Download phases that still own the result and must finish before it is reordered.
 *
 * A prepared-but-unsaved file is deliberately absent: it describes the previous order, so a new
 * sort releases it rather than waiting for the reader to deal with it first.
 */
const ACTIVE_DOWNLOAD_PHASES = new Set(['picking', 'loading', 'encoding', 'saving', 'cancelling']);

/** Whether a download still owns the result, as opposed to having left a file behind. */
export function hasActiveDownload(state: SessionState): boolean {
  return state.download !== null && ACTIVE_DOWNLOAD_PHASES.has(state.download.phase);
}

/**
 * Whether sort controls must ignore activation right now, for reasons that have nothing to do with
 * the data: the result is stale, the session is busy, a sort is already running, or a download
 * still owns the result. This blocks restoring the original order too — those reasons apply
 * whatever the requested order is.
 */
export function resultSortInteractionBlocked(state: SessionState): boolean {
  if (!state.resultIsCurrent || state.phase !== 'ready') return true;
  if (isResultSorting(state)) return true;
  return hasActiveDownload(state);
}
