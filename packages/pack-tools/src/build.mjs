import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compileProjection, parsePackManifest, parseProjectionSpec } from '@byteql/core';
import { parse as parseYaml } from 'yaml';

import { emitGenerated, hookNames } from './emit.mjs';
import { compileKsy } from './ksy.mjs';
import { lintQueries, specTableNames } from './queries.mjs';

const placeholder = () => {
  throw new Error('placeholder hook');
};

/**
 * `byteql-pack build`: validates a pack directory's `pack.yaml`, projection spec, canned
 * queries, and `.ksy` schemas, then writes `gen/**` (if `manifest.ksy` is set) and
 * `src/pack.generated.ts`. Throws on the first problem found; every thrown message is prefixed
 * `file: ...` so a build failure names the offending file.
 */
export const buildPack = async (dir) => {
  const manifest = parsePackManifest(parseYaml(await readFile(join(dir, 'pack.yaml'), 'utf8')), 'pack.yaml');
  const specYaml = await readFile(join(dir, manifest.spec), 'utf8');
  let spec;
  try {
    spec = parseProjectionSpec(specYaml);
    const names = hookNames(manifest, spec);
    compileProjection(spec, new Map(names.parsers.map((n) => [n, placeholder])), {
      keyExtractors: new Map(names.keyExtractors.map((n) => [n, placeholder])),
      framers: new Map(names.streamFramers.map((n) => [n, placeholder])),
    });
  } catch (error) {
    throw new Error(`${manifest.spec}: ${error.message}`, { cause: error });
  }
  if (spec.format !== manifest.id) {
    throw new Error(`${manifest.spec}: format "${spec.format}" must equal pack id "${manifest.id}"`);
  }
  const queries = lintQueries(parseYaml(await readFile(join(dir, manifest.queries), 'utf8')), {
    tables: specTableNames(spec),
    capabilities: manifest.capabilities,
    file: manifest.queries,
  });
  if (manifest.ksy) await compileKsy(dir, manifest.ksy);
  await writeFile(join(dir, 'src/pack.generated.ts'), emitGenerated({ manifest, spec, specYaml, queries }));
};
