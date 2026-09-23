import { readFile } from 'node:fs/promises';

import type { FixtureCase } from '@byteql/core/testing';

const file = (name: string, path: URL): FixtureCase => ({
  name,
  container: 'smf',
  load: async () => new Uint8Array(await readFile(path)),
});
const local = (name: string) => file(name, new URL(`./fixtures/${name}`, import.meta.url));

export const MIDI_FIXTURES: FixtureCase[] = [
  local('basic-type0.mid'),
  local('demo.mid'),
  local('malformed-then-valid.mid'),
  local('running-status-type1.mid'),
  local('tempo-second-track.mid'),
  file(
    'fur_Elise_opening.mid',
    new URL('../../../../apps/web/src/assets/fur_Elise_opening.mid', import.meta.url),
  ),
];
