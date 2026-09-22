export type SourceRangePieceValue = { start: bigint | number; end: bigint | number };

const pairs = (value: Iterable<SourceRangePieceValue>) =>
  Array.from(value, (piece) => `${String(piece.start)}-${String(piece.end)}`);

export const sourceRangesCsv = (value: Iterable<SourceRangePieceValue>): string => pairs(value).join(';');

export const sourceRangesSummary = (value: Iterable<SourceRangePieceValue>, maxPieces = 3): string => {
  const all = pairs(value);
  const shown = all.slice(0, maxPieces).join('; ');
  const rest = all.length > maxPieces ? `; … +${all.length - maxPieces} more` : '';
  return `${all.length} ranges · ${shown}${rest}`;
};
