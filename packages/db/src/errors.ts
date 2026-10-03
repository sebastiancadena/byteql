/**
 * Failure codes the database layer raises for environment-level storage conditions. Consumers
 * branch on `code`, never on message text, which is free to change.
 */
export type ByteqlDbErrorCode =
  'SPILL_QUOTA_EXCEEDED' | 'SPILL_UNSUPPORTED' | 'RESULT_SPILL_QUOTA_EXCEEDED' | 'RESULT_SPILL_UNSUPPORTED';

export class ByteqlDbError extends Error {
  readonly code: ByteqlDbErrorCode;

  constructor(code: ByteqlDbErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ByteqlDbError';
    this.code = code;
  }
}

/** Whether `error` is a {@link ByteqlDbError} carrying one of the given codes. */
export const hasDbErrorCode = (error: unknown, ...codes: readonly ByteqlDbErrorCode[]): boolean =>
  error instanceof ByteqlDbError && codes.includes(error.code);
