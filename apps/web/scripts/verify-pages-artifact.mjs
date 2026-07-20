import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import process from 'node:process';

const directory = resolve(process.argv[2] ?? 'dist');
const maximumFileBytes = 25 * 1024 * 1024;
const expectedHeaders = `/*.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable

/*.wasm.gz
  Content-Type: application/gzip
  Cache-Control: public, max-age=31536000, immutable

/index.html
  Cache-Control: no-cache
`;
const hashedCompressedWasm = /-[A-Za-z0-9_-]{8,}\.wasm\.gz$/u;
const threadedAsset = /(?:pthread|duckdb-browser-coi|sharedworker)/iu;
const requiredExtensions = [
  'duckdb-extensions/v1.5.4/wasm_eh/parquet.duckdb_extension.wasm',
  'duckdb-extensions/v1.5.4/wasm_mvp/parquet.duckdb_extension.wasm',
];

async function walk(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

await stat(join(directory, 'index.html'));
const actualHeaders = (await readFile(join(directory, '_headers'), 'utf8')).replaceAll('\r\n', '\n');
if (actualHeaders !== expectedHeaders) {
  throw new Error('The Pages _headers file does not match the required header contract.');
}

const files = await walk(directory);
const relativeFiles = files.map((path) => relative(directory, path));
const missingExtensions = requiredExtensions.filter((path) => !relativeFiles.includes(path));
if (missingExtensions.length > 0) {
  throw new Error(
    `Prepared Pages artifact is missing local DuckDB extensions: ${missingExtensions.join(', ')}`,
  );
}
const oversized = [];
for (const path of files) {
  const size = (await stat(path)).size;
  if (size > maximumFileBytes) {
    oversized.push(`${relative(directory, path)} (${size} bytes)`);
  }
}
if (oversized.length > 0) {
  throw new Error(`Pages assets exceed the 25 MiB per-file limit:\n${oversized.join('\n')}`);
}

const names = files.map((path) => basename(path));
const rawWasm = relativeFiles.filter(
  (path) => path.endsWith('.wasm') && !path.startsWith('duckdb-extensions/'),
);
if (rawWasm.length > 0) {
  throw new Error(`Prepared Pages artifact still contains raw WASM: ${rawWasm.join(', ')}`);
}

const compressedWasm = names.filter((name) => name.endsWith('.wasm.gz'));
if (compressedWasm.length === 0) {
  throw new Error('Prepared Pages artifact contains no compressed WASM assets.');
}
const stableWasm = compressedWasm.filter((name) => !hashedCompressedWasm.test(name));
if (stableWasm.length > 0) {
  throw new Error(`Compressed WASM filenames must be content-hashed: ${stableWasm.join(', ')}`);
}

const threaded = names.filter((name) => threadedAsset.test(name));
if (threaded.length > 0) {
  throw new Error(`Prepared Pages artifact contains a threaded asset: ${threaded.join(', ')}`);
}

process.stdout.write(
  `Pages artifact verified: ${files.length} files, ${compressedWasm.length} compressed WASM asset${compressedWasm.length === 1 ? '' : 's'}, all at or below 25 MiB.\n`,
);
