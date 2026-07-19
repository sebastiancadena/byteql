const OFFSET_PATTERN = /^([+-])?(?:0x([0-9a-f]+)|(\d+))$/iu;

/** Parses '0x1a2b', '6699', '+16', '-0x10'. Relative forms apply to `reference`. */
export function parseOffsetInput(text: string, reference: number): number | 'invalid' {
  const match = OFFSET_PATTERN.exec(text.trim());
  if (!match) return 'invalid';
  const [, sign, hex, dec] = match;
  const magnitude = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? '', 10);
  if (!Number.isFinite(magnitude)) return 'invalid';
  if (sign === undefined) return magnitude;
  return sign === '-' ? reference - magnitude : reference + magnitude;
}
