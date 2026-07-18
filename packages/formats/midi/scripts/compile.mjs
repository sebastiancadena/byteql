import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

const require = createRequire(import.meta.url);
const compiler = require('kaitai-struct-compiler');
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(packageDirectory, 'gen');

function resolveWithinPackage(name) {
  const relativeName = name.startsWith('/') ? name.slice(1) : name;
  if (isAbsolute(relativeName) || relativeName.split(/[\\/]/).includes('..')) {
    throw new Error(`KAITAI_IMPORT_PATH: import is outside the MIDI package: ${name}`);
  }

  const schemaPath = resolve(packageDirectory, `${relativeName}.ksy`);
  const packageRelativePath = relative(packageDirectory, schemaPath);
  if (
    packageRelativePath === '..' ||
    packageRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(packageRelativePath)
  ) {
    throw new Error(`KAITAI_IMPORT_PATH: import is outside the MIDI package: ${name}`);
  }

  return schemaPath;
}

const importer = {
  async importYaml(name) {
    return parseYaml(await readFile(resolveWithinPackage(name), 'utf8'));
  },
};

const rootSchema = parseYaml(await readFile(resolve(packageDirectory, 'standard_midi_file.ksy'), 'utf8'));
const files = await compiler.compile('javascript', rootSchema, importer, true);

await mkdir(outputDirectory, { recursive: true });
await writeFile(
  resolve(outputDirectory, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
  'utf8',
);
await Promise.all(
  Object.entries(files).map(async ([name, contents]) => {
    const outputPath = resolve(outputDirectory, name);
    const outputRelativePath = relative(outputDirectory, outputPath);
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
