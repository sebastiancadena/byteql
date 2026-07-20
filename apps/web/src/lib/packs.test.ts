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
    expect(selectPack(packs, head)?.id).toBe('b');
  });

  it('first-registered pack wins ties and zero confidence never selects', () => {
    expect(selectPack([fakePack('a', 0.5), fakePack('b', 0.5)], head)?.id).toBe('a');
    expect(selectPack([fakePack('a', 0), fakePack('b', null)], head)).toBeNull();
  });

  it('formatId bypasses probing and misses return null', () => {
    const packs = [fakePack('a', null)];
    expect(selectPack(packs, head, 'a')?.id).toBe('a');
    expect(selectPack(packs, head, 'zzz')).toBeNull();
  });

  it('registry lists midi then pcap and exposes the probe head size', () => {
    expect(REGISTERED_PACKS.map((pack) => pack.id)).toEqual(['standard_midi_file', 'pcap']);
    expect(PROBE_HEAD_BYTES).toBe(4096);
  });
});
