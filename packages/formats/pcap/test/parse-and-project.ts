import type {
  ByteSource,
  OpenOptions,
  OpenWithOptions,
  ParseProgress,
  ParseResult,
  RecordSource,
} from '@byteql/core';
import { collectSource } from '@byteql/core/testing';

import { pcapFormatPack } from '../src/index.js';

export const parseAndProjectPcap = async (
  bytes: Uint8Array,
  signal: AbortSignal,
  onProgress?: (p: ParseProgress) => void,
): Promise<ParseResult> =>
  collectSource(pcapFormatPack, bytes, {
    signal,
    ...(onProgress ? { onProgress } : {}),
  });

export const openPcapSource = (
  source: ByteSource,
  opts: OpenOptions,
  tuning: Omit<OpenWithOptions, 'container'> = {},
): RecordSource => pcapFormatPack.openWith(source, opts, { container: 'pcap', ...tuning });
