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

export type AssemblerAddStatus = 'added' | 'rebased' | 'duplicate' | 'conflict' | 'dropped' | 'truncated';

export interface AssemblerAddOutcome {
  status: AssemblerAddStatus;
  /** Some incoming bytes overlapped stored bytes and differed; the stored bytes were kept. */
  conflicted: boolean;
  /** A prefix below the locked (consumed > 0) base was discarded. */
  trimmedBelowBase: boolean;
}

interface StoredSegment {
  /** Absolute offset-space [start, end) (the raw `offset` values, not rebased). */
  start: number;
  end: number;
  srcStart: number;
  srcEnd: number;
}

/** A half-open absolute file byte range `[start, end)`. */
export interface SourcePiece {
  start: number;
  end: number;
}

/**
 * Canonical exact-provenance form: empty pieces dropped, sorted by start, overlapping or
 * touching pieces merged. Null when at most one piece remains — a single range is already exact
 * and is expressed by `_src_start`/`_src_end` alone.
 */
export const normalizeRanges = (pieces: readonly SourcePiece[]): SourcePiece[] | null => {
  const sorted = pieces
    .filter((piece) => piece.end > piece.start)
    .map((piece) => ({ start: piece.start, end: piece.end }))
    .sort((a, b) => a.start - b.start);
  const merged: SourcePiece[] = [];
  for (const piece of sorted) {
    const last = merged[merged.length - 1];
    if (last && piece.start <= last.end) last.end = Math.max(last.end, piece.end);
    else merged.push(piece);
  }
  return merged.length >= 2 ? merged : null;
};

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

  /**
   * Reconciles `[offset, offset + bytes.length)` against stored segments: bytes overlapping an
   * already-stored range are compared (first-arrived bytes win — a mismatch is reported as a
   * conflict but never overwrites what's stored) and only the fresh (uncovered) sub-ranges are
   * actually stored, so `#segments` always stays sorted and non-overlapping and exact
   * `_src_ranges` provenance per stored piece stays correct. A prefix below the locked
   * (`#consumed > 0`) base is trimmed and reported rather than rejecting the whole call.
   */
  // `srcEnd` is accepted (every caller passes it, matching srcStart/bytes.length symmetrically)
  // but unused in the body: an accepted range's end is always srcStart + bytes.length, computed
  // fresh per stored piece in #store below.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for call-site symmetry, see above
  add(offset: number, bytes: Uint8Array, srcStart: number, srcEnd: number): AssemblerAddOutcome {
    let trimmedBelowBase = false;
    if (this.#base !== null && this.#consumed > 0 && offset < this.#base) {
      const cut = Math.min(this.#base - offset, bytes.length);
      trimmedBelowBase = true;
      if (cut === bytes.length) return { status: 'dropped', conflicted: false, trimmedBelowBase };
      offset += cut;
      srcStart += cut;
      bytes = bytes.subarray(cut);
    }
    const end = offset + bytes.length;

    // Covered/fresh split over the stored segments this range touches (sorted, non-overlapping).
    const fresh: { start: number; end: number }[] = [];
    let conflicted = false;
    let cursor = offset;
    for (let i = this.#firstEndingAfter(offset); i < this.#segments.length; i += 1) {
      const s = this.#segments[i]!;
      if (s.start >= end) break;
      if (s.start > cursor) fresh.push({ start: cursor, end: s.start });
      const coveredStart = Math.max(s.start, offset);
      const coveredEnd = Math.min(s.end, end);
      if (!conflicted && !this.#matchesStored(coveredStart, coveredEnd, bytes, offset)) conflicted = true;
      cursor = Math.max(cursor, coveredEnd);
    }
    if (cursor < end) fresh.push({ start: cursor, end });
    if (fresh.length === 0) {
      return { status: conflicted ? 'conflict' : 'duplicate', conflicted, trimmedBelowBase };
    }

    const freshStart = fresh[0]!.start;
    const freshEnd = fresh[fresh.length - 1]!.end;
    const rebasing = this.#base !== null && freshStart < this.#base; // consumed === 0 here
    const newBase = this.#base === null ? freshStart : Math.min(this.#base, freshStart);
    const newExtent = Math.max(freshEnd, this.#highestEndAbs ?? freshEnd) - newBase;
    if (newExtent > this.#maxBuffer) return { status: 'truncated', conflicted, trimmedBelowBase };
    // See #rebaseTo for the cost bound of a rebase.
    if (rebasing) this.#rebaseTo(newBase, newExtent);
    else this.#base = newBase;

    for (const piece of fresh) {
      this.#store(
        piece.start,
        bytes.subarray(piece.start - offset, piece.end - offset),
        srcStart + (piece.start - offset),
        srcStart + (piece.end - offset),
      );
    }
    this.#advanceFrontier();
    return { status: rebasing ? 'rebased' : 'added', conflicted, trimmedBelowBase };
  }

  /** Index of the first stored segment whose end is past `offset` (ends are non-decreasing). */
  #firstEndingAfter(offset: number): number {
    let lo = 0;
    let hi = this.#segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#segments[mid]!.end <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #matchesStored(start: number, end: number, bytes: Uint8Array, offset: number): boolean {
    const base = this.#base!;
    for (let p = start; p < end; p += 1) {
      if (this.#data[p - base] !== bytes[p - offset]) return false;
    }
    return true;
  }

  /**
   * Stores one fresh (already known not to overlap any existing segment), non-empty piece:
   * grows/copies `#data`, inserts a sorted `StoredSegment`, and updates the byte/src-span
   * counters and `#highestEndAbs`. Assumes `#base` is already final for this `add` call — the
   * caller settles the base (including any rebase) before calling this.
   */
  #store(start: number, bytes: Uint8Array, srcStart: number, srcEnd: number): void {
    const end = start + bytes.length;
    const relStart = start - this.#base!;
    if (relStart + bytes.length > this.#data.length) {
      const needed = relStart + bytes.length;
      const grown = new Uint8Array(Math.min(Math.max(needed, this.#data.length * 2), this.#maxBuffer));
      grown.set(this.#data);
      this.#data = grown;
    }
    this.#data.set(bytes, relStart);

    const segment: StoredSegment = { start, end, srcStart, srcEnd };
    let insertedAt: number;
    const lastSegment = this.#segments[this.#segments.length - 1];
    if (lastSegment === undefined || start > lastSegment.start) {
      this.#segments.push(segment);
      insertedAt = this.#segments.length - 1;
    } else {
      const at = this.#segments.findIndex((s) => s.start > start);
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
  }

  /**
   * Pins the stream base to `offset` without storing bytes (an open/SYN segment).
   * `'anchored'`: base was null, now `offset`. `'rebased'`: `offset` is below the current base,
   * nothing has been consumed yet, and the resulting extent fits `maxBuffer` — the base moves
   * down and stored data shifts accordingly. `'ignored'`: any other case (offset at/above base,
   * consumed > 0, or the rebase extent would exceed the cap). Never stores a segment; does not
   * change `byteCount`, `segmentCount`, or `srcSpan`.
   */
  anchor(offset: number): 'anchored' | 'rebased' | 'ignored' {
    if (this.#base === null) {
      this.#base = offset;
      return 'anchored';
    }
    if (offset >= this.#base || this.#consumed > 0) return 'ignored';
    const newExtent = (this.#highestEndAbs ?? this.#base) - offset;
    if (newExtent > this.#maxBuffer) return 'ignored';
    this.#rebaseTo(offset, newExtent);
    this.#advanceFrontier();
    return 'rebased';
  }

  // Cost bound: a rebase is an O(extent) copy of #data plus the O(n) segment-array
  // insertion/frontier rescan in add()'s caller path (once per #store call — splitting a
  // conflicting/bridging add into several fresh pieces adds at most one #firstEndingAfter binary
  // search plus one linear pass over the segments the range touches, not an extra pass per
  // piece), so an adversarial strictly-descending arrival order (each segment rebasing the base
  // further down) is worst-case quadratic in the number of segments. That's deliberately accepted
  // rather than engineered away: #maxBuffer hard-bounds the extent factor, and callers
  // abort-check per record upstream, so the quadratic blowup can only ever run over a bounded
  // buffer for a bounded record count. If this ever shows up as a real cost, the fix is to stop
  // reusing the linear #segments array for insertion and reach for an index that supports
  // O(log n) insertion (e.g. a sorted tree/skip list) instead.
  #rebaseTo(newBase: number, newExtent: number): void {
    const shift = this.#base! - newBase;
    const shiftedLen = Math.min(Math.max(this.#data.length + shift, newExtent), this.#maxBuffer);
    const shifted = new Uint8Array(shiftedLen);
    shifted.set(this.#data, shift);
    this.#data = shifted;
    // contiguousEnd is a filled-from-base frontier; a rebase moves the base, so reset it
    // (and the cached frontier scan index) here and let #advanceFrontier recompute it from
    // the (re-sorted) segments.
    this.#contiguousEnd = 0;
    this.#frontierIndex = 0;
    this.#base = newBase;
  }

  #advanceFrontier(): void {
    const base = this.#base!;
    let frontier = this.#contiguousEnd;
    let i = this.#frontierIndex;
    while (i < this.#segments.length) {
      const s = this.#segments[i]!;
      if (s.start - base > frontier) break;
      if (s.end - base > frontier) frontier = s.end - base;
      i++;
    }
    this.#frontierIndex = i;
    this.#contiguousEnd = frontier;
  }
}
