import console from 'node:console';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(webRoot, '../..');
const distAssets = join(webRoot, 'dist/assets');
const maximumJavaScriptBytes = 5 * 1024 * 1024;
const runtimeExtensions = new Set(['.js', '.mjs', '.ts', '.svelte']);
const testFile = /(?:^|[./])(?:e2e|test|tests)(?:[./]|$)|\.(?:spec|test)\.[^.]+$/u;
const externalSourceReference = /https?:\/\/|cdn\.jsdelivr|\bunpkg\b/giu;
const forbiddenBuiltReference = /https?:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com)(?:[/:]|$)/giu;
const e2eOnlyMarker = /__byteqlE2E|armParserCrash|E2E audio engine/gu;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

async function packageSourceRoots() {
  const packagesRoot = join(repositoryRoot, 'packages');
  const directories = [packagesRoot];
  const roots = [];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name === 'src') roots.push(path);
      else directories.push(path);
    }
  }
  return roots;
}

function findings(content, pattern) {
  return [...content.matchAll(pattern)].map((match) => {
    const prefix = content.slice(0, match.index);
    const line = prefix.split('\n').length;
    const column = prefix.length - prefix.lastIndexOf('\n');
    return `${line}:${column} ${match[0]}`;
  });
}

const sourceRoots = [join(webRoot, 'src'), ...(await packageSourceRoots())];
const sourceFailures = [];
for (const root of sourceRoots) {
  for (const path of await walk(root)) {
    const repositoryPath = relative(repositoryRoot, path);
    if (!runtimeExtensions.has(extname(path)) || path.endsWith('.d.ts') || testFile.test(repositoryPath)) {
      continue;
    }
    const matches = findings(await readFile(path, 'utf8'), externalSourceReference);
    for (const match of matches) sourceFailures.push(`${repositoryPath}:${match}`);
  }
}

if (sourceFailures.length > 0) {
  throw new Error(`Runtime source contains direct external URL references:\n${sourceFailures.join('\n')}`);
}
console.log(`Source URL audit: ${sourceRoots.length} runtime roots passed.`);

const assets = await walk(distAssets);
const bundleFailures = [];
const sizeRows = [];
for (const path of assets) {
  const size = (await stat(path)).size;
  const name = relative(distAssets, path);
  const extension = extname(path).toLowerCase();
  const kind = extension === '.wasm' ? 'Wasm' : extension === '.js' ? 'JavaScript' : 'Other';
  sizeRows.push({ name, size, kind });
  if (extension === '.js' && size > maximumJavaScriptBytes) {
    bundleFailures.push(
      `${name} is ${size} bytes; JavaScript chunks must not exceed ${maximumJavaScriptBytes} bytes.`,
    );
  }
  if (extension === '.js' || extension === '.css') {
    const content = await readFile(path, 'utf8');
    for (const match of findings(content, forbiddenBuiltReference)) {
      bundleFailures.push(`${name}:${match}`);
    }
    for (const match of findings(content, e2eOnlyMarker)) {
      bundleFailures.push(`${name}:${match} (compile-time E2E hook leaked into a normal build)`);
    }
  }
}

for (const kind of ['JavaScript', 'Wasm', 'Other']) {
  const rows = sizeRows
    .filter((row) => row.kind === kind)
    .sort((left, right) => left.name.localeCompare(right.name));
  if (rows.length === 0) continue;
  console.log(`${kind} assets:`);
  for (const row of rows) console.log(`  ${row.name} ${row.size} bytes`);
}

if (bundleFailures.length > 0) {
  throw new Error(`Bundle audit failed:\n${bundleFailures.join('\n')}`);
}

const largestJavaScript = sizeRows
  .filter((row) => row.kind === 'JavaScript')
  .sort((left, right) => right.size - left.size)[0];
console.log(
  `Bundle audit passed: ${assets.length} assets; largest JavaScript chunk ${basename(largestJavaScript?.name ?? 'none')} ${largestJavaScript?.size ?? 0} bytes (< 5 MiB).`,
);
