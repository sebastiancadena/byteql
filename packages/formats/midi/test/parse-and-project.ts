import type { ParseProgress, ParseResult } from '@byteql/core';
import { collectSource } from '@byteql/core/testing';

import { midiFormatPack } from '../src/index.js';

export const parseAndProjectMidi = async (
  bytes: Uint8Array,
  signal: AbortSignal,
  onProgress?: (p: ParseProgress) => void,
): Promise<ParseResult> =>
  collectSource(midiFormatPack, bytes, {
    signal,
    ...(onProgress ? { onProgress } : {}),
  });
