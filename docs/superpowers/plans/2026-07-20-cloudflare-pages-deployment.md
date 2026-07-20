# Cloudflare Pages Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guarded, repeatable Cloudflare Pages release path and deploy ByteQL to the new
`byteql` Pages project.

**Architecture:** Vite copies a source-controlled `public/_headers` file into the production
artifact. A small Node verifier treats the built `dist` directory as the release boundary, while
root package scripts compose build, repository checks, privacy audit, artifact verification, and
Wrangler upload. The first project creation and live-edge verification remain explicit one-time
operations.

**Tech Stack:** pnpm workspace scripts, Vite static assets, Node.js ESM, Vitest, Wrangler 4.x,
Cloudflare Pages Direct Upload.

## Global Constraints

- Deploy only `apps/web/dist`; never deploy `apps/web/dist-e2e`.
- Target Pages project `byteql` and production branch `main` explicitly.
- Keep `/index.html` uncached with `Cache-Control: no-cache`.
- Apply immutable one-year caching only to content-hashed `.wasm` assets.
- Do not add COOP/COEP while ByteQL has no pthread worker or `SharedArrayBuffer` requirement.
- Preserve unrelated worktree files and changes.
- Keep ByteQL's zero-runtime-network privacy contract intact.

---

### Task 1: Pages artifact contract

**Files:**

- Create: `apps/web/scripts/verify-pages-artifact.test.ts`
- Create: `apps/web/scripts/verify-pages-artifact.mjs`
- Create: `apps/web/public/_headers`

**Interfaces:**

- Consumes: a build directory passed as `process.argv[2]`.
- Produces: exit code `0` and a concise success line for a valid artifact; a thrown error and
  non-zero exit for missing headers, stable WASM names, or threaded worker assets.

**Steps:**

- [ ] **Step 1: Write failing verifier tests**

Create temporary build directories in `verify-pages-artifact.test.ts` and spawn
`node scripts/verify-pages-artifact.mjs <fixture>`. Cover a valid fixture plus independent failures
for an absent `_headers` file, a stable `duckdb-eh.wasm` name, and a
`duckdb-browser-coi.pthread.worker.js` asset.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @byteql/web exec vitest run scripts/verify-pages-artifact.test.ts
```

Expected: FAIL because `scripts/verify-pages-artifact.mjs` does not exist.

- [ ] **Step 3: Implement the minimal artifact verifier**

Implement an ESM CLI using `node:fs/promises` and `node:path`. Require this exact normalized header
contract:

```text
/*.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable

/index.html
  Cache-Control: no-cache
```

Walk the artifact recursively, require `index.html`, require at least one `.wasm`, accept only WASM
basenames matching `/-[A-Za-z0-9_-]{8,}\.wasm$/u`, and reject filenames matching
`/(?:pthread|duckdb-browser-coi|sharedworker)/iu`.

- [ ] **Step 4: Add the source-controlled Pages headers**

Create `apps/web/public/_headers` with the exact contract above. Do not add COOP or COEP headers.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @byteql/web exec vitest run scripts/verify-pages-artifact.test.ts
```

Expected: four tests pass with pristine output.

- [ ] **Step 6: Commit the artifact contract**

```bash
git add apps/web/public/_headers apps/web/scripts/verify-pages-artifact.mjs \
  apps/web/scripts/verify-pages-artifact.test.ts
git commit -m "build(web): verify Pages release artifacts"
```

### Task 2: Repeatable release commands and documentation

**Files:**

- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**

- Consumes: Task 1's `verify-pages-artifact.mjs` CLI and the existing production build/checks.
- Produces: `pnpm verify:pages`, `pnpm deploy:pages`, and `pnpm release:pages`.

**Steps:**

- [ ] **Step 1: Write a failing package-script assertion**

Extend `apps/web/scripts/verify-pages-artifact.test.ts` with a test that reads the repository root
`package.json` and expects:

```json
{
  "verify:pages": "node apps/web/scripts/verify-pages-artifact.mjs apps/web/dist",
  "deploy:pages": "pnpm verify:pages && wrangler pages deploy apps/web/dist --project-name=byteql --branch=main",
  "release:pages": "pnpm check && pnpm check:bundle && pnpm deploy:pages"
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run the Task 1 focused Vitest command. Expected: the package-script assertion fails because the
three scripts are absent.

- [ ] **Step 3: Add the minimal root scripts**

Add the exact three scripts above to root `package.json`. Keep project creation out of routine
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

### Task 3: Production artifact and first deployment

**Files:**

- Verify generated: `apps/web/dist/index.html`
- Verify generated: `apps/web/dist/_headers`
- Verify generated: `apps/web/dist/assets/*.wasm`

**Interfaces:**

- Consumes: Tasks 1-2 release commands and an authenticated Wrangler 4.x session.
- Produces: Cloudflare Pages project `byteql` with a verified production deployment.

**Steps:**

- [ ] **Step 1: Run the full preflight without external upload**

Run:

```bash
pnpm check
pnpm check:bundle
pnpm verify:pages
```

Expected: all commands exit `0`; verifier reports the number of hashed WASM assets inspected.

- [ ] **Step 2: Inspect the generated contract**

Confirm `dist/_headers` equals `public/_headers`, all `.wasm` files are content-hashed, no threaded
worker exists, and no file exceeds Cloudflare Pages' 25 MiB per-file upload limit.

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
