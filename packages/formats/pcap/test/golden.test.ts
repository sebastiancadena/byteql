import { collectSource, goldenText, schemaSnapshotText } from '@byteql/core/testing';
import { describe, expect, it } from 'vitest';

import { pcapFormatPack } from '../src/index.js';
import { PCAP_FIXTURES } from './fixtures.list.js';

describe('pcap goldens', () => {
  for (const fixture of PCAP_FIXTURES) {
    it(`matches ${fixture.name}`, async () => {
      const result = await collectSource(pcapFormatPack, await fixture.load());
      await expect(await goldenText(result)).toMatchFileSnapshot(`./goldens/${fixture.name}.golden.json`);
    });
  }

  it('schemas match the captured snapshot', async () => {
    await expect(schemaSnapshotText(pcapFormatPack.schemas())).toMatchFileSnapshot('./schemas.snapshot.json');
  });
});
