# Resizable panels implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox syntax for tracking. This is a planning deliverable, not authorization to
> begin implementation. Read the design first; resolve requested design changes in both files.

**Goal:** Make Sources, Query, Results, inspection, and Values/Bytes resize through their shared
dividers while preserving editing, data, provenance, and accessible navigation.

**Architecture:** One Workbench-local coordinator resolves preferred and effective sizes.
Controlled separators share input mechanics. Existing components stay mounted, with explicit
grid tracks and local scrolling; Results and Bytes consume the remaining space.

**Tech Stack:** Existing Svelte 5, TypeScript, CodeMirror 6, TanStack Virtual, Vitest,
Testing Library, Playwright, and canvas. No new dependency.

**Spec:** [Resizable panels design](../specs/2026-09-10-resizable-panels-design.md).

Status: Ready for design review; no implementation or application verification performed here.
Audited base: `3672e87e4ceadfda50aaa789dfa5d9c8f9a0a7ec`.

## Global constraints

- Keep Svelte 5, TypeScript, CodeMirror 6, TanStack Virtual, and the existing canvas renderer.
- Add no runtime dependency, external asset, network request, or persisted file/query content.
- Keep `RESULT_ROW_HEIGHT = 36`, the 16,384-row result window, and existing paging safeguards.
- Preserve query, export, cancellation, byte provenance, source switching, and audio behavior.
- Store presentation preferences outside `SessionState` and the controller.
- Resize must not remount SqlEditor, ResultGrid, Inspector, or HexPane components.
- Keep the existing result-generation key; never key results by size or responsive mode.
- Preserve the current arrangement and existing visibility controls. Do not add docking,
  reordering, new viewers, parser/DB changes, or result-column resizing.
- Do not implement, commit, push, or deploy in the planning session. During later authorized
  execution, commit only completed task files and only if that session authorizes commits.

## Read first and execution discipline

Read `AGENTS.md`, PRD §9 and Appendix A, the companion design, and the current Trace Workspace
spec's §§5–7. Inspect `git status --short` and `git rev-parse HEAD`; preserve unrelated edits.
If the base changed, recheck affected interfaces before applying this plan. July orientation
does not describe the current shell. `src/app.css` now only imports `styles/*.css`.

The implementation is sequential. Complete one task and its focused tests before the next.
Do not batch a shell redesign with input logic and then debug all three together. Do not rewrite
the controller, virtualizer, or hex renderer to make the layout tests easier. On a mismatch,
record the observed behavior and fix the smallest relevant seam.

Run unit tests directly through Vitest for focus and predictable argument handling:

```bash
pnpm --filter @byteql/web exec vitest run src/lib/ui/panel-layout.test.ts
```

Playwright's existing wrapper accepts file paths after `--`. Its config builds `dist-e2e` and
starts its own preview server. Do not start a competing server on 4173 or publish `dist-e2e`.
If package exports are missing because build output is stale, run `pnpm build` before attributing
the error to source. Do not install new tooling for this feature.

## File map and boundaries

| File | Responsibility |
| --- | --- |
| Create `apps/web/src/lib/ui/panel-layout.ts` + `.test.ts` | Types, constants, defaults, numeric budget and bounds, responsive mode |
| Create `apps/web/src/lib/ui/layout-preferences.ts` + `.test.ts` | Storage schema/read/write/legacy fallback |
| Create `apps/web/src/lib/ui/resize-handle.ts` + `.test.ts` | Svelte action for pointer capture, keyboard and cleanup |
| Create `apps/web/src/components/ResizeHandle.svelte` + `.test.ts` | Accessible controlled handle markup |
| Create `apps/web/src/lib/ui/use-panel-layout.svelte.ts` + `use-panel-layout.svelte.test.ts` | Reactive layout coordinator and measurement lifecycle |
| Modify `apps/web/src/components/Workbench.svelte` + `.test.ts` | Explicit refs, shared state, handles, reset wiring |
| Modify `apps/web/src/components/TraceDock.svelte`, `.test.ts`, `.harness.svelte` | Controlled geometry, chrome measurements, Values divider |
| Modify `apps/web/src/components/HexPane.svelte` + `.test.ts` | Chrome reporting and horizontal byte access |
| Modify `apps/web/src/styles/workbench.css` | Explicit tracks, scroll ownership, constrained content |
| Modify `apps/web/src/components/ShortcutsOverlay.svelte` + `.test.ts` | Divider help and Reset panel sizes |
| Create `apps/web/e2e/panel-resize.spec.ts` | Full-workspace geometry and state regressions |
| Modify `apps/web/e2e/hex-resize.spec.ts`, `trace-workspace.spec.ts`, `query-result-scrolling.spec.ts` | Retain old coverage under the new ownership and add resize coverage |
| Conditional `ResultGrid.svelte` + `ResultGrid.demand.test.ts` | Only if growing viewport fails to trigger existing demand inspection |
| Delete `apps/web/src/lib/ui/dock-layout.ts` + `.test.ts` | After all dock callers/tests move to the shared solution |

Do not edit `packages/*`, lockfiles, appearance tokens, font assets, or existing design documents.
`SqlEditor.svelte` should need no source changes: first correct its CSS scroll ownership.

## Task 1: Pure geometry and preferences

**Files:** Create `panel-layout.ts`, `panel-layout.test.ts`, `layout-preferences.ts`, and
`layout-preferences.test.ts` under `apps/web/src/lib/ui/`.

**Interfaces:** Export these exact names from `panel-layout.ts`; future tasks consume them.

```ts
export type PanelId = 'sources' | 'query' | 'inspection' | 'values';
export interface Bounds { min: number; max: number }
export interface LayoutPreferences {
  version: 1;
  sourcesWidth: number | null;
  queryHeight: number | null;
  dockHeight: number | null;
  valuesWidth: number | null;
}
export interface VerticalInput {
  availableHeight: number;
  chromeHeight: number; // query/results toolbars, notices, active handle tracks only
  stripHeight: number;
  tabsHeight: number;
  bodyMin: number;
  collapsed: boolean;
  queryHeight: number; // resolved preference or active-drag snapshot
  dockHeight: number;
}
export interface VerticalLayout {
  queryHeight: number;
  dockHeight: number;
  resultsHeight: number;
  overflow: number;
  queryBounds: Bounds;
  dockBounds: Bounds;
}
export interface HorizontalLayout {
  sourcesWidth: number;
  valuesWidth: number;
  sourcesBounds: Bounds;
  valuesBounds: Bounds;
}
export const clamp = (value: number, bounds: Bounds): number =>
  Math.max(bounds.min, Math.min(bounds.max, value));
export const emptyPreferences = (): LayoutPreferences => ({
  version: 1, sourcesWidth: null, queryHeight: null, dockHeight: null, valuesWidth: null,
});
export function defaultSizes(viewportWidth: number, viewportHeight: number) {
  return {
    sourcesWidth: viewportWidth >= 1280 ? 224 : 208,
    queryHeight: viewportWidth < 700 || viewportHeight < 760 ? 80 : 116,
    dockHeight: 248,
    valuesWidth: 256,
  };
}
export function compactForWidth(
  viewportWidth: number, dockWidth: number, wasCompact: boolean,
): boolean {
  if (viewportWidth < 1280 || dockWidth < 900) return true;
  if (dockWidth >= 924) return false;
  return wasCompact;
}
```

- [ ] Add budget fixtures as failing tests; use Vitest `describe/it/expect`.

```ts
const base: VerticalInput = {
  availableHeight: 800, chromeHeight: 88, stripHeight: 40,
  tabsHeight: 0, bodyMin: 112, collapsed: false,
  queryHeight: 116, dockHeight: 248,
};
it('gives remaining height to Results', () => {
  expect(fitVertical(base)).toMatchObject({
    queryHeight: 116, dockHeight: 248, resultsHeight: 348, overflow: 0,
  });
});
it('yields dock space before reducing the editor', () => {
  expect(fitVertical({ ...base, availableHeight: 500 })).toMatchObject({
    queryHeight: 116, dockHeight: 168, resultsHeight: 128, overflow: 0,
  });
});
it('reports unavoidable overflow instead of clipping minimum panes', () => {
  expect(fitVertical({ ...base, availableHeight: 300 })).toMatchObject({
    queryHeight: 80, dockHeight: 152, resultsHeight: 128, overflow: 148,
  });
});
it('counts strip wrapping, tabs and hex chrome', () => {
  const layout = fitVertical({ ...base, stripHeight: 76, tabsHeight: 36, bodyMin: 180 });
  expect(layout.dockBounds.min).toBe(292);
  expect(layout.dockHeight).toBe(292);
});
```

Run the focused command above and confirm failure is the missing export/behavior.

- [ ] Implement the budget; this is the reference algorithm, not a sibling-measurement shortcut.

```ts
export function fitVertical(input: VerticalInput): VerticalLayout {
  const strip = Math.max(40, input.stripHeight);
  const minDock = input.collapsed ? strip : strip + input.tabsHeight + input.bodyMin;
  const budget = input.availableHeight - input.chromeHeight;
  const queryHeight = clamp(input.queryHeight, {
    min: 80, max: Math.max(80, budget - minDock - 128),
  });
  const dockHeight = input.collapsed ? strip : clamp(input.dockHeight, {
    min: minDock, max: Math.max(minDock, budget - queryHeight - 128),
  });
  const resultsHeight = Math.max(128, budget - queryHeight - dockHeight);
  return {
    queryHeight, dockHeight, resultsHeight,
    overflow: Math.max(0, input.chromeHeight + queryHeight + dockHeight + resultsHeight
      - input.availableHeight),
    queryBounds: { min: 80, max: Math.max(80, budget - dockHeight - 128) },
    dockBounds: { min: minDock, max: Math.max(minDock, budget - queryHeight - 128) },
  };
}

export function fitHorizontal(input: {
  shellWidth: number; dockWidth: number; gutter: number;
  sourcesWidth: number; valuesWidth: number;
}): HorizontalLayout {
  const sourcesBounds = { min: 192,
    max: Math.max(192, Math.min(420, input.shellWidth - input.gutter - 640)) };
  const valuesBounds = { min: 200,
    max: Math.max(200, Math.min(480, input.dockWidth - input.gutter - 360)) };
  return {
    sourcesWidth: clamp(input.sourcesWidth, sourcesBounds),
    valuesWidth: clamp(input.valuesWidth, valuesBounds),
    sourcesBounds, valuesBounds,
  };
}
```

Horizontal values describe expanded desktop panes; the caller removes their tracks/handles in
drawer/tab/hidden modes. The max>=min fallback must never be used to force those columns onto a
390 px screen. Measurements must be finite; skip disconnected/zero-size DOM readings in Task 3.

- [ ] Cover collapsed dock (`chromeHeight` excludes its handle), huge valid preferences,
  query drag +100 with dock unchanged, then dock +100 with Query unchanged, and hysteresis:

```ts
expect(compactForWidth(1440, 899, false)).toBe(true);
expect(compactForWidth(1440, 910, true)).toBe(true);
expect(compactForWidth(1440, 910, false)).toBe(false);
expect(compactForWidth(1440, 924, true)).toBe(false);
expect(compactForWidth(1279, 1100, false)).toBe(true);
expect(fitHorizontal({ shellWidth: 960, dockWidth: 900, gutter: 8,
  sourcesWidth: 400, valuesWidth: 800 })).toMatchObject({
  sourcesWidth: 312, valuesWidth: 480,
});
```

- [ ] Define storage ports without exposing DOM globals in pure tests:

```ts
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export const LAYOUT_KEY = 'byteql.ui.layout.v1';
export function readLayoutPreferences(storage: LayoutStorage | null): LayoutPreferences;
export function writeLayoutPreferences(
  storage: LayoutStorage | null, preferences: LayoutPreferences,
): void;
```

Implement read with try/catch around getItem and JSON.parse. If v1 text is absent, read the
legacy key and accept a nonempty finite numeric string in `(0, 10000]`. If v1 is present,
require a non-array object with version exactly 1; validate only the four named fields as
finite numbers in `(0, 10000]`, rounded, or null. Ignore extra fields. Unsupported/malformed
objects return `emptyPreferences()`. Write a freshly constructed whitelist object with those
five fields; catch errors. Never serialize the coordinator or a spread of caller state.

- [ ] Add these concrete storage regressions, then run both new test files:

```ts
it('imports a legacy height only when v1 is absent', () => {
  const data = new Map([['byteql.hexpane.height', '320']]);
  const storage = { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); } };
  expect(readLayoutPreferences(storage).dockHeight).toBe(320);
  writeLayoutPreferences(storage, emptyPreferences());
  expect(readLayoutPreferences(storage).dockHeight).toBeNull();
  expect(data.get('byteql.hexpane.height')).toBe('320');
});
it('rejects bad fields without discarding valid fields', () => {
  const storage = { getItem: () => JSON.stringify({ version: 1,
    sourcesWidth: '300', queryHeight: -8, dockHeight: 320, valuesWidth: 1e9 }),
    setItem: () => undefined };
  expect(readLayoutPreferences(storage)).toEqual({ ...emptyPreferences(), dockHeight: 320 });
});
```

Also test malformed JSON, unsupported version, array/null JSON, missing fields, `0`, and storage
get/set throwing. Confirm writing never includes SQL, filenames, or unknown properties.

**Review gate:** Numeric fixtures match the spec exactly; no DOM lookup, CSS string parsing,
localStorage access, or reactive state lives in `panel-layout.ts`.

## Task 2: One reusable input transaction and accessible separator

**Files:** Create `lib/ui/resize-handle.ts`, `.test.ts`, and `components/ResizeHandle.svelte`,
`.test.ts`. No application wiring yet.

**Interfaces:** `resizeHandle` is a Svelte action with an update method. Keep the ARIA component
small and put input mechanics in the action so cancellation can be tested without layout.

```ts
export interface ResizeOptions {
  orientation: 'horizontal' | 'vertical';
  direction: 1 | -1; // sign from increasing client coordinate to growing primary pane
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  cancelEpoch?: number; // external cancellation also releases action-owned pointer capture
  onstart(): void;
  onpreview(value: number): void;
  oncommit(value: number): void;
  oncancel(): void;
  onreset(): void;
}
export function resizeHandle(node: HTMLElement, options: ResizeOptions): {
  update(next: ResizeOptions): void;
  destroy(): void;
};
```

The component accepts all options plus `label`, `controls` and optional `compatibilityClass`.
All are controlled props; do not add an internal preferred height or storage key.

- [ ] Write failing action tests using a real jsdom element, mocked pointer capture methods,
  callback spies, and controllable rAF. The decisive pending-frame case is:

```ts
const previews: number[] = [];
const commits: number[] = [];
const handle = document.createElement('div');
handle.setPointerCapture = vi.fn();
handle.hasPointerCapture = vi.fn(() => true);
handle.releasePointerCapture = vi.fn();
document.body.append(handle);
const action = resizeHandle(handle, {
  orientation: 'horizontal', direction: 1, value: 116, min: 80, max: 400,
  onstart: vi.fn(), onpreview: value => previews.push(value),
  oncommit: value => commits.push(value), oncancel: vi.fn(), onreset: vi.fn(),
});
// Use a helper to define pointer fields when jsdom lacks PointerEvent; do not skip the test.
function pointer(type: string, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 7 }, isPrimary: { value: true }, button: { value: 0 },
    clientX: { value: 0 }, clientY: { value: y },
  });
  handle.dispatchEvent(event);
}
pointer('pointerdown', 100);
pointer('pointermove', 150);
pointer('pointerup', 200); // do not advance the queued animation frame
expect(commits).toEqual([216]);
action.destroy();
handle.remove();
```

- [ ] Implement exactly one active transaction `{pointerId, origin, startValue, lastCoordinate}`.
  On primary button 0 down: ignore when disabled or already active, prevent default, focus with
  preventScroll, capture, snapshot existing body cursor/user-select, call onstart. The coordinate
  is clientY for horizontal separators and clientX for vertical ones.

  The value equation is:

```ts
const candidate = startValue + options.direction * (coordinate - origin);
const next = Math.max(options.min, Math.min(options.max, candidate));
```

  Use the latest options bounds, but never replace origin/startValue during an update. Queue at
  most one rAF for preview, using the newest coordinate. Pointerup cancels queued preview,
  calculates from its own coordinate, previews the final value, clears the transaction, releases
  capture, restores global styles/listeners, and commits once. A no-motion transaction must not
  turn default/null preferences into saved sizes; call oncancel when the final value equals the
  original value so the coordinator also leaves its transaction. Store the original value
  separately from the mutable drag baseline. After a processed coordinate clamps, set
  origin=coordinate and startValue=next; this eliminates dead travel when reversing at a limit.
  Rebase only during coordinate processing, never merely because controlled props updated.
  Test overshoot, reverse by 10 px, and immediate 10 px pane movement.

- [ ] Route cancel, lost capture, Escape, window blur, visibility hidden, disable, and destroy
  through one idempotent cancel path. Call oncancel only for an active transaction. Deactivate
  before releasePointerCapture; use try/finally around capture cleanup. Restore original global
  styles, not blindly empty strings. Register document/window listeners only for active drag.
  If capture fails, cancel and clean up rather than leaving the document locked. In `update`,
  compare cancelEpoch with the previous value and cancel any active drag when it changes.

- [ ] Implement keyboard handling. Ignore Ctrl/Alt/Meta and unrelated keys. Appropriate arrows
  produce ±18, Shift ±72, multiplied by direction; Home/End use min/max without direction.
  Prevent default only for handled keys. Call onstart, onpreview, oncommit synchronously for
  a changed value. Escape cancels only an active pointer transaction. Double-click calls
  onreset after canceling any active transaction. Do not interpret Enter as collapse.

- [ ] Implement component markup using Svelte `use:resizeHandle`:

```svelte
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class={`panel-resize ${compatibilityClass ?? ''}`}
  data-orientation={orientation}
  role="separator"
  aria-label={label}
  aria-orientation={orientation}
  aria-controls={controls}
  aria-valuemin={Math.round(min)}
  aria-valuemax={Math.round(max)}
  aria-valuenow={Math.round(value)}
  aria-valuetext={`${Math.round(value)} pixels ${orientation === 'horizontal' ? 'high' : 'wide'}`}
  aria-disabled={disabled || undefined}
  tabindex={disabled ? -1 : 0}
  use:resizeHandle={{ orientation, direction, value, min, max, disabled, cancelEpoch,
    onstart, onpreview, oncommit, oncancel, onreset }}
></div>
```

Use a typed `$props()` destructure matching the interface. Add only locally justified Svelte
a11y suppression if the checker requires it for the action; do not globally disable rules.

- [ ] Add tests for right-button/secondary pointer ignored; wrong pointerId ignored; both axes
  and inverted inspection direction; clamps; Home/End; Shift; unrelated keys; pointercancel;
  unexpected lost capture; Escape; blur; visibility hidden; disabled update; unmount; capture
  failure; successful pointerup followed by lost capture; and no pending callback after cleanup.
  Component tests verify controlled value updates, ARIA controls, orientation, and disabled Tab.

```bash
pnpm --filter @byteql/web exec vitest run src/lib/ui/resize-handle.test.ts src/components/ResizeHandle.test.ts
pnpm --filter @byteql/web check
```

**Review gate:** No body style/listener persists after any terminal event. Pointerup observes
the final coordinate. Action tests do not depend on fabricated nonzero browser layout.

## Task 3: Shared coordinator; Query and inspection vertical resizing

**Files:** Create `use-panel-layout.svelte.ts` + `use-panel-layout.svelte.test.ts`. Modify Workbench, TraceDock,
its harness/tests, `styles/workbench.css`, and `hex-resize.spec.ts`. Delete dock-layout files
after replacing callers. Keep horizontal layout at its existing fixed sizes until Task 4.

**Interfaces:** The coordinator consumes Task 1 functions and Task 2 callback values. Its
input is one numeric measurement record; keep DOM measurement behind a separate exported
function in the same module so coordinator tests can provide numeric fixtures.

```ts
export interface LayoutMetrics {
  viewportWidth: number;
  viewportHeight: number;
  shellWidth: number;
  workspaceHeight: number;
  dockWidth: number;
  queryToolbar: number;
  notices: number;
  resultsToolbar: number;
  strip: number;
  tabs: number;
  hexChrome: number;
  gutter: number;
  dockCollapsed: boolean;
  bytesVisible: boolean;
}
export interface ResolvedLayout extends VerticalLayout, HorizontalLayout {
  compact: boolean;
}
export interface PanelLayoutController {
  readonly preferences: LayoutPreferences;
  readonly layout: ResolvedLayout;
  readonly active: PanelId | null;
  readonly cancelEpoch: number;
  measure(metrics: LayoutMetrics): void;
  begin(panel: PanelId): void;
  preview(panel: PanelId, value: number): void;
  commit(panel: PanelId, value: number): void;
  cancel(): void;
  reset(panel?: PanelId): void;
}
export function createPanelLayout(storage: LayoutStorage | null): PanelLayoutController;
export function observePanelMetrics(read: () => LayoutMetrics | null,
  elements: readonly Element[], onmeasure: (value: LayoutMetrics) => void): {
    schedule(): void;
    destroy(): void;
  };
```

Import types from Task 1/storage in the implementation. Initialize with responsive defaults and
safe nonnegative initial measurements, but do not save them. First meaningful measurements
replace the fallback. Use ordinary getters on the returned object to expose Svelte rune state.

- [ ] Add failing coordinator tests using the H=800 fixture, then shrinking to 500 and restoring
  800. The storage spy must report zero writes. A query drag preview must not write; commit
  updates Query and the current expanded dock pair exactly once. Cancel restores prior
  preferences, even if constraints changed. Reset-all writes the null-valued v1 record once.

```ts
const memory = new Map<string, string>();
const storage = { getItem: (key: string) => memory.get(key) ?? null,
  setItem: vi.fn((key: string, value: string) => { memory.set(key, value); }) };
const model = createPanelLayout(storage);
const metrics: LayoutMetrics = {
  viewportWidth: 1440, viewportHeight: 960, shellWidth: 1440,
  workspaceHeight: 800, dockWidth: 1208, queryToolbar: 36, notices: 0,
  resultsToolbar: 36, strip: 40, tabs: 0, hexChrome: 36, gutter: 8,
  dockCollapsed: false, bytesVisible: true,
};
model.measure(metrics);
model.begin('query');
model.preview('query', 216);
expect(model.layout).toMatchObject({ queryHeight: 216, dockHeight: 248, resultsHeight: 248 });
expect(storage.setItem).not.toHaveBeenCalled();
model.commit('query', 216);
expect(storage.setItem).toHaveBeenCalledTimes(1);
model.measure({ ...metrics, workspaceHeight: 500 });
model.measure(metrics);
expect(model.layout.queryHeight).toBe(216);
expect(storage.setItem).toHaveBeenCalledTimes(1);
```

- [ ] Implement `measure` by computing compact mode, bodyMin and chrome then resolving from
  nullable preferences/defaults. Use these exact expressions:

```ts
const bodyMin = metrics.bytesVisible ? Math.max(112, metrics.hexChrome + 72) : 112;
const chromeHeight = metrics.queryToolbar + metrics.notices + metrics.resultsToolbar
  + metrics.gutter + (metrics.dockCollapsed ? 0 : metrics.gutter);
```

For first-render/unmeasured hex chrome use 36 until the component reports its actual height.
Ignore hidden zero-height chrome reports; retain the last measurement until visible. Reconcile
when it becomes visible. Do not interpret hidden geometry as user intent.

`begin` saves a copy of preferences and resolved sizes. `preview` clamps with current bounds
and uses the frozen other vertical size (not its earlier preferred size). `commit` resolves the
final value before saving; vertical commits adopt both effective heights unless dock is
collapsed, horizontal commits only their field. `cancel` clears preview, restores the copied
preferences and resolves under current measurements without saving. Keep a single active drag.
`reset(panel)` clamps the default against the current other-pane bounds, storing null when the
default fits and the clamped number otherwise; adopt the other effective vertical size to prevent
an unrelated jump. `reset()`
sets all four fields to null and uses passive reconciliation. Save only after a changed intent.

The measurement setter cancels vertical transactions on changes to available height/chrome,
collapse, or compact mode. Horizontal transactions survive their own width changes but cancel
on external viewport width/height changes. Workbench cancels before opening a modal and before
making an active handle unavailable. This is distinct from action cleanup on actual unmount.
Every effective `cancel()` increments cancelEpoch, which Workbench passes to all four handles
(through TraceDock for Values). The action's update then releases its capture and listeners.
The resulting oncancel callback must be a no-op in the already idle coordinator. Ignore preview
or commit callbacks whose panel no longer matches active. Add a test for external cancellation
while a preview frame is pending, not just direct pointercancel.

- [ ] Implement `observePanelMetrics`: one ResizeObserver across explicit elements plus window
  resize; queue one rAF, call `read` once per frame, compare scalar snapshot fields, deliver only
  differences. Return schedule() and destroy(); destroy cancels the frame, disconnects, and
  removes the resize listener. Schedule the initial measurement immediately after registration.
  Recreate the observer only when bound element identities change, not when their sizes change.
  A content-height report/state change calls schedule() on this same object. Test that two
  observer callbacks coalesce and cleanup prevents a queued measurement.

- [ ] Make TraceDock controlled. Remove HEIGHT_KEY, read/write height, internal pointer handlers,
  resultsElement prop, dockBounds import, and its vertical observer. Add these geometry props
  alongside its existing semantic/snippet props:

```ts
height: number;
valuesWidth: number;
onchromechange: (value: { strip: number; tabs: number }) => void;
```

Its root uses the supplied height only when expanded; collapsed height is natural strip height.
Observe strip/tab refs to report their border-box height after mount and wrapping. Hidden tabs
report zero. Preserve trace summary, tab key navigation, values/bytes snippets, IDs, and collapse
callbacks. Update the harness to accept these controlled inputs. Replace old storage/height
ownership tests with prop/reporting and stable panel-node tests. Storage tests now live in Task 1.
Do not keep dead height preferences in TraceDock for compatibility.

- [ ] Wire the two vertical handles in Workbench, outside TraceDock. Add stable IDs to editor
  (`query-pane` wrapper), dock (`inspection-pane`) and set `aria-controls` accordingly. Keep the
  existing `.sql-editor` host and editor component intact; a wrapper can supply the grid area.
  Move only presentation ownership; controller calls and result-generation key stay in place.

Use named areas so optional notices, toolbars, and dividers cannot shift positional rows:

```css
.sql-workspace {
  display: grid;
  height: 100%;
  grid-template-areas:
    'query-heading' 'editor' 'notices' 'query-handle'
    'results-heading' 'results' 'inspection-handle' 'dock';
  grid-template-rows:
    auto var(--query-height) auto var(--panel-gutter)
    auto minmax(128px, 1fr) var(--inspection-gutter) var(--dock-height);
  min-width: 0;
  min-height: 0;
}
.editor-heading { grid-area: query-heading; }
.query-pane { grid-area: editor; min-width: 0; min-height: 0; }
.query-notices { grid-area: notices; max-height: min(160px, 25dvh); overflow-y: auto; }
.query-notices, .query-diagnostic span { min-width: 0; overflow-wrap: anywhere; }
.query-resize-slot { grid-area: query-handle; }
.results-heading { grid-area: results-heading; }
.results-panel { grid-area: results; }
.inspection-resize-slot { grid-area: inspection-handle; }
.trace-dock { grid-area: dock; }
.sql-editor { height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.sql-editor .cm-editor { height: 100%; min-width: 0; min-height: 0; }
.sql-editor .cm-scroller { overflow: auto; }
.workbench-main { overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; }
```

Set `--query-height` and expanded `--dock-height` from effective layout. Collapsed dock uses
`--dock-height: auto; --inspection-gutter: 0px`; remove the inspection handle. Query handle
remains. Bind workbench-main and intrinsic toolbar/notices refs; use their client/border-box
sizes consistently. Headers are auto rows with 36 px minimum, not fixed 36 px rows.

Do not blindly add the CSS on top of old selectors. Remove the six-row definition and the two
media overrides that impose 80 px. Replace `.sql-editor` overflow, not just its height.
Preserve Results/Values existing scrollers. Compare CSS Results height to solved resultsHeight
in acceptance tests; the CSS flex remainder and numeric solution must agree within 1 px.

- [ ] Add common handle CSS. Slots own geometry; each handle fills its slot. Set
  `--panel-gutter: 8px`, overridden to 24px under `(pointer: coarse)`, and measure it from a
  rendered slot/computed token. The rule is centered, 1px in the drag axis, with token-based
  hover/focus styling. Set pointer cursor from orientation, `touch-action: none`, border:0,
  margin:0, min-width:0, min-height:0. A focus outline must remain visible within the slot.
  No geometry transition or animation. No pseudo-element overlap into content.

Keep `.hex-resize` as compatibility class on the shared inspection handle, but remove its old
negative margin and absolute dock styling from this path. Scope old rules to standalone
`.hex-pane > .hex-resize`; embedded HexPane still has no internal separator.

- [ ] Update Workbench tests with numeric measurements, using the existing mock controller and
  EditorView access patterns. Assert resizing does not call runQuery/openFile/selectResultRow;
  keep editor node identity and document/undo history. Test notices appearing and disappearing,
  read-only querying state, collapsed inspection, and results generation replacement during
  drag. Adapt hex-resize test's handle location without weakening hit testing or Results minimum.

```bash
pnpm --filter @byteql/web exec vitest run src/lib/ui/use-panel-layout.svelte.test.ts src/components/TraceDock.test.ts src/components/Workbench.test.ts src/components/SqlEditor.theme.test.ts
pnpm --filter @byteql/web check
pnpm --filter @byteql/web test:e2e -- hex-resize.spec.ts trace-workspace.spec.ts
```

Use the actual chosen co-located test filename consistently: `use-panel-layout.svelte.test.ts`
for this rune module. Its tests execute in the existing Svelte/Vitest pipeline.

**Review gate:** Query and inspection exchange space only with Results. Old dock geometry and
storage owners are gone. No CSS row-order dependency, no growing parent measured as budget,
no storage writes from observers, no CodeMirror recreation.

## Task 4: Sources and Values widths, responsive transitions, reset

**Files:** Modify Workbench, TraceDock and their tests/harness, `workbench.css`, ShortcutsOverlay
and tests. Extend coordinator tests and create `e2e/panel-resize.spec.ts`.

**Interfaces:** Add `valuesBounds: Bounds`, `cancelEpoch: number`, and `onvaluestart`, `onvaluespreview(value)`,
`onvaluescommit(value)`, `onvaluescancel`, `onvaluesreset` callbacks to TraceDock. It renders
the shared handle but owns no preferences. Add `onresetpanels?: () => void` to ShortcutsOverlay;
show the reset button only when passed from a loaded Workbench.

- [ ] Write browser geometry tests before changing shell columns. This starting test checks
  actual movement; it is not satisfied by updating aria-valuenow alone:

```ts
import { expect, test, type Page } from '@playwright/test';
import { openMidiSample, runSql } from './support/app.js';

test.use({ viewport: { width: 1440, height: 960 } });

async function drag(page: Page, name: string, dx: number, dy: number) {
  const handle = page.getByRole('separator', { name, exact: true });
  const box = await handle.boundingBox();
  if (!box) throw new Error(`No rectangle for ${name}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  expect(await handle.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2,
      rect.y + rect.height / 2) === node;
  })).toBe(true);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

test('query growth takes room from Results, preserving inspection', async ({ page }) => {
  await openMidiSample(page);
  await runSql(page, 'select i from range(300) t(i)');
  await expect(page.getByRole('row', { name: 'Row 1', exact: true })).toBeVisible();
  const editor = page.locator('.sql-editor');
  const results = page.locator('.results-panel');
  const dock = page.locator('[data-trace-dock]');
  const q0 = (await editor.boundingBox())!.height;
  const r0 = (await results.boundingBox())!.height;
  const d0 = (await dock.boundingBox())!.height;
  await drag(page, 'Resize query', 0, 100);
  await expect.poll(async () => Math.round((await editor.boundingBox())!.height - q0)).toBe(100);
  expect(Math.round(r0 - (await results.boundingBox())!.height)).toBe(100);
  expect(Math.abs((await dock.boundingBox())!.height - d0)).toBeLessThanOrEqual(1);
});
```

- [ ] Convert desktop shell to three columns/areas and preserve narrow rules:

```css
.app-shell {
  grid-template:
    'header header header' var(--header-height)
    'explorer source-handle workbench' minmax(0, 1fr)
    'status status status' var(--status-height)
    / var(--sources-width) var(--sources-gutter) minmax(0, 1fr);
}
.explorer-drawer { grid-area: explorer; display: flex; min-width: 0; min-height: 0; }
.explorer-drawer > .explorer { flex: 1 1 auto; min-width: 0; min-height: 0; }
.source-resize-slot { grid-area: source-handle; min-width: 0; min-height: 0; }
.app-shell.explorer-collapsed { grid-template-columns: 0 0 minmax(0, 1fr); }
.trace-dock-body {
  grid-template-columns: var(--values-width) var(--values-gutter) minmax(0, 1fr);
}
.trace-dock.compact .trace-dock-body,
.trace-dock.values-hidden .trace-dock-body { grid-template-columns: minmax(0, 1fr); }
```

Use a source slot and `ResizeHandle` controlling `source-pane` (the desktop/drawer wrapper ID).
Values handle controls existing `dock-panel-values`. Remove the obsolete 224/208 columns and
their media overrides. Keep the existing one-column @media(max-width:959px) shell, drawer,
backdrop, inert subtree and independent columnCollapsed/drawerOpen. Inactive source/value handles
must be absent, not merely transparent. EmptyState still spans all columns and shows no handles.

- [ ] Replace viewport-only compactDock matching with the coordinator's measured-width decision.
  Keep matchMedia for the source drawer and responsive defaults. Remove the old 1279 listener
  and cleanup; one owner computes compact mode. When Values is hidden, only Bytes is shown;
  showing Values restores its width. Handle 900–923 hysteresis using the previous mode, initial
  compact=true, and viewport <1280 mandatory tabs.

Before a mode switch, inspect focus only within the affected dock DOM refs. If focus is in
Values/Bytes, make that its active compact tab (unless Values was explicitly hidden). If a
separator disappears, after tick focus the appropriate active tab or Sources/Values/inspection
toggle. Do not move focus just because the width changed. Preserve existing panel snippets;
do not create separate mobile/desktop instances.

- [ ] Wire reset-all to the shortcuts dialog. The button says “Reset panel sizes”, calls
  `model.reset()`, and stays in the dialog. Add help “Resize panel: focus divider, use arrows;
  Shift for larger steps; Home/End for limits; double-click to reset one size.” Add Escape-drag
  cancellation help. Do not add a toolbar full of sizing controls or a new preferences dialog.

- [ ] Expand tests with named outcomes: Sources +80 reduces workspace width by 80; Values +80
  reduces Bytes by 80; neither changes Query/Results height except legitimate chrome wrapping;
  both min/max clamp; collapsed Sources restores width; 959 drawer stays fixed; 1280 + wide
  Sources enters tabs; 924 restores columns; active-tab focus survives; audio component stays
  mounted; reset leaves theme/dock collapse/selection intact; storage blocked still permits drag.
  Update prior trace-workspace exact-width assertions only for the new gutter/defaults.

```bash
pnpm --filter @byteql/web exec vitest run src/components/Workbench.test.ts src/components/TraceDock.test.ts src/components/ShortcutsOverlay.test.ts src/lib/ui/use-panel-layout.svelte.test.ts
pnpm --filter @byteql/web test:e2e -- panel-resize.spec.ts trace-workspace.spec.ts hex-resize.spec.ts
```

**Review gate:** The real desktop Explorer wrapper has a box; drawer tests still pass; no
duplicated panels; no hidden separator tab stops; ARIA bounds update after width/mode changes.

## Task 5: Narrow Bytes access and content resize integration

**Files:** Modify HexPane + tests and `workbench.css`; extend TraceDock/Workbench measurement
wiring and `panel-resize.spec.ts`. Read `lib/hex/layout.ts` but do not change 16-byte geometry.
Conditionally modify ResultGrid only when the demand test demonstrates a failure.

**Interfaces:** Add optional `onchromeheightchange?: (height: number) => void` to HexPane.
Workbench passes that to coordinator measurements only for embedded usage. The callback reports
all non-drawing vertical space: `.hex-chrome` border-box height, pane borders, and the viewport's
horizontal scrollbar thickness. It does not report the whole panel height. Existing
source/read/caret APIs and standalone layout remain compatible.

- [ ] Write a browser test that constrains Bytes, scrolls its viewport horizontally, then clicks
  a known ASCII byte in the first row. Calculate cell x from the existing rendered font metrics
  and layout functions/patterns in `hex-provenance.spec.ts`, not hard-coded screenshot pixels.
  Verify `data-hex-caret` equals that byte offset, including after a divider drag. A test that
  only checks canvas width is insufficient. Check the last hex byte and final ASCII column are
  reachable and a nonzero first-row value still gives the correct global offset.

- [ ] Wrap existing hex toolbar, hint, and read-error chrome in `.hex-chrome`. Keep its actions,
  roles, labels, conditional content, and error retry intact. Measure the wrapper with one
  ResizeObserver across the wrapper and viewport; include root border thickness and
  `viewport.offsetHeight - viewport.clientHeight` (the viewport has no border) in the report.
  Report only changed nonzero height; disconnect when unmounted. Embedded
  body continues to fill the remaining height. Parent receives chrome changes without reaching
  into arbitrary children with previousElementSibling queries.

- [ ] Implement horizontal scrolling with the existing viewport as owner:

```css
.hex-chrome { flex: 0 0 auto; min-width: 0; }
.hex-body { min-width: 0; min-height: 0; }
.hex-viewport { min-width: 0; overflow-x: auto; overflow-y: hidden; }
.hex-canvas { max-width: none; flex-shrink: 0; }
```

Keep the canvas's CSS width equal to `columns.width`, and backing dimensions multiplied by DPR.
Keep the custom vertical scrollbar in its existing adjacent element. Use viewport.clientHeight
after horizontal scrollbar appearance for the number of painted rows. Do not scale the canvas
to its parent and do not add scrollLeft to the existing canvas-rectangle hit-test calculation.

- [ ] Store viewport scrollLeft in HexPane component state on native scroll. Restore it when the
  conditional viewport reappears; clamp naturally to the new width. A source/resetKey change
  may reset horizontal scroll consistently with existing source navigation, but ordinary resizing,
  hiding/showing, appearance, and tab changes must not reset it. Reopening must not rebuild cache.

For keyboard caret movement, goto and explicit reveal, expose the target hex cell:

```ts
// Import hexByteX from the existing layout module. Do not infer columns from canvas pixels.
function keepCaretHorizontallyVisible(offset: number): void {
  if (!viewportEl) return;
  const left = hexByteX(metrics, columns, offset % BYTES_PER_ROW);
  const right = left + 2 * metrics.charWidth;
  if (left < viewportEl.scrollLeft) viewportEl.scrollLeft = left;
  else if (right > viewportEl.scrollLeft + viewportEl.clientWidth) {
    viewportEl.scrollLeft = right - viewportEl.clientWidth;
  }
}
```

Call from explicit navigation paths after the viewport exists, not from every paint. An ordinary
resize should preserve scroll and selection, not force a selected row/caret back into view.
When hidden, defer exposure until the existing reveal/focus path opens the viewport.

- [ ] Update `onWheel`: when Shift or predominantly horizontal delta is present, handle native
  horizontal movement without executing the vertical byte-scroll branch. Plain deltaY retains
  its current custom row-scroll calculation. Respect deltaMode if applying deltas manually
  (pixels=1, lines=metrics.rowHeight, pages=viewport clientWidth). Prevent default only when
  consuming the horizontal gesture; a no-overflow horizontal gesture does not move byte rows.
  Verify scrollbar dragging, trackpad horizontal scrolling, and keyboard byte navigation.

- [ ] Add long-query integration checks: type at least 60 lines and one 500-character line;
  scroll to its end, select a word, grow/shrink Query, type, undo, and verify text/selection.
  `.cm-scroller` must own both editor axes, while `.sql-editor` has no independent scrolling.
  Toggle theme without rerunning SQL; CodeMirror's own resize observer should suffice.

- [ ] Add a paged-result test where enlarging Results crosses the existing demand threshold
  without a scroll event; assert rows load and no duplicate query generation appears. Retain
  the 300-row tail and million-row/window tests. If demand fails, use ONLY this integration:

```ts
$effect(() => {
  const element = scrollElement;
  if (!element || typeof ResizeObserver !== 'function') return;
  const observer = new ResizeObserver(() => scheduleDemandInspection());
  observer.observe(element);
  return () => observer.disconnect();
});
```

Retain existing demandFrame cancellation, rebase suppression, loadingMore/pageError checks and
demandGuard. Do not call controller.loadMore directly from the observer. Verify no request after
unmount/query replacement. If the virtualizer already meets the test, omit this production edit.

```bash
pnpm --filter @byteql/web exec vitest run src/components/HexPane.test.ts src/components/ResultGrid.demand.test.ts src/components/SqlEditor.theme.test.ts
pnpm --filter @byteql/web test:e2e -- panel-resize.spec.ts hex-provenance.spec.ts query-result-scrolling.spec.ts
```

**Review gate:** All bytes remain reachable at the minimum width. Scrolled canvas clicks select
the exact byte; no double scrollLeft/DPR adjustment. Long SQL undo and resize-driven paging work.

## Task 6: Adversarial regression matrix and final handoff

**Files:** Extend the tests already listed. No new production code unless a specific failed
acceptance test requires it. Record actual results in the execution handoff, not as claims here.

- [ ] Map every design gate to tests and manual evidence using the table below. Fill remaining
  cases in `panel-resize.spec.ts` with actual assertions; do not mark coverage from a test name.

| Design gate | Required test/evidence |
| --- | --- |
| G1/G2 | All four drags with real mouse, keyboard arrows/Shift/Home/End, physical rectangles, elementFromPoint and live ARIA comparison |
| G3 | Save large Query/dock sizes, shrink viewport, assert storage unchanged, restore viewport and assert original sizes |
| G4 | 1440×480 and 844×390: minima, workspace scroll, Run/error text/inspection reachable; document has no horizontal overflow |
| G5 | 960/959 drawer, 1279/1280 dock, dock-width hysteresis, Sources/Values collapse, focus return, stable editor/viewer instance |
| G6 | 60-line SQL, long line, selection/undo/scroll, query disable/enable, theme change |
| G7 | Existing 300/million-row tests, wide scroller/header alignment, growth-driven paging, selected global row survives |
| G8 | Horizontal hex scroll, byte/ASCII click after scroll, caret/goto exposure, bottom-of-file vertical range, hide/reopen |
| G9 | All action terminal events, pointerup before queued rAF, real drag then viewport/modal change, no storage write on cancel |
| G10 | Legacy/v1/invalid/throwing storage, reset-one and reset-all, inactive handles absent from Tab sequence |
| G11 | SQL error, long notices, source filename, multi-file selector, active byte filter, read-error chrome, export error/status wrapping |
| G12 | Existing MIDI/pcap/ZIP, multi-file, audio, downloads, recovery, privacy and worker/bundle tests |

- [ ] For bounds, compare `aria-valuenow` with the controlled pane's actual width/height within
  1 px after each step. For no-overflow, compare document/body client/scrollWidth and the specific
  scroll owners. During an active drag, cause a diagnostic or modal to appear and assert cancel
  cleanup. Reload with no source, then load a sample before asserting restored layout.

- [ ] Test 24 px coarse-pointer gutters in the numeric solver and in a touch-capable browser
  context. PointerEvent synthesis tests interruption logic but does not establish real touch
  usability. Manually drag by touch if a device is available; otherwise record it as unverified.
  Check keyboard accessibility with a screen reader if available; do not infer screen-reader
  usability solely from ARIA assertions.

- [ ] Inspect light/dark screenshots at 1440×900 and 1280×720, 1024×768, 390×844 with drawer
  closed/open and dock expanded, plus 1440×480. Perform actual 200% browser zoom separately:
  deviceScaleFactor and CSS zoom are not substitutes. Confirm handles don't steal toolbar
  clicks, create decorative heavy bars, or disappear against either appearance. Screenshot
  artifacts belong in ignored test output, not tracked fabricated fixtures.

- [ ] Run the final verification sequence once after focused tests pass:

```bash
pnpm check
pnpm lint
pnpm -r test -- --run
pnpm --filter @byteql/web check:bundle
pnpm --filter @byteql/web test:e2e
git diff --check
git status --short
```

`pnpm check` builds, runs workspace checks, and checks formatting. It does not run root eslint;
that is why `pnpm lint` is explicit. Do not replace the e2e gate with isolated numeric tests.
Investigate failures; do not repeat full suites without a new change or unresolved concern.

- [ ] Review the diff for forbidden shortcuts and accidental scope:

```bash
rg -n 'dockBounds|storedDockHeight|resultsElement|resizeStartHeight' apps/web/src/components/TraceDock.svelte apps/web/src/lib/ui
rg -n 'grid-template-rows|grid-template-columns|overflow' apps/web/src/styles/workbench.css
rg -n 'byteql.hexpane.height|byteql.ui.layout.v1' apps/web/src
git diff --stat
```

Legacy height references are expected only in the preferences migration and standalone HexPane;
the old TraceDock owner must be absent. Workbench can remove its old resultsElement ref once no
consumer needs it. Keep any unrelated ResultsGrid selection and generation logic untouched.

- [ ] Report the implemented behaviors, automated command results, actual screenshot/manual
  findings, and any unverified browser/touch/accessibility cases. Do not call the feature fully
  verified if a listed gate is still untested. Do not deploy as part of implementation.

## Suggested prompt for the implementing model

> Implement the approved resizable-panel design in
> `docs/superpowers/specs/2026-09-10-resizable-panels-design.md`, following
> `docs/superpowers/plans/2026-09-10-resizable-panels.md` in order. Start by checking the working
> tree and audited base. Keep the current layout arrangement and all data components mounted.
> Use one central geometry owner and the shared handle; do not copy the old dock sizing logic
> into Query. Complete each task's focused tests before continuing. Preserve query history,
> provenance, paging, exports and audio. Do not add dependencies or deploy. Report any required
> design deviation before broadening the implementation. Keep manual evidence distinct from
> automated results, and preserve unrelated changes.
