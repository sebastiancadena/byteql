import console from 'node:console';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const HELP_TEXT = `Usage: node scripts/run-scale-bench.mjs [--gb 1|4] [--help]

Runs the scaled throughput/read-fraction benchmark (apps/web/e2e/scale-metrics.spec.ts) against a
synthetic pcap capture of the given size. Rebuilds the whole monorepo first (workspace package
changes, e.g. to packages/db, only take effect once rebuilt — apps/web resolves them via their
built dist/, not source), then writes the measured benchmark record to
bench/scale-<gb>gb-<date>.json and prints a one-line summary.

  --gb 1   Default. A 1 GB (decimal, 1e9-byte) capture. Both the proportional parse-time budget
           (target 60,000 ms/GB; the spec hard-fails above 120,000 ms/GB) and the read-fraction
           budget (< 10%) are hard assertions — this is the metric's defined baseline scale.
  --gb 4   A 4 GB capture. The parse-time budget is only defined at the 1 GB baseline, so above
           that the spec downgrades it to reporting-only. The read-fraction budget stays a hard
           assertion at this scale too: this invocation sets BYTEQL_SCALE_ASSERT_READ=1, which
           the spec reads to opt back into asserting it explicitly above 1 GB.

Examples:
  node scripts/run-scale-bench.mjs --gb 1
  node scripts/run-scale-bench.mjs --gb 4
`;

function parseGb(args) {
  const index = args.indexOf('--gb');
  if (index === -1) return 1;
  const value = args[index + 1];
  const gb = Number(value);
  if (gb !== 1 && gb !== 4) {
    throw new Error(`--gb must be 1 or 4 (got ${JSON.stringify(value ?? null)}). See --help.`);
  }
  return gb;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

const gb = parseGb(args);
// Decimal GB (1e9 bytes), matching createScaleBenchmarkRecord's own unit choice and the
// scale-metrics.spec.ts throughput formula — not the binary MiB/GiB used for storage-size
// constants elsewhere in this codebase.
const BYTES_PER_GB = 1e9;
const targetBytes = gb * BYTES_PER_GB;

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const date = new Date().toISOString().slice(0, 10);
const outputPath = join(webRoot, 'bench', `scale-${gb}gb-${date}.json`);

console.log('Building the monorepo (pnpm -r build) so workspace package changes take effect...');
const build = spawnSync('pnpm', ['-r', 'build'], { cwd: repoRoot, stdio: 'inherit', shell: false });
if (build.error) throw build.error;
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

console.log(`Running the scaled spec at --gb ${gb} (${targetBytes.toLocaleString('en-US')} bytes)...`);
const env = {
  ...process.env,
  BYTEQL_SCALE_BYTES: String(targetBytes),
  // Read by the spec itself: writes the same record it attaches to the Playwright report
  // straight to this path, so this script never has to parse Playwright's reporter internals to
  // recover the JSON a normal CI run only attaches.
  BYTEQL_SCALE_BENCH_OUTPUT: outputPath,
};
if (gb > 1) {
  env.BYTEQL_SCALE_ASSERT_READ = '1';
}

const result = spawnSync('playwright', ['test', 'scale-metrics'], {
  cwd: webRoot,
  env,
  stdio: 'inherit',
  shell: false,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const record = JSON.parse(await readFile(outputPath, 'utf8'));
const msPerGb = record.parseElapsedMs / (record.capture.bytes / BYTES_PER_GB);
console.log(
  `BYTEQL_SCALE_BENCH_SUMMARY gb=${gb} bytes=${record.capture.bytes} ` +
    `parseElapsedMs=${record.parseElapsedMs.toFixed(1)} msPerGb=${msPerGb.toFixed(1)} ` +
    `parseTargetMet=${record.parseTargetMet} bytesReadFraction=${record.bytesReadFraction} ` +
    `readTargetMet=${record.readTargetMet} -> ${outputPath}`,
);
