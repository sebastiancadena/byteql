#!/usr/bin/env node
import console from 'node:console';
import { resolve } from 'node:path';
import process from 'node:process';

const [command, ...rest] = process.argv.slice(2);
const dirFlag = rest.indexOf('--dir');
if (dirFlag >= 0 && (dirFlag + 1 >= rest.length || rest[dirFlag + 1].startsWith('--'))) {
  console.error('byteql-pack: --dir requires a path');
  process.exit(1);
}
const dir = resolve(dirFlag >= 0 ? rest[dirFlag + 1] : process.cwd());
try {
  if (command === 'build') {
    const { buildPack } = await import('../src/build.mjs');
    await buildPack(dir);
  } else if (command === 'new') {
    const { newPack } = await import('../src/new.mjs');
    await newPack(
      dir,
      rest.find((arg, i) => !arg.startsWith('--') && (dirFlag < 0 || i !== dirFlag + 1)),
    );
  } else {
    throw new Error('usage: byteql-pack <build|new <id>> [--dir <path>]');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
