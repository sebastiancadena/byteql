import KaitaiStream from 'kaitai-struct/KaitaiStream.js';

export interface KaitaiReadable {
  _read(): void;
}

/** Construct `GenClass` over a DataView that preserves `bytes.byteOffset`, then `_read()` (may throw). */
export const kaitaiParse = <T extends KaitaiReadable>(
  GenClass: new (stream: KaitaiStream) => T,
  bytes: Uint8Array,
): T => {
  const parsed = new GenClass(
    new KaitaiStream(new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)),
  );
  parsed._read();
  return parsed;
};

/**
 * `{ bytes, start }` payload range for a field read from the top-level stream. `start` is
 * `_debug.<field>.start`: relative to the view the wrapper was handed, NOT `ioOffset + start`.
 * The engine composes absolute provenance as `baseOffset + payload.start`; adding ioOffset
 * would double-count the enclosing layers.
 */
export const payload = (
  parsed: { _debug: Record<string, { start: number }> },
  field: string,
): { bytes: Uint8Array; start: number } => ({
  bytes: (parsed as unknown as Record<string, Uint8Array>)[field]!,
  start: parsed._debug[field]!.start,
});
