import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const webRoot = fileURLToPath(new URL('../', import.meta.url));

describe('bundle source audit', () => {
  it('rejects an external URL imported by runtime CSS', async () => {
    const fixtureDirectory = await mkdtemp(join(webRoot, 'src/.bundle-css-fixture-'));
    const fixturePath = join(fixtureDirectory, 'runtime.css');
    try {
      await writeFile(fixturePath, '@import url("https://private.example.invalid/styles.css");\n');
      const result = spawnSync(process.execPath, ['scripts/check-bundle.mjs'], {
        cwd: webRoot,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('runtime.css');
      expect(result.stderr).toContain('https://');
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
