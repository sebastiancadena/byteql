import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { buildPack } from '../src/build.mjs';
import { newPack } from '../src/new.mjs';

const run = promisify(execFile);

// Must live under this package (not the OS temp dir) so tsc's/node's node_modules walk-up finds
// `packages/pack-tools/node_modules/@byteql/core` — same reasoning as build.test.mjs's
// copyFixture. A sandbox mimics the real `packages/formats/<id>/` nesting the scaffold's
// tsconfig.json `extends` assumes (3 levels below a `tsconfig.base.json`) by holding its own
// copy of the repo's tsconfig.base.json at its root and putting the scaffold under
// `<sandbox>/packages/formats/<id>/`.
const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url));
const repoTsconfigBase = fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url));

const makeSandbox = async () => {
  await mkdir(tmpRoot, { recursive: true });
  const sandbox = await mkdtemp(join(tmpRoot, 'new-pack-'));
  await writeFile(join(sandbox, 'tsconfig.base.json'), await readFile(repoTsconfigBase, 'utf8'));
  const formatsDir = join(sandbox, 'packages', 'formats');
  await mkdir(formatsDir, { recursive: true });
  return { sandbox, formatsDir };
};

test('scaffolds a pack whose build passes byteql-pack build and tsc --noEmit', async (t) => {
  const { sandbox, formatsDir } = await makeSandbox();
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const dir = await newPack(formatsDir, 'widget');
  assert.equal(dir, join(formatsDir, 'widget'));

  await buildPack(dir);
  await assert.doesNotReject(access(join(dir, 'src', 'pack.generated.ts')));
  const generated = await readFile(join(dir, 'src', 'pack.generated.ts'), 'utf8');
  assert.match(generated, /export type FramerName = 'widget';/u);

  await assert.doesNotReject(run('pnpm', ['exec', 'tsc', '--noEmit', '-p', join(dir, 'tsconfig.json')]));
});

test('rejects scaffolding into a directory that already exists', async (t) => {
  const { sandbox, formatsDir } = await makeSandbox();
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  await newPack(formatsDir, 'widget');
  await assert.rejects(newPack(formatsDir, 'widget'), /already exists/u);
});

test('rejects an id that is not a bare identifier', async (t) => {
  const { sandbox, formatsDir } = await makeSandbox();
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  await assert.rejects(newPack(formatsDir, 'new-pack'), /must be an identifier/u);
});
