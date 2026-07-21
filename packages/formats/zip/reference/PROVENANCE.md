# ZIP structural reference

`zip.ksy` is the upstream Kaitai Struct definition of the ZIP container
(<https://formats.kaitai.io/zip/>), committed here as **field-layout provenance only**.

It is NOT compiled or imported. The authoritative reader is the hand-written
`src/container.ts`, which walks the archive via random access (End Of Central
Directory → central directory → local headers by offset) rather than the
sequential, whole-file scan Kaitai generates. Keep this file in sync with the
byte offsets in `container.ts` when either changes.
