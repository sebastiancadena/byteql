export type SourceRangePieceValue = { start: bigint | number; end: bigint | number };

/** A `.length`-bearing `_src_ranges` cell value, like the `Vector` a list column's `.get(row)` returns. */
export type SourceRangesValue = Iterable<SourceRangePieceValue> & { length?: number };

const formatPiece = (piece: SourceRangePieceValue): string => `${String(piece.start)}-${String(piece.end)}`;

export const sourceRangesCsv = (value: Iterable<SourceRangePieceValue>): string =>
  Array.from(value, formatPiece).join(';');

/**
 * A hostile reassembled capture can carry ~1M pieces. Formats only the first `maxPieces` and
 * takes the total from `value.length` when it is available (e.g. an Arrow `Vector`), so this
 * never does per-piece string work proportional to a huge list; when `.length` is absent it
 * still counts every piece (cheap) without formatting them.
 */
export const sourceRangesSummary = (value: SourceRangesValue, maxPieces = 3): string => {
  const knownTotal = typeof value.length === 'number';
  let total = knownTotal ? (value.length as number) : 0;
  const shown: string[] = [];
  for (const piece of value) {
    if (shown.length < maxPieces) shown.push(formatPiece(piece));
    if (!knownTotal) total += 1;
    else if (shown.length >= maxPieces) break;
  }
  const rest = total > maxPieces ? `; … +${total - maxPieces} more` : '';
  return `${total} ranges · ${shown.join('; ')}${rest}`;
};
