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

/**
 * A segment as returned by `segmentsOverlapping`: `start`/`end` are stream-relative to the
 * CURRENT base (i.e. already rebased), while `srcStart`/`srcEnd` are absolute file offsets.
 */
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
  /** Index of the first segment not yet folded into #contiguousEnd; monotonic except reset to 0 on rebase. */
  #frontierIndex = 0;
  /** Highest absolute segment end seen so far (absolute offset space), null when no segments. */
  #highestEndAbs: number | null = null;
  /** Lowest/highest absolute srcStart/srcEnd seen so far, null when no segments. */
  #srcMin: number | null = null;
  #srcMax: number | null = null;

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
    return this.#highestEndAbs === null ? 0 : this.#highestEndAbs - (this.#base ?? 0);
  }
  get srcSpan(): { start: number; end: number } | null {
    if (this.#srcMin === null || this.#srcMax === null) return null;
    return { start: this.#srcMin, end: this.#srcMax };
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

    // #segments is sorted ascending by start and (being non-overlapping) has non-decreasing
    // ends along that order too. Scanning backward from the highest starts lets both checks
    // below short-circuit on the common ascending-append path (typically 1 comparison) while
    // still covering the full array in adversarial/gap-filling cases — same semantics as a
    // plain .some() scan, just ordered to exploit the sortedness invariant.
    for (let i = this.#segments.length - 1; i >= 0; i--) {
      const s = this.#segments[i]!;
      if (s.start === offset) {
        if (s.end === end) return 'duplicate';
        break; // start is unique among non-overlapping segments; no other can match it
      }
      if (s.start < offset) break;
    }
    for (let i = this.#segments.length - 1; i >= 0; i--) {
      const s = this.#segments[i]!;
      if (s.start < end && offset < s.end) return 'overlap';
      if (s.end <= offset) break; // ends are non-increasing going backward from here
    }

    const rebasing = this.#base !== null && offset < this.#base;
    if (rebasing && this.#consumed > 0) return 'below_base';
    const newBase = this.#base === null ? offset : Math.min(this.#base, offset);
    const newExtent = Math.max(end, this.#highestEndAbs ?? end) - newBase;
    if (newExtent > this.#maxBuffer) return 'truncated';

    if (rebasing) {
      const shift = this.#base! - newBase;
      const shiftedLen = Math.min(Math.max(this.#data.length + shift, newExtent), this.#maxBuffer);
      const shifted = new Uint8Array(shiftedLen);
      shifted.set(this.#data, shift);
      this.#data = shifted;
      // contiguousEnd is a filled-from-base frontier; a rebase moves the base, so reset it
      // (and the cached frontier scan index) here and let the frontier scan below recompute
      // it from the (re-sorted) segments.
      this.#contiguousEnd = 0;
      this.#frontierIndex = 0;
    }
    this.#base = newBase;

    const relStart = offset - this.#base;
    if (relStart + bytes.length > this.#data.length) {
      const needed = relStart + bytes.length;
      const grown = new Uint8Array(Math.min(Math.max(needed, this.#data.length * 2), this.#maxBuffer));
      grown.set(this.#data);
      this.#data = grown;
    }
    this.#data.set(bytes, relStart);

    const segment: StoredSegment = { start: offset, end, srcStart, srcEnd };
    let insertedAt: number;
    const lastSegment = this.#segments[this.#segments.length - 1];
    if (lastSegment === undefined || offset > lastSegment.start) {
      this.#segments.push(segment);
      insertedAt = this.#segments.length - 1;
    } else {
      const at = this.#segments.findIndex((s) => s.start > offset);
      if (at < 0) {
        this.#segments.push(segment);
        insertedAt = this.#segments.length - 1;
      } else {
        this.#segments.splice(at, 0, segment);
        insertedAt = at;
      }
    }
    this.#byteCount += bytes.length;
    this.#highestEndAbs = this.#highestEndAbs === null ? end : Math.max(this.#highestEndAbs, end);
    this.#srcMin = this.#srcMin === null ? srcStart : Math.min(this.#srcMin, srcStart);
    this.#srcMax = this.#srcMax === null ? srcEnd : Math.max(this.#srcMax, srcEnd);
    if (insertedAt < this.#frontierIndex) this.#frontierIndex = insertedAt;

    let frontier = this.#contiguousEnd;
    let i = this.#frontierIndex;
    while (i < this.#segments.length) {
      const s = this.#segments[i]!;
      if (s.start - this.#base > frontier) break;
      if (s.end - this.#base > frontier) frontier = s.end - this.#base;
      i++;
    }
    this.#frontierIndex = i;
    this.#contiguousEnd = frontier;
    return rebasing ? 'rebased' : 'added';
  }
}
