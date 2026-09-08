# ByteQL Phase 0 privacy boundary

ByteQL Phase 0 is a static browser application. It has no application backend, analytics endpoint,
telemetry client, remote format pack, CDN dependency, remote soundfont, or remote sample. Local file
bytes, file names, SQL text, projected rows, and playback data remain inside the browser process.

## Readiness boundary

Before the application publishes `[data-app-ready="true"]`, the page loads same-origin static
JavaScript, DuckDB WebAssembly and workers, and the repository-authored demo fixture. Static hosting
logs can therefore see the ordinary page and asset requests. They cannot see a later local file
selection or its contents.

After readiness, parsing, SQL, row inspection, result export, worker recreation, and audio-viewer use
require zero network request events. The Chromium acceptance test installs its request listener only
after the readiness marker, blocks service workers so requests cannot bypass observation, opens a
uniquely named local fixture, executes SQL containing a unique sentinel, inspects provenance, exports
fallback CSV and Parquet files, exercises an export write failure and a repeated export, and opens a
stubbed audio capability. It requires the literal recorded request list to be empty and also checks
every recorded URL, header, and body for the file name and SQL sentinel.

## Local export data

Downloads use only result pages from the completed query cursor; ByteQL does not send or rerun the
SQL to create an export. Result pages may be retained temporarily under the origin-private
`byteql-results/` directory. Fallback export files and Parquet staging use per-tab, per-export
directories under `byteql-exports/`. A direct browser save handle writes to the user-selected local
file instead. Fallback files and their object URLs remain available after browser handoff until
dismissal, replacement, or controller disposal. Cancellation and failure also clean up the owned
temporary export. The app does not remove another tab's active export.

CSV can fall back to an in-memory Blob only when OPFS and a save handle are unavailable; that route
stops before exceeding 64 MiB of encoded output. Parquet requires OPFS because its bounded writer
uses local shards before producing one final file. A crashed tab can leave origin-private temporary
files. When creating export files, ByteQL sweeps only UUID-shaped inactive owners when Web Locks
can prove they are not live; without Web Locks it leaves other owners untouched.

The production-visible CSV and Parquet export flows, including their workers, destination failures,
and repeated exports, run while the post-readiness request listener is installed and produce zero
request events.

Independent artifact readback is a separate instrumented acceptance operation and is not part of
that production request assertion. The reader is excluded from the production bundle. After an
artifact has been captured, it creates a fresh test-only DuckDB database and worker, which can load
and decompress same-origin bundled DuckDB and Parquet-extension assets after application readiness.
Those local asset loads are request events even though no data leaves the origin. The reader then
applies the `byteql-exports/` allowlist, disables external access, locks its own configuration, and
only then reads the registered captured artifact. It does not relax the production database's
filesystem or external-access settings.

Run the authoritative browser check with:

```bash
pnpm --filter @byteql/web test:e2e -- privacy.spec.ts
```

`check:bundle` separately rejects direct external URL/CDN references in repository runtime source,
including CSS `@import` and `url()` text, rejects actual jsDelivr or unpkg endpoint URLs in built
JavaScript/CSS, reports all asset sizes, and checks that normal production assets contain no E2E hook
markers. A controlled regression creates a temporary runtime CSS import and proves that audit fails.
Upstream libraries can contain inert documentation URLs or package metadata strings; the
post-readiness Chromium request test is authoritative for runtime network behavior.

Playwright compiles its narrowly gated test hooks into `apps/web/dist-e2e` and previews only that
directory. Deployable `apps/web/dist` is always produced without the gate and remains the target of
`check:bundle`; running browser acceptance does not replace it.

## Hosting and threat boundary

- Serve the generated `apps/web/dist` directory as immutable static files over HTTPS.
- Hosting access logs can observe initial page and static-asset requests, client IP information, and
  browser headers. They do not observe local file operations or SQL.
- A compromised host can replace application assets and is outside this client-only privacy claim.
  Pin releases, use HTTPS, and apply the hosting platform's normal integrity and access controls.
- Browser extensions and local device compromise are outside the application boundary.
- Do not add analytics, remote fonts, remote audio assets, CDN imports, or runtime-loaded executable
  format packs without revisiting the privacy tests and design.
