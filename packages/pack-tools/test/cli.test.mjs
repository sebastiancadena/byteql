import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);

const binPath = fileURLToPath(new URL('../bin/byteql-pack.mjs', import.meta.url));

// Must live under this package (not the OS temp dir) — same reasoning as build.test.mjs/
// new.test.mjs: `byteql-pack new` scaffolds a pack whose tsconfig.json assumes a
// `packages/formats/<id>/` nesting, and `byteql-pack build` needs Node's node_modules
// walk-up to find `packages/pack-tools/node_modules/@byteql/core`.
const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url));

const makeCwd = async () => {
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(join(tmpRoot, 'cli-'));
};

test('byteql-pack new <id> scaffolds into cwd when --dir is omitted', async (t) => {
  const cwd = await makeCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  await run('node', [binPath, 'new', 'widget'], { cwd });
  await assert.doesNotReject(access(join(cwd, 'widget', 'pack.yaml')));
});

test('byteql-pack new <id> --dir <path> scaffolds into the given directory', async (t) => {
  const cwd = await makeCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const target = join(cwd, 'formats');
  await mkdir(target, { recursive: true });

  await run('node', [binPath, 'new', 'widget', '--dir', target], { cwd });
  await assert.doesNotReject(access(join(target, 'widget', 'pack.yaml')));
});

test('byteql-pack new --dir <path> <id> accepts --dir before the id', async (t) => {
  const cwd = await makeCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const target = join(cwd, 'formats');
  await mkdir(target, { recursive: true });

  await run('node', [binPath, 'new', '--dir', target, 'widget'], { cwd });
  await assert.doesNotReject(access(join(target, 'widget', 'pack.yaml')));
});

test('byteql-pack new --dir with no value is a clear usage error', async (t) => {
  const cwd = await makeCwd();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  await assert.rejects(run('node', [binPath, 'new', 'widget', '--dir'], { cwd }), /--dir requires a path/u);
});
