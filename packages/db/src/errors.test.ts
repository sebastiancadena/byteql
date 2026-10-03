import { describe, expect, it } from 'vitest';

import { ByteqlDbError, hasDbErrorCode } from './errors.js';

describe('ByteqlDbError', () => {
  it('carries its code, message and cause', () => {
    const cause = new Error('boom');
    const error = new ByteqlDbError('SPILL_UNSUPPORTED', 'SPILL_UNSUPPORTED: nope', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ByteqlDbError');
    expect(error.code).toBe('SPILL_UNSUPPORTED');
    expect(error.message).toBe('SPILL_UNSUPPORTED: nope');
    expect(error.cause).toBe(cause);
  });

  it('matches codes only on typed errors, never on message text', () => {
    const typed = new ByteqlDbError('SPILL_QUOTA_EXCEEDED', 'x');
    expect(hasDbErrorCode(typed, 'SPILL_QUOTA_EXCEEDED', 'SPILL_UNSUPPORTED')).toBe(true);
    expect(hasDbErrorCode(typed, 'SPILL_UNSUPPORTED')).toBe(false);
    expect(hasDbErrorCode(new Error('SPILL_QUOTA_EXCEEDED: x'), 'SPILL_QUOTA_EXCEEDED')).toBe(false);
    expect(hasDbErrorCode(undefined, 'SPILL_QUOTA_EXCEEDED')).toBe(false);
  });
});
