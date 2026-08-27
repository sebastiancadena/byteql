# Final paged-query e2e fixes

## Root causes and fixes

- The shared `runSql` helper could race CodeMirror's startup transition: the editor is
  temporarily `contenteditable="false"` while the automatic overview query runs. It now waits
  for `contenteditable="true"` before calling `fill`, and the inspect flow uses that helper.
- During a paged-window rebase, TanStack's virtualizer can report the previous local range for a
  frame even though the scroll element has already moved to the physical tail. `ResultGrid` now
  derives the demand range from `scrollTop`/`clientHeight` when available, so the final forward
  demand is not lost behind stale virtual items.
- Demand checks are coalesced to one `requestAnimationFrame`; a window rebase cancels an already
  queued demand frame and clears suppression on its own frame. This prevents an old callback from
  re-entering demand during rebase while allowing the scroll event/state effect to schedule the
  next check.

## TDD RED -> GREEN

- RED was the pre-fix focused browser state: the inspect flow intermittently attempted `.fill()`
  while CodeMirror was non-editable, and the million-row flow could finish its demand loop with
  no rendered `Row 1000000`. The new `visibleResultRange` unit cases also fail to compile before
  that helper exists.
- GREEN: the focused inspect + scrolling run passed all 5 tests, including exact EOF, row
  1,000,000, one real DuckDB send, and bounded window/geometry assertions. The scrolling file
  remained green for 5 repetitions (20/20 tests).

## Verification

- `pnpm --filter @byteql/web test:e2e -- e2e/open-query-inspect.spec.ts e2e/query-result-scrolling.spec.ts` — 5 passed.
- `pnpm --filter @byteql/web test:e2e -- e2e/query-result-scrolling.spec.ts --repeat-each=5` — 20 passed.
- `pnpm --filter @byteql/web test:e2e -- e2e/open-query-inspect.spec.ts e2e/query-result-scrolling.spec.ts e2e/privacy.spec.ts` — 6 passed.
- `pnpm --filter @byteql/web exec vitest run src/lib/session/result-scroll.test.ts` — 6 passed.
- `pnpm --filter @byteql/web exec vitest run src/lib/session/result-scroll.test.ts src/components/Workbench.test.ts` — 49 passed.
- `pnpm --filter @byteql/web check` — 0 errors, 0 warnings.
- `pnpm -r check` — passed.
- `git diff --check` — passed.

## Limitations

The rAF check is browser-acceptance covered under Chromium, not a deterministic scheduler test;
the 5-repeat run provides repeatability but cannot prove behavior under every browser scheduler.
The existing Vite chunk-size and Node `NO_COLOR` advisories remain non-failing.
