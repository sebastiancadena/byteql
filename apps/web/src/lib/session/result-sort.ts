import { resultSortEligibility, type ResultSort, type ResultSortCapability } from '@byteql/db';
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
const fieldLabel = (schema: Schema, columnIndex: number): string => {
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

/** Whether a sort is genuinely in flight. A failed operation is over, not running. */
export function isResultSorting(state: SessionState): boolean {
  return state.sorting !== null && state.sorting.phase !== 'failed';
}

/** Download phases that still own the result and must finish before it is reordered. */
const ACTIVE_DOWNLOAD_PHASES = new Set([
  'picking',
  'loading',
  'encoding',
  'saving',
  'cancelling',
  'ready-to-save',
]);

/**
 * Whether sort controls must ignore activation right now, for reasons that have nothing to do with
 * the data: the result is stale, the session is busy, a sort is already running, or a download
 * still owns the result. This blocks restoring the original order too — those reasons apply
 * whatever the requested order is.
 */
export function resultSortInteractionBlocked(state: SessionState): boolean {
  if (!state.resultIsCurrent || state.phase !== 'ready') return true;
  if (isResultSorting(state)) return true;
  return state.download !== null && ACTIVE_DOWNLOAD_PHASES.has(state.download.phase);
}

/**
 * Why a NEW sort cannot be started, or null when one can. Restoring the original order bypasses
 * these — it needs no storage, no ordering and no supported types, only the retained base — but it
 * still respects `resultSortInteractionBlocked`.
 */
export function resultSortDisabledReason(
  state: SessionState,
  capability: ResultSortCapability,
): string | null {
  const result = state.result;
  if (!result) return 'Run a query before sorting its results.';
  if (result.pageError) {
    return 'Load the remaining rows before sorting: sorting reorders the whole result.';
  }
  if (!capability.supported) return capability.reason;
  if (result.complete && result.loadedRows <= 1) {
    return 'There is nothing to sort: the result has one row or fewer.';
  }
  const eligibility = resultSortEligibility(result.schema);
  return eligibility.supported ? null : eligibility.reason;
}
