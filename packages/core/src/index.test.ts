import { describe, expect, it } from 'vitest';
import { BYTEQL_CORE_VERSION } from './index.js';

describe('core public surface', () => {
  it('exports the projection contract version', () => {
    expect(BYTEQL_CORE_VERSION).toBe('0.1');
  });
});
