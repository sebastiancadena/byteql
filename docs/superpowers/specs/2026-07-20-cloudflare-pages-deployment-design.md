# Cloudflare Pages deployment design

## Goal

Deploy ByteQL as a new Cloudflare Pages Direct Upload project named `byteql`, and leave a
repeatable, guarded release path for later versions. Custom-domain attachment for `byteql.dev`
is explicitly deferred.

## Deployment model

ByteQL remains a static Vite application. Production assets are built into `apps/web/dist` and
uploaded with the already-installed Wrangler CLI. The one-time project creation targets the
`byteql` Pages project with `main` as its production branch. Routine releases target that project
explicitly and do not attempt project creation.

Direct Upload is intentional for this deployment. Moving this project to Cloudflare's Git
integration later would require creating a separate Pages project; the repeatable local release
command is therefore part of the repository contract.

## Static response headers

Author `apps/web/public/_headers` so Vite copies it unchanged to `apps/web/dist/_headers`, beside
`index.html`. The file contains four rules:

- `/*.wasm` sets `Content-Type: application/wasm` and
  `Cache-Control: public, max-age=31536000, immutable`.
- `/*.wasm.gz` sets `Content-Type: application/gzip` and the same immutable cache policy.
- `/duckdb-extensions/*` explicitly preserves the WASM MIME type and immutable cache policy for
  the locally mirrored, versioned DuckDB extension binaries.
- `/index.html` sets `Cache-Control: no-cache` so a new deployment's entry point propagates without
  retaining references to an older asset graph.

The normal Vite build emits 34.3 MiB and 39.4 MiB DuckDB modules, above Cloudflare Pages' 25 MiB
per-file limit. The Pages preparation step therefore gzip-compresses each content-hashed `.wasm`
asset, rewrites its generated JavaScript reference to `.wasm.gz`, and removes the oversized raw
module from the deployable artifact. The compressed modules are about 8-9 MiB each.

The database runtime recognizes `.wasm.gz`, fetches and decompresses it with the browser's
`DecompressionStream`, creates an `application/wasm` blob URL, and gives that URL to DuckDB's worker.
DuckDB therefore retains its `WebAssembly.instantiateStreaming()` fast path against a correctly
typed response without relying on Pages to decode a precompressed static file. The blob URL is
revoked after DuckDB finishes instantiation.

DuckDB-WASM dynamically loads its signed Parquet extension. ByteQL mirrors the official v1.5.4 EH
and MVP binaries under `/duckdb-extensions` and loads the selected variant by an absolute
same-origin URL before disabling extension loading and locking the database configuration. This
prevents DuckDB's default startup request to `extensions.duckdb.org` from violating ByteQL's
zero-runtime-network contract. Their upstream URLs and checksums live in the artifact's
`PROVENANCE.md`.

Immutable caching is safe for the generated modules because Vite emits content-hashed filenames,
and for the mirrored extension because its path is versioned and the recorded binary is fixed. The
release artifact verification must reject a stable generated WASM filename, a missing local
extension, a remaining generated raw `.wasm`, or any file above 25 MiB before deployment.

Do not add `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy`. ByteQL registers only
DuckDB-WASM's MVP and exception-handling bundles and provides no `pthreadWorker`, so the deployed
application does not require `SharedArrayBuffer` or cross-origin isolation. If a threaded bundle
is introduced later, that change must deliberately revisit the headers and the privacy tests.

## Release automation

Add a focused artifact verifier under `apps/web/scripts`. It checks the production output rather
than source intent:

1. `dist/index.html` and `dist/_headers` exist.
2. The `_headers` rules and values match the deployment contract.
3. At least one `.wasm.gz` asset exists and every module basename carries Vite's content-hash
   segment.
4. Both versioned, same-origin Parquet extension variants are present.
5. No generated raw `.wasm` or file above 25 MiB remains in the deployable directory.
6. No threaded DuckDB/PThread worker asset is present unless the header policy is deliberately
   updated in the same change.

The verifier receives co-located Vitest coverage for accepted and rejected temporary artifacts.

Expose repository-level commands with distinct responsibilities:

- `prepare:pages` gzip-compresses and rewrites the production WASM assets.
- `verify:pages` validates the prepared Pages artifact.
- `deploy:pages` verifies the existing artifact and uploads it to project `byteql`, branch `main`.
- `release:pages` runs the full production check, the privacy/bundle audit, Pages preparation,
  artifact verification, and then `deploy:pages`.

The deployment command uses Wrangler's explicit project and branch flags. It must not publish
`dist-e2e`; only `apps/web/dist` is deployable.

## Failure handling

Any build, test, formatting, privacy, bundle, or artifact-verification failure stops the release
before Wrangler runs. Wrangler authentication, network, project-creation, or upload failures are
reported without modifying local build outputs. A failed first deployment leaves either no project
or an empty Pages project, both safe to retry.

Existing unrelated worktree changes are preserved and excluded from deployment-specific commits.

## Verification and acceptance

Before the first upload:

1. Run the verifier's unit tests through the web package test suite.
2. Run the full production release preflight without its external upload step.
3. Inspect `apps/web/dist` to confirm hashed `.wasm.gz` assets, only the two expected extension
   `.wasm` files, the 25 MiB ceiling, and `_headers` placement.
4. Create the `byteql` project with production branch `main`, then deploy the verified directory.

After upload, request the live production URL and confirm:

- the application reaches its ready state;
- a compressed WASM response has immutable caching and DuckDB initializes from its locally
  decompressed `application/wasm` blob;
- `/index.html` is served with `Cache-Control: no-cache`;
- the response does not carry COOP/COEP headers;
- no request leaves the site origin during startup or after readiness, consistent with ByteQL's
  privacy contract.

The returned `*.pages.dev` URL and deployment identifier are recorded in the handoff. Attaching
`byteql.dev` is a later Cloudflare Pages custom-domain operation and is not performed here.
