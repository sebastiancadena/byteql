import { readFile } from 'node:fs/promises';

import { describePackConformance, schemaSnapshotText } from '@byteql/core/testing';
import { expect, it } from 'vitest';

import { pcapFormatPack } from '../src/index.js';
import { PCAP_FIXTURES } from './fixtures.list.js';

describePackConformance(pcapFormatPack, {
  fixtures: PCAP_FIXTURES,
  fuzz: { seed: 1, truncations: 6, flips: 6 },
});

it('schemas equal the pre-kit snapshot except the documented _src_* nullability delta', async () => {
  const snapshot = JSON.parse(await readFile(new URL('./schemas.snapshot.json', import.meta.url), 'utf8'));
  const derived = JSON.parse(schemaSnapshotText(pcapFormatPack.schemas()));
  const relax = (schemas: { name: string; columns: { name: string; nullable: boolean }[] }[]) =>
    schemas.map((s) => ({
      ...s,
      columns: s.columns.map((c) =>
        s.name !== 'errors' && (c.name === '_src_start' || c.name === '_src_end')
          ? { ...c, nullable: false }
          : c,
      ),
    }));
  expect(derived).toEqual(relax(snapshot));
});
