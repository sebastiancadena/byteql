export interface StreamKeyContext {
  node: unknown;
  ancestors: readonly unknown[];
}

export interface StreamKeyResult {
  key: string;
  root: Readonly<Record<string, unknown>>;
}

export type StreamKeyExtractor = (context: StreamKeyContext) => StreamKeyResult | null;

/** Returns the total byte length of the first message once determinable (MAY exceed buffer.length — the engine waits), null when undeterminable; a throw or non-positive length stalls framing. */
export type StreamFramer = (buffer: Uint8Array) => number | null;

export type StreamKeyRegistry = ReadonlyMap<string, StreamKeyExtractor>;

export type StreamFramerRegistry = ReadonlyMap<string, StreamFramer>;

export interface StreamRegistries {
  keyExtractors?: StreamKeyRegistry;
  framers?: StreamFramerRegistry;
}

export interface AssemblerSegment {
  start: number;
  end: number;
  srcStart: number;
  srcEnd: number;
}

export type AssemblerAddResult = 'added' | 'rebased' | 'duplicate' | 'below_base' | 'overlap' | 'truncated';

interface StoredSegment {
  /** Absolute offset-space [start, end) (the raw `offset` values, not rebased). */
  start: number;
  end: number;
  srcStart: number;
  srcEnd: number;
}

export class StreamAssembler {
  readonly #maxBuffer: number;
  #base: number | null = null;
  #data = new Uint8Array(0);
  /** Sorted by start; absolute offset space. */
  #segments: StoredSegment[] = [];
  #consumed = 0;
  #contiguousEnd = 0; // relative to #base
  #byteCount = 0;

  constructor(maxBuffer: number) {
    this.#maxBuffer = maxBuffer;
  }

  get base(): number | null {
    return this.#base;
  }
  get segmentCount(): number {
    return this.#segments.length;
  }
  get byteCount(): number {
    return this.#byteCount;
  }
  get consumed(): number {
    return this.#consumed;
  }
  get contiguousEnd(): number {
    return this.#contiguousEnd;
  }
  get highestEnd(): number {
    if (this.#base === null || this.#segments.length === 0) return 0;
    return Math.max(...this.#segments.map((s) => s.end)) - this.#base;
  }
  get srcSpan(): { start: number; end: number } | null {
    if (this.#segments.length === 0) return null;
    return {
      start: Math.min(...this.#segments.map((s) => s.srcStart)),
      end: Math.max(...this.#segments.map((s) => s.srcEnd)),
    };
  }

  hasGap(): boolean {
    return this.highestEnd > this.#contiguousEnd;
  }
  pendingBytes(): number {
    return this.#contiguousEnd - this.#consumed;
  }
  contiguousView(): Uint8Array {
    return this.#data.subarray(this.#consumed, this.#contiguousEnd);
  }
  consume(length: number): void {
    this.#consumed += length;
  }

  segmentsOverlapping(start: number, end: number): AssemblerSegment[] {
    const base = this.#base ?? 0;
    return this.#segments
      .filter((s) => s.start - base < end && start < s.end - base)
      .map((s) => ({ start: s.start - base, end: s.end - base, srcStart: s.srcStart, srcEnd: s.srcEnd }));
  }

  add(offset: number, bytes: Uint8Array, srcStart: number, srcEnd: number): AssemblerAddResult {
    const end = offset + bytes.length;
    if (this.#segments.some((s) => s.start === offset && s.end === end)) return 'duplicate';
    if (this.#segments.some((s) => s.start < end && offset < s.end)) return 'overlap';

    const rebasing = this.#base !== null && offset < this.#base;
    if (rebasing && this.#consumed > 0) return 'below_base';
    const newBase = this.#base === null ? offset : Math.min(this.#base, offset);
    const newExtent = Math.max(end, ...this.#segments.map((s) => s.end), newBase) - newBase;
    if (newExtent > this.#maxBuffer) return 'truncated';

    if (rebasing) {
      const shift = this.#base! - newBase;
      const shifted = new Uint8Array(Math.max(this.#data.length + shift, newExtent));
      shifted.set(this.#data, shift);
      this.#data = shifted;
      // contiguousEnd is a filled-from-base frontier; a rebase moves the base, so reset it
      // here and let the frontier scan below recompute it from the (re-sorted) segments.
      this.#contiguousEnd = 0;
    }
    this.#base = newBase;

    const relStart = offset - this.#base;
    if (relStart + bytes.length > this.#data.length) {
      const grown = new Uint8Array(Math.max(relStart + bytes.length, this.#data.length * 2));
      grown.set(this.#data);
      this.#data = grown;
    }
    this.#data.set(bytes, relStart);

    const segment: StoredSegment = { start: offset, end, srcStart, srcEnd };
    const at = this.#segments.findIndex((s) => s.start > offset);
    if (at < 0) this.#segments.push(segment);
    else this.#segments.splice(at, 0, segment);
    this.#byteCount += bytes.length;

    let frontier = this.#contiguousEnd;
    for (const s of this.#segments) {
      if (s.start - this.#base > frontier) break;
      if (s.end - this.#base > frontier) frontier = s.end - this.#base;
    }
    this.#contiguousEnd = frontier;
    return rebasing ? 'rebased' : 'added';
  }
}
