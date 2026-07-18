# ByteQL

> **SQL for binary files.** Wireshark's dissector philosophy, generalized to
> every record-oriented format.

ByteQL turns *any* record-oriented binary file — pcaps, event logs, registry
hives, MIDI, proprietary telemetry — into relational tables you can join,
filter, and aggregate, while preserving byte-level provenance back to the exact
offsets each row and cell came from.

## Status

This crate is a **name-reservation placeholder** for the Rust component of the
ByteQL project. It currently exposes nothing beyond a `version()` function —
none of the query, parsing, or provenance functionality described above is
implemented here yet. The real Phase 0 implementation lives in the TypeScript
workspace of the repository; a Rust component (sandboxed wasm plugins such as
an EVTX parser) is planned for a later phase and will land in this crate when
that work begins. The API is not stable and will change.

- Repository: <https://github.com/sebastiancadena/byteql>

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.
