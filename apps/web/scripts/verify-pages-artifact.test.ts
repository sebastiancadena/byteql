import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const maximumFileBytes = 25 * 1024 * 1024;
const headers = `/*.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable

/*.wasm.gz
  Content-Type: application/gzip
  Cache-Control: public, max-age=31536000, immutable

/index.html
  Cache-Control: no-cache
`;

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'byteql-pages-verify-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<!doctype html>\n');
  await writeFile(join(directory, '_headers'), headers);
  await writeFile(join(directory, 'assets/duckdb-eh-AbCd1234.wasm.gz'), 'compressed');
  await writeFile(join(directory, 'assets/index-AbCd1234.js'), 'export {};\n');
  return directory;
}

function verify(directory: string) {
  return spawnSync(process.execPath, ['scripts/verify-pages-artifact.mjs', directory], {
    cwd: webRoot,
    encoding: 'utf8',
  });
}

describe('Pages artifact verifier', () => {
  test('accepts a prepared static artifact', async () => {
    const result = verify(await fixture());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('rejects an absent _headers contract', async () => {
    const directory = await fixture();
    await truncate(join(directory, '_headers'), 0);

    expect(verify(directory).stderr).toContain('header contract');
  });

  test('rejects a stable compressed WASM filename', async () => {
    const directory = await fixture();
    await writeFile(join(directory, 'assets/duckdb.wasm.gz'), 'compressed');

    expect(verify(directory).stderr).toContain('content-hashed');
  });

  test('rejects a remaining raw WASM asset', async () => {
    const directory = await fixture();
    await writeFile(join(directory, 'assets/duckdb-eh-ZyXw9876.wasm'), 'raw');

    expect(verify(directory).stderr).toContain('raw WASM');
  });

  test('rejects an asset above the Pages per-file limit', async () => {
    const directory = await fixture();
    const oversized = join(directory, 'assets/oversized.bin');
    await writeFile(oversized, '');
    await truncate(oversized, maximumFileBytes + 1);

    expect(verify(directory).stderr).toContain('25 MiB');
  });

  test('rejects a threaded DuckDB worker', async () => {
    const directory = await fixture();
    await writeFile(join(directory, 'assets/duckdb-browser-coi.pthread.worker-AbCd1234.js'), '');

    expect(verify(directory).stderr).toContain('threaded asset');
  });
});

test('root scripts compose preparation, verification, and an explicit production deploy', async () => {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  expect(packageJson.scripts).toMatchObject({
    'prepare:pages': 'node apps/web/scripts/prepare-pages-artifact.mjs apps/web/dist',
    'verify:pages': 'node apps/web/scripts/verify-pages-artifact.mjs apps/web/dist',
    'deploy:pages':
      'pnpm verify:pages && wrangler pages deploy apps/web/dist --project-name=byteql --branch=main',
    'release:pages': 'pnpm check && pnpm check:bundle && pnpm prepare:pages && pnpm deploy:pages',
  });
});
