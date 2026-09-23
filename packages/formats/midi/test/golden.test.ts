import { collectSource, goldenText, schemaSnapshotText } from '@byteql/core/testing';
import { describe, expect, it } from 'vitest';

import { midiFormatPack } from '../src/index.js';
import { MIDI_FIXTURES } from './fixtures.list.js';

describe('midi goldens', () => {
  for (const fixture of MIDI_FIXTURES) {
    it(`matches ${fixture.name}`, async () => {
      const result = await collectSource(midiFormatPack, await fixture.load());
      await expect(await goldenText(result)).toMatchFileSnapshot(`./goldens/${fixture.name}.golden.json`);
    });
  }

  it('schemas match the captured snapshot', async () => {
    await expect(schemaSnapshotText(midiFormatPack.schemas())).toMatchFileSnapshot('./schemas.snapshot.json');
  });
});
