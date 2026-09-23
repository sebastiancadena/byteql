import { collectSource, goldenText, schemaSnapshotText } from '@byteql/core/testing';
import { describe, expect, it } from 'vitest';

import { zipFormatPack } from '../src/index.js';
import { ZIP_FIXTURES } from './fixtures.list.js';

describe('zip goldens', () => {
  for (const fixture of ZIP_FIXTURES) {
    it(`matches ${fixture.name}`, async () => {
      const result = await collectSource(zipFormatPack, await fixture.load());
      await expect(await goldenText(result)).toMatchFileSnapshot(`./goldens/${fixture.name}.golden.json`);
    });
  }

  it('schemas match the captured snapshot', async () => {
    await expect(schemaSnapshotText(zipFormatPack.schemas())).toMatchFileSnapshot('./schemas.snapshot.json');
  });
});
