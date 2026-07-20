import console from 'node:console';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const directory = resolve(process.argv[2] ?? 'dist');

async function walk(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

const files = await walk(directory);
const wasmFiles = files.filter((path) => path.endsWith('.wasm'));
if (wasmFiles.length === 0) {
  throw new Error(`Pages preparation found no raw WASM assets in ${directory}.`);
}

const javascriptFiles = files.filter((path) => ['.js', '.mjs'].includes(extname(path)));
for (const wasmPath of wasmFiles) {
  const wasmName = basename(wasmPath);
  const compressedName = `${wasmName}.gz`;
  let references = 0;

  for (const javascriptPath of javascriptFiles) {
    const source = await readFile(javascriptPath, 'utf8');
    const occurrences = source.split(wasmName).length - 1;
    if (occurrences === 0) continue;
    references += occurrences;
    await writeFile(javascriptPath, source.replaceAll(wasmName, compressedName));
  }

  if (references === 0) {
    throw new Error(`Pages preparation found no JavaScript reference to ${wasmName}.`);
  }

  const compressed = await gzipAsync(await readFile(wasmPath), { level: 9 });
  const compressedPath = `${wasmPath}.gz`;
  await writeFile(compressedPath, compressed);
  await unlink(wasmPath);
  console.log(
    `Prepared ${relative(directory, compressedPath)} (${compressed.byteLength} bytes; ${references} reference${references === 1 ? '' : 's'}).`,
  );
}
