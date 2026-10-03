import { hasDbErrorCode } from '@byteql/db';

export const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

/** Whether a failed result page can be retried in place rather than needing the query rerun. */
export const isRetryablePageError = (error: unknown): boolean =>
  hasDbErrorCode(error, 'RESULT_SPILL_QUOTA_EXCEEDED');

export const resultPageFailureMessage = (error: unknown, fallback: string): string => {
  const raw = errorMessage(error, fallback);
  if (hasDbErrorCode(error, 'RESULT_SPILL_QUOTA_EXCEEDED')) {
    return 'Local result storage is full. Free local storage, then retry loading rows.';
  }
  if (hasDbErrorCode(error, 'RESULT_SPILL_UNSUPPORTED')) {
    return 'This browser cannot retain more local result pages. Narrow the SQL and run the query again.';
  }
  return `${raw} Run the query again to load more rows.`;
};
