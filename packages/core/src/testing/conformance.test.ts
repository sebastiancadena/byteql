import { describe, expect, it } from 'vitest';

import { definePack } from '../pack/define.js';
import type { Framer } from '../pack/framer.js';
import { PackFatalError } from '../pack/framer.js';
import { parsePackManifest } from '../pack/manifest.js';
import { describePackConformance, runFuzzCase } from './conformance.js';

const specYaml = (format: string): string => `
version: '0.4'
format: ${format}
tables:
  - name: rec
    rows: $
    key: rec_id
    columns:
      value: { expr: _.value, type: uint8 }
`;

const manifestFor = (id: string) =>
  parsePackManifest({
    version: '0.1',
    id,
    title: id,
    spec: `${id}.tables.yaml`,
    queries: 'queries.yaml',
    containers: [{ id: 'a', framer: 'fa', probe: { magic: [{ at: 0, hex: 'aa', confidence: 0.5 }] } }],
  });

/** One record per byte; a magic byte other than 0xaa at offset 0 is a fatal container mismatch. */
const toyFramer: Framer = async function* (source, ctx) {
  const bytes = await source.read(0, source.size);
  if (bytes.length === 0 || bytes[0] !== 0xaa) {
    throw new PackFatalError('BAD_MAGIC', 'first byte must be 0xaa');
  }
  for (let i = 0; i < bytes.length; i += 1) {
    yield { root: { value: bytes[i] }, provenance: { start: i, end: i + 1 } };
    ctx.bytes(i + 1);
  }
};

const toyPack = definePack(
  { manifest: manifestFor('toy'), specYaml: specYaml('toy'), queries: [] },
  { framers: { fa: toyFramer }, parsers: {}, keyExtractors: {}, streamFramers: {}, probes: {} },
);

/** Same shape as toyFramer, but crashes with a raw (non-PackFatalError) Error on byte 0x02 — used
 * to prove the kit's fuzz check does NOT silently accept an unclassified failure. */
const crashFramer: Framer = async function* (source, ctx) {
  const bytes = await source.read(0, source.size);
  if (bytes.length === 0 || bytes[0] !== 0xaa) {
    throw new PackFatalError('BAD_MAGIC', 'first byte must be 0xaa');
  }
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x02) throw new Error('raw crash');
    yield { root: { value: bytes[i] }, provenance: { start: i, end: i + 1 } };
    ctx.bytes(i + 1);
  }
};

const crashPack = definePack(
  { manifest: manifestFor('crash'), specYaml: specYaml('crash'), queries: [] },
  { framers: { fa: crashFramer }, parsers: {}, keyExtractors: {}, streamFramers: {}, probes: {} },
);

describePackConformance(toyPack, {
  fixtures: [{ name: 'toy.bin', container: 'a', load: async () => new Uint8Array([0xaa, 1, 2, 3]) }],
  fuzz: { seed: 1, truncations: 3, flips: 3 },
});

describe('runFuzzCase', () => {
  it('rejects with a message containing "unclassified" for a pack whose framer throws a raw error', async () => {
    await expect(runFuzzCase(crashPack, new Uint8Array([0xaa, 1, 2, 3]), 'a')).rejects.toThrow(
      /unclassified/u,
    );
  });
});
