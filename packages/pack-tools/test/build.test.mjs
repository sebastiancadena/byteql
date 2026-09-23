import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { buildPack } from '../src/build.mjs';

const run = promisify(execFile);

// The copy must live under this package (not the OS temp dir) so Node's/tsc's node_modules
// walk-up finds `packages/pack-tools/node_modules/@byteql/core` — see tsconfig.json/.bad.json's
// `extends`, which is written for this exact nesting depth (test/.tmp/<random>/).
const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url));

const copyFixture = async () => {
  await mkdir(tmpRoot, { recursive: true });
  const dir = await mkdtemp(join(tmpRoot, 'pack-'));
  await cp(new URL('./fixture-pack/', import.meta.url), dir, { recursive: true });
  return dir;
};

test('emits pack.generated.ts with hook unions and compiles ksy', async (t) => {
  const dir = await copyFixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await buildPack(dir);
  const generated = await readFile(join(dir, 'src/pack.generated.ts'), 'utf8');
  assert.match(generated, /export type FramerName = 'demo';/u);
  assert.match(generated, /export type ParserName = 'two_bytes';/u);
  assert.match(generated, /export type ProbeHookName = never;/u);
  await readFile(join(dir, 'gen/TwoBytes.js'), 'utf8');
});

test('manifest errors name file and path', async (t) => {
  const dir = await copyFixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'pack.yaml'), 'version: "0.1"\nid: demo\n');
  await assert.rejects(buildPack(dir), /pack\.yaml: title/u);
});

test('spec compile errors fail the build', async (t) => {
  const dir = await copyFixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spec = await readFile(join(dir, 'demo.tables.yaml'), 'utf8');
  await writeFile(join(dir, 'demo.tables.yaml'), spec.replace('rows: $', 'rows: "$[["'));
  await assert.rejects(buildPack(dir), /demo\.tables\.yaml/u);
});

test('queries referencing unknown tables fail the lint; CTEs and engine tables pass', async (t) => {
  const dir = await copyFixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, 'queries.yaml'),
    `version: '0.1'
queries:
  - { id: ok, title: Ok, kind: grid, sql: "with x as (select * from rec) select * from x join errors on true" }
  - { id: bad, title: Bad, kind: grid, sql: "select * from nope" }
`,
  );
  await assert.rejects(buildPack(dir), /queries\.yaml: queries\.1: unknown table "nope"/u);
});

test('playback queries require the audio capability', async (t) => {
  const dir = await copyFixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, 'queries.yaml'),
    `version: '0.1'\nqueries:\n  - { id: p, title: P, kind: playback, sql: "select 1" }\n`,
  );
  await assert.rejects(buildPack(dir), /kind "playback" requires capability "audio"/u);
});

test('ksy imports cannot escape the package', async (t) => {
  const dir = await copyFixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, 'ksy/two_bytes.ksy'),
    'meta:\n  id: two_bytes\n  imports: [../../etc/passwd]\nseq: []\n',
  );
  await assert.rejects(buildPack(dir), /KAITAI_IMPORT_PATH/u);
});

test('generated hook unions make misspelled hooks a tsc error', async (t) => {
  const dir = await copyFixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await buildPack(dir);
  await run('pnpm', ['exec', 'tsc', '--noEmit', '-p', join(dir, 'tsconfig.json')]);
  await assert.rejects(
    run('pnpm', ['exec', 'tsc', '--noEmit', '-p', join(dir, 'tsconfig.bad.json')]),
    (error) => {
      assert.match(String(error.stdout ?? error.message), /dmeo/u);
      return true;
    },
  );
});

// Every pack's checked-in canned queries must still lint clean once the lint knows that pack's
// own spec table names (and, for MIDI, that it declares the `audio` capability its `playback`
// queries require) — this is the real acceptance bar for Task 8's query lint, not just the
// fixture pack above.
const formatsDir = fileURLToPath(new URL('../../formats/', import.meta.url));

const existingPacks = [
  { dir: 'midi', spec: 'midi.tables.yaml', capabilities: ['audio'] },
  { dir: 'pcap', spec: 'pcap.tables.yaml', capabilities: [] },
  { dir: 'zip', spec: 'zip.tables.yaml', capabilities: [] },
];

for (const pack of existingPacks) {
  test(`lintQueries accepts ${pack.dir}'s existing queries.yaml`, async () => {
    const { parseProjectionSpec } = await import('@byteql/core');
    const { lintQueries, specTableNames } = await import('../src/queries.mjs');
    const { parse: parseYaml } = await import('yaml');
    const packDir = join(formatsDir, pack.dir);
    const spec = parseProjectionSpec(await readFile(join(packDir, pack.spec), 'utf8'));
    const queryPack = parseYaml(await readFile(join(packDir, 'queries.yaml'), 'utf8'));
    assert.doesNotThrow(() =>
      lintQueries(queryPack, {
        tables: specTableNames(spec),
        capabilities: pack.capabilities,
        file: `${pack.dir}/queries.yaml`,
      }),
    );
  });
}
