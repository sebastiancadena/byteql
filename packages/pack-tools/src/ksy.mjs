import { createRequire } from 'node:module';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { parse as parseYaml } from 'yaml';

const require = createRequire(import.meta.url);
const compiler = require('kaitai-struct-compiler');

const pathExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const isOutsidePackage = (packageDir, target) => {
  const rel = relative(packageDir, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

/**
 * Compiles a pack's `.ksy` schemas to `gen/**` JavaScript, generalizing the two hand-written
 * `scripts/compile.mjs` (MIDI, pcap) that this replaces. `ksy` is `manifest.ksy`: `{ dir, roots? }`.
 */
export const compileKsy = async (packageDir, ksy) => {
  const ksyDir = resolve(packageDir, ksy.dir);
  const outputDir = resolve(packageDir, 'gen');

  const resolveImport = async (name) => {
    const relativeName = name.startsWith('/') ? name.slice(1) : name;
    if (isAbsolute(relativeName) || relativeName.split(/[\\/]/u).includes('..')) {
      throw new Error(`KAITAI_IMPORT_PATH: import is outside the package: ${name}`);
    }
    let schemaPath = resolve(ksyDir, `${relativeName}.ksy`);
    if (!(await pathExists(schemaPath))) {
      schemaPath = resolve(ksyDir, `${basename(relativeName)}.ksy`);
    }
    if (isOutsidePackage(packageDir, schemaPath)) {
      throw new Error(`KAITAI_IMPORT_PATH: import is outside the package: ${name}`);
    }
    return schemaPath;
  };

  const importer = {
    async importYaml(name) {
      return parseYaml(await readFile(await resolveImport(name), 'utf8'));
    },
  };

  const rootPaths = ksy.roots
    ? ksy.roots.map((root) => resolve(ksyDir, `${root}.ksy`))
    : (await readdir(ksyDir))
        .filter((name) => name.endsWith('.ksy'))
        .sort()
        .map((name) => resolve(ksyDir, name));

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    resolve(outputDir, 'package.json'),
    `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
    'utf8',
  );

  for (const rootPath of rootPaths) {
    const rootSchema = parseYaml(await readFile(rootPath, 'utf8'));
    const files = await compiler.compile('javascript', rootSchema, importer, true);

    await Promise.all(
      Object.entries(files).map(async ([name, contents]) => {
        const outputPath = resolve(outputDir, name);
        const outputRelativePath = relative(outputDir, outputPath);
        if (
          outputRelativePath === '..' ||
          outputRelativePath.startsWith(`..${sep}`) ||
          isAbsolute(outputRelativePath)
        ) {
          throw new Error(`KAITAI_OUTPUT_PATH: compiler returned an unsafe path: ${name}`);
        }

        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, contents, 'utf8');
      }),
    );
  }
};
