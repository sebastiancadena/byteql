# Task 7 — Browser Acceptance and Startup Regression Report

## Outcome

Browser acceptance now proves cursor-backed result demand can reach one million rows without
re-sending SQL, retaining browser-height geometry, or exceeding the decoded-page memory bound.
The guarded e2e harness exposes read-only diagnostics and invokes the production demand/window
methods; it does not provide a second query-loading path.

## RED → GREEN

- RED: the new million-row browser test initially failed at
  `window.__BYTEQL_E2E__.drainQueryResult` because the e2e-only query harness seam did not exist.
  The first run also exposed stale non-exact result-count selectors after paged-result UI copy
  introduced an end-of-result status.
- GREEN: `query-result-scrolling.spec.ts`, `privacy.spec.ts`, and `scale-metrics.spec.ts` passed
  together: 6/6 in 24.3 s. The million-row run reached exact EOF, stored 123 local Arrow pages,
  retained a maximum 16,384-row DOM window, rehydrated row 1 after visiting row 1,000,000, and
  retained a `sendCount` of one.

## Browser coverage added

- Physical wheel demand beyond the initial 1,024 rows; drain-to-EOF; exact `1,000,000 rows` copy.
- One-millionth and first-row visibility, bounded virtual spacer, bounded decoded Arrow cache,
  and one DuckDB cursor send.
- OPFS `byteql-results/<generation>/<page>.arrow` enumeration, replacement cancellation cleanup,
  and reload orphan sweeping.
- Multi-page privacy assertion: no post-ready network events and result pages remain local OPFS
  scratch paths only.
- Startup/sample regressions: all stale one-click sample assumptions now choose the MIDI menu item;
  result-count checks target the heading rather than the duplicated footer status.
- Scale benchmark waits for the new query's unique `ts` column before measuring, then drains the
  same production demand path before read-stat export. Final measured 100,664,055-byte capture:
  6,473.4 ms parse, 303.6 ms query, 1.74% read fraction.

## Verification

- `pnpm -r check` — pass (including Svelte: 0 errors, 0 warnings).
- `pnpm -r test -- --run` — pass: core 225, db 100, MIDI 52, pcap 85 plus one intentional skip,
  zip 10, and web 321 tests. The existing jsdom canvas `getContext` notices remain in that unit
  command; no test failed.
- `pnpm --filter @byteql/web check:bundle` — pass: source URL audit and 9-asset bundle audit.
- `pnpm --filter @byteql/web test:e2e` — pass: 30 Chromium tests. The focused final browser run
  above also passed 6/6 after the last metrics-path assertion change.

## Files changed

- Browser harness/app/controller: `apps/web/src/App.svelte`, `apps/web/src/lib/e2e-harness.ts`,
  `apps/web/src/lib/session/controller.ts`, and e2e global types.
- Result diagnostic source: `packages/db/src/{browser,query-pages,types}.ts`.
- Browser tests and helpers under `apps/web/e2e/`, including the focused scrolling, privacy,
  startup/performance, scale, and stale selector/menu regressions.

## Environment notes

Chromium e2e was available and used directly. Vite emits its existing chunk-size advisory and
Node emits the existing `NO_COLOR`/`FORCE_COLOR` advisory while Playwright starts; neither caused
a test failure. No environment limitation blocked this task.

## Review round 1 remediation

- The send metric is no longer a literal. `PendingQueryToken.sendCount` increments immediately
  after the real `connection.send(sql)` resolves, and `QuerySession.status()` reads that token.
  The DB multi-page test now asserts `sendCount === 1` before and after a second page fetch while
  also asserting DuckDB's `send` mock was called exactly once. The browser test checks the same
  value after wheel demand, full drain, and backward window hydration.
- `queryResultMetrics()` is now asynchronous and enumerates `byteql-results/` for every call;
  there is no cached path priming or ordering dependency. The privacy test uses this same single
  diagnostic call.
- Replacement coverage captures the incomplete generation's exact paths, waits for the replacement
  generation, requires its one expected page, and asserts no previous path survives.
- Reload coverage seeds `byteql-results/777/0.arrow` and an adjacent non-generated
  `byteql-results/manual-notes/keep.txt` through an e2e-only OPFS fixture. A reload must remove
  the exact numeric orphan while preserving the manual entry.
- RED: before this remediation, the revised focused spec saw empty cached metric paths and lacked
  `seedResultPageOrphan`; 3 of 4 scrolling tests failed. GREEN:
  `pnpm --filter @byteql/db test -- --run` passed 100 tests and
  `pnpm --filter @byteql/web test:e2e -- query-result-scrolling.spec.ts privacy.spec.ts` passed
  5 Chromium tests in 14.1 s.
