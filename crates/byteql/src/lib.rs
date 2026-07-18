//! # ByteQL
//!
//! **SQL for binary files.** ByteQL turns record-oriented binary formats —
//! pcaps, event logs, registry hives, MIDI, proprietary telemetry — into
//! relational tables you can join, filter, and aggregate, while preserving the
//! link back to the exact bytes.
//!
//! This crate is an early placeholder for the Rust component of the ByteQL
//! project. The API is not yet stable. See the project repository for status:
//! <https://github.com/sebastiancadena/byteql>.

/// Returns the crate version as declared in `Cargo.toml`.
///
/// ```
/// assert!(!byteql::version().is_empty());
/// ```
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_reported() {
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
    }
}
