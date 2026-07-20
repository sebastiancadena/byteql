import type { FormatPack } from '@byteql/core';
import { midiFormatPack } from '@byteql/midi';
import { pcapFormatPack } from '@byteql/pcap';

/** Canonical pack registration order — probing ties break toward the earlier entry. */
export const REGISTERED_PACKS: readonly FormatPack[] = [midiFormatPack, pcapFormatPack];

export const PROBE_HEAD_BYTES = 4096;

export const selectPack = (
  packs: readonly FormatPack[],
  head: Uint8Array,
  formatId?: string,
): FormatPack | null => {
  if (formatId !== undefined) return packs.find((pack) => pack.id === formatId) ?? null;
  let best: FormatPack | null = null;
  let bestConfidence = 0;
  // Strict `>`: the first-registered pack wins ties, and a confidence of 0 is never selected.
  for (const pack of packs) {
    const confidence = pack.probe(head);
    if (confidence !== null && confidence > bestConfidence) {
      best = pack;
      bestConfidence = confidence;
    }
  }
  return best;
};
