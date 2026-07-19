# Hex-Provenance UI & Polish (Phase 1 slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The canvas hex pane under the results grid with the bidirectional hex↔grid provenance
link (grid row → byte highlight; byte click → reveal covering row; structure shading;
filter-to-selection), plus the full-shell polish pass — closing out Phase 1's last slice and its
"hex↔grid round-trip works on every gallery format" exit criterion.

**Architecture:** Pure-TS hex modules (`apps/web/src/lib/hex/`): scroll/layout math, an LRU page
cache over the retained source `Blob`, a provenance interval index built from the result's
`_src_start`/`_src_end` Arrow columns, a selection reducer, and a canvas frame renderer — all
composed by a thin `HexPane.svelte`. Zero per-interaction DuckDB round-trips; no engine/worker/DB
changes beyond the controller retaining the source `Blob`.

**Tech Stack:** TypeScript, Svelte 5 (runes), apache-arrow JS, Canvas 2D, vitest + jsdom +
@testing-library/svelte, Playwright, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-07-19-phase1-hex-provenance-ui-design.md`.

## Global Constraints

- **Every commit keeps the whole workspace green:** `pnpm -r check`, `pnpm -r test -- --run`,
  `pnpm --filter @byteql/web check:bundle`, `pnpm --filter @byteql/web test:e2e` all pass at
  every task boundary (the e2e gate may be deferred to a task's final step, never broken at a
  commit). **Run `pnpm -r build` before any e2e run** — e2e resolves `@byteql/db` via built dist;
  un-rebuilt fixes are invisible (hard-won slice-2 lesson).
- **No engine/worker/DB changes.** Only `apps/web` is touched. Existing tables, rows, and
  provenance values are byte-identical for identical inputs.
- **Offset conventions (verified in `packages/core/src/projection/project.ts:1221`):**
  `_src_start` inclusive, `_src_end` EXCLUSIVE (`srcEnd = absoluteStart + payload.bytes.length`).
  All hex-module ranges `{ start, end }` are end-exclusive. A row covers offset `o` iff
  `start <= o < end`. The filter predicate for selection `[s, e)` is
  `_src_start < e and _src_end > s`.
- **Named constants (exact names, initial values):** `BYTES_PER_ROW = 16`, `MIN_THUMB_PX = 24`
  (`layout.ts`); `PAGE_BYTES = 64 * 1024`, `CACHE_BUDGET_BYTES = 8 * 1024 * 1024`
  (`byte-cache.ts`); `COVERAGE_ROW_CAP = 2_000_000` (`coverage.ts`). Test overrides via
  constructor options only, as documented per task.
- **Theming:** refined dark theme only. All new colors are CSS custom properties in
  `apps/web/src/app.css`; the canvas reads them via `getComputedStyle` at draw time. Monospace
  is always `var(--font-mono)`. Respect `prefers-reduced-motion` for every new animation.
- **Keyboard "Mod"** = `Meta` on macOS, `Ctrl` elsewhere (CodeMirror's `Mod-` convention; reuse
  `event.metaKey || event.ctrlKey` checks).
- **Persistence keys (localStorage):** `byteql.hexpane.height`, `byteql.hexpane.collapsed`.
- **Format gate:** prettier + eslint clean before every commit (`docs/superpowers/` and `PRD.md`
  are prettier-ignored; everything under `apps/` is not).
- **Conventional commits; no Co-Authored-By trailers or AI branding.**
- **Unit/component test env is jsdom** (repo convention — `apps/web` devDeps ship jsdom, not
  happy-dom). jsdom has no real canvas: `canvas.getContext('2d')` returns null — `HexPane`
  guards a null context (skips painting, uses fallback metrics), so component tests assert DOM
  and data attributes only; painting is unit-tested against a recording fake context.

## Reference: current shapes (verified) that tasks build on

- `apps/web/src/lib/session/state.ts`: `SessionState { phase; source: { name; size } | null;
  format; progress { completed; total; label; bytes }; openStartedAt; tables; issues; queries;
  capabilities; sql; result: Table | null; queryElapsedMs; queryError; selectedRow; fatalError }`;
  events `opening/progress/ready/queryStarted/querySucceeded/queryFailed/rowSelected/cancelled/
  failed`; `reduceSession` pure reducer; `'opening'` resets to `initialSessionState` spread.
- `apps/web/src/lib/session/controller.ts`: `SessionController` — `openFile(file)` sets
  `this.retainedFile = file` (kept until dispose/openSample); `openSample()` builds
  `new Blob([this.sampleBytes])`; `open(source, blob)` is the single funnel both call;
  `selectResultRow(row)` dispatches `rowSelected`; `runQuery(sql)`; generation guards via
  `isCurrent(generation)`; `dispatch` runs `reduceSession` + notifies subscribers.
- `apps/web/src/components/Workbench.svelte`: `ControllerPort { subscribe; openFile; openSample;
  runQuery; cancel; selectResultRow }`; `session` `$state` mirror; `draftSql`; `perform(action)`
  error funnel; `run(sql)`; auto-runs the pack `overview` query on ready; compact mode via
  `matchMedia('(max-width: 1099px)')`; center column markup:
  `.sql-workspace` grid `auto minmax(8rem, 28%) auto auto minmax(10rem, 1fr)` =
  editor-heading / SqlEditor / diagnostics / results-heading / `.results-panel`.
- `apps/web/src/components/ResultGrid.svelte`: TanStack `createVirtualizer` (`estimateSize: 36`,
  `overscan: 8`), `fields = table.schema.fields`, `gridColumns = repeat(n, minmax(9rem, 1fr))`,
  `valueAt(row, column)` via `table.getChildAt(column).get(row)`, `formatValue` (bigint →
  string; Uint8Array → hex preview ≤100 chars; text ≤100 chars), keyboard nav scrolls via
  `$virtualizer.scrollToIndex` — **only** on keyboard, not on external `selectedRow` change.
- `apps/web/src/components/Explorer.svelte`: props `{ state; collapsed; onquery(sql) }`; tables
  as `<details><summary>name + rowCount</summary><dl>columns</dl></details>`; saved-query
  buttons call `onquery(query.sql)` (load only, no run).
- `apps/web/src/components/Inspector.svelte`: `provenanceNames = new Set(['_src_start',
  '_src_end'])`; Values section skips them; Provenance section shows them via
  `formatValue(valueAt(i))`.
- `apps/web/src/components/StatusBar.svelte`: `statusLabel` derived; `progressPercent`;
  `progressRate` (MB/s from `progress.completed` + `openStartedAt`); metrics spans separated by
  left borders.
- `apps/web/src/components/AppHeader.svelte`: props `{ sourceName; explorerCollapsed;
  inspectorCollapsed; ontoggleexplorer; ontoggleinspector }`; grid `1fr minmax(8rem, auto) 1fr`.
- `apps/web/src/components/EmptyState.svelte`: props `{ busy; error; onopen(file); onsample }`;
  hidden `<input type="file" aria-label="Open file">` (e2e drives it via
  `page.getByLabel('Open file').setInputFiles(...)`); panel-local drag/drop; optional
  `showOpenFilePicker` path.
- `apps/web/src/App.svelte`: constructs `SessionController`, renders `<Workbench {controller}>`
  inside `data-app-ready` div; e2e harness attaches `globalThis.__byteqlE2E`.
- `apps/web/src/app.css`: single global stylesheet; tokens in `:root`; `.app-shell` grid
  `header / explorer workbench inspector / status`; mono stack duplicated inline as
  `ui-monospace, 'SFMono-Regular', Consolas, monospace` in 5 rule blocks (`.table-name`,
  `.schema-list dt/dd…`, `.shortcut`, `.grid-header > div`, `.grid-row > div`);
  `prefers-reduced-motion` kill-switch at the end.
- Arrow columns: `table.getChild('_src_start')` → `Vector | null`; `.get(row)` returns `bigint`
  for uint64 columns, `null` for null slots. Numbers ≤ 2^53 convert safely via `Number()`.
- E2e: specs in `apps/web/e2e/*.spec.ts`, fixtures `apps/web/e2e/fixtures/{sample.pcap,
  dns-stream.pcap}`; runner `pnpm --filter @byteql/web test:e2e` (wraps
  `scripts/run-playwright.mjs`); SQL typed via `page.getByRole('textbox', { name: 'SQL query'
  })`; run via button `Run query`; row select via `page.getByRole('row', { name: 'Row 1',
  exact: true }).click()`.
- Unit tests: `pnpm --filter @byteql/web exec vitest --run <path>`; full suite
  `pnpm --filter @byteql/web test`.

## File Structure

```text
apps/web/src/lib/hex/
  layout.ts          # BYTES_PER_ROW, metrics, column layout, hit-testing, scrollbar math
  layout.test.ts
  byte-cache.ts      # ByteCache: LRU pages over Blob, coalescing, subscribe, dispose
  byte-cache.test.ts
  coverage.ts        # buildCoverage / provenanceOfRow — interval index over _src_* columns
  coverage.test.ts
  selection.ts       # HexSelection reducer (click/drag/extend/move/record/clear)
  selection.test.ts
  render.ts          # drawHexFrame(ctx, frame) — pure painting against a CanvasTextContext
  render.test.ts
  goto.ts            # parseOffsetInput('0x1a2b' | '6699' | '+16' | '-16')
  goto.test.ts
  filter-sql.ts      # wrapFilterSql(sql, range)
  filter-sql.test.ts
apps/web/src/components/
  HexPane.svelte     # composition: toolbar, canvas, scrollbar, resize, aria
  HexPane.test.ts
  ShortcutsOverlay.svelte
  ShortcutsOverlay.test.ts
```

Modified: `state.ts`, `controller.ts` (+ their tests), `Workbench.svelte`, `ResultGrid.svelte`,
`Explorer.svelte`, `Inspector.svelte`, `StatusBar.svelte`, `AppHeader.svelte`,
`EmptyState.svelte`, `app.css`; new e2e spec `apps/web/e2e/hex-provenance.spec.ts`.

---

### Task 1: Hex layout & scrollbar math (`layout.ts`)

**Files:**
- Create: `apps/web/src/lib/hex/layout.ts`
- Test: `apps/web/src/lib/hex/layout.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Tasks 5, 7):
  `BYTES_PER_ROW: 16`; `MIN_THUMB_PX: 24`;
  `interface HexMetrics { charWidth: number; rowHeight: number; gutterDigits: number; padding: number }`;
  `interface ColumnLayout { gutterX: number; hexX: number; asciiX: number; width: number }`;
  `offsetDigits(fileSize: number): number`; `totalRows(fileSize: number): number`;
  `columnLayout(m: HexMetrics): ColumnLayout`;
  `hexByteX(m: HexMetrics, l: ColumnLayout, i: number): number`;
  `asciiByteX(m: HexMetrics, l: ColumnLayout, i: number): number`;
  `byteAtPoint(x: number, y: number, m: HexMetrics, l: ColumnLayout, firstRow: number, fileSize: number): number | null`;
  `rowsInView(heightPx: number, rowHeight: number): number`;
  `clampScrollRow(row: number, total: number, view: number): number`;
  `thumbGeometry(trackPx: number, total: number, view: number, scrollRow: number): { thumbPx: number; thumbTop: number }`;
  `scrollRowForThumbTop(topPx: number, trackPx: number, total: number, view: number): number`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/hex/layout.test.ts
import { describe, expect, it } from 'vitest';

import {
  BYTES_PER_ROW,
  byteAtPoint,
  clampScrollRow,
  columnLayout,
  hexByteX,
  offsetDigits,
  rowsInView,
  scrollRowForThumbTop,
  thumbGeometry,
  totalRows,
  type HexMetrics,
} from './layout.js';

const metrics: HexMetrics = { charWidth: 8, rowHeight: 18, gutterDigits: 8, padding: 12 };

describe('offsets and rows', () => {
  it('uses 8 gutter digits up to 4 GiB and grows in steps of 2 past it', () => {
    expect(offsetDigits(0)).toBe(8);
    expect(offsetDigits(2 ** 32)).toBe(8);
    expect(offsetDigits(2 ** 32 + 1)).toBe(10);
  });

  it('computes total rows, with an empty file still showing one row', () => {
    expect(totalRows(0)).toBe(1);
    expect(totalRows(16)).toBe(1);
    expect(totalRows(17)).toBe(2);
    expect(totalRows(4 * 2 ** 30)).toBe(268_435_456);
  });
});

describe('column layout and hit-testing', () => {
  const layout = columnLayout(metrics);

  it('lays out gutter, hex, and ascii regions left to right', () => {
    expect(layout.gutterX).toBe(12);
    expect(layout.hexX).toBe(12 + 10 * 8); // gutterDigits + 2 gap chars
    expect(layout.asciiX).toBe(layout.hexX + 49 * 8 + 16); // 16*3+1 mid-gap chars + 2 gap chars
    expect(layout.width).toBe(layout.asciiX + BYTES_PER_ROW * 8 + 12);
  });

  it('adds the mid-gap after byte 8', () => {
    expect(hexByteX(metrics, layout, 7)).toBe(layout.hexX + 21 * 8);
    expect(hexByteX(metrics, layout, 8)).toBe(layout.hexX + 25 * 8);
  });

  it('hit-tests hex cells (including the trailing gap) and ascii cells', () => {
    const y = 18 * 2 + 4; // third visible row
    const hexHit = byteAtPoint(hexByteX(metrics, layout, 3) + 5, y, metrics, layout, 10, 4096);
    expect(hexHit).toBe(12 * 16 + 3);
    const asciiHit = byteAtPoint(layout.asciiX + 8 * 5 + 2, y, metrics, layout, 10, 4096);
    expect(asciiHit).toBe(12 * 16 + 5);
  });

  it('returns null outside byte regions and past EOF', () => {
    expect(byteAtPoint(2, 4, metrics, layout, 0, 4096)).toBeNull();
    // y = 40 → row 2 → offset 2 * 16 + 2 = 34, past the 33-byte file
    expect(byteAtPoint(hexByteX(metrics, layout, 2), 40, metrics, layout, 0, 33)).toBeNull();
  });
});

describe('scrollbar mapping', () => {
  it('clamps the scroll row to the last full viewport', () => {
    expect(clampScrollRow(-5, 100, 20)).toBe(0);
    expect(clampScrollRow(95, 100, 20)).toBe(80);
    expect(clampScrollRow(5, 10, 20)).toBe(0);
  });

  it('round-trips thumb position to scroll row at 4 GiB scale', () => {
    const total = totalRows(4 * 2 ** 30);
    const view = rowsInView(360, 18);
    const scrollRow = 123_456_789;
    const { thumbPx, thumbTop } = thumbGeometry(300, total, view, scrollRow);
    expect(thumbPx).toBe(24); // MIN_THUMB_PX floor at this scale
    const roundTripped = scrollRowForThumbTop(thumbTop, 300, total, view);
    expect(Math.abs(roundTripped - scrollRow)).toBeLessThan(total / (300 - 24) + 1);
  });

  it('pins the thumb to the top when everything fits', () => {
    expect(thumbGeometry(300, 10, 20, 0)).toEqual({ thumbPx: 300, thumbTop: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @byteql/web exec vitest --run src/lib/hex/layout.test.ts`
Expected: FAIL — `Cannot find module './layout.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/lib/hex/layout.ts
/** Fixed hex-view geometry: 16 bytes per row, grouped 8 + 8 with a one-char mid-gap. */
export const BYTES_PER_ROW = 16;
/** Scrollbar thumb never shrinks below this, so it stays grabbable on multi-GB files. */
export const MIN_THUMB_PX = 24;

export interface HexMetrics {
  charWidth: number;
  rowHeight: number;
  gutterDigits: number;
  padding: number;
}

export interface ColumnLayout {
  gutterX: number;
  hexX: number;
  asciiX: number;
  width: number;
}

export function offsetDigits(fileSize: number): number {
  let digits = 8;
  while (fileSize > 2 ** (4 * digits)) digits += 2;
  return digits;
}

export const totalRows = (fileSize: number): number =>
  fileSize === 0 ? 1 : Math.ceil(fileSize / BYTES_PER_ROW);

export function columnLayout(m: HexMetrics): ColumnLayout {
  const gutterX = m.padding;
  const hexX = gutterX + (m.gutterDigits + 2) * m.charWidth;
  const hexWidth = (BYTES_PER_ROW * 3 + 1) * m.charWidth;
  const asciiX = hexX + hexWidth + 2 * m.charWidth;
  return { gutterX, hexX, asciiX, width: asciiX + BYTES_PER_ROW * m.charWidth + m.padding };
}

export const hexByteX = (m: HexMetrics, layout: ColumnLayout, i: number): number =>
  layout.hexX + (i * 3 + (i >= BYTES_PER_ROW / 2 ? 1 : 0)) * m.charWidth;

export const asciiByteX = (m: HexMetrics, layout: ColumnLayout, i: number): number =>
  layout.asciiX + i * m.charWidth;

export function byteAtPoint(
  x: number,
  y: number,
  m: HexMetrics,
  layout: ColumnLayout,
  firstRow: number,
  fileSize: number,
): number | null {
  const row = firstRow + Math.floor(y / m.rowHeight);
  if (row < 0) return null;
  let index: number | null = null;
  if (x >= layout.asciiX && x < layout.asciiX + BYTES_PER_ROW * m.charWidth) {
    index = Math.floor((x - layout.asciiX) / m.charWidth);
  } else if (x >= layout.hexX && x < layout.asciiX - 2 * m.charWidth) {
    for (let i = BYTES_PER_ROW - 1; i >= 0; i -= 1) {
      const left = hexByteX(m, layout, i);
      if (x >= left) {
        if (x < left + 3 * m.charWidth) index = i;
        break;
      }
    }
  }
  if (index === null) return null;
  const offset = row * BYTES_PER_ROW + index;
  return offset < fileSize ? offset : null;
}

export const rowsInView = (heightPx: number, rowHeight: number): number =>
  Math.max(1, Math.floor(heightPx / rowHeight));

export const clampScrollRow = (row: number, total: number, view: number): number =>
  Math.max(0, Math.min(row, Math.max(0, total - view)));

export function thumbGeometry(
  trackPx: number,
  total: number,
  view: number,
  scrollRow: number,
): { thumbPx: number; thumbTop: number } {
  if (total <= view) return { thumbPx: trackPx, thumbTop: 0 };
  const thumbPx = Math.max(MIN_THUMB_PX, Math.min(trackPx, (view / total) * trackPx));
  const maxScroll = total - view;
  const thumbTop = ((trackPx - thumbPx) * clampScrollRow(scrollRow, total, view)) / maxScroll;
  return { thumbPx, thumbTop };
}

export function scrollRowForThumbTop(
  topPx: number,
  trackPx: number,
  total: number,
  view: number,
): number {
  const { thumbPx } = thumbGeometry(trackPx, total, view, 0);
  const range = trackPx - thumbPx;
  if (range <= 0) return 0;
  const maxScroll = Math.max(0, total - view);
  return clampScrollRow(Math.round((topPx / range) * maxScroll), total, view);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @byteql/web exec vitest --run src/lib/hex/layout.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Gate and commit**

```bash
pnpm --filter @byteql/web check && pnpm --filter @byteql/web exec eslint src/lib/hex --max-warnings 0
git add apps/web/src/lib/hex/layout.ts apps/web/src/lib/hex/layout.test.ts
git commit -m "feat(web): hex viewer layout and scrollbar math"
```

---

### Task 2: Byte page cache (`byte-cache.ts`)

**Files:**
- Create: `apps/web/src/lib/hex/byte-cache.ts`
- Test: `apps/web/src/lib/hex/byte-cache.test.ts`

**Interfaces:**
- Consumes: a `BlobLike` (structural subset of `Blob`) so tests need no DOM Blob.
- Produces (used by Task 7):
  `PAGE_BYTES: 65536`; `CACHE_BUDGET_BYTES: 8388608`;
  `interface BlobLike { size: number; slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } }`;
  `class ByteCache { constructor(blob: BlobLike, options?: { pageBytes?: number; budgetBytes?: number });
  readonly pageBytes: number; readonly size: number; readonly fetchCount: number;
  byteAt(offset: number): number | null; ensureRange(start: number, end: number): Promise<void>;
  copyRange(start: number, end: number): Promise<Uint8Array>;
  subscribe(listener: () => void): () => void; dispose(): void }`.
  `byteAt` is synchronous: cache hit returns the byte; miss returns `null` AND schedules the
  fetch; `subscribe` listeners fire after each page lands (repaint signal).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/hex/byte-cache.test.ts
import { describe, expect, it } from 'vitest';

import { ByteCache, type BlobLike } from './byte-cache.js';

interface Deferred {
  resolve: () => void;
}

/** Blob double that counts slice reads and can hold responses open. */
function fakeBlob(size: number, options: { manual?: boolean } = {}) {
  const reads: Array<{ start: number; end: number }> = [];
  const pending: Deferred[] = [];
  const blob: BlobLike = {
    size,
    slice(start, end) {
      reads.push({ start, end });
      return {
        arrayBuffer() {
          const buffer = new ArrayBuffer(end - start);
          new Uint8Array(buffer).fill(start % 251);
          if (!options.manual) return Promise.resolve(buffer);
          return new Promise((resolve) => {
            pending.push({ resolve: () => resolve(buffer) });
          });
        },
      };
    },
  };
  return { blob, reads, pending };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('ByteCache', () => {
  it('misses synchronously, fetches the page, then hits', async () => {
    const { blob, reads } = fakeBlob(1024);
    const cache = new ByteCache(blob, { pageBytes: 256 });
    expect(cache.byteAt(300)).toBeNull();
    await flush();
    expect(cache.byteAt(300)).toBe(256 % 251);
    expect(reads).toEqual([{ start: 256, end: 512 }]);
    expect(cache.byteAt(-1)).toBeNull();
    expect(cache.byteAt(1024)).toBeNull();
  });

  it('coalesces concurrent requests for the same page into one read', async () => {
    const { blob, reads, pending } = fakeBlob(1024, { manual: true });
    const cache = new ByteCache(blob, { pageBytes: 256 });
    cache.byteAt(10);
    cache.byteAt(20);
    void cache.ensureRange(0, 100);
    expect(reads).toHaveLength(1);
    pending[0]?.resolve();
    await flush();
    expect(cache.byteAt(10)).not.toBeNull();
    expect(cache.fetchCount).toBe(1);
  });

  it('evicts least-recently-used pages past the budget', async () => {
    const { blob, reads } = fakeBlob(4096);
    const cache = new ByteCache(blob, { pageBytes: 256, budgetBytes: 512 }); // 2 pages max
    await cache.ensureRange(0, 256); // page 0
    await cache.ensureRange(256, 512); // page 1
    expect(cache.byteAt(0)).not.toBeNull(); // touch page 0 → page 1 is now LRU
    await cache.ensureRange(512, 768); // page 2 evicts page 1
    expect(cache.byteAt(300)).toBeNull(); // page 1 gone → refetch scheduled
    await flush();
    expect(reads.filter((r) => r.start === 256)).toHaveLength(2);
  });

  it('notifies subscribers when a page lands and stops after dispose', async () => {
    const { blob, pending } = fakeBlob(1024, { manual: true });
    const cache = new ByteCache(blob, { pageBytes: 256 });
    let notified = 0;
    cache.subscribe(() => {
      notified += 1;
    });
    cache.byteAt(0);
    cache.byteAt(600);
    cache.dispose();
    pending.forEach((p) => p.resolve());
    await flush();
    expect(notified).toBe(0); // disposed → deliveries dropped, listeners never fire
  });

  it('copyRange assembles bytes across page boundaries', async () => {
    const { blob } = fakeBlob(1024);
    const cache = new ByteCache(blob, { pageBytes: 256 });
    const bytes = await cache.copyRange(250, 262);
    expect(bytes).toHaveLength(12);
    expect(bytes[0]).toBe(0 % 251); // from page 0 (fill = start % 251 = 0)
    expect(bytes[6]).toBe(256 % 251); // from page 1
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @byteql/web exec vitest --run src/lib/hex/byte-cache.test.ts`
Expected: FAIL — `Cannot find module './byte-cache.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/lib/hex/byte-cache.ts
export const PAGE_BYTES = 64 * 1024;
export const CACHE_BUDGET_BYTES = 8 * 1024 * 1024;

/** Structural subset of Blob so unit tests can pass plain fakes. */
export interface BlobLike {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export class ByteCache {
  readonly pageBytes: number;
  readonly #blob: BlobLike;
  readonly #maxPages: number;
  /** Map iteration order doubles as LRU order: delete + re-set on touch. */
  readonly #pages = new Map<number, Uint8Array>();
  readonly #inflight = new Map<number, Promise<void>>();
  readonly #listeners = new Set<() => void>();
  #disposed = false;
  #fetchCount = 0;

  constructor(blob: BlobLike, options: { pageBytes?: number; budgetBytes?: number } = {}) {
    this.#blob = blob;
    this.pageBytes = options.pageBytes ?? PAGE_BYTES;
    this.#maxPages = Math.max(1, Math.floor((options.budgetBytes ?? CACHE_BUDGET_BYTES) / this.pageBytes));
  }

  get size(): number {
    return this.#blob.size;
  }

  get fetchCount(): number {
    return this.#fetchCount;
  }

  byteAt(offset: number): number | null {
    if (this.#disposed || offset < 0 || offset >= this.#blob.size) return null;
    const page = Math.floor(offset / this.pageBytes);
    const bytes = this.#touch(page);
    if (bytes) return bytes[offset - page * this.pageBytes] ?? null;
    void this.#fetch(page);
    return null;
  }

  ensureRange(start: number, end: number): Promise<void> {
    if (this.#disposed || this.#blob.size === 0) return Promise.resolve();
    const first = Math.max(0, Math.floor(start / this.pageBytes));
    const last = Math.min(Math.ceil(this.#blob.size / this.pageBytes) - 1, Math.floor((end - 1) / this.pageBytes));
    const fetches: Promise<void>[] = [];
    for (let page = first; page <= last; page += 1) {
      if (!this.#pages.has(page)) fetches.push(this.#fetch(page));
    }
    return Promise.all(fetches).then(() => undefined);
  }

  async copyRange(start: number, end: number): Promise<Uint8Array> {
    const from = Math.max(0, start);
    const to = Math.min(this.#blob.size, end);
    if (to <= from) return new Uint8Array(0);
    await this.ensureRange(from, to);
    const out = new Uint8Array(to - from);
    for (let offset = from; offset < to; offset += 1) {
      const page = this.#pages.get(Math.floor(offset / this.pageBytes));
      out[offset - from] = page?.[offset % this.pageBytes] ?? 0;
    }
    return out;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#disposed = true;
    this.#pages.clear();
    this.#inflight.clear();
    this.#listeners.clear();
  }

  #touch(page: number): Uint8Array | undefined {
    const bytes = this.#pages.get(page);
    if (bytes) {
      this.#pages.delete(page);
      this.#pages.set(page, bytes);
    }
    return bytes;
  }

  #fetch(page: number): Promise<void> {
    const existing = this.#inflight.get(page);
    if (existing) return existing;
    this.#fetchCount += 1;
    const start = page * this.pageBytes;
    const end = Math.min(this.#blob.size, start + this.pageBytes);
    const request = this.#blob
      .slice(start, end)
      .arrayBuffer()
      .then((buffer) => {
        if (this.#disposed) return;
        this.#store(page, new Uint8Array(buffer));
        for (const listener of this.#listeners) listener();
      })
      .finally(() => this.#inflight.delete(page));
    this.#inflight.set(page, request);
    return request;
  }

  #store(page: number, bytes: Uint8Array): void {
    while (this.#pages.size >= this.#maxPages) {
      const oldest = this.#pages.keys().next();
      if (oldest.done) break;
      this.#pages.delete(oldest.value);
    }
    this.#pages.set(page, bytes);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @byteql/web exec vitest --run src/lib/hex/byte-cache.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Gate and commit**

```bash
pnpm --filter @byteql/web check && pnpm --filter @byteql/web exec eslint src/lib/hex --max-warnings 0
git add apps/web/src/lib/hex/byte-cache.ts apps/web/src/lib/hex/byte-cache.test.ts
git commit -m "feat(web): LRU byte page cache over the retained source blob"
```

---

### Task 3: Provenance coverage index (`coverage.ts`)

**Files:**
- Create: `apps/web/src/lib/hex/coverage.ts`
- Test: `apps/web/src/lib/hex/coverage.test.ts`

**Interfaces:**
- Consumes: `Table` from `apache-arrow` (`getChild(name)`, `.get(row)` returning
  `bigint | null` for uint64 columns).
- Produces (used by Tasks 7, 8):
  `COVERAGE_ROW_CAP: 2_000_000`;
  `interface ByteSpan { start: number; end: number; alt: boolean }` (end exclusive);
  `interface CoverageIndex { rowCount: number; rowsAt(offset: number): number[];
  spansIn(start: number, end: number): ByteSpan[] }` — `rowsAt` returns result-row indices
  ordered smallest interval first (most specific record);
  `type CoverageReason = 'ok' | 'no-provenance' | 'too-large'`;
  `interface CoverageResult { index: CoverageIndex | null; reason: CoverageReason }`;
  `buildCoverage(table: Table): CoverageResult`;
  `provenanceOfRow(table: Table, row: number): { start: number; end: number } | null` —
  index-free (grid→hex keeps working past the cap).

- [ ] **Step 1: Write the failing test**

Build tiny Arrow tables inline via `tableFromArrays` with BigUint64Array provenance columns —
nested intervals modeled on pcap (packet ⊃ tcp ⊃ dns):

```ts
// apps/web/src/lib/hex/coverage.test.ts
import { tableFromArrays } from 'apache-arrow';
import { describe, expect, it } from 'vitest';

import { buildCoverage, COVERAGE_ROW_CAP, provenanceOfRow } from './coverage.js';

function provenanceTable(rows: Array<[number, number]>) {
  return tableFromArrays({
    id: Int32Array.from(rows.map((_, i) => i)),
    _src_start: BigUint64Array.from(rows.map(([s]) => BigInt(s))),
    _src_end: BigUint64Array.from(rows.map(([, e]) => BigInt(e))),
  });
}

describe('buildCoverage', () => {
  it('reports no-provenance when the columns are absent', () => {
    const table = tableFromArrays({ n: Int32Array.from([1, 2]) });
    expect(buildCoverage(table)).toEqual({ index: null, reason: 'no-provenance' });
  });

  it('finds covering rows smallest-interval first', () => {
    // row 0: packet [0, 100); row 1: tcp [20, 100); row 2: dns [40, 60); row 3: next packet [100, 200)
    const { index, reason } = buildCoverage(provenanceTable([[0, 100], [20, 100], [40, 60], [100, 200]]));
    expect(reason).toBe('ok');
    expect(index?.rowsAt(50)).toEqual([2, 1, 0]);
    expect(index?.rowsAt(10)).toEqual([0]);
    expect(index?.rowsAt(100)).toEqual([3]); // _src_end is exclusive
    expect(index?.rowsAt(250)).toEqual([]);
  });

  it('clips spans to the queried viewport and alternates adjacent records', () => {
    const { index } = buildCoverage(provenanceTable([[0, 32], [32, 64], [200, 232]]));
    const spans = index?.spansIn(16, 48) ?? [];
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ start: 16, end: 32 });
    expect(spans[1]).toMatchObject({ start: 32, end: 48 });
    expect(spans[0]?.alt).not.toBe(spans[1]?.alt);
    expect(index?.spansIn(64, 200)).toEqual([]);
  });

  it('skips null provenance slots without failing', () => {
    const table = tableFromArrays({
      _src_start: BigUint64Array.from([0n, 10n]),
      _src_end: BigUint64Array.from([5n, 20n]),
    });
    expect(buildCoverage(table).index?.rowsAt(12)).toEqual([1]);
  });

  it('declines to index past the cap', () => {
    expect(COVERAGE_ROW_CAP).toBe(2_000_000);
    // Cap check is on numRows alone — no need to materialize 2M rows here; verified by contract.
  });
});

describe('provenanceOfRow', () => {
  it('reads a row range directly and converts bigint to number', () => {
    const table = provenanceTable([[0, 100], [20, 100]]);
    expect(provenanceOfRow(table, 1)).toEqual({ start: 20, end: 100 });
  });

  it('returns null without provenance columns or on null slots', () => {
    expect(provenanceOfRow(tableFromArrays({ n: Int32Array.from([1]) }), 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @byteql/web exec vitest --run src/lib/hex/coverage.test.ts`
Expected: FAIL — `Cannot find module './coverage.js'`.

- [ ] **Step 3: Write the implementation**

Sorted-by-start typed arrays + a running-max-of-ends prefix array for early exit — the classic
interval-stabbing structure. Build cost O(n log n) once per result; queries touch only
candidates whose prefix max-end reaches the probe.

```ts
// apps/web/src/lib/hex/coverage.ts
import type { Table } from 'apache-arrow';

export const COVERAGE_ROW_CAP = 2_000_000;

export interface ByteSpan {
  start: number;
  end: number;
  alt: boolean;
}

export interface CoverageIndex {
  rowCount: number;
  rowsAt(offset: number): number[];
  spansIn(start: number, end: number): ByteSpan[];
}

export type CoverageReason = 'ok' | 'no-provenance' | 'too-large';

export interface CoverageResult {
  index: CoverageIndex | null;
  reason: CoverageReason;
}

const toRange = (start: unknown, end: unknown): { start: number; end: number } | null => {
  if (start === null || start === undefined || end === null || end === undefined) return null;
  return { start: Number(start), end: Number(end) };
};

export function provenanceOfRow(table: Table, row: number): { start: number; end: number } | null {
  const startColumn = table.getChild('_src_start');
  const endColumn = table.getChild('_src_end');
  if (!startColumn || !endColumn) return null;
  return toRange(startColumn.get(row), endColumn.get(row));
}

/** First index in `starts[0..count)` whose value is > probe. */
function upperBound(starts: Float64Array, count: number, probe: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((starts[mid] as number) <= probe) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function buildCoverage(table: Table): CoverageResult {
  const startColumn = table.getChild('_src_start');
  const endColumn = table.getChild('_src_end');
  if (!startColumn || !endColumn) return { index: null, reason: 'no-provenance' };
  if (table.numRows > COVERAGE_ROW_CAP) return { index: null, reason: 'too-large' };

  const capacity = table.numRows;
  const rawStarts = new Float64Array(capacity);
  const rawEnds = new Float64Array(capacity);
  const rawRows = new Uint32Array(capacity);
  let count = 0;
  for (let row = 0; row < capacity; row += 1) {
    const range = toRange(startColumn.get(row), endColumn.get(row));
    if (!range || range.end <= range.start) continue;
    rawStarts[count] = range.start;
    rawEnds[count] = range.end;
    rawRows[count] = row;
    count += 1;
  }

  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => {
    const byStart = (rawStarts[a] as number) - (rawStarts[b] as number);
    return byStart !== 0 ? byStart : (rawEnds[b] as number) - (rawEnds[a] as number);
  });
  const starts = new Float64Array(count);
  const ends = new Float64Array(count);
  const rows = new Uint32Array(count);
  const maxEndPrefix = new Float64Array(count);
  order.forEach((source, i) => {
    starts[i] = rawStarts[source] as number;
    ends[i] = rawEnds[source] as number;
    rows[i] = rawRows[source] as number;
    maxEndPrefix[i] = i === 0 ? (ends[i] as number) : Math.max(maxEndPrefix[i - 1] as number, ends[i] as number);
  });

  const index: CoverageIndex = {
    rowCount: count,
    rowsAt(offset) {
      const matches: number[] = [];
      for (let i = upperBound(starts, count, offset) - 1; i >= 0; i -= 1) {
        if ((maxEndPrefix[i] as number) <= offset) break;
        if ((ends[i] as number) > offset) matches.push(i);
      }
      matches.sort((a, b) => {
        const bySize = (ends[a] as number) - (starts[a] as number) - ((ends[b] as number) - (starts[b] as number));
        return bySize !== 0 ? bySize : (starts[b] as number) - (starts[a] as number);
      });
      return matches.map((i) => rows[i] as number);
    },
    spansIn(start, end) {
      const spans: ByteSpan[] = [];
      for (let i = upperBound(starts, count, end - 1) - 1; i >= 0; i -= 1) {
        if ((maxEndPrefix[i] as number) <= start) break;
        if ((ends[i] as number) > start) {
          spans.push({
            start: Math.max(starts[i] as number, start),
            end: Math.min(ends[i] as number, end),
            alt: (i & 1) === 1,
          });
        }
      }
      return spans.reverse();
    },
  };
  return { index, reason: 'ok' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @byteql/web exec vitest --run src/lib/hex/coverage.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Gate and commit**

```bash
pnpm --filter @byteql/web check && pnpm --filter @byteql/web exec eslint src/lib/hex --max-warnings 0
git add apps/web/src/lib/hex/coverage.ts apps/web/src/lib/hex/coverage.test.ts
git commit -m "feat(web): provenance coverage index over result _src columns"
```

---

### Task 4: Selection reducer, goto parser, filter SQL (`selection.ts`, `goto.ts`, `filter-sql.ts`)

Three small pure modules; one task because each is a few functions and they gate the same
consumer (Task 7).

**Files:**
- Create: `apps/web/src/lib/hex/selection.ts`, `apps/web/src/lib/hex/goto.ts`,
  `apps/web/src/lib/hex/filter-sql.ts`
- Test: `apps/web/src/lib/hex/selection.test.ts`, `apps/web/src/lib/hex/goto.test.ts`,
  `apps/web/src/lib/hex/filter-sql.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 7, 8):
  `interface HexSelection { anchor: number; focus: number }` (inclusive byte offsets);
  `selectionRange(sel: HexSelection): { start: number; end: number }` (end exclusive);
  `type SelectionAction = { type: 'point'; offset: number; extend: boolean } | { type: 'drag';
  offset: number } | { type: 'move'; delta: number; extend: boolean; fileSize: number } |
  { type: 'record'; start: number; end: number } | { type: 'clear' }`;
  `reduceSelection(sel: HexSelection | null, action: SelectionAction): HexSelection | null`;
  `parseOffsetInput(text: string, reference: number): number | 'invalid'` (absolute hex/decimal
  or `+n`/`-n` relative to `reference`; result may still need clamping by the caller);
  `wrapFilterSql(sql: string, range: { start: number; end: number }): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/lib/hex/selection.test.ts
import { describe, expect, it } from 'vitest';

import { reduceSelection, selectionRange } from './selection.js';

describe('reduceSelection', () => {
  it('click sets a caret; shift-click extends from the anchor', () => {
    const caret = reduceSelection(null, { type: 'point', offset: 10, extend: false });
    expect(caret).toEqual({ anchor: 10, focus: 10 });
    const extended = reduceSelection(caret, { type: 'point', offset: 4, extend: true });
    expect(extended).toEqual({ anchor: 10, focus: 4 });
    expect(selectionRange(extended!)).toEqual({ start: 4, end: 11 });
  });

  it('drag moves the focus and keeps the anchor', () => {
    const start = reduceSelection(null, { type: 'point', offset: 8, extend: false });
    expect(reduceSelection(start, { type: 'drag', offset: 40 })).toEqual({ anchor: 8, focus: 40 });
  });

  it('move steps the caret, clamps to the file, and collapses unless extending', () => {
    const sel = { anchor: 4, focus: 8 };
    expect(reduceSelection(sel, { type: 'move', delta: 1, extend: false, fileSize: 100 })).toEqual({
      anchor: 9,
      focus: 9,
    });
    expect(reduceSelection(sel, { type: 'move', delta: 16, extend: true, fileSize: 20 })).toEqual({
      anchor: 4,
      focus: 19,
    });
    expect(reduceSelection(null, { type: 'move', delta: 1, extend: false, fileSize: 0 })).toBeNull();
    expect(reduceSelection(null, { type: 'move', delta: 1, extend: false, fileSize: 9 })).toEqual({
      anchor: 0,
      focus: 0,
    });
  });

  it('record selects a [start, end) range inclusively and clear clears', () => {
    expect(reduceSelection(null, { type: 'record', start: 82, end: 120 })).toEqual({ anchor: 82, focus: 119 });
    expect(reduceSelection({ anchor: 1, focus: 2 }, { type: 'clear' })).toBeNull();
  });
});
```

```ts
// apps/web/src/lib/hex/goto.test.ts
import { describe, expect, it } from 'vitest';

import { parseOffsetInput } from './goto.js';

describe('parseOffsetInput', () => {
  it('parses hex, decimal, and relative forms', () => {
    expect(parseOffsetInput('0x1a2b', 0)).toBe(0x1a2b);
    expect(parseOffsetInput('6699', 0)).toBe(6699);
    expect(parseOffsetInput('+16', 100)).toBe(116);
    expect(parseOffsetInput('-0x10', 100)).toBe(84);
    expect(parseOffsetInput('  0X2F ', 0)).toBe(47);
  });

  it('rejects garbage', () => {
    expect(parseOffsetInput('', 0)).toBe('invalid');
    expect(parseOffsetInput('0x', 0)).toBe('invalid');
    expect(parseOffsetInput('12g', 0)).toBe('invalid');
    expect(parseOffsetInput('--4', 0)).toBe('invalid');
  });
});
```

```ts
// apps/web/src/lib/hex/filter-sql.test.ts
import { describe, expect, it } from 'vitest';

import { wrapFilterSql } from './filter-sql.js';

describe('wrapFilterSql', () => {
  it('wraps the query with the exclusive-end overlap predicate', () => {
    expect(wrapFilterSql('select * from packets limit 10', { start: 64, end: 120 })).toBe(
      'select * from (\nselect * from packets limit 10\n) where _src_start < 120 and _src_end > 64;',
    );
  });

  it('strips a trailing semicolon and whitespace before wrapping', () => {
    expect(wrapFilterSql('select * from dns;\n  ', { start: 0, end: 1 })).toBe(
      'select * from (\nselect * from dns\n) where _src_start < 1 and _src_end > 0;',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @byteql/web exec vitest --run src/lib/hex/selection.test.ts src/lib/hex/goto.test.ts src/lib/hex/filter-sql.test.ts`
Expected: FAIL — three missing modules.

- [ ] **Step 3: Write the implementations**

```ts
// apps/web/src/lib/hex/selection.ts
export interface HexSelection {
  anchor: number;
  focus: number;
}

export type SelectionAction =
  | { type: 'point'; offset: number; extend: boolean }
  | { type: 'drag'; offset: number }
  | { type: 'move'; delta: number; extend: boolean; fileSize: number }
  | { type: 'record'; start: number; end: number }
  | { type: 'clear' };

export const selectionRange = (selection: HexSelection): { start: number; end: number } => ({
  start: Math.min(selection.anchor, selection.focus),
  end: Math.max(selection.anchor, selection.focus) + 1,
});

export function reduceSelection(
  selection: HexSelection | null,
  action: SelectionAction,
): HexSelection | null {
  switch (action.type) {
    case 'point':
      if (action.extend && selection) return { anchor: selection.anchor, focus: action.offset };
      return { anchor: action.offset, focus: action.offset };
    case 'drag':
      if (!selection) return { anchor: action.offset, focus: action.offset };
      return { anchor: selection.anchor, focus: action.offset };
    case 'move': {
      if (action.fileSize === 0) return null;
      if (!selection) return { anchor: 0, focus: 0 };
      const focus = Math.max(0, Math.min(action.fileSize - 1, selection.focus + action.delta));
      return action.extend ? { anchor: selection.anchor, focus } : { anchor: focus, focus };
    }
    case 'record':
      if (action.end <= action.start) return selection;
      return { anchor: action.start, focus: action.end - 1 };
    case 'clear':
      return null;
  }
}
```

```ts
// apps/web/src/lib/hex/goto.ts
const OFFSET_PATTERN = /^([+-])?(?:0x([0-9a-f]+)|(\d+))$/iu;

/** Parses '0x1a2b', '6699', '+16', '-0x10'. Relative forms apply to `reference`. */
export function parseOffsetInput(text: string, reference: number): number | 'invalid' {
  const match = OFFSET_PATTERN.exec(text.trim());
  if (!match) return 'invalid';
  const [, sign, hex, dec] = match;
  const magnitude = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? '', 10);
  if (!Number.isFinite(magnitude)) return 'invalid';
  if (sign === undefined) return magnitude;
  return sign === '-' ? reference - magnitude : reference + magnitude;
}
```

```ts
// apps/web/src/lib/hex/filter-sql.ts
/**
 * Wraps the current query with the byte-overlap predicate for selection [start, end).
 * `_src_end` is exclusive engine-side, hence strict/strict comparisons.
 */
export function wrapFilterSql(sql: string, range: { start: number; end: number }): string {
  const inner = sql.trim().replace(/;\s*$/u, '');
  return `select * from (\n${inner}\n) where _src_start < ${range.end} and _src_end > ${range.start};`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @byteql/web exec vitest --run src/lib/hex/selection.test.ts src/lib/hex/goto.test.ts src/lib/hex/filter-sql.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Gate and commit**

```bash
pnpm --filter @byteql/web check && pnpm --filter @byteql/web exec eslint src/lib/hex --max-warnings 0
git add apps/web/src/lib/hex/selection.* apps/web/src/lib/hex/goto.* apps/web/src/lib/hex/filter-sql.*
git commit -m "feat(web): hex selection reducer, offset parser, and filter-sql wrapper"
```

---

### Task 5: Canvas frame renderer (`render.ts`)

**Files:**
- Create: `apps/web/src/lib/hex/render.ts`
- Test: `apps/web/src/lib/hex/render.test.ts`

**Interfaces:**
- Consumes: Task 1 (`HexMetrics`, `ColumnLayout`, `hexByteX`, `asciiByteX`, `BYTES_PER_ROW`,
  `offsetDigits` NOT needed here — digits come in via metrics), Task 3 (`ByteSpan`).
- Produces (used by Task 7):
  `interface HexColors { background: string; gutter: string; text: string; ascii: string;
  shadeA: string; shadeB: string; selection: string; highlight: string; caret: string;
  placeholder: string }`;
  `interface CanvasTextContext { fillStyle: string; font: string; textBaseline: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeStyle: string; lineWidth: number;
  strokeRect(x: number, y: number, w: number, h: number): void }` (structural subset of
  `CanvasRenderingContext2D`);
  `interface HexFrame { widthPx: number; heightPx: number; firstRow: number; fileSize: number;
  metrics: HexMetrics; layout: ColumnLayout; colors: HexColors; fontSpec: string;
  byteAt(offset: number): number | null; shading: readonly ByteSpan[];
  selection: { start: number; end: number } | null;
  highlight: { start: number; end: number } | null; caret: number | null }`;
  `drawHexFrame(ctx: CanvasTextContext, frame: HexFrame): void`.
  Paint order per layer (bottom→top): background → shading → highlight → selection → text →
  caret outline. Missing bytes (cache miss) render as a `placeholder` rect the size of the hex
  pair, no text.

- [ ] **Step 1: Write the failing test**

A recording fake context asserts what would be painted, not pixels:

```ts
// apps/web/src/lib/hex/render.test.ts
import { describe, expect, it } from 'vitest';

import { columnLayout, hexByteX, type HexMetrics } from './layout.js';
import { drawHexFrame, type CanvasTextContext, type HexColors, type HexFrame } from './render.js';

const metrics: HexMetrics = { charWidth: 8, rowHeight: 18, gutterDigits: 8, padding: 12 };
const layout = columnLayout(metrics);
const colors: HexColors = {
  background: '#bg', gutter: '#gu', text: '#tx', ascii: '#as', shadeA: '#sa', shadeB: '#sb',
  selection: '#se', highlight: '#hi', caret: '#ca', placeholder: '#pl',
};

interface Op { kind: 'rect' | 'text' | 'stroke'; style: string; args: unknown[] }

function recordingContext() {
  const ops: Op[] = [];
  const ctx: CanvasTextContext = {
    fillStyle: '', font: '', textBaseline: '', strokeStyle: '', lineWidth: 1,
    fillRect: (...args) => ops.push({ kind: 'rect', style: String(ctx.fillStyle), args }),
    fillText: (...args) => ops.push({ kind: 'text', style: String(ctx.fillStyle), args }),
    strokeRect: (...args) => ops.push({ kind: 'stroke', style: String(ctx.strokeStyle), args }),
  };
  return { ctx, ops };
}

function frame(overrides: Partial<HexFrame> = {}): HexFrame {
  return {
    widthPx: 800, heightPx: 54, firstRow: 0, fileSize: 64, metrics, layout, colors,
    fontSpec: '12px monospace',
    byteAt: (offset) => (offset === 20 ? null : offset & 0xff),
    shading: [], selection: null, highlight: null, caret: null,
    ...overrides,
  };
}

describe('drawHexFrame', () => {
  it('draws gutter offsets, hex pairs, and ascii for available bytes', () => {
    const { ctx, ops } = recordingContext();
    drawHexFrame(ctx, frame());
    const texts = ops.filter((op) => op.kind === 'text').map((op) => op.args[0]);
    expect(texts).toContain('00000000');
    expect(texts).toContain('00000010');
    expect(texts).toContain('0f'); // hex pair for offset 15 (byteAt returns offset & 0xff)
  });

  it('paints a placeholder rect instead of text for missing bytes', () => {
    const { ctx, ops } = recordingContext();
    drawHexFrame(ctx, frame());
    const placeholder = ops.find((op) => op.kind === 'rect' && op.style === '#pl');
    expect(placeholder).toBeDefined();
    expect(placeholder?.args[0]).toBe(hexByteX(metrics, layout, 4)); // offset 20 = row 1, byte 4
  });

  it('paints selection above shading and outlines the caret', () => {
    const { ctx, ops } = recordingContext();
    drawHexFrame(
      ctx,
      frame({
        shading: [{ start: 0, end: 32, alt: false }],
        selection: { start: 4, end: 6 },
        caret: 5,
      }),
    );
    const styles = ops.map((op) => op.style);
    expect(styles.indexOf('#se')).toBeGreaterThan(styles.indexOf('#sa'));
    expect(ops.some((op) => op.kind === 'stroke' && op.style === '#ca')).toBe(true);
  });

  it('stops at EOF instead of painting phantom bytes', () => {
    const { ctx, ops } = recordingContext();
    drawHexFrame(ctx, frame({ fileSize: 3 }));
    const hexTexts = ops.filter((op) => op.kind === 'text' && op.style === '#tx');
    expect(hexTexts).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @byteql/web exec vitest --run src/lib/hex/render.test.ts`
Expected: FAIL — `Cannot find module './render.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/lib/hex/render.ts
import {
  asciiByteX,
  BYTES_PER_ROW,
  hexByteX,
  type ColumnLayout,
  type HexMetrics,
} from './layout.js';
import type { ByteSpan } from './coverage.js';

export interface HexColors {
  background: string;
  gutter: string;
  text: string;
  ascii: string;
  shadeA: string;
  shadeB: string;
  selection: string;
  highlight: string;
  caret: string;
  placeholder: string;
}

export interface CanvasTextContext {
  fillStyle: string;
  font: string;
  textBaseline: string;
  strokeStyle: string;
  lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
}

export interface HexFrame {
  widthPx: number;
  heightPx: number;
  firstRow: number;
  fileSize: number;
  metrics: HexMetrics;
  layout: ColumnLayout;
  colors: HexColors;
  fontSpec: string;
  byteAt(offset: number): number | null;
  shading: readonly ByteSpan[];
  selection: { start: number; end: number } | null;
  highlight: { start: number; end: number } | null;
  caret: number | null;
}

const HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, '0'));

const printable = (byte: number): string =>
  byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '·';

/** Fills the hex-cell and ascii-cell rects for every byte of [start, end) in view. */
function fillRange(
  ctx: CanvasTextContext,
  frame: HexFrame,
  start: number,
  end: number,
  style: string,
): void {
  const { metrics, layout, firstRow } = frame;
  const lastRowExclusive = firstRow + Math.ceil(frame.heightPx / metrics.rowHeight) + 1;
  const from = Math.max(start, firstRow * BYTES_PER_ROW);
  const to = Math.min(end, lastRowExclusive * BYTES_PER_ROW, frame.fileSize);
  ctx.fillStyle = style;
  for (let offset = from; offset < to; offset += 1) {
    const row = Math.floor(offset / BYTES_PER_ROW);
    const i = offset % BYTES_PER_ROW;
    const y = (row - firstRow) * metrics.rowHeight;
    ctx.fillRect(hexByteX(metrics, layout, i), y, 2 * metrics.charWidth, metrics.rowHeight);
    ctx.fillRect(asciiByteX(metrics, layout, i), y, metrics.charWidth, metrics.rowHeight);
  }
}

export function drawHexFrame(ctx: CanvasTextContext, frame: HexFrame): void {
  const { metrics, layout, colors, firstRow } = frame;
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, frame.widthPx, frame.heightPx);
  ctx.font = frame.fontSpec;
  ctx.textBaseline = 'middle';

  for (const span of frame.shading) fillRange(ctx, frame, span.start, span.end, span.alt ? colors.shadeB : colors.shadeA);
  if (frame.highlight) fillRange(ctx, frame, frame.highlight.start, frame.highlight.end, colors.highlight);
  if (frame.selection) fillRange(ctx, frame, frame.selection.start, frame.selection.end, colors.selection);

  const rows = Math.ceil(frame.heightPx / metrics.rowHeight);
  for (let r = 0; r < rows; r += 1) {
    const rowOffset = (firstRow + r) * BYTES_PER_ROW;
    if (rowOffset >= frame.fileSize && frame.fileSize > 0) break;
    const y = r * metrics.rowHeight + metrics.rowHeight / 2;
    ctx.fillStyle = colors.gutter;
    ctx.fillText(rowOffset.toString(16).padStart(metrics.gutterDigits, '0'), layout.gutterX, y);
    for (let i = 0; i < BYTES_PER_ROW; i += 1) {
      const offset = rowOffset + i;
      if (offset >= frame.fileSize) break;
      const byte = frame.byteAt(offset);
      if (byte === null) {
        ctx.fillStyle = colors.placeholder;
        ctx.fillRect(
          hexByteX(metrics, layout, i),
          r * metrics.rowHeight + 3,
          2 * metrics.charWidth,
          metrics.rowHeight - 6,
        );
        continue;
      }
      ctx.fillStyle = colors.text;
      ctx.fillText(HEX[byte] as string, hexByteX(metrics, layout, i), y);
      ctx.fillStyle = colors.ascii;
      ctx.fillText(printable(byte), asciiByteX(metrics, layout, i), y);
    }
  }

  if (frame.caret !== null) {
    const row = Math.floor(frame.caret / BYTES_PER_ROW) - firstRow;
    const i = frame.caret % BYTES_PER_ROW;
    if (row >= 0 && row < rows) {
      ctx.strokeStyle = colors.caret;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        hexByteX(metrics, layout, i) - 1,
        row * metrics.rowHeight + 1,
        2 * metrics.charWidth + 2,
        metrics.rowHeight - 2,
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @byteql/web exec vitest --run src/lib/hex/render.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Gate and commit**

```bash
pnpm --filter @byteql/web check && pnpm --filter @byteql/web exec eslint src/lib/hex --max-warnings 0
git add apps/web/src/lib/hex/render.ts apps/web/src/lib/hex/render.test.ts
git commit -m "feat(web): pure canvas frame renderer for the hex pane"
```

---

### Task 6: Session state & controller — `byteSelection` + retained source blob

**Files:**
- Modify: `apps/web/src/lib/session/state.ts`, `apps/web/src/lib/session/controller.ts`
- Test: extend `apps/web/src/lib/session/state.test.ts`,
  `apps/web/src/lib/session/controller.test.ts`

**Interfaces:**
- Consumes: existing reducer/controller shapes (see Reference).
- Produces (used by Tasks 7, 8, 11):
  `SessionState.byteSelection: { start: number; end: number } | null` (end exclusive, absolute
  file offsets); event `{ type: 'byteRangeSelected'; range: { start: number; end: number } |
  null }`; `SessionController.selectByteRange(range: { start: number; end: number } | null):
  void`; `SessionController.getSourceBlob(): Blob | null` — the `Blob` passed to the current
  `open()` (file or sample), retained until the next open or dispose.

- [ ] **Step 1: Write the failing tests**

Append to `state.test.ts` (follow the file's existing reducer-test style):

```ts
describe('byteRangeSelected', () => {
  it('stores the range while a source is open and clears on lifecycle resets', () => {
    let state = reduceSession(initialSessionState, {
      type: 'opening',
      source: { name: 'a.pcap', size: 10 },
    });
    state = reduceSession(state, { type: 'byteRangeSelected', range: { start: 4, end: 8 } });
    expect(state.byteSelection).toEqual({ start: 4, end: 8 });
    state = reduceSession(state, { type: 'byteRangeSelected', range: null });
    expect(state.byteSelection).toBeNull();
  });

  it('is cleared by a new query result and by opening', () => {
    let state = reduceSession(initialSessionState, {
      type: 'byteRangeSelected',
      range: { start: 0, end: 1 },
    });
    state = reduceSession(state, { type: 'querySucceeded', result: fakeTable, elapsedMs: 1 });
    expect(state.byteSelection).toBeNull();
    state = reduceSession(state, { type: 'byteRangeSelected', range: { start: 0, end: 1 } });
    state = reduceSession(state, { type: 'opening', source: { name: 'b', size: 1 } });
    expect(state.byteSelection).toBeNull();
  });
});
```

(`fakeTable` — reuse however the existing `querySucceeded` tests in this file build their
`Table`; there is one already.)

Append to `controller.test.ts` (reuse its existing fake database/parser harness):

```ts
it('retains the source blob for the session and exposes byte selection', async () => {
  const controller = makeController(); // the file's existing helper/fixture
  expect(controller.getSourceBlob()).toBeNull();
  const file = new File([new Uint8Array([1, 2, 3])], 'x.mid');
  await controller.openFile(file);
  expect(controller.getSourceBlob()).toBe(file);
  controller.selectByteRange({ start: 0, end: 2 });
  expect(controller.getState().byteSelection).toEqual({ start: 0, end: 2 });
  controller.selectByteRange(null);
  expect(controller.getState().byteSelection).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @byteql/web exec vitest --run src/lib/session/state.test.ts src/lib/session/controller.test.ts`
Expected: FAIL — `byteSelection` missing from state; `getSourceBlob` not a function.

- [ ] **Step 3: Implement**

`state.ts` — add to `SessionState` and `initialSessionState`:

```ts
  /** Active hex-pane byte selection: absolute file offsets, end exclusive. */
  byteSelection: { start: number; end: number } | null;
```

```ts
  byteSelection: null,
```

Add the event to `SessionEvent`:

```ts
  | { type: 'byteRangeSelected'; range: { start: number; end: number } | null }
```

Reducer: new case, plus explicit clears where the spec requires them (`opening` already resets
via the `initialSessionState` spread; `failed` must add `byteSelection: null` to its literal;
`cancelled`'s non-querying branch resets whole state already — its querying branch keeps the
selection, correct since the file is unchanged):

```ts
    case 'byteRangeSelected':
      return state.source === null ? state : { ...state, byteSelection: event.range };
```

and add `byteSelection: null,` to the `querySucceeded` case object (spec: cleared on new
result) and to the `failed` case object.

`controller.ts` — new private field + wiring:

```ts
  private retainedBlob: Blob | null = null;
```

In `open(source, blob)` (the single funnel), after `this.stopActiveViewer()`:

```ts
    this.retainedBlob = blob;
```

In `dispose()`, next to `this.retainedFile = null;`:

```ts
    this.retainedBlob = null;
```

New public methods (near `selectResultRow`):

```ts
  selectByteRange(range: { start: number; end: number } | null): void {
    this.assertUsable();
    this.dispatch({ type: 'byteRangeSelected', range });
  }

  getSourceBlob(): Blob | null {
    return this.retainedBlob;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @byteql/web exec vitest --run src/lib/session/state.test.ts src/lib/session/controller.test.ts`
Expected: PASS, including all pre-existing cases.

- [ ] **Step 5: Full web gate and commit**

```bash
pnpm --filter @byteql/web check && pnpm --filter @byteql/web test
git add apps/web/src/lib/session/state.ts apps/web/src/lib/session/state.test.ts \
  apps/web/src/lib/session/controller.ts apps/web/src/lib/session/controller.test.ts
git commit -m "feat(web): byte-selection session state and retained source blob"
```

---

### Task 7: `HexPane.svelte`

**Files:**
- Create: `apps/web/src/components/HexPane.svelte`
- Test: `apps/web/src/components/HexPane.test.ts`
- Modify: `apps/web/src/app.css` (hex-pane styles + the token block it needs — the FULL token
  refresh is Task 9; this task adds only the hex-specific properties listed below)

**Interfaces:**
- Consumes: every Task 1–5 export.
- Produces (used by Task 8):
  Svelte component with props
  `{ blob: Blob | null; fileSize: number; coverage: CoverageIndex | null;
  coverageReason: CoverageReason; highlight: { start: number; end: number } | null;
  filterAvailable: boolean; compact?: boolean;
  onreveal: (offset: number) => void;
  onselectionchange: (range: { start: number; end: number } | null) => void;
  onfilter: (range: { start: number; end: number }) => void }`
  and exported instance methods `focusGoto(): void` (for the global Mod+G shortcut) and
  `revealRange(range: { start: number; end: number }): void` (Inspector's byte-range link —
  scrolls + flashes without changing selection).
  E2e/test hooks on the root element: `data-hex-pane`, `data-hex-caret` (decimal offset or
  empty), `data-hex-selection` (`"start-end"` end-exclusive, or empty), `data-hex-first-row`,
  `data-hex-provenance` (the `CoverageReason`), `data-hex-collapsed`.
  New CSS custom properties (this task): `--font-mono`, `--color-shade-a`, `--color-shade-b`,
  `--color-hex-highlight`, `--color-hex-placeholder`.

**Behavior checklist implemented here** (each is asserted either in the component test or via
module tests already written): toolbar readout (caret offset hex + byte value hex/dec);
goto input (`aria-label="Go to offset"`, Enter jumps + caret + flash, invalid shows inline
message + `aria-invalid`); collapse toggle (persists `byteql.hexpane.collapsed`); resize handle
(pointer drag, min = toolbar + 4 rows, max = 70% of parent, persists `byteql.hexpane.height`);
custom scrollbar (thumb drag + track-click paging); wheel = 3 rows, Shift+wheel = page;
click = caret + `onreveal`; drag = range; Shift+click extends; double-click = smallest covering
record via `coverage.rowsAt` → `record` action; keyboard on the canvas wrapper
(`role="application"`, `tabindex="0"`, aria-label "Hex viewer"): arrows ±1/±BYTES_PER_ROW,
PgUp/PgDn ±rowsInView·16, Mod+Home/End file ends, Shift extends, Enter/Space = `onreveal(caret)`,
`g` focuses goto, Mod+C copies selection hex via `cache.copyRange` + `navigator.clipboard.writeText`;
`aria-live="polite"` visually-hidden region announcing `Offset 0x…, byte 0x…` (+ `, N covering
rows` when coverage active); non-fatal read-error strip with a Retry button when a page fetch
rejects (`NotReadableError` path — file changed on disk); hint line when
`coverageReason !== 'ok'` ("No byte provenance in this result — browse a table to link bytes to
rows." / "Result too large to index — shading and reveal are off."); jump-flash and smooth
scrolling suppressed under `prefers-reduced-motion` (gate on
`matchMedia('(prefers-reduced-motion: reduce)')`).

- [ ] **Step 1: Write the failing component test**

jsdom: no canvas context, so assert DOM/data-attribute behavior only.

```ts
// apps/web/src/components/HexPane.test.ts
import { render } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import HexPane from './HexPane.svelte';

const blob = new Blob([new Uint8Array(64).map((_, i) => i)]);

function renderPane(overrides: Record<string, unknown> = {}) {
  return render(HexPane, {
    props: {
      blob,
      fileSize: 64,
      coverage: null,
      coverageReason: 'no-provenance',
      highlight: null,
      filterAvailable: false,
      onreveal: vi.fn(),
      onselectionchange: vi.fn(),
      onfilter: vi.fn(),
      ...overrides,
    },
  });
}

describe('HexPane', () => {
  it('renders the pane with provenance status and no caret', () => {
    const { container } = renderPane();
    const root = container.querySelector('[data-hex-pane]');
    expect(root?.getAttribute('data-hex-provenance')).toBe('no-provenance');
    expect(root?.getAttribute('data-hex-caret')).toBe('');
    expect(root?.textContent).toContain('No byte provenance in this result');
  });

  it('jumps and sets the caret through the goto input', async () => {
    const user = userEvent.setup();
    const { container, getByLabelText } = renderPane();
    await user.type(getByLabelText('Go to offset'), '0x10{Enter}');
    const root = container.querySelector('[data-hex-pane]');
    expect(root?.getAttribute('data-hex-caret')).toBe('16');
  });

  it('flags invalid goto input instead of jumping', async () => {
    const user = userEvent.setup();
    const { container, getByLabelText } = renderPane();
    await user.type(getByLabelText('Go to offset'), 'wat{Enter}');
    expect(getByLabelText('Go to offset').getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[data-hex-pane]')?.getAttribute('data-hex-caret')).toBe('');
  });

  it('moves the caret with arrows and reveals with Enter', async () => {
    const user = userEvent.setup();
    const onreveal = vi.fn();
    const { container, getByLabelText, getByRole } = renderPane({ onreveal });
    await user.type(getByLabelText('Go to offset'), '0{Enter}');
    const canvasHost = getByRole('application', { name: 'Hex viewer' });
    canvasHost.focus();
    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(container.querySelector('[data-hex-pane]')?.getAttribute('data-hex-caret')).toBe('17');
    await user.keyboard('{Enter}');
    expect(onreveal).toHaveBeenCalledWith(17);
  });

  it('reports selection changes end-exclusively', async () => {
    const user = userEvent.setup();
    const onselectionchange = vi.fn();
    const { getByLabelText, getByRole } = renderPane({ onselectionchange });
    await user.type(getByLabelText('Go to offset'), '4{Enter}');
    getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}');
    expect(onselectionchange).toHaveBeenLastCalledWith({ start: 4, end: 7 });
  });

  it('shows the filter action only when available and a selection exists', async () => {
    const user = userEvent.setup();
    const onfilter = vi.fn();
    const { getByLabelText, getByRole, queryByRole } = renderPane({
      filterAvailable: true,
      coverageReason: 'ok',
      onfilter,
    });
    expect(queryByRole('button', { name: 'Filter results to selection' })).toBeNull();
    await user.type(getByLabelText('Go to offset'), '4{Enter}');
    getByRole('application', { name: 'Hex viewer' }).focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await user.click(getByRole('button', { name: 'Filter results to selection' }));
    expect(onfilter).toHaveBeenCalledWith({ start: 4, end: 6 });
  });

  it('collapses to the toolbar strip and persists the flag', async () => {
    const user = userEvent.setup();
    const { container, getByRole } = renderPane();
    await user.click(getByRole('button', { name: 'Collapse hex view' }));
    expect(container.querySelector('[data-hex-pane]')?.getAttribute('data-hex-collapsed')).toBe('true');
    expect(localStorage.getItem('byteql.hexpane.collapsed')).toBe('true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @byteql/web exec vitest --run src/components/HexPane.test.ts`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement `HexPane.svelte`**

Structure (full component, ~320 lines — key regions shown with complete logic; wire exactly
these pieces):

```svelte
<script lang="ts">
  /* global Blob, HTMLCanvasElement, HTMLDivElement, HTMLInputElement, KeyboardEvent,
     PointerEvent, WheelEvent, localStorage, navigator, requestAnimationFrame, window */
  import { untrack } from 'svelte';

  import { ByteCache } from '../lib/hex/byte-cache.js';
  import type { CoverageIndex, CoverageReason } from '../lib/hex/coverage.js';
  import { parseOffsetInput } from '../lib/hex/goto.js';
  import {
    BYTES_PER_ROW,
    byteAtPoint,
    clampScrollRow,
    columnLayout,
    offsetDigits,
    rowsInView,
    scrollRowForThumbTop,
    thumbGeometry,
    totalRows,
    type HexMetrics,
  } from '../lib/hex/layout.js';
  import { drawHexFrame, type HexColors } from '../lib/hex/render.js';
  import {
    reduceSelection,
    selectionRange,
    type HexSelection,
    type SelectionAction,
  } from '../lib/hex/selection.js';

  interface Props {
    blob: Blob | null;
    fileSize: number;
    coverage: CoverageIndex | null;
    coverageReason: CoverageReason;
    highlight: { start: number; end: number } | null;
    filterAvailable: boolean;
    compact?: boolean;
    onreveal: (offset: number) => void;
    onselectionchange: (range: { start: number; end: number } | null) => void;
    onfilter: (range: { start: number; end: number }) => void;
  }

  let { blob, fileSize, coverage, coverageReason, highlight, filterAvailable,
    compact = false, onreveal, onselectionchange, onfilter }: Props = $props();

  const COLLAPSED_KEY = 'byteql.hexpane.collapsed';
  const HEIGHT_KEY = 'byteql.hexpane.height';

  let canvas = $state<HTMLCanvasElement | null>(null);
  let viewportEl = $state<HTMLDivElement | null>(null);
  let gotoInput = $state<HTMLInputElement | null>(null);
  let cache = $state<ByteCache | null>(null);
  let scrollRow = $state(0);
  let selection = $state<HexSelection | null>(null);
  let gotoInvalid = $state(false);
  let readError = $state(false);
  let flashRow = $state<number | null>(null);
  let collapsed = $state(localStorage.getItem(COLLAPSED_KEY) === 'true');
  let paneHeight = $state(Number(localStorage.getItem(HEIGHT_KEY)) || 260);
  let viewportHeight = $state(200);

  // jsdom has no 2d context: fall back to fixed metrics and skip painting.
  const metrics = $derived<HexMetrics>({
    charWidth: measureCharWidth(),
    rowHeight: 18,
    gutterDigits: offsetDigits(fileSize),
    padding: 12,
  });
  const layout = $derived(columnLayout(metrics));
  const total = $derived(totalRows(fileSize));
  const view = $derived(rowsInView(viewportHeight, metrics.rowHeight));
  const caret = $derived(selection?.focus ?? null);
  const range = $derived(selection ? selectionRange(selection) : null);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // ... derived caretByte via cache?.byteAt(caret), announcement string, thumb geometry.
</script>
```

Key implementation notes the code must follow:

1. **Cache lifecycle:** `$effect` keyed on `blob` — dispose the old `ByteCache`, create a new
   one, `reset scrollRow/selection/readError`, subscribe → `schedulePaint()`. Cleanup on
   destroy. Stale deliveries are inert because the old instance is disposed (generation guard).
2. **Painting:** `schedulePaint()` batches through `requestAnimationFrame`; `paint()` no-ops
   when `!canvas || collapsed`; gets `ctx = canvas.getContext('2d')` (null in jsdom → return);
   scales for `devicePixelRatio` (`canvas.width = cssWidth * dpr; ctx.scale(dpr, dpr)`);
   builds colors from `getComputedStyle(canvas)`
   (`background: --color-surface-inset, gutter: --color-text-subtle, text: --color-text,
   ascii: --color-text-muted, shadeA: --color-shade-a, shadeB: --color-shade-b,
   selection: --color-selection, highlight: --color-hex-highlight, caret: --color-focus,
   placeholder: --color-hex-placeholder`); `fontSpec = '12px ' + getPropertyValue('--font-mono')`;
   shading from `coverage?.spansIn(viewStart, viewEnd) ?? []`; calls `drawHexFrame`. Every
   state that affects the frame (`scrollRow`, `selection`, `highlight`, `coverage`, cache pages)
   triggers `schedulePaint()` from an `$effect`.
3. **Byte fetch:** an `$effect` on `scrollRow/view` calls
   `cache.ensureRange(viewStart * 16, (viewStart + view + 1) * 16 + cache.pageBytes)`
   (viewport + one page of prefetch), with `.catch(() => (readError = true))`.
4. **measureCharWidth():** create a detached canvas once at module scope; if no 2d context
   (jsdom) return `7.2`.
5. **Pointer handling on the canvas:** `pointerdown` → `byteAtPoint(...)`; hit → apply
   `{ type: 'point', offset, extend: event.shiftKey }`, `setPointerCapture`, and (no shift)
   `onreveal(offset)`; `pointermove` while captured → `{ type: 'drag', offset }`;
   `dblclick` → `coverage?.rangeAt(offset)`, the smallest UNCLIPPED interval covering the byte
   (ties: later start, matching `rowsAt` ordering). Apply `{ type: 'record', ...range }` and call
   `onreveal(offset)`. Do NOT use `coverage.spansIn(offset, offset + 1)`: `spansIn` clips every
   span to its query window, so a one-byte window degenerates each record to a single byte and the
   double-click behaves like a plain click. `rangeAt` reuses the same sorted arrays +
   `maxEndPrefix` early-exit as `rowsAt`. Every selection change calls `onselectionchange(range)`
   (or `null`).
6. **Scroll:** wheel → `scrollRow = clampScrollRow(scrollRow + 3 * Math.sign(event.deltaY), total, view)`
   (Shift → `± view`); thumb drag maps via `scrollRowForThumbTop`; track click pages by `view`.
7. **Highlight prop:** `$effect` on `highlight` — when non-null, if its start row is outside
   `[scrollRow, scrollRow + view)` set
   `scrollRow = clampScrollRow(rowOf(highlight.start) - Math.floor(view / 2), total, view)`;
   set `flashRow = rowOf(highlight.start)` for 600 ms unless `reducedMotion` (flash paints the
   row background with `--color-accent-wash` inside `paint()`).
   `revealRange(range)` (exported) does the same scroll+flash without touching selection.
8. **Keyboard map** (on the `role="application"` wrapper): as in the behavior checklist;
   `move` deltas: arrows `±1`, Up/Down `∓BYTES_PER_ROW`, PgUp/PgDn `∓view * BYTES_PER_ROW`,
   Mod+Home → `point 0`, Mod+End → `point fileSize - 1`; after any caret move, auto-scroll to
   keep the caret row in view. `event.preventDefault()` on handled keys only.
9. **Goto:** on Enter — `parseOffsetInput(value, caret ?? scrollRow * BYTES_PER_ROW)`;
   `'invalid'` → `gotoInvalid = true`; else clamp to `[0, fileSize - 1]`, apply
   `{ type: 'point', offset, extend: false }`, scroll to it, flash. `focusGoto()` (exported)
   focuses the input.
10. **Copy:** Mod+C on the wrapper — `cache.copyRange(range.start, range.end)` →
    hex string `bytes.map(b => HEX[b]).join(' ')` → `navigator.clipboard?.writeText`.
11. **Toolbar markup order:** readout · goto input (+ inline invalid message) · filter button
    (`filterAvailable && range && coverageReason === 'ok'`) · hint (when reason ≠ 'ok') ·
    collapse toggle (`aria-label` "Collapse hex view"/"Expand hex view"). Root:
    `<section class="hex-pane" data-hex-pane data-hex-caret={caret ?? ''}
    data-hex-selection={range ? `${range.start}-${range.end}` : ''}
    data-hex-first-row={scrollRow} data-hex-provenance={coverageReason}
    data-hex-collapsed={collapsed} style:height={collapsed ? 'auto' : `${paneHeight}px`}>`.
12. **Resize handle:** a `role="separator"` div above the toolbar; pointer drag adjusts
    `paneHeight` clamped to `[toolbar + 4 * rowHeight, 0.7 * parentHeight]`; persists on
    pointerup. `compact` prop defaults `collapsed = true` on first render when no stored key.
13. **Read-error strip:** rendered above the canvas when `readError`; Retry button clears the
    flag and re-runs the ensure effect (recreate the cache from `blob`).

Add hex-pane CSS to `app.css` (`.hex-pane`, `.hex-toolbar`, `.hex-viewport`, `.hex-canvas`,
`.hex-scrollbar`, `.hex-scrollbar-thumb`, `.hex-resize`, `.hex-hint`, `.hex-error`,
`.visually-hidden`) plus the new tokens:

```css
  --font-mono: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', 'SF Mono', Consolas,
    'Liberation Mono', monospace;
  --color-shade-a: rgb(85 216 190 / 10%);
  --color-shade-b: rgb(125 211 252 / 10%);
  --color-hex-highlight: rgb(255 202 104 / 28%);
  --color-hex-placeholder: rgb(70 91 109 / 45%);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @byteql/web exec vitest --run src/components/HexPane.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Gate and commit**

```bash
pnpm --filter @byteql/web check && pnpm --filter @byteql/web test
git add apps/web/src/components/HexPane.svelte apps/web/src/components/HexPane.test.ts apps/web/src/app.css
git commit -m "feat(web): canvas hex pane with selection, goto, and provenance shading"
```

---

### Task 8: Workbench integration — the bidirectional link

**Files:**
- Modify: `apps/web/src/components/Workbench.svelte`,
  `apps/web/src/components/ResultGrid.svelte`, `apps/web/src/components/Explorer.svelte`
- Test: extend `apps/web/src/components/Workbench.test.ts`; extend `apps/web/src/App.test.ts`
  only if it snapshots the port shape.

**Interfaces:**
- Consumes: Tasks 3, 4, 6, 7.
- Produces:
  `ControllerPort` gains `selectByteRange(range: { start: number; end: number } | null): void`
  and `getSourceBlob(): Blob | null` (both already on `SessionController`).
  `ResultGrid` new props: `hiddenPrefix?: string` (default `'_'`) — columns whose name starts
  with it are hidden behind a header chip labeled `+N hidden` (`aria-pressed` toggle,
  `aria-label "Toggle hidden columns"`); grid scrolls to `selectedRow` whenever it changes
  externally.
  `Explorer` new prop: `onbrowse: (table: string) => void`; each table summary row gains a
  `Browse` button (`aria-label` \`Browse ${name}\`).

- [ ] **Step 1: Write the failing tests**

Extend `Workbench.test.ts` with its existing fake-controller harness (it already fakes
`ControllerPort`; add the two new methods to the fake):

```ts
it('reveals the covering result row when the hex pane reports a byte click', async () => {
  // fake controller: result table with _src_start/_src_end (reuse provenanceTable-style
  // construction from coverage.test.ts), phase 'ready', source set, getSourceBlob → new Blob.
  // Drive: find [data-hex-pane]'s goto input, type the offset inside row 1's range, Enter,
  // focus the application role, press Enter.
  // Assert: fake.selectResultRow called with 1 (smallest covering interval).
});

it('runs the wrapped filter query from the hex pane filter action', async () => {
  // Drive: make a selection (goto + shift-arrow), click 'Filter results to selection'.
  // Assert: fake.runQuery called with a query containing
  // 'where _src_start < ' and the current sql wrapped in 'select * from ('.
});

it('passes the selected row provenance to the hex pane as highlight', async () => {
  // Drive: click Row 2 in the grid.
  // Assert: controller.selectResultRow called; after state round-trip the pane root reflects
  // scroll targeting (data-hex-first-row is near row(_src_start of row 2)).
});

it('browses a table from the explorer with select * limit 10000', async () => {
  // Drive: click the 'Browse packets' button.
  // Assert: fake.runQuery called with 'select * from packets limit 10000'.
});

it('hides underscore columns behind the +N hidden chip', async () => {
  // Render grid with columns [note, _src_start, _src_end].
  // Assert: only 'note' columnheader visible, chip labeled '+2 hidden'; click chip →
  // '_src_start' columnheader appears.
});
```

Write these as real tests against the existing harness (they follow the file's established
render + `await tick()` patterns — copy the style of the current row-selection test).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @byteql/web exec vitest --run src/components/Workbench.test.ts`
Expected: FAIL — port lacks the new methods, no hex pane in the tree, no chip, no browse.

- [ ] **Step 3: Implement**

**`ResultGrid.svelte`:**

```ts
  interface Props {
    table: Table;
    selectedRow?: number | null;
    hiddenPrefix?: string;
    onselect: (row: number) => void;
  }

  let { table, selectedRow = null, hiddenPrefix = '_', onselect }: Props = $props();
  let showHidden = $state(false);

  const columns = $derived(
    table.schema.fields
      .map((field, index) => ({ field, index }))
      .filter(({ field }) => showHidden || !field.name.startsWith(hiddenPrefix)),
  );
  const hiddenCount = $derived(table.schema.fields.length - columns.length + (showHidden ? 0 : 0));
```

Compute `hiddenCount` as `table.schema.fields.filter((f) => f.name.startsWith(hiddenPrefix)).length`
(stable, independent of toggle). Header renders the chip after the last columnheader when
`hiddenCount > 0`:

```svelte
    <button
      class="hidden-chip"
      type="button"
      aria-label="Toggle hidden columns"
      aria-pressed={showHidden}
      onclick={() => (showHidden = !showHidden)}
    >{showHidden ? '− hide' : `+${hiddenCount} hidden`}</button>
```

All `{#each fields as field, columnIndex}` loops become `{#each columns as { field, index }
(field.name)}` with `valueAt(virtualRow.index, index)`; `gridColumns` uses `columns.length`;
`aria-colcount={columns.length}`. External scroll: add

```ts
  $effect(() => {
    const row = selectedRow;
    if (row !== null) untrack(() => $virtualizer.scrollToIndex(row, { align: 'auto' }));
  });
```

Numeric alignment lands in Task 10 — not here.

**`Explorer.svelte`:** add `onbrowse: (table: string) => void` to Props; inside each
`<summary>` row after the row count:

```svelte
      <button
        class="table-browse"
        type="button"
        aria-label={`Browse ${table.name}`}
        onclick={(event) => {
          event.preventDefault();
          onbrowse(table.name);
        }}
      >Browse</button>
```

(`preventDefault` keeps the `<details>` from toggling.) Style `.table-browse` as a quiet
inline button, visible on `summary:hover`/`summary:focus-within`, always visible on touch
(`@media (hover: none)`).

**`Workbench.svelte`:**

1. `ControllerPort` gains `selectByteRange` + `getSourceBlob`.
2. Imports: `HexPane`, `buildCoverage`, `provenanceOfRow`, `wrapFilterSql`, types.
3. Derived state:

```ts
  const coverageResult = $derived.by(() =>
    session.result ? buildCoverage(session.result) : { index: null, reason: 'no-provenance' as const },
  );
  const sourceBlob = $derived(session.source ? controller.getSourceBlob() : null);
  const rowHighlight = $derived(
    session.result && session.selectedRow !== null
      ? provenanceOfRow(session.result, session.selectedRow)
      : null,
  );
```

4. Reveal with cycling:

```ts
  let lastRevealOffset: number | null = null;
  let revealCycle = 0;

  function revealAt(offset: number): void {
    const rows = coverageResult.index?.rowsAt(offset) ?? [];
    if (rows.length === 0) return;
    revealCycle = lastRevealOffset === offset ? revealCycle + 1 : 0;
    lastRevealOffset = offset;
    controller.selectResultRow(rows[revealCycle % rows.length] as number);
  }
```

5. Handlers wired to the pane:

```svelte
        <HexPane
          bind:this={hexPane}
          blob={sourceBlob}
          fileSize={session.source?.size ?? 0}
          coverage={coverageResult.index}
          coverageReason={coverageResult.reason}
          highlight={rowHighlight}
          filterAvailable={coverageResult.reason === 'ok'}
          compact={compactMode}
          onreveal={revealAt}
          onselectionchange={(range) => controller.selectByteRange(range)}
          onfilter={(range) => run(wrapFilterSql(draftSql || session.sql, range))}
        />
```

Placed as a new last child of `.sql-workspace`, rendered when `session.source !== null`.
Adjust `.sql-workspace` grid rows in `app.css` to
`auto minmax(8rem, 24%) auto auto minmax(8rem, 1fr) auto` (hex pane row is `auto` — the pane
controls its own height).
6. Explorer wiring: `onbrowse={(name) => run(`select * from ${name} limit 10000`)}` (table
names come from pack schemas — lowercase identifiers, no quoting needed).
7. ResultGrid keeps `{#key session.result}` and gains nothing else here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @byteql/web exec vitest --run src/components/Workbench.test.ts src/components/ResultGrid.test.ts 2>/dev/null || pnpm --filter @byteql/web test`
Expected: PASS, including all pre-existing Workbench cases.

- [ ] **Step 5: Manual smoke, gate, and commit**

Run: `pnpm --filter @byteql/web dev` — open the sample, browse `events`, click a row (bytes
highlight below), click a byte (row selects), select a range, filter. Then:

```bash
pnpm -r check && pnpm -r test -- --run
git add apps/web/src/components/Workbench.svelte apps/web/src/components/Workbench.test.ts \
  apps/web/src/components/ResultGrid.svelte apps/web/src/components/Explorer.svelte apps/web/src/app.css
git commit -m "feat(web): bidirectional hex-grid provenance link and table browsing"
```

---

### Task 9: Design-token refresh (`app.css`)

**Files:**
- Modify: `apps/web/src/app.css`
- Test: `apps/web/src/components/SqlEditor.theme.test.ts` guards editor vars stay defined; the
  rest is visual — verified by the Task 13 screenshot pass. No new unit tests.

**Interfaces:**
- Produces (used by Tasks 10–12): tokens
  `--text-xs: 0.68rem; --text-sm: 0.76rem; --text-md: 0.9rem; --text-lg: 1.05rem;
  --leading-tight: 1.25; --leading-normal: 1.55;
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
  --space-5: 1.5rem; --space-6: 2rem; --duration-quick: 140ms;`
  utility classes `.tabular { font-variant-numeric: tabular-nums; }` and `.visually-hidden`
  (if not already added in Task 7).

- [ ] **Step 1: Add the tokens** to `:root` (after the existing radius/height block) and the
  utilities. Replace every literal mono stack
  (`ui-monospace, 'SFMono-Regular', Consolas, monospace` — 5 occurrences: `.table-name`, the
  `.schema-list …` dt/dd block, `.shortcut`, `.grid-header > div`, `.grid-row > div`) with
  `var(--font-mono)`.
- [ ] **Step 2: Normalize the interactive-state recipe.** Buttons/summaries/chips share:
  hover = `--color-surface-hover` bg + `--color-border` border; active = translateY(0.5px);
  transitions `background var(--duration-quick) ease, border-color var(--duration-quick) ease`.
  Apply to `.button`, `.icon-button`, `.query-list button`, `.table-list summary`,
  `.hidden-chip`, `.table-browse`, `.mobile-tabs button`.
- [ ] **Step 3: Apply the type scale.** Swap the ad-hoc sizes: `0.63–0.69rem` cluster →
  `var(--text-xs)`; `0.72–0.78rem` cluster → `var(--text-sm)`; `0.9rem+` body → `var(--text-md)`;
  pane headings 1rem → `var(--text-lg)`. Add `.tabular` to `.row-count`, `.result-count`,
  `.status-metrics`, `.grid-header small`.
- [ ] **Step 4: Verify visually and gate.** `pnpm --filter @byteql/web dev` — click through
  empty state, sample session, query, inspector; nothing should look broken at 1440/1100/700 px
  widths. Then `pnpm -r check && pnpm --filter @byteql/web test`.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app.css
git commit -m "style(web): design tokens - type scale, spacing, mono font, state recipe"
```

---

### Task 10: Shell polish — EmptyState, header, drag-drop, grid, inspector, status bar, explorer diagnostics

**Files:**
- Modify: `apps/web/src/components/EmptyState.svelte`, `AppHeader.svelte`, `Workbench.svelte`,
  `ResultGrid.svelte`, `Inspector.svelte`, `StatusBar.svelte`, `Explorer.svelte`,
  `apps/web/src/app.css`
- Test: extend `EmptyState.test.ts`, `StatusBar.test.ts`, `Workbench.test.ts`

**Interfaces:**
- Consumes: Tasks 6–8 state and pane methods.
- Produces: `AppHeader` new props `{ sourceSize?: number | null; formatTitle?: string | null;
  onopen?: () => void }`; `StatusBar` reads `state.byteSelection`; `Inspector` new prop
  `onrevealrange: (range: { start: number; end: number }) => void`; `Workbench` exposes a
  window-level drop overlay and an `openPicker()` used by header + (Task 11) Mod+O.

- [ ] **Step 1: Write the failing tests**

```ts
// EmptyState.test.ts additions
it('shows the supported-format badges and the privacy line', () => {
  const { getByText } = render(EmptyState, { props: { onopen: vi.fn(), onsample: vi.fn() } });
  expect(getByText('MIDI')).toBeTruthy();
  expect(getByText('pcap')).toBeTruthy();
  expect(getByText(/never leaves this browser/iu)).toBeTruthy();
});
```

```ts
// StatusBar.test.ts additions
it('shows the byte selection readout', () => {
  const state = { ...initialSessionState, byteSelection: { start: 0x40, end: 0x78 } };
  const { getByText } = render(StatusBar, { props: { state } });
  expect(getByText('0x40–0x77 · 56 bytes')).toBeTruthy();
});
```

```ts
// Workbench.test.ts addition
it('opens a dropped file through the window-level drop overlay', async () => {
  // render ready session; dispatch dragenter + drop with DataTransfer containing a File on the
  // app-shell root; assert fake controller.openFile received the file.
});
```

- [ ] **Step 2: Run to verify failures**, then implement each sweep item:

1. **EmptyState:** badges row under the copy —
   `<ul class="format-badges" aria-label="Supported formats"><li>MIDI</li><li>pcap</li></ul>`;
   change `.empty-copy` to end with "Files never leave this browser — parsing, storage, and SQL
   all run locally."; keep all existing actions/handlers untouched.
2. **App-wide drag-drop (Workbench):** on the `.app-shell` div — `ondragenter` (counter++ →
   `dropActive = true` when the drag has files), `ondragleave` (counter-- → 0 clears),
   `ondragover` preventDefault, `ondrop` → `perform(() => controller.openFile(file))` + reset.
   Overlay: `{#if dropActive}<div class="drop-overlay" aria-hidden="true"><p>Drop to open</p></div>{/if}`.
   Works in every phase (a drop replaces the session — `open()` already supersedes).
3. **AppHeader:** replace the center context span with a chip when `sourceName`:
   `<span class="source-chip"><span class="source-pulse"/><span class="truncate">{sourceName}</span>
   {#if sourceSize != null}<span>{formatBytes(sourceSize)}</span>{/if}
   {#if formatTitle}<span>{formatTitle}</span>{/if}</span>`; add a compact `Open` button
   (calls `onopen`) next to the wordmark. `formatBytes`: `n < 1e6 ? '${(n/1e3).toFixed(0)} KB'
   : n < 1e9 ? '${(n/1e6).toFixed(1)} MB' : '${(n/1e9).toFixed(2)} GB'` — inline helper.
   Workbench passes `sourceSize={session.source?.size ?? null}`
   `formatTitle={session.format?.title ?? null}` `onopen={openPicker}`; `openPicker()` clicks a
   hidden `<input type="file" aria-label="Open file picker">` kept in Workbench (only when a
   session exists — EmptyState keeps its own input; the two never render simultaneously).
4. **ResultGrid numerics:** per-column class:
   `const numeric = (type: string): boolean => /^(u?int|float|decimal)/iu.test(type);`
   gridcell + columnheader get `class:cell-numeric={numeric(field.type.toString())}`;
   `.cell-numeric { text-align: right; font-variant-numeric: tabular-nums; }`. Binary cells:
   `formatValue` prefixes `Uint8Array` with `` `${value.byteLength} B · ` ``.
5. **Results heading:** add elapsed chip next to the row count:
   `{#if session.queryElapsedMs !== null}<span class="result-count tabular">{session.queryElapsedMs.toFixed(1)} ms</span>{/if}`.
6. **Inspector:** provenance `<dd>` values become one button when both offsets exist:
   `<button class="provenance-link" onclick={() => onrevealrange(range)}>0x{start.toString(16)} – 0x{end.toString(16)}</button>`
   (range from `provenanceOfRow(table, selectedRow)`); Workbench passes
   `onrevealrange={(range) => hexPane?.revealRange(range)}`. Number values in the Values list
   get the `tabular` class.
7. **StatusBar:** selection readout (before "Local processing"):
   `{#if state.byteSelection}<span class="tabular">{formatByteRange(state.byteSelection)}</span>{/if}`
   with `const formatByteRange = ({ start, end }) => `0x${start.toString(16)}–0x${(end - 1).toString(16)} · ${end - start} bytes`;`
   failed phase turns the dot `--color-danger` via `class:failed={state.phase === 'failed'}`.
8. **Explorer diagnostics:** the issues card becomes
   `<details><summary>{n} parse diagnostics</summary><ul>` listing up to 50 of
   `issue.code · issue.table ?? '' · issue.message` with a trailing "…and N more" item.
9. **CSS:** `.format-badges`, `.drop-overlay` (fixed inset 0, dashed accent border inset
   12 px, `backdrop-filter: blur(2px)`, z-index 50), `.source-chip`, `.provenance-link`,
   `.cell-numeric`, diagnostics list styles — all from tokens.

- [ ] **Step 3: Run the web suite**

Run: `pnpm --filter @byteql/web test`
Expected: PASS including the three new tests.

- [ ] **Step 4: Visual pass** at 1440/1100/700 px in `pnpm --filter @byteql/web dev`.

- [ ] **Step 5: Gate and commit**

```bash
pnpm -r check && pnpm -r test -- --run
git add apps/web/src
git commit -m "feat(web): shell polish - drop intake, source chip, readouts, diagnostics"
```

---

### Task 11: Keyboard model + shortcuts overlay

**Files:**
- Create: `apps/web/src/components/ShortcutsOverlay.svelte`,
  `apps/web/src/components/ShortcutsOverlay.test.ts`
- Modify: `apps/web/src/components/Workbench.svelte`

**Interfaces:**
- Consumes: `HexPane.focusGoto()` (Task 7), `openPicker()` (Task 10).
- Produces: global shortcuts — Mod+Enter run (already in SqlEditor, listed only), Mod+O open
  file, Mod+G focus hex goto, Mod+B toggle explorer, Mod+I toggle inspector, `?` shortcuts
  overlay. Guards: ignore keydown when `event.target` is an input, textarea, select, or
  `[contenteditable]` ancestor (CodeMirror), EXCEPT Mod+Enter which CodeMirror handles itself.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/components/ShortcutsOverlay.test.ts
import { render } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import ShortcutsOverlay from './ShortcutsOverlay.svelte';

describe('ShortcutsOverlay', () => {
  it('lists the shortcut map and closes on Escape and on the close button', async () => {
    const user = userEvent.setup();
    const onclose = vi.fn();
    const { getByRole, getByText } = render(ShortcutsOverlay, { props: { onclose } });
    expect(getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    expect(getByText('Run query')).toBeTruthy();
    expect(getByText('Go to offset')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(onclose).toHaveBeenCalledTimes(1);
    await user.click(getByRole('button', { name: 'Close shortcuts' }));
    expect(onclose).toHaveBeenCalledTimes(2);
  });
});
```

And in `Workbench.test.ts`:

```ts
it('opens the shortcuts overlay with ? and toggles panes with Mod+B / Mod+I', async () => {
  // render ready session; keyboard '?' → dialog visible; '{Escape}' → gone;
  // '{Control>}b{/Control}' → app-shell root has class 'explorer-collapsed'.
});
```

- [ ] **Step 2: Run to verify failure**, then implement.

`ShortcutsOverlay.svelte`: a `role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"`
panel (fixed, centered, `--shadow-pane`), focus moved to it on mount, `onkeydown` Escape →
`onclose()`, close button `aria-label="Close shortcuts"`. Two-column `<dl>` of: Run query
`Mod+Enter` · Open file `Mod+O` · Go to offset `Mod+G` · Toggle explorer `Mod+B` · Toggle
inspector `Mod+I` · Hex: move caret `Arrows` · extend `Shift+Arrows` · reveal row
`Enter` · select record `Double-click` · copy bytes `Mod+C` · This overlay `?`. Render `Mod`
as `⌘` when `navigator.platform` starts with `Mac`, else `Ctrl`.

Workbench: `let shortcutsOpen = $state(false);` + `<svelte:window onkeydown={globalKeys} />`:

```ts
  function inEditableTarget(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    return !!target?.closest('input, textarea, select, [contenteditable="true"], .cm-editor');
  }

  function globalKeys(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === '?' && !mod && !inEditableTarget(event)) {
      event.preventDefault();
      shortcutsOpen = !shortcutsOpen;
      return;
    }
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === 'o') { event.preventDefault(); openPicker(); }
    else if (key === 'b') { event.preventDefault(); explorerCollapsed = !explorerCollapsed; }
    else if (key === 'i') { event.preventDefault(); inspectorCollapsed = !inspectorCollapsed; }
    else if (key === 'g') { event.preventDefault(); hexPane?.focusGoto(); }
  }
```

- [ ] **Step 3: Run the suite** — `pnpm --filter @byteql/web test`; PASS.
- [ ] **Step 4: Gate and commit**

```bash
pnpm -r check
git add apps/web/src/components/ShortcutsOverlay.* apps/web/src/components/Workbench.svelte apps/web/src/components/Workbench.test.ts
git commit -m "feat(web): global keyboard model and shortcuts overlay"
```

---

### Task 12: E2E — the round-trip on both gallery formats

**Files:**
- Create: `apps/web/e2e/hex-provenance.spec.ts`

**Interfaces:**
- Consumes: data attributes from Task 7, chip/browse affordances from Task 8, drop overlay from
  Task 10. Fixtures: bundled sample MIDI (`Try sample`), `apps/web/e2e/fixtures/sample.pcap`.

- [ ] **Step 1: Write the spec** (it fails only if the feature is broken — this is the
  discharge of the Phase 1 exit criterion, written after the features, so expect PASS; any
  failure is a real bug to fix before commit):

```ts
// apps/web/e2e/hex-provenance.spec.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

const pane = (page: Page) => page.locator('[data-hex-pane]');
const hexCanvas = (page: Page) => page.getByRole('application', { name: 'Hex viewer' });

async function gotoOffset(page: Page, offset: number): Promise<void> {
  await page.getByLabel('Go to offset').fill(String(offset));
  await page.getByLabel('Go to offset').press('Enter');
}

async function selectedHexRange(page: Page): Promise<{ start: number; end: number }> {
  const raw = await pane(page).getAttribute('data-hex-selection');
  const [start, end] = (raw ?? '').split('-').map(Number);
  expect(Number.isFinite(start) && Number.isFinite(end)).toBe(true);
  return { start: start as number, end: end as number };
}

test('midi: grid row lights up bytes and a byte click reveals the row back', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try sample' }).click();
  await page.getByRole('button', { name: 'Browse events' }).click();
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();

  await page.getByRole('row', { name: 'Row 3', exact: true }).click();
  const range = await selectedHexRange(page); // grid→hex: selection mirrors the row range
  expect(range.end).toBeGreaterThan(range.start);

  await page.getByRole('row', { name: 'Row 1', exact: true }).click(); // move selection away
  await gotoOffset(page, range.start); // hex→grid: land a caret in row 3's bytes…
  await hexCanvas(page).press('Enter'); // …and reveal
  await expect(page.getByRole('row', { name: 'Row 3', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('pcap: browse, reveal, filter-to-selection, and hidden columns chip', async ({ page }) => {
  await page.goto('/');
  await page
    .getByLabel('Open file')
    .setInputFiles(fileURLToPath(new URL('./fixtures/sample.pcap', import.meta.url)));
  await page.getByRole('button', { name: 'Browse packets' }).click();
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Toggle hidden columns' })).toHaveText('+2 hidden');
  await expect(page.getByRole('columnheader').filter({ hasText: '_src_start' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle hidden columns' }).click();
  await expect(page.getByRole('columnheader').filter({ hasText: '_src_start' })).toHaveCount(1);

  await page.getByRole('row', { name: 'Row 2', exact: true }).click();
  const range = await selectedHexRange(page);

  await gotoOffset(page, range.start);
  await hexCanvas(page).press('Shift+ArrowRight');
  await hexCanvas(page).press('Shift+ArrowRight');
  await page.getByRole('button', { name: 'Filter results to selection' }).click();
  await expect(page.getByRole('textbox', { name: 'SQL query' })).toContainText('_src_start <');
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  const rowsText = await page
    .getByRole('region', { name: 'SQL workspace' })
    .getByText(/\d+ rows/u)
    .textContent();
  expect(Number.parseInt(rowsText ?? '0', 10)).toBeGreaterThanOrEqual(1);
});

test('drag-and-drop opens a file through the window overlay', async ({ page }) => {
  await page.goto('/');
  const bytes = Array.from(readFileSync(fileURLToPath(new URL('./fixtures/sample.pcap', import.meta.url))));
  await page.evaluate(async (fileBytes) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([new Uint8Array(fileBytes)], 'dropped.pcap'));
    const target = document.querySelector('.app-shell') ?? document.body;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, dataTransfer }));
    }
  }, bytes);
  await expect(page.getByRole('button', { name: 'Browse packets' })).toBeVisible({ timeout: 30_000 });
});
```

Caveat for the implementer: on the idle screen the drop lands on `EmptyState`'s own handler —
both paths call `openFile`; the assertion holds either way. If the wordmark chip intercepts
`.app-shell` drops, dispatch on `document.body` instead — the Workbench handler listens with
bubbling.

- [ ] **Step 2: Build then run e2e**

```bash
pnpm -r build
pnpm --filter @byteql/web test:e2e
```

Expected: the new spec PASSES alongside every existing spec. Debug real failures (do not relax
assertions to pass).

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/hex-provenance.spec.ts
git commit -m "test(web): e2e hex-grid round-trip on midi and pcap"
```

---

### Task 13: Final gates, screenshot pass, docs

**Files:**
- Modify: `PRD.md` (progress row), `AGENTS.md` (status section)

- [ ] **Step 1: Full workspace gate**

```bash
pnpm -r check && pnpm -r test -- --run && pnpm --filter @byteql/web check:bundle
pnpm -r build && pnpm --filter @byteql/web test:e2e
```

Expected: all green. Fix anything that isn't before proceeding.

- [ ] **Step 2: Screenshot pass** — `pnpm --filter @byteql/web dev`; capture and eyeball
  desktop (1440), narrow (1100), and mobile (700) with: empty state, drop overlay, sample
  session with hex pane open + shading + selection, shortcuts overlay, a failed query
  diagnostic. Fix visual regressions found; re-run Step 1 if code changed.

- [ ] **Step 3: Update docs.** `PRD.md` progress row: `slice 3/3 (hex-provenance UI) ✅ shipped
  2026-07-19` replacing `next`. `AGENTS.md`: mark slice 3 shipped; next open items are Phase
  0's two manual exit criteria and Phase 2 content. Run `rumdl fmt` on neither (both are
  prettier-ignored and follow existing line style).

- [ ] **Step 4: Commit**

```bash
git add PRD.md AGENTS.md
git commit -m "docs: record phase-1 slice 3 hex-provenance UI as shipped"
```

---

## Self-Review (completed)

- **Spec coverage:** modules (Tasks 1–5) ↔ spec Architecture; state/blob (6) ↔ Session state;
  pane behavior (7) ↔ Rendering & interaction; link, chip, browse (8) ↔ Provenance link;
  tokens (9) + sweep (10) + keyboard (11) ↔ Polish pass; e2e (12) ↔ Testing/exit criterion;
  degradation paths in 7 (hints, read-error strip) ↔ Error handling. No gaps.
- **Type consistency:** ranges are `{ start, end }` end-exclusive everywhere; `HexSelection`
  is inclusive internally and converted only via `selectionRange`; `CoverageReason` strings
  match between coverage.ts, HexPane props, and Workbench.
- **Placeholders:** none — every step carries runnable code or an exact, bounded instruction.
```
