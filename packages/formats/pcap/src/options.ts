/**
 * pcapng option lists: a sequence of (code u16, length u16, value padded to 4) entries in the
 * section byte order, ended by opt_endofopt (code 0) or by the end of the options area.
 */

export type OptionWalk = 'ok' | 'malformed';

/**
 * Visits each option in `[start, end)` of `view`. Returns 'malformed' when an option header or
 * value does not fit; options visited before that point stay visited.
 */
export function walkOptions(
  view: DataView,
  start: number,
  end: number,
  littleEndian: boolean,
  visit: (code: number, valueStart: number, valueLength: number) => void,
): OptionWalk {
  let offset = start;
  while (offset + 4 <= end) {
    const code = view.getUint16(offset, littleEndian);
    const length = view.getUint16(offset + 2, littleEndian);
    if (code === 0) return 'ok';
    const valueStart = offset + 4;
    if (valueStart + length > end) return 'malformed';
    visit(code, valueStart, length);
    offset = valueStart + ((length + 3) & ~3);
  }
  return offset >= end ? 'ok' : 'malformed';
}

const decoder = new TextDecoder('utf-8');

/** A UTF-8 option value; writers sometimes include trailing NULs, which are dropped. */
export function optionText(bytes: Uint8Array, start: number, length: number): string {
  let stop = start + length;
  while (stop > start && bytes[stop - 1] === 0) stop -= 1;
  return decoder.decode(bytes.subarray(start, stop));
}
