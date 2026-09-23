import type { FormatPack } from '@byteql/core';
import { describe, expect, it } from 'vitest';

import { PROBE_HEAD_BYTES, REGISTERED_PACKS, selectPack } from './packs.js';

const fakePack = (id: string, confidence: number | null): FormatPack => ({
  id,
  title: id,
  probe: () => confidence,
  schemas: () => [],
  open: () => {
    throw new Error('not used');
  },
  queries: [],
});

describe('selectPack', () => {
  const head = new Uint8Array(0);

  it('selects the highest-confidence pack', () => {
    const packs = [fakePack('a', 0.4), fakePack('b', 0.9)];
    expect(selectPack(packs, head)?.pack.id).toBe('b');
  });

  it('first-registered pack wins ties and zero confidence never selects', () => {
    expect(selectPack([fakePack('a', 0.5), fakePack('b', 0.5)], head)?.pack.id).toBe('a');
    expect(selectPack([fakePack('a', 0), fakePack('b', null)], head)).toBeNull();
  });

  it('formatId bypasses probing and misses return null', () => {
    const packs = [fakePack('a', null)];
    expect(selectPack(packs, head, 'a')?.pack.id).toBe('a');
    expect(selectPack(packs, head, 'zzz')).toBeNull();
  });

  it('returns the matched container when the pack reports one', () => {
    const pack = { ...fakePack('a', 0.7), probeContainer: () => ({ container: 'ng', confidence: 0.7 }) };
    expect(selectPack([pack], head)).toEqual({ pack, container: 'ng' });
  });

  it('formatId leaves the container undefined so the pack re-probes', () => {
    const pack = { ...fakePack('a', null), probeContainer: () => null };
    expect(selectPack([pack], head, 'a')).toEqual({ pack, container: undefined });
  });

  it('registry lists midi then pcap then zip and exposes the probe head size', () => {
    expect(REGISTERED_PACKS.map((pack) => pack.id)).toEqual(['standard_midi_file', 'pcap', 'zip']);
    expect(PROBE_HEAD_BYTES).toBe(4096);
  });
});
