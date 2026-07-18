# ByteQL Phase 0 privacy boundary

ByteQL Phase 0 is a static browser application. It has no application backend, analytics endpoint,
telemetry client, remote format pack, CDN dependency, remote soundfont, or remote sample. Local file
bytes, file names, SQL text, projected rows, and playback data remain inside the browser process.

## Readiness boundary

Before the application publishes `[data-app-ready="true"]`, the page loads same-origin static
JavaScript, DuckDB WebAssembly and workers, and the repository-authored demo fixture. Static hosting
logs can therefore see the ordinary page and asset requests. They cannot see a later local file
selection or its contents.

After readiness, parsing, SQL, row inspection, worker recreation, and audio-viewer use require zero
network request events. The Chromium acceptance test installs its request listener only after the
readiness marker, blocks service workers so requests cannot bypass observation, opens a uniquely
named local fixture, executes SQL containing a unique sentinel, inspects provenance, and opens a
stubbed audio capability. It requires the literal recorded request list to be empty and also checks
every recorded URL, header, and body for the file name and SQL sentinel.

Run the authoritative browser check with:

```bash
pnpm --filter @byteql/web test:e2e -- privacy.spec.ts
```

`check:bundle` separately rejects direct external URL/CDN references in repository runtime source,
rejects actual jsDelivr or unpkg endpoint URLs in built JavaScript/CSS, reports all asset sizes, and
checks that normal production assets contain no E2E hook markers. Upstream libraries can contain
inert documentation URLs or package metadata strings; the post-readiness Chromium request test is
authoritative for runtime network behavior.

## Hosting and threat boundary

- Serve the generated `apps/web/dist` directory as immutable static files over HTTPS.
- Hosting access logs can observe initial page and static-asset requests, client IP information, and
  browser headers. They do not observe local file operations or SQL.
- A compromised host can replace application assets and is outside this client-only privacy claim.
  Pin releases, use HTTPS, and apply the hosting platform's normal integrity and access controls.
- Browser extensions and local device compromise are outside the application boundary.
- Do not add analytics, remote fonts, remote audio assets, CDN imports, or runtime-loaded executable
  format packs without revisiting the privacy tests and design.
