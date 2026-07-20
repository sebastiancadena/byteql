# DuckDB-WASM parquet extensions

These are the official signed DuckDB-WASM v1.5.4 parquet extension binaries mirrored for ByteQL's
same-origin, zero-runtime-network deployment.

| Platform | Upstream URL | SHA-256 |
|---|---|---|
| `wasm_eh` | `https://extensions.duckdb.org/v1.5.4/wasm_eh/parquet.duckdb_extension.wasm` | `4845705bbd69fc9ad52878d96a505c73cae4a6c509822079cc2413e5eb437f95` |
| `wasm_mvp` | `https://extensions.duckdb.org/v1.5.4/wasm_mvp/parquet.duckdb_extension.wasm` | `b64c255a7f7d06cc234535b2f0ecab345fda91bffff5509d3179004bc13aa19a` |

Downloaded with HTTP content decoding enabled so the stored files begin with the WebAssembly magic
bytes and can be loaded directly by DuckDB. Their embedded DuckDB signatures remain intact.
