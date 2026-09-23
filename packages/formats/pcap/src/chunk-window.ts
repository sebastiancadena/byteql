/**
 * A chunk-window reader over a `ByteSource`, shared by the classic-pcap and pcapng readers.
 *
 * Reads are served from one `chunkBytes`-sized window (reloaded at the requested offset, not
 * slid), so framing never needs the whole capture in memory. A span larger than one chunk is
 * read directly as an isolated copy. `generation` bumps on every reload that replaces an
 * already-loaded window (the very first load, which fills the still-empty window, does not
 * count); `stable()` applies the straddle-copy rule: a chunk view obtained after such a reload
 * happened while framing the current record is copied, so it stays valid across later reads.
 */

import type { ByteSource } from '@byteql/core';

/** A window read, and whether the returned bytes are a view into the mutable chunk. */
export interface WindowRead {
  bytes: Uint8Array;
  isChunkView: boolean;
}

export interface ChunkWindow {
  /** Bumped every time an already-loaded window is reloaded (not on the initial load). */
  readonly generation: number;
  /** Returns `[absoluteStart, absoluteStart + length)`, reloading the window if needed. */
  ensure(absoluteStart: number, length: number): Promise<WindowRead>;
  /** `read.bytes`, copied when it is a chunk view and a reload happened since `generationAtStart`. */
  stable(read: WindowRead, generationAtStart: number): Uint8Array;
}

export function createChunkWindow(source: ByteSource, chunkBytes: number, start: number): ChunkWindow {
  // `chunk[i]` is absolute offset `chunkStart + i`.
  let chunk: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let chunkStart = start;
  let generation = 0;
  // The very first load fills an empty window rather than reloading an established one, so it
  // doesn't count as a "reload" for `stable()`'s straddle check.
  let primed = false;

  return {
    get generation() {
      return generation;
    },
    async ensure(absoluteStart, length) {
      const within = absoluteStart - chunkStart;
      if (within >= 0 && within + length <= chunk.length) {
        return { bytes: chunk.subarray(within, within + length), isChunkView: true };
      }
      if (length > chunkBytes) {
        // Larger than one chunk: read it directly rather than growing the shared window. Already
        // an isolated copy, so no reload/generation bump is needed.
        return { bytes: await source.read(absoluteStart, length), isChunkView: false };
      }
      chunkStart = absoluteStart;
      chunk = await source.read(absoluteStart, Math.max(chunkBytes, length));
      if (primed) generation += 1;
      primed = true;
      return { bytes: chunk.subarray(0, length), isChunkView: true };
    },
    stable(read, generationAtStart) {
      return read.isChunkView && generation !== generationAtStart ? read.bytes.slice() : read.bytes;
    },
  };
}
