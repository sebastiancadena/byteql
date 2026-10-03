import { describe, expect, it, vi } from 'vitest';

import { hardenConnection, PRODUCTION_ALLOWED_DIRECTORIES } from './hardening.js';

describe('hardenConnection', () => {
  it('issues the lockdown statements in the runtime-forced order', async () => {
    const query = vi.fn().mockResolvedValue(null);
    await hardenConnection({ query } as never, { allowedDirectories: PRODUCTION_ALLOWED_DIRECTORIES });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "SET allowed_directories = ['opfs://byteql-spill/', 'opfs://byteql-exports/'];",
      'SET enable_external_access = false;',
      'SET autoinstall_known_extensions = false;',
      'SET autoload_known_extensions = false;',
      'SET allow_community_extensions = false;',
      'SET lock_configuration = true;',
    ]);
  });

  it('uses the caller-supplied allowed directories, quoted', async () => {
    const query = vi.fn().mockResolvedValue(null);
    await hardenConnection({ query } as never, { allowedDirectories: ["opfs://a'b/"] });
    expect(query.mock.calls[0]?.[0]).toBe("SET allowed_directories = ['opfs://a''b/'];");
  });
});
