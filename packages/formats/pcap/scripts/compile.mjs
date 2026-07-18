import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

const require = createRequire(import.meta.url);
const compiler = require('kaitai-struct-compiler');
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ksyDirectory = resolve(packageDirectory, 'ksy');
const outputDirectory = resolve(packageDirectory, 'gen');

function resolveWithinPackage(name) {
  const relativeName = name.startsWith('/') ? name.slice(1) : name;
  if (isAbsolute(relativeName) || relativeName.split(/[\\/]/).includes('..')) {
    throw new Error(`KAITAI_IMPORT_PATH: import is outside the pcap package: ${name}`);
  }

  const baseName = relativeName.startsWith('network/') ? relativeName.slice('network/'.length) : relativeName;
  const schemaPath = resolve(ksyDirectory, `${baseName}.ksy`);
  const packageRelativePath = relative(packageDirectory, schemaPath);
  if (
    packageRelativePath === '..' ||
    packageRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(packageRelativePath)
  ) {
    throw new Error(`KAITAI_IMPORT_PATH: import is outside the pcap package: ${name}`);
  }

  return schemaPath;
}

const importer = {
  async importYaml(name) {
    return parseYaml(await readFile(resolveWithinPackage(name), 'utf8'));
  },
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(
  resolve(outputDirectory, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
  'utf8',
);

const ksyFiles = (await readdir(ksyDirectory)).filter((name) => name.endsWith('.ksy')).sort();

for (const ksyFile of ksyFiles) {
  const rootSchema = parseYaml(await readFile(resolve(ksyDirectory, ksyFile), 'utf8'));
  const files = await compiler.compile('javascript', rootSchema, importer, true);

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
}
