import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const webRoot = fileURLToPath(new URL('../', import.meta.url));

test('compresses hashed WASM assets and rewrites their generated JavaScript references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'byteql-pages-prepare-'));
  const assets = join(directory, 'assets');
  const wasmName = 'duckdb-eh-AbCd1234.wasm';
  const wasm = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  await mkdir(assets);
  await writeFile(join(assets, wasmName), wasm);
  await writeFile(join(assets, 'index-AbCd1234.js'), `const moduleUrl = "/assets/${wasmName}";\n`);

  const result = spawnSync(process.execPath, ['scripts/prepare-pages-artifact.mjs', directory], {
    cwd: webRoot,
    encoding: 'utf8',
  });

  expect(result.status, result.stderr).toBe(0);
  await expect(readFile(join(assets, wasmName))).rejects.toThrow();
  expect([...gunzipSync(await readFile(join(assets, `${wasmName}.gz`)))]).toEqual([...wasm]);
  expect(await readFile(join(assets, 'index-AbCd1234.js'), 'utf8')).toContain(`/assets/${wasmName}.gz`);
});
