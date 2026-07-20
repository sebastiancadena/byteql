# Cloudflare Pages Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guarded, repeatable Cloudflare Pages release path and deploy ByteQL to the new
`byteql` Pages project.

**Architecture:** Vite copies a source-controlled `public/_headers` file into the production
artifact. A tested preparation CLI gzip-compresses Pages' oversized DuckDB modules and rewrites
their generated URLs; the database runtime locally decompresses them into `application/wasm` blob
URLs before worker instantiation. A separate verifier treats the prepared `dist` directory as the
release boundary, while root scripts compose checks, preparation, verification, and Wrangler upload.

**Tech Stack:** pnpm workspace scripts, Vite static assets, Node.js ESM, Vitest, Wrangler 4.x,
Cloudflare Pages Direct Upload.

## Global Constraints

- Deploy only `apps/web/dist`; never deploy `apps/web/dist-e2e`.
- Target Pages project `byteql` and production branch `main` explicitly.
- Keep `/index.html` uncached with `Cache-Control: no-cache`.
- Apply immutable one-year caching only to content-hashed `.wasm` and `.wasm.gz` assets.
- Reject every deployable file larger than Cloudflare Pages' 25 MiB per-file limit.
- Do not add COOP/COEP while ByteQL has no pthread worker or `SharedArrayBuffer` requirement.
- Preserve unrelated worktree files and changes.
- Keep ByteQL's zero-runtime-network privacy contract intact.

---

### Task 1: Compressed WASM runtime

**Files:**

- Modify: `packages/db/src/browser.test.ts`
- Modify: `packages/db/src/browser.ts`

**Interfaces:**

- Consumes: a DuckDB bundle whose `mainModule` may end in `.wasm.gz`.
- Produces: an `application/wasm` blob URL used only for instantiation and revoked afterward.

**Steps:**

- [ ] **Step 1: Write the failing compressed-module test**

Add a `browser.test.ts` case that selects a `.wasm.gz` module, supplies real gzip bytes through a
mocked same-origin fetch, and expects DuckDB instantiation to receive a blob URL whose decoded bytes
start with `00 61 73 6d`. Assert that the URL is revoked after instantiation.

- [ ] **Step 2: Run the database test and verify RED**

Run `pnpm --filter @byteql/db test -- --run`. Expected: the compressed-module assertion fails
because the runtime forwards the `.wasm.gz` URL unchanged.

- [ ] **Step 3: Implement minimal runtime decompression**

In `browser.ts`, leave ordinary module URLs unchanged. For `.wasm.gz`, require an OK response body,
pipe it through `new DecompressionStream('gzip')`, create an `application/wasm` Blob and object URL,
instantiate DuckDB with that URL, and revoke it in `finally`.

- [ ] **Step 4: Run the database test and verify GREEN**

Run `pnpm --filter @byteql/db test -- --run`. Expected: all database tests pass.

- [ ] **Step 5: Commit the runtime support**

```bash
git add packages/db/src/browser.ts packages/db/src/browser.test.ts
git commit -m "feat(db): load compressed WASM modules"
```

### Task 2: Pages artifact preparation and contract

**Files:**

- Create: `apps/web/scripts/prepare-pages-artifact.test.ts`
- Create: `apps/web/scripts/prepare-pages-artifact.mjs`
- Create: `apps/web/scripts/verify-pages-artifact.test.ts`
- Create: `apps/web/scripts/verify-pages-artifact.mjs`
- Create: `apps/web/public/_headers`

**Interfaces:**

- Consumes: an ordinary Vite build directory passed as `process.argv[2]`.
- Produces: content-hashed `.wasm.gz` modules below 25 MiB, rewritten JavaScript asset references,
  and a verifier exit code that rejects an invalid deployable directory.

**Steps:**

- [ ] **Step 1: Write failing preparation and verifier tests**

Test that preparation gzip-compresses a raw hashed module, rewrites its exact JavaScript reference,
and removes the raw file. Test the verifier with a valid prepared fixture plus independent failures
for absent headers, stable module names, remaining raw WASM, files over 25 MiB, and a pthread asset.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @byteql/web exec vitest run scripts/prepare-pages-artifact.test.ts \
  scripts/verify-pages-artifact.test.ts
```

Expected: FAIL because both implementation CLIs do not exist.

- [ ] **Step 3: Implement preparation and verification CLIs**

Preparation uses `node:zlib` gzip level 9, exact emitted filenames, and fails if a module reference
is missing or ambiguous. Verification requires this normalized header contract:

```text
/*.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable

/*.wasm.gz
  Content-Type: application/gzip
  Cache-Control: public, max-age=31536000, immutable

/index.html
  Cache-Control: no-cache
```

Walk recursively, require `index.html`, require hashed `.wasm.gz`, reject raw `.wasm`, reject files
above 25 MiB, and reject names matching `/(?:pthread|duckdb-browser-coi|sharedworker)/iu`.

- [ ] **Step 4: Add the source-controlled Pages headers**

Create `apps/web/public/_headers` with the exact contract above. Do not add COOP or COEP headers.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @byteql/web exec vitest run scripts/verify-pages-artifact.test.ts
```

Expected: all preparation and verifier tests pass with pristine output.

- [ ] **Step 6: Commit the artifact contract**

```bash
git add apps/web/public/_headers apps/web/scripts/prepare-pages-artifact.mjs \
  apps/web/scripts/prepare-pages-artifact.test.ts apps/web/scripts/verify-pages-artifact.mjs \
  apps/web/scripts/verify-pages-artifact.test.ts
git commit -m "build(web): verify Pages release artifacts"
```

### Task 3: Repeatable release commands and documentation

**Files:**

- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**

- Consumes: Task 2's preparation/verifier CLIs and the existing production build/checks.
- Produces: `pnpm prepare:pages`, `pnpm verify:pages`, `pnpm deploy:pages`, and
  `pnpm release:pages`.

**Steps:**

- [ ] **Step 1: Write a failing package-script assertion**

Extend `apps/web/scripts/verify-pages-artifact.test.ts` with a test that reads the repository root
`package.json` and expects:

```json
{
  "prepare:pages": "node apps/web/scripts/prepare-pages-artifact.mjs apps/web/dist",
  "verify:pages": "node apps/web/scripts/verify-pages-artifact.mjs apps/web/dist",
  "deploy:pages": "pnpm verify:pages && wrangler pages deploy apps/web/dist --project-name=byteql --branch=main",
  "release:pages": "pnpm check && pnpm check:bundle && pnpm prepare:pages && pnpm deploy:pages"
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run the Task 2 focused Vitest command. Expected: the package-script assertion fails because the
four scripts are absent.

- [ ] **Step 3: Add the minimal root scripts**

Add the exact four scripts above to root `package.json`. Keep project creation out of routine
release scripts.

- [ ] **Step 4: Document release and one-time creation commands**

Add a concise `Cloudflare Pages` section to `README.md` documenting:

```bash
wrangler pages project create byteql --production-branch=main
pnpm release:pages
```

State that `release:pages` targets `byteql/main`, publishes only `apps/web/dist`, and requires an
authenticated Wrangler session. Note that `byteql.dev` is intentionally not attached yet.

- [ ] **Step 5: Run focused tests and checks**

Run:

```bash
pnpm --filter @byteql/web exec vitest run scripts/verify-pages-artifact.test.ts
pnpm --filter @byteql/web check
pnpm exec prettier --check package.json README.md apps/web/public/_headers \
  apps/web/scripts/verify-pages-artifact.mjs apps/web/scripts/verify-pages-artifact.test.ts
```

Expected: all commands exit `0`.

- [ ] **Step 6: Commit the repeatable release path**

```bash
git add package.json README.md apps/web/scripts/verify-pages-artifact.test.ts
git commit -m "build: add Cloudflare Pages release command"
```

### Task 4: Production artifact and first deployment

**Files:**

- Verify generated: `apps/web/dist/index.html`
- Verify generated: `apps/web/dist/_headers`
- Verify generated: `apps/web/dist/assets/*.wasm.gz`

**Interfaces:**

- Consumes: Tasks 1-3 release commands and an authenticated Wrangler 4.x session.
- Produces: Cloudflare Pages project `byteql` with a verified production deployment.

**Steps:**

- [ ] **Step 1: Run the full preflight without external upload**

Run:

```bash
pnpm check
pnpm check:bundle
pnpm prepare:pages
pnpm verify:pages
```

Expected: all commands exit `0`; verifier reports the number of hashed WASM assets inspected.

- [ ] **Step 2: Inspect the generated contract**

Confirm `dist/_headers` equals `public/_headers`, all `.wasm.gz` files are content-hashed, no raw
WASM or threaded worker exists, and no file exceeds Cloudflare Pages' 25 MiB per-file upload limit.

- [ ] **Step 3: Confirm Cloudflare authentication and project absence**

Run `wrangler whoami` and `wrangler pages project list`. Expected: the intended account is shown and
no project named `byteql` exists. If it already exists, stop before mutation and report the conflict.

- [ ] **Step 4: Create the Pages project**

Run:

```bash
wrangler pages project create byteql --production-branch=main
```

Expected: Wrangler reports successful project creation.

- [ ] **Step 5: Deploy the verified production artifact**

Run:

```bash
pnpm deploy:pages
```

Expected: Wrangler reports a successful production deployment and returns a `pages.dev` URL.

- [ ] **Step 6: Verify the live edge responses**

Request the returned production URL and a deployed WASM URL. Confirm app readiness, WASM content
type and immutable cache control, `index.html` no-cache, absence of COOP/COEP, and no cross-origin
runtime requests after readiness.

- [ ] **Step 7: Record fresh verification evidence**

Run `git status --short` and re-run the focused verifier test plus `pnpm verify:pages`. Report the
deployment URL, deployment identifier, command exit statuses, header observations, and any
unrelated pre-existing worktree files without modifying them.
