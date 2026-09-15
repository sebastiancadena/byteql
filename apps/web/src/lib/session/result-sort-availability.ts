import { resultSortEligibility, type ResultSortCapability } from '@byteql/db';

import type { SessionState } from './state.js';

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
