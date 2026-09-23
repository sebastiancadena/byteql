import type { FormatPack } from '@byteql/core';
import { midiFormatPack } from '@byteql/midi';
import { pcapFormatPack } from '@byteql/pcap';
import { zipFormatPack } from '@byteql/zip';

/** Canonical pack registration order — probing ties break toward the earlier entry. */
export const REGISTERED_PACKS: readonly FormatPack[] = [midiFormatPack, pcapFormatPack, zipFormatPack];

export const PROBE_HEAD_BYTES = 4096;

export interface SelectedPack {
  pack: FormatPack;
  container: string | undefined;
}

export const selectPack = (
  packs: readonly FormatPack[],
  head: Uint8Array,
  formatId?: string,
): SelectedPack | null => {
  if (formatId !== undefined) {
    const pack = packs.find((candidate) => candidate.id === formatId);
    return pack ? { pack, container: undefined } : null;
  }
  let best: SelectedPack | null = null;
  let bestConfidence = 0;
  // Strict `>`: the first-registered pack wins ties, and a confidence of 0 is never selected.
  for (const pack of packs) {
    const match = pack.probeContainer?.(head) ?? null;
    const confidence = match?.confidence ?? pack.probe(head);
    if (confidence !== null && confidence > bestConfidence) {
      best = { pack, container: match?.container };
      bestConfidence = confidence;
    }
  }
  return best;
};
