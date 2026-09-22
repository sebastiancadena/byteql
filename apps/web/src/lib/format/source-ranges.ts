export type SourceRangePieceValue = { start: bigint | number; end: bigint | number };

export const isSourceRangesValue = (value: unknown): value is Iterable<SourceRangePieceValue> =>
  value !== null &&
  typeof value === 'object' &&
  Symbol.iterator in value &&
  typeof (value as { toArray?: unknown }).toArray === 'function';

const pairs = (value: Iterable<SourceRangePieceValue>) =>
  Array.from(value, (piece) => `${String(piece.start)}-${String(piece.end)}`);

export const sourceRangesCsv = (value: Iterable<SourceRangePieceValue>): string => pairs(value).join(';');

export const sourceRangesSummary = (value: Iterable<SourceRangePieceValue>, maxPieces = 3): string => {
  const all = pairs(value);
  const shown = all.slice(0, maxPieces).join('; ');
  const rest = all.length > maxPieces ? `; … +${all.length - maxPieces} more` : '';
  return `${all.length} ranges · ${shown}${rest}`;
};
