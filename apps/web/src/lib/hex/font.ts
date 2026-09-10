/** The single canvas font contract: hit testing and painting must never disagree. */
export function measureHexFont(
  context: Pick<CanvasRenderingContext2D, 'font' | 'measureText'>,
  family: string,
): { fontSpec: string; charWidth: number } {
  const fontSpec = `12px ${family}`;
  context.font = fontSpec;
  const measured = context.measureText('0').width;
  return { fontSpec, charWidth: Number.isFinite(measured) && measured > 0 ? measured : 7.2 };
}
