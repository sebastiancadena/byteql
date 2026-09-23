import { describe, expect, it } from 'vitest';

import { memoryByteSource } from '../byte-source.js';
import { definePack } from './define.js';
import type { Framer } from './framer.js';
import { parsePackManifest } from './manifest.js';

const specYaml = `
version: '0.4'
format: demo
tables:
  - name: rec
    rows: $
    key: rec_id
    columns:
      kind: { expr: _.kind, type: utf8 }
`;
const manifest = parsePackManifest({
  version: '0.1',
  id: 'demo',
  title: 'Demo',
  spec: 'demo.tables.yaml',
  queries: 'queries.yaml',
  containers: [
    { id: 'a', framer: 'fa', probe: { magic: [{ at: 0, hex: 'aa', confidence: 0.5 }] } },
    { id: 'b', framer: 'fb', probe: { magic: [{ at: 1, hex: 'bbcc', confidence: 0.9 }] } },
  ],
});
const framer = (kind: string): Framer =>
  async function* () {
    yield { root: { kind }, provenance: { start: 0, end: 1 } };
  };
const pack = definePack(
  { manifest, specYaml, queries: [] },
  {
    framers: { fa: framer('a'), fb: framer('b') },
    parsers: {},
    keyExtractors: {},
    streamFramers: {},
    probes: {},
  },
);

describe('definePack', () => {
  it('probes declaratively and reports the matched container', () => {
    expect(pack.probeContainer(new Uint8Array([0xaa, 0xbb, 0xcc]))).toEqual({
      container: 'b',
      confidence: 0.9,
    });
    expect(pack.probe(new Uint8Array([0xaa]))).toBe(0.5);
    expect(pack.probe(new Uint8Array([0x00]))).toBeNull();
    expect(pack.probe(new Uint8Array([]))).toBeNull();
  });

  it('opens the requested container, or re-probes when none is given', async () => {
    const kinds = async (options?: { container?: string }) => {
      const bytes = new Uint8Array([0xaa, 0xbb, 0xcc]);
      const rs = pack.openWith(memoryByteSource(bytes), { signal: new AbortController().signal }, options);
      const out: string[] = [];
      for (let b = await rs.nextBatch(); b; b = await rs.nextBatch()) out.push(b.table);
      return out;
    };
    expect(await kinds({ container: 'a' })).toEqual(['rec', 'errors']);
    expect(await kinds()).toEqual(['rec', 'errors']);
  });

  it('derives schemas and exposes identity', () => {
    expect(pack.id).toBe('demo');
    expect(pack.schemas().map((s) => s.name)).toEqual(['rec', 'errors']);
  });

  it('rejects a spec whose format differs from the manifest id at definition time', () => {
    expect(() =>
      definePack(
        { manifest, specYaml: specYaml.replace('format: demo', 'format: other'), queries: [] },
        {
          framers: { fa: framer('a'), fb: framer('b') },
          parsers: {},
          keyExtractors: {},
          streamFramers: {},
          probes: {},
        },
      ),
    ).toThrow(/PACK_FORMAT_MISMATCH/u);
  });

  it('an unknown container id fails the source with PACK_CONTAINER_UNKNOWN', async () => {
    const rs = pack.openWith(
      memoryByteSource(new Uint8Array([1])),
      { signal: new AbortController().signal },
      { container: 'zzz' },
    );
    await expect(rs.nextBatch()).rejects.toThrow(/PACK_CONTAINER_UNKNOWN/u);
  });

  describe('hook probes', () => {
    const hookManifest = parsePackManifest({
      version: '0.1',
      id: 'demo',
      title: 'Demo',
      spec: 'demo.tables.yaml',
      queries: 'queries.yaml',
      containers: [{ id: 'c', framer: 'fc', probe: { hook: 'sniff' } }],
    });

    it('a working hook probe selects its container', () => {
      const hookPack = definePack(
        { manifest: hookManifest, specYaml, queries: [] },
        {
          framers: { fc: framer('c') },
          parsers: {},
          keyExtractors: {},
          streamFramers: {},
          probes: { sniff: (head) => (head[0] === 0x42 ? 0.7 : null) },
        },
      );
      expect(hookPack.probeContainer(new Uint8Array([0x42]))).toEqual({ container: 'c', confidence: 0.7 });
      expect(hookPack.probeContainer(new Uint8Array([0x00]))).toBeNull();
    });

    it('a probe hook named in the manifest but missing from hooks.probes throws at definition time', () => {
      expect(() =>
        definePack(
          { manifest: hookManifest, specYaml, queries: [] },
          { framers: { fc: framer('c') }, parsers: {}, keyExtractors: {}, streamFramers: {}, probes: {} },
        ),
      ).toThrow(/PACK_PROBE_HOOK_MISSING/u);
    });
  });
});
