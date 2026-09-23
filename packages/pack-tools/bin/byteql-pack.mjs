#!/usr/bin/env node
import console from 'node:console';
import { resolve } from 'node:path';
import process from 'node:process';

const [command, ...rest] = process.argv.slice(2);
const dirFlag = rest.indexOf('--dir');
const dir = resolve(dirFlag >= 0 ? rest[dirFlag + 1] : process.cwd());
try {
  if (command === 'build') {
    const { buildPack } = await import('../src/build.mjs');
    await buildPack(dir);
  } else if (command === 'new') {
    const { newPack } = await import('../src/new.mjs');
    await newPack(
      dir,
      rest.find((arg) => !arg.startsWith('--') && arg !== rest[dirFlag + 1]),
    );
  } else {
    throw new Error('usage: byteql-pack <build|new <id>> [--dir <path>]');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
