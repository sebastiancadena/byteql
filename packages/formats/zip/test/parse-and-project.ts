import type { ByteSource, ParseProgress, ParseResult } from '@byteql/core';
import { collectSource } from '@byteql/core/testing';

import { zipFormatPack } from '../src/index.js';

export const parseAndProjectZip = async (
  source: ByteSource,
  signal: AbortSignal,
  onProgress?: (p: ParseProgress) => void,
): Promise<ParseResult> =>
  collectSource(zipFormatPack, await source.read(0, source.size), {
    signal,
    ...(onProgress ? { onProgress } : {}),
  });
