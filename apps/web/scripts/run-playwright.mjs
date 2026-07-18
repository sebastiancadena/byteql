import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

const result = spawnSync('playwright', ['test', ...args], {
  stdio: 'inherit',
  shell: false,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
