# ByteQL Trace Workspace Implementation Plan

> For agentic workers: use `superpowers:executing-plans` to implement this plan sequentially,
> task by task, after the user accepts the proposed design and requests execution. This task
> requested documents only. Do not execute the plan as part of writing it. Checkboxes track
> execution, not planning. Use one implementation model; parallel agents are not required.

**Goal:** Replace Command Deck with a distinctive binary-analysis workspace and complete light/dark
design system, centered on a wide result grid and a shared values/bytes inspection dock.

**Architecture:** Keep the controller, result paging, workers, database, and format packs intact.
Move presentation into a two-column shell, with a snippet-composed `TraceDock` owning its geometry.
Small UI helpers own appearance, local font readiness, and truthful range presentation.

**Tech stack:** Existing Svelte 5, TypeScript, Vite, CodeMirror 6, TanStack Virtual, canvas, Vitest,
Testing Library, and Playwright. Local IBM Plex font assets; no new runtime packages.

**Spec:** [Trace Workspace design](../specs/2026-09-10-trace-workspace-design.md).

**Status:** Proposed execution instructions, based on `af54133`; no implementation performed.

**Confirmed choices:** The user selected the precision-instrument personality and warm light
default with a fully specified dark mode. Keep these choices fixed; this confirmation does not
authorize implementation or imply approval of every detailed design decision.

## Global constraints

- Keep Svelte 5, TypeScript, CodeMirror 6, TanStack Virtual, and the canvas hex renderer.
- Add no UI framework, component kit, icon package, animation package, or runtime font service.
- Serve all runtime assets locally; emit zero network requests after application readiness.
- Keep `RESULT_ROW_HEIGHT = 36`, the 16,384-row result window, and existing demand-loading logic.
- Preserve the selected ByteQL logo artwork; do not crop, recolor, redraw, or replace it.
- Keep source ranges end-exclusive internally; display the last included byte as `end - 1`.
- Keep presentation preferences out of `SessionState`, query data, and source-file persistence.
- Preserve existing query, intake, export, playback, cancellation, recovery, and provenance behavior.

The spec's planning-only restriction applies until the user requests execution. This document does
not authorize deployment or installing skills. Commits during execution require the user's Git
scope; checkpoint subjects below are suggestions, not instructions to stage unrelated files.

## Execution protocol for a less expensive model

Read the spec once, then process one task at a time. Within a task, read the listed files, add the
specified behavioral regression, confirm it fails for the intended reason, implement, and run the
targeted gate. For purely visual CSS moves, use type/build checks and screenshots rather than
inventing source-string tests. Do not rewrite entire components just to change their markup.

Task order is binding: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10**. Tasks 1–3 establish the visual
foundation, 4–6 establish the new workspace, and 7–10 complete interaction and verification.
Do not ask the implementation model to choose new fonts, invent components, or reinterpret colors.

Use this handoff prompt in a new execution session:

```text
Implement docs/superpowers/plans/2026-09-10-trace-workspace.md against its linked spec.
The approved direction is Trace Workspace, with light default and dark appearance.
Work sequentially, preserve all engine and paging contracts, and complete each task's gate.
Do not deploy. Report the completed task, changed files, verification, and any real blocker.
Do not claim visual approval without inspecting the required rendered screens.
```

The direction and appearance choice are confirmed. Use that prompt when requesting implementation
of the detailed design. If the spec changes, update the prompt and
plan first. Task 3 and Task 10 include visual review checkpoints; fix deviations from the spec
there before continuing or reporting completion. A missing browser connection is a validation
limitation to report, not grounds for substituting imagined screenshots.

## File ownership map

All paths below are relative to `apps/web/`, except where explicitly qualified.

| Files | Responsibility |
| --- | --- |
| `src/styles/tokens.css` | Exact spec palette, geometry, type, motion and elevation tokens |
| `src/styles/base.css` | Font stacks, reset, focus, shared button/input/icon primitives |
| `src/styles/workbench.css` | Header/catalog/query/results/dock and responsive geometry |
| `src/styles/components.css` | Intake, menus, diagnostics, downloads, viewer/status presentation |
| `src/app.css` | Imports the four layers in the specified order |
| `src/lib/ui/theme.ts` | Validated appearance preference and root attribute |
| `src/lib/ui/fonts.ts` | Three eager local FontFace loads before app readiness |
| `src/lib/ui/trace.ts` | Range validation, display formatting and trace-summary union |
| `src/lib/ui/dock-layout.ts` | Pure dock resize constraints and stored-height validation |
| `src/lib/ui/focus.ts` | Reusable focus containment/restoration for modal surfaces |
| `src/lib/hex/font.ts` | One canvas font specification for measurement and painting |
| `src/components/ui/Icon.svelte` | Small finite inline SVG icon vocabulary |
| `src/components/AppearanceToggle.svelte` | Appearance button, no domain state |
| `src/components/TraceBar.svelte` | Source trace readout and reveal/collapse controls |
| `src/components/TraceDock.svelte` | Height, resize, tabbed/side-by-side snippet composition |
| `src/components/Workbench.svelte` | Existing session coordination and new layout composition |
| Existing components | Existing tool behavior, new markup/semantic token consumers |

New helper/component unit tests are co-located. New browser coverage belongs in
`e2e/trace-workspace.spec.ts`. Modify `command-deck.spec.ts` for new identity expectations; do not
delete its behavioral coverage. No separate design-system demo application or Storybook project.

## Preflight

- [ ] Read local `AGENTS.md`, the linked spec, and the existing files for Task 1.
- [ ] Run these from the repository root and note any unrelated work or baseline failures:

```bash
git status --short
git rev-parse HEAD
pnpm --filter @byteql/web check
pnpm --filter @byteql/web exec vitest run src/components/Workbench.test.ts src/components/HexPane.test.ts src/components/ResultsDownload.test.ts
```

- [ ] Confirm the September download feature is present. Older PRD/AGENTS snapshots are not the
  current complete feature inventory. Do not modify `packages/` for this redesign.
- [ ] If implementation requires an isolated checkout, establish it using the available worktree
  workflow before edits. Preserve these proposed documents and all unrelated user changes.

## Task 1: Token system, stylesheet boundaries, and appearance preference

**Files:** Create the four `src/styles/*.css` files, `src/lib/ui/theme.ts` and its test,
`src/components/AppearanceToggle.svelte` and its test. Modify `src/app.css`, `src/main.ts`,
`src/components/SqlEditor.theme.test.ts`. Read all existing global CSS before moving it.

**Interfaces:** Produce `Theme = 'light' | 'dark'`, `readTheme(storage): Theme`, and
`applyTheme(theme, root, storage): void`. AppearanceToggle props are
`{ theme: Theme; onchange: (theme: Theme) => void }`. Root attribute is `data-theme`.

- [ ] Add tests for light default, a stored dark value, invalid value fallback, and throwing storage.

```ts
import { describe, expect, it } from 'vitest';
import { readTheme } from './theme.js';

describe('appearance preference', () => {
  it('validates storage and defaults to light', () => {
    expect(readTheme(null)).toBe('light');
    expect(readTheme({ getItem: () => 'dark' })).toBe('dark');
    expect(readTheme({ getItem: () => 'system' })).toBe('light');
    expect(readTheme({ getItem: () => { throw new Error('blocked'); } })).toBe('light');
  });
});
```

- [ ] Run `pnpm --filter @byteql/web exec vitest run src/lib/ui/theme.test.ts`; confirm the missing
  implementation is the failure, then implement:

```ts
export type Theme = 'light' | 'dark';
export const THEME_KEY = 'byteql.ui.theme.v1';
type ThemeReader = Pick<Storage, 'getItem'>;
type ThemeWriter = Pick<Storage, 'setItem'>;

export function readTheme(storage: ThemeReader | null): Theme {
  try { return storage?.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}

export function applyTheme(theme: Theme, root: HTMLElement, storage: ThemeWriter | null): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  try { storage?.setItem(THEME_KEY, theme); } catch { /* Preference is optional. */ }
}
```

- [ ] In `main.ts`, get localStorage inside a try/catch (its getter can throw), read the theme,
  and apply it before `mount`. In the toggle render one labelled button; on click call
  `onchange(theme === 'light' ? 'dark' : 'light')`. The parent will own the reactive value.
- [ ] Split existing CSS by the ownership table. `app.css` becomes:

```css
@import './styles/tokens.css';
@import './styles/base.css';
@import './styles/workbench.css';
@import './styles/components.css';
```

- [ ] Copy every exact color in spec §4.3 into the light/dark blocks. Add the specified editor
  aliases and shared spacing/type/dimension tokens. Keep geometry initially compatible with the
  old shell so this task is independently usable. Remove gradient/glow/backdrop effects and old
  token consumers while preserving their functional layout rules.
- [ ] In `SqlEditor.theme.test.ts`, replace Command Deck literal expectations with a token test
  that reads `tokens.css`, parses light and dark blocks separately, resolves simple `var` aliases,
  and applies its existing luminance calculation to both. Test subtle text across canvas, surface,
  inset, raised, hover, selection, and hex highlight; all SQL colors on editor background and active
  line; danger/warning on their surfaces; action text on action fill; focus/strong borders at 3:1.
  Keep the editor's CSS-token contract test. Do not weaken contrast thresholds.
- [ ] Run the theme/toggle/editor-color tests and web check. Inspect computed colors in both
  appearances once browser access exists; temporary old geometry is expected until Task 6.

Checkpoint subject: `feat(web): establish trace workspace design tokens`.

## Task 2: Local typography, font readiness, and editor/canvas appearance

**Files:** Create `src/assets/fonts/IBMPlexSans-Regular.woff2`,
`IBMPlexSans-SemiBold.woff2`, `IBMPlexMono-Regular.woff2`, `LICENSE.txt`, `PROVENANCE.md` in that
directory; `src/lib/ui/fonts.ts`, `fonts.test.ts`, `src/lib/hex/font.ts`, `font.test.ts`.
Modify `src/App.svelte`, `src/App.test.ts`, `src/styles/base.css`, `src/styles/tokens.css`,
`src/components/SqlEditor.svelte`, `SqlEditor.theme.test.ts`, `HexPane.svelte`, `HexPane.test.ts`.

**Interfaces:** `prepareUiFonts(): Promise<'loaded' | 'fallback'>`, memoized for the session.
`measureHexFont(context, family): { fontSpec: string; charWidth: number }`.
Add optional `appearance?: Theme` to SqlEditor and HexPane, defaulting to light.

- [ ] Obtain the three files and license from the official IBM Plex source, record an exact commit
  and hashes, and do not add the complete font family. The verified source directories are
  [Sans WOFF2](https://github.com/IBM/plex/tree/master/packages/plex-sans/fonts/complete/woff2) and
  [Mono WOFF2](https://github.com/IBM/plex/tree/master/packages/plex-mono/fonts/complete/woff2).
  Resolve the upstream revision at execution time and use that immutable revision for downloads.
  A download failure is not permission to use a CDN in runtime CSS.
- [ ] Add unit coverage for all three font loads completing, one failure selecting fallback,
  repeated calls sharing the same promise, and app readiness waiting for a deferred font promise.
  Use mocked FontFace objects; tests must not fetch fonts. Keep App's existing database disposal
  and stale-startup tests.
- [ ] Implement the font loader with eager Vite `?url` imports and three FontFace instances:

```ts
import sansRegularUrl from '../../assets/fonts/IBMPlexSans-Regular.woff2?url';
import sansSemiboldUrl from '../../assets/fonts/IBMPlexSans-SemiBold.woff2?url';
import monoRegularUrl from '../../assets/fonts/IBMPlexMono-Regular.woff2?url';

type FontResult = 'loaded' | 'fallback';
let pending: Promise<FontResult> | null = null;
async function loadFonts(): Promise<FontResult> {
  let result: FontResult = 'fallback';
  try {
    if (typeof FontFace !== 'undefined' && document.fonts) {
      const definitions = [
        ['IBM Plex Sans', sansRegularUrl, '400'],
        ['IBM Plex Sans', sansSemiboldUrl, '600'],
        ['IBM Plex Mono', monoRegularUrl, '400'],
      ] as const;
      const faces = definitions.map(([family, url, weight]) =>
        new FontFace(family, `url(${JSON.stringify(url)})`, { weight, style: 'normal' }),
      );
      const outcomes = await Promise.allSettled(faces.map((face) => face.load()));
      if (outcomes.every((outcome) => outcome.status === 'fulfilled')) {
        for (const face of faces) document.fonts.add(face);
        result = 'loaded';
      }
    }
  } catch { /* Fall back without blocking the query engine. */ }
  document.documentElement.dataset.fonts = result;
  return result;
}
export function prepareUiFonts(): Promise<FontResult> {
  return pending ??= loadFonts();
}
```

  Guard unavailable FontFace/document.fonts with the same fallback result. On any failure wait
  for all attempted loads to settle, add none, and use fallback stacks for the rest of the session.
  Do not introduce a timeout that leaves font requests running after readiness.

- [ ] Keep default root stacks system-only. `:root[data-fonts='loaded']` sets the exact Plex
  stacks. Use FontFace loading above, not a second CSS `@font-face` declaration that could trigger
  late requests. Set `font-variant-numeric: tabular-nums` and data/code ligatures off.
- [ ] Start `prepareUiFonts()` alongside engine startup in App; await it before publishing the
  controller/readiness marker. Keep database ownership/cleanup correct when initialization fails
  while fonts are pending. Retry may reuse the settled font result. Startup text uses fallback
  fonts until the promise completes.
- [ ] Test and implement one canvas font contract:

```ts
export function measureHexFont(
  context: Pick<CanvasRenderingContext2D, 'font' | 'measureText'>,
  family: string,
): { fontSpec: string; charWidth: number } {
  const fontSpec = `12px ${family}`;
  context.font = fontSpec;
  const measured = context.measureText('0').width;
  return { fontSpec, charWidth: Number.isFinite(measured) && measured > 0 ? measured : 7.2 };
}
```

  Measure after the mounted HexPane element has computed styles. Replace the hard-coded
  JetBrains measurement and constant CHAR_WIDTH with reactive metrics from this helper. Paint
  with the returned `fontSpec`. Do not change byte layout mathematics or the 18 px row height.
  If canvas context is unavailable use the same 12 px fallback specification and 7.2 px width.
  Update coordinate-sensitive tests to derive positions through `columnLayout`/`hexByteX` instead
  of assuming the old installed font's width.

- [ ] Give CodeMirror a separate appearance Compartment. Reconfigure its `EditorView.theme`
  light/dark flag when `appearance` changes; retain CSS-token color rules, editable compartment,
  document, undo stack, and selection. In HexPane observe appearance and schedule a repaint only;
  do not call reveal/reset APIs. Resolve CSS aliases before passing colors to canvas.
- [ ] Run:

```bash
pnpm --filter @byteql/web exec vitest run src/lib/ui/fonts.test.ts src/lib/hex/font.test.ts src/components/SqlEditor.theme.test.ts src/components/HexPane.test.ts src/App.test.ts
pnpm --filter @byteql/web check
```

Checkpoint subject: `feat(web): load local typefaces and synchronize canvas typography`.

## Task 3: Header, intake, and shared icon vocabulary

**Files:** Create `src/components/ui/Icon.svelte` and `src/components/AppHeader.test.ts`.
Modify `AppHeader.svelte`, `EmptyState.svelte`, `EmptyState.test.ts`, `SampleMenu.svelte`,
`SampleMenu.test.ts`, `Workbench.svelte`, `App.svelte`, both layout/component styles,
`e2e/command-deck.spec.ts`. Do not edit the artwork in `src/assets/`.

**Interfaces:** Add AppHeader props `appearance: Theme`,
`onappearancechange: (theme: Theme) => void`, `onshortcuts: () => void`,
`intakeBusy?: boolean`; preserve source/toggle callbacks. Workbench owns appearance state and calls
`applyTheme`, passing appearance to the editor and hex. EmptyState's public onopen/onsample props
remain. Add `openFile(): void` as a public EmptyState method and bind its instance in Workbench so
Mod+O works during idle as well as loaded sessions.

- [ ] Update intake tests to require a single visible Open file action and an attached labelled
  multiple input. Test native success, AbortError (silent), non-abort failure (alert plus fallback),
  and fallback input selection/reset. Add a Workbench test that Mod+O reaches the idle intake.
- [ ] Replace the decorative Unicode glyphs with the finite Icon component. Define a union of
  `sources | values | sun | moon | shortcuts | chevron | close | file | table | arrow`.
  Use this stroke-only path map; no downloaded icon dependency:

```ts
const paths = {
  sources: 'M3 4h18v16H3z M9 4v16',
  values: 'M3 4h18v16H3z M15 4v16',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  moon: 'M20 15a8 8 0 0 1-11-11A8 8 0 1 0 20 15z',
  shortcuts: 'M3 6h18v12H3z M6 9h1 M10 9h1 M14 9h1 M18 9h1 M6 12h1 M10 12h1 M14 12h1 M18 12h1 M7 15h10',
  chevron: 'm8 4 8 8-8 8',
  close: 'm6 6 12 12 M18 6 6 18',
  file: 'M5 3h9l5 5v13H5z M14 3v6h5',
  table: 'M3 4h18v16H3z M3 9h18 M3 14h18 M9 4v16',
  arrow: 'M4 12h16 M14 6l6 6-6 6',
} as const;
let { name }: { name: keyof typeof paths } = $props();
```

```svelte
<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
  stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d={paths[name]} />
</svg>
```

  Icons are decorative; parent controls supply accessible names. Keep the map in the component
  script and the SVG in its markup.

- [ ] Implement the spec's exact intake copy and 5:3 layout. Keep SAMPLES as the sole sample list;
  show its descriptions and preserve the Try sample button/menu and current item labels.
  Supplied logo is uncropped at 80 px desktop/64 px narrow. Remove the hero proof cards and slogans.
- [ ] The visible Open file button calls this gesture-safe path; use it for the public method too:

```ts
function openFile(): void {
  if (busy) return;
  pickerError = null;
  if (!window.showOpenFilePicker) { input?.click(); return; }
  void window.showOpenFilePicker({ multiple: true })
    .then((handles) => Promise.all(handles.map((handle) => handle.getFile())))
    .then((files) => { if (files.length) onopen(files); })
    .catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      pickerError = error instanceof Error ? error.message : 'The file picker could not open.';
    });
}
```

  Use `export function openFile` in the component, declare `pickerError` and the input binding
  locally, and render Use file input only after non-abort failure. In Workbench retain the loaded
  hidden picker and delegate idle shortcuts to the bound EmptyState. Do not double-trigger native
  picker and input. Keep replacement semantics and existing controller error handling.

- [ ] Header: live ByteQL wordmark, “Binary file workspace” descriptor, source context, Open,
  Sources/Values controls, AppearanceToggle and Keyboard shortcuts. Idle hides Sources/Values;
  its Open file action is in intake only. Disable open actions while intake is busy. Startup copy
  becomes the exact spec text, with existing Retry startup behavior preserved.
- [ ] Update Command Deck tests' identity/copy/color assertions, keeping image completeness,
  narrow-view intake reachability and no-page-overflow coverage. Pass component tests and check:

```bash
pnpm --filter @byteql/web exec vitest run src/components/EmptyState.test.ts src/components/SampleMenu.test.ts src/components/AppHeader.test.ts src/components/Workbench.test.ts
pnpm --filter @byteql/web test:e2e -- command-deck.spec.ts
```

- [ ] **Visual checkpoint 1:** inspect light/dark intake at 1440×900 and 390×844. Verify the exact
  type scale, flat surfaces, brand proportions, and single clear intake action. Correct deviations
  before starting layout work. Do not call the loaded screen finished at this milestone.

Checkpoint subject: `feat(web): redesign file intake and workspace controls`.

## Task 4: Source catalog and example query semantics

**Files:** Modify `Explorer.svelte`, `Workbench.svelte`, `SqlEditor.svelte`, styles.
Create `Explorer.test.ts`; extend `Workbench.test.ts`.

**Interfaces:** Add Explorer props `currentFile?: string | null` and
`onselectsource?: (file: string) => void`. Preserve `state`, `onquery`, `onbrowse`, `collapsed`.
Add `SqlEditor.focus(): void`, backed by its existing EditorView.

- [ ] Add a component test verifying source selection calls only onselectsource, Browse calls
  only onbrowse, and an example query calls only onquery. Test schema expansion independently
  from Browse and the diagnostic 50-item cap. Use the existing readyState fixture shape in
  Workbench.test.ts for integration; do not create a controller implementation in tests.
- [ ] Render source rows as buttons with a visible “Viewing bytes” marker for currentFile. Wire
  Workbench's existing `switchHexFile` as the owner; show the dock's Bytes view once Task 6 exists.
  Do not call run or mutate draftSql from the source-selection callback.
- [ ] Replace table summary-with-nested-button markup with independently focusable controls:

```svelte
<div class="table-entry">
  <div class="table-entry-heading">
    <button type="button" aria-expanded={expandedTables.has(table.name)}
      aria-controls={`schema-${tableIndex}`} onclick={() => toggleSchema(table.name)}>
      {table.name}<span class="row-count">{table.rowCount.toLocaleString()} rows</span>
    </button>
    <button type="button" aria-label={`Browse ${table.name}`}
      onclick={() => onbrowse(table.name)}>Browse</button>
  </div>
  <dl id={`schema-${tableIndex}`} hidden={!expandedTables.has(table.name)} class="schema-list">
    {#each table.columns as column (column.name)}
      <div><dt>{column.name}</dt><dd>{column.type}{column.nullable ? '?' : ''}</dd></div>
    {/each}
  </dl>
</div>
```

  Declare `expandedTables` as `$state(new Set<string>())`; replace the Set on toggle so updates
  are reactive. Obtain tableIndex from the existing table each block. Reset expansion only when
  a new source batch opens. Do not use arbitrary table names as CSS selectors or DOM IDs.

- [ ] Change “Saved queries” to “Example queries”, “Capture map / Explorer” to a single Sources
  heading, and preserve the Tables region and Data explorer landmark. Use 32 px navigation rows,
  semantic type colors, and a single catalog scroll owner.
- [ ] Bind SqlEditor in Workbench. After loading an example query, `await tick()` then call its
  `focus()` method. Keep the once-per-source overview logic unchanged. Narrow drawer dismissal
  is wired in Task 7.
- [ ] Run:

```bash
pnpm --filter @byteql/web exec vitest run src/components/Explorer.test.ts src/components/Workbench.test.ts
pnpm --filter @byteql/web check
```

Checkpoint subject: `feat(web): clarify source and query navigation`.

## Task 5: Truthful trace summary and shared range formatting

**Files:** Create `src/lib/ui/trace.ts`, `trace.test.ts`, `TraceBar.svelte`, `TraceBar.test.ts`.
Modify `Inspector.svelte`, `StatusBar.svelte`, `Workbench.svelte`, and their current tests where available.

**Interfaces:** Produce the following types and functions. `TraceBar` props are
`{ summary: TraceSummary; collapsed: boolean; onreveal: () => void; ontoggle: () => void }`.
Its root has `role="region"`, `aria-label="Source trace"`, and `data-trace-state={summary.kind}`.

```ts
export interface SourceRange { file: string; start: number; end: number }
export type TraceSummary =
  | { kind: 'empty' | 'unselected' | 'outside-window' | 'unlinked' | 'unavailable'; message: string }
  | { kind: 'linked'; row: number; range: SourceRange; label: string };
export interface TraceInput {
  hasResult: boolean;
  selectedGlobalRow: number | null;
  selectedLocalRow: number | null;
  provenance: SourceRange | null;
  files: readonly { name: string; size: number }[];
}
export function formatByteRange(start: number, end: number): string | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
  const hex = (n: number) => `0x${n.toString(16).padStart(8, '0')}`;
  return `${hex(start)}–${hex(end - 1)} · ${end - start} bytes`;
}
export function buildTraceSummary(input: TraceInput): TraceSummary {
  if (!input.hasResult) return { kind: 'empty', message: 'Run a query to inspect source bytes.' };
  if (input.selectedGlobalRow === null) return { kind: 'unselected', message: 'Select a row to trace its source bytes.' };
  if (input.selectedLocalRow === null) return { kind: 'outside-window', message: 'Selected row is outside the loaded window.' };
  if (!input.provenance) return { kind: 'unlinked', message: 'This row has no source byte range.' };
  const range = input.provenance;
  const file = input.files.find((candidate) => candidate.name === range.file);
  const label = formatByteRange(range.start, range.end);
  if (!file || !label || range.end > file.size) return { kind: 'unavailable', message: 'Source bytes are unavailable for this row.' };
  return { kind: 'linked', row: input.selectedGlobalRow + 1, range, label };
}
```

- [ ] Add focused tests before implementation:

```ts
expect(formatByteRange(12, 20)).toBe('0x0000000c–0x00000013 · 8 bytes');
expect(formatByteRange(0, 1)).toBe('0x00000000–0x00000000 · 1 bytes');
expect(formatByteRange(20, 20)).toBeNull();
expect(formatByteRange(-1, 4)).toBeNull();
expect(formatByteRange(0, Number.MAX_SAFE_INTEGER + 1)).toBeNull();
const selected = {
  hasResult: true, selectedGlobalRow: 16385, selectedLocalRow: 1,
  provenance: { file: 'second.zip', start: 12, end: 20 },
  files: [{ name: 'second.zip', size: 100 }],
};
expect(buildTraceSummary(selected)).toMatchObject({ kind: 'linked', row: 16386 });
expect(buildTraceSummary({ ...selected, selectedLocalRow: null })).toMatchObject({ kind: 'outside-window' });
expect(buildTraceSummary({ ...selected, provenance: null })).toMatchObject({ kind: 'unlinked' });
expect(buildTraceSummary({ ...selected, files: [] })).toMatchObject({ kind: 'unavailable' });
```

  Put these assertions in named Vitest cases with normal imports. Also cover no result, no
  selection, NaN, a range past file EOF, and a filename mismatch.

- [ ] Implement TraceBar's linked state as row → file → range with an Inspect source button;
  non-linked states render their message and no reveal button. Every state has Show/Hide inspection
  with `aria-expanded`. Keep the strip mounted while the dock is collapsed. Button tests verify
  callbacks and missing action for unavailable data, not CSS snapshots.
- [ ] Replace Inspector/footer range string assembly with `formatByteRange`. Guard a null return
  with the spec's unavailable message. Pass known source files to Inspector as an optional prop
  so its reveal action uses the same validation as TraceBar; the prop type is
  `sourceFiles?: readonly { name: string; size: number }[]`, defaulting to an empty array.
  Pass Workbench's existing sourceFiles into its current Inspector invocation in this task.
  Do not display a clickable invalid range. Maintain the Provenance region used by browser tests.
- [ ] Run:

```bash
pnpm --filter @byteql/web exec vitest run src/lib/ui/trace.test.ts src/components/TraceBar.test.ts src/components/StatusBar.test.ts src/components/Workbench.test.ts
pnpm --filter @byteql/web check
```

Checkpoint subject: `feat(web): add explicit source trace presentation`.

## Task 6: Shared inspection dock and wide results layout

**Files:** Create `src/lib/ui/dock-layout.ts`, `dock-layout.test.ts`, `TraceDock.svelte`,
`TraceDock.test.ts`, `e2e/trace-workspace.spec.ts`. Modify `Workbench.svelte`, `Workbench.test.ts`,
`HexPane.svelte`, `HexPane.test.ts`, `Inspector.svelte`, `src/styles/workbench.css`,
`e2e/hex-resize.spec.ts`. This task replaces layout; do not rewrite controller subscriptions.

**Interfaces:** Add `layout?: 'standalone' | 'embedded'` and `visible?: boolean` to HexPane,
defaulting to standalone/true. Preserve every existing prop and both public methods; add
`focusViewport(): void` implemented as `viewportEl?.focus()` for explicit source inspection.
Produce `DockTab = 'values' | 'bytes'` and the following TraceDock props:

```ts
import type { Snippet } from 'svelte';
import type { TraceSummary } from '../lib/ui/trace.js';

interface Props {
  summary: TraceSummary;
  collapsed: boolean;
  oncollapsedchange: (collapsed: boolean) => void;
  compact: boolean;
  showValues: boolean;
  tab: 'values' | 'bytes';
  ontabchange: (tab: 'values' | 'bytes') => void;
  onreveal: () => void;
  resultsElement: HTMLElement | null;
  values: Snippet;
  bytes: Snippet;
}
```

TraceDock owns height and pointer resizing. Workbench owns collapse preference, active tab, and
whether Values are visible on wide layouts. Read `byteql.hexpane.collapsed` once at initialization,
defaulting to collapsed below 700 px only when no valid preference exists. Preserve this state
across breakpoint crossings; do not overwrite user preference on resize.

- [ ] Add pure resize tests and embedded-mode tests before changing layout:

```ts
expect(dockBounds({ height: 248, resultsHeight: 360, overflow: 0, stripHeight: 40, compact: false }))
  .toEqual({ min: 152, max: 480 });
expect(dockBounds({ height: 248, resultsHeight: 128, overflow: 0, stripHeight: 40, compact: true }))
  .toEqual({ min: 188, max: 248 });
expect(storedDockHeight('garbage')).toBe(248);
expect(storedDockHeight('-80')).toBe(248);
```

  In HexPane.test.ts assert embedded mode has no Resize hex view separator or local collapse
  action, does not mutate legacy geometry keys, and keeps caret/selection after visible false→true.
  Retain all standalone tests.

- [ ] Implement pure bounds with this exact contract:

```ts
export interface DockGeometry {
  height: number;
  resultsHeight: number;
  overflow: number;
  stripHeight: number;
  compact: boolean;
}
export function storedDockHeight(value: string | null): number {
  const height = Number(value);
  return Number.isFinite(height) && height > 0 ? Math.max(152, height) : 248;
}
export function dockBounds(input: DockGeometry): { min: number; max: number } {
  const min = Math.max(40, input.stripHeight) + (input.compact ? 36 : 0) + 112;
  const slack = Math.max(0, input.resultsHeight - 128);
  return { min, max: Math.max(min, input.height + slack - Math.max(0, input.overflow)) };
}
```

  The standalone `paneResizeBounds` stays unchanged. TraceDock reads actual `.results-panel`
  height through resultsElement, strip height through its element, and workspace overflow through
  its parent. Observe geometry changes with ResizeObserver and clamp without animation.

- [ ] Add TraceDock's root `data-trace-dock`, `data-dock-collapsed`, and explicit pixel height
  only when expanded. Put the separator above the strip with a 6 px pointer hit area layered above
  adjacent chrome. Give it `aria-label="Resize inspection"`, horizontal orientation, numeric
  min/max/now, and tabindex. Preserve `.hex-resize` as a compatibility class during this migration
  so the existing topmost-hit-test regression still applies; its owner is now TraceDock.
  Pointer up/cancel releases capture and commits valid height; ArrowUp/Down change 18 px;
  Home/End use current bounds. Storage access must catch exceptions.
- [ ] Render TraceBar always, then Values/Bytes panels using snippets. Keep both panels mounted;
  use `hidden` on the inactive panel. In wide mode hide only Values when showValues is false;
  Bytes then spans the full dock. In compact mode use the tab contract completed in Task 7.
  A collapsed dock hides its body and separator, leaving only TraceBar.
- [ ] Implement embedded HexPane without implicit geometry ownership. Derive effective collapse
  as `layout === 'embedded' ? !visible : collapsed`; use it for data attributes, painting, and
  body visibility. Suppress the internal resize handle/toggle and fixed height in embedded mode.
  Guard standalone storage reads, writes, and resize observers by layout mode. Keep existing
  byte cache, selection, coverage, reset-key, and highlight memoization.
- [ ] Recompose Workbench into two outer columns and a single workspace. Bind resultsElement
  on the existing `.results-panel`. Keep the editor, notices, results toolbar, and results panel
  in their current relative order; replace the old inline hex row with TraceDock. Move the one
  existing Inspector and the one existing HexPane into its snippets. Remove the old right shell
  column and whole-workbench mobile tab markup. Do not mount duplicate tools for each breakpoint.

```svelte
{#snippet values()}
  <Inspector table={session.result?.window ?? null}
    viewerTable={session.result?.completeTable ?? null}
    selectedRow={selectedLocalRow} selectedGlobalRow={session.selectedRow}
    sourceFiles={sourceFiles} collapsed={!valuesVisible} mobileOpen={valuesVisible}
    {viewers} {activeViewer} {audioEngineFactory}
    onopenviewer={openViewer} oncloseviewer={() => (activeViewerId = null)}
    onrevealrange={revealInspectorRange} />
{/snippet}
{#snippet bytes()}
  <HexPane bind:this={hexPane} layout="embedded" visible={bytesVisible} {appearance}
    blob={sourceBlob} fileSize={hexFileSize}
    coverage={coverageResult.index} coverageReason={coverageResult.reason}
    highlight={rowHighlight && rowHighlight.file === hexFile
      ? { start: rowHighlight.start, end: rowHighlight.end } : null}
    filterAvailable={coverageResult.reason === 'ok'} resetKey={hexResetKey}
    compact={compactDock} files={sourceFiles} currentFile={hexFile}
    onreveal={revealAt}
    onselectionchange={(range) =>
      controller.selectByteRange(range && hexFile ? { file: hexFile, ...range } : null)}
    onfilter={(range) => hexFile && run(wrapFilterSql(draftSql || session.sql, { file: hexFile, ...range }))}
    onfilechange={switchHexFile} />
{/snippet}
```

  `valuesVisible = !dockCollapsed && (compactDock ? dockTab === 'values' : !inspectorCollapsed)`;
  `bytesVisible = !dockCollapsed && (!compactDock || dockTab === 'bytes')`.
  `compactDock` means viewport width below 1280 px. Preserve sourceBlob,
  coverageResult, hexResetKey, rowHighlight, switchHexFile, revealAt, and filter SQL wiring.

- [ ] Derive traceSummary from session.result, selected global/local rows, the existing memoized
  rowHighlight, and sourceFiles. Implement Workbench functions `openViewer(viewer)`,
  `revealInspectorRange(range)`, and `inspectSource()` as follows: open the dock; activate Values
  for a viewer or Bytes for a reveal; unhide Values when opening a viewer; await Svelte tick;
  then call `hexPane?.revealRange(range)` followed by `hexPane?.focusViewport()` for a reveal.
  The existing revealRange only scrolls; do not assume it also moves focus. Inspect source uses only a linked
  traceSummary. Do not execute SQL from these presentation functions.
- [ ] Apply the desktop layout. Essential CSS shape:

```css
.app-shell {
  display: grid;
  grid-template: 'header header' 48px 'explorer workbench' minmax(0, 1fr)
    'status status' 28px / 224px minmax(0, 1fr);
  height: 100dvh;
}
.sql-workspace {
  display: grid;
  grid-template-rows: 36px 116px auto 36px minmax(128px, 1fr) auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.trace-dock-body { display: grid; grid-template-columns: 256px minmax(0, 1fr); min-height: 0; }
.results-panel, .result-grid, .trace-dock, .trace-values, .trace-bytes { min-width: 0; min-height: 0; }
.result-grid { overflow: hidden; }
.grid-scroll { overflow: auto; }
[hidden] { display: none !important; }
```

  Add the spec's collapsed-catalog column rule, wide Values-hidden rule, dock flex-fill behavior,
  toolbar/body sizing, and short-screen editor rule. Set `.workbench-main` to min-width/min-height
  zero, and allow its own vertical overflow only when minimum tool chrome cannot fit; it must not
  become a competing horizontal scroller. Avoid the old grid's third column and
  selector rules that hide `.sql-workspace` when Inspector is active.

- [ ] Update resize e2e assertions to measure `[data-trace-dock]` for height/top rather than the
  embedded hex child's height. Keep topmost separator, upward growth, and viewport fit checks.
  Add keyboard limits/persistence and a dock-collapse/reopen selection test. Run:

```bash
pnpm --filter @byteql/web exec vitest run src/lib/ui/dock-layout.test.ts src/components/TraceDock.test.ts src/components/HexPane.test.ts src/components/Workbench.test.ts
pnpm --filter @byteql/web test:e2e -- hex-resize.spec.ts hex-provenance.spec.ts query-result-scrolling.spec.ts
```

Checkpoint subject: `feat(web): connect results to a shared inspection dock`.

## Task 7: Responsive composition and complete keyboard behavior

**Files:** Create `src/lib/ui/focus.ts`, `focus.test.ts`. Modify `Workbench.svelte`,
`AppHeader.svelte`, `TraceDock.svelte`, `ShortcutsOverlay.svelte`, `ShortcutsOverlay.test.ts`,
`SampleMenu.svelte`, `ViewerMenu.svelte`, `ResultsDownload.svelte`, associated tests,
`src/styles/workbench.css`, `src/styles/components.css`, `e2e/trace-workspace.spec.ts`.

**Interfaces:** `containFocus(panel: HTMLElement, onescape: () => void): () => void` installs
keyboard containment and returns cleanup that restores focus to the previously focused element
if connected. Use it only for modal drawer/shortcuts surfaces. Popover menus use roving item focus
and restoration without claiming modality. ResultsDownload remains a nonmodal dialog.

- [ ] Test Escape and Tab/Shift+Tab wrap in modal panels; after close, focus returns to the opener.
  Test that hidden dock panels and the closed drawer are not tab-reachable. Add browser tests for
  960/959, 1280/1279, and 700/699 breakpoint crossings with a selected row and byte caret.
- [ ] Implement the helper using a keydown listener and a live list of focusable descendants:

```ts
const selector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(selector))
  .filter((node) => !node.closest('[hidden], [inert]') && node.getClientRects().length > 0);
```

  On Escape call onescape. On Tab wrap first↔last; if no focusable elements, keep focus on the
  panel with tabindex -1. Capture the original focused HTMLElement before initial focus.
  Cleanup removes the listener and returns focus when connected. In tests, mock client rects
  for visible elements, not all hidden elements. Modal backdrop clicks close only when the
  backdrop itself is the event target. Use `inert` on obscured workspace content, not on the
  entire app ancestor containing the modal.

- [ ] Add layout media queries at 1280, 960, and 700 px exactly as spec §5.6. At widths below 960,
  render the catalog in the same mounted nav inside an opaque drawer with a labelled dialog
  wrapper, close control, backdrop, and focus containment. Keep it closed by default. Browsing a
  table/example closes it; selecting a source opens Bytes. Preserve user choice when crossing
  a breakpoint during an existing session.
- [ ] TraceDock compact tabs are a tablist named “Inspection views”, with Values and Bytes tabs,
  aria-selected, aria-controls, and tabpanels. Home/End and arrows change tab and focus the new
  tab. Workbench remains mounted when dock panels hide. Remove old Results/Inspector tab keyboard
  handlers and replace tests with the new contract rather than retaining inaccessible duplicate UI.
- [ ] Wire Mod+B to Sources; Mod+I toggles Values on wide screens. In compact mode Mod+I opens
  the dock on Values, or switches to Bytes if Values is already active. Mod+G opens the dock on
  Bytes and then calls focusGoto. Header Values follows the same behavior. `?` opens shortcuts
  outside editable content only; platform labels use the existing navigator convention.
- [ ] Sample/Viewer menus: focus the first enabled menuitem when opening, handle ArrowUp/Down,
  Home/End, Escape, click outside, and return focus to the opener on dismissal. For a selection,
  allow the owning action to move focus to its destination. Keep existing visible names.
- [ ] Keep download dialog semantics nonmodal: Escape and outside-click close it and return focus;
  do not trap the whole workspace. Its existing user-gesture download path stays synchronous.
- [ ] Add browser coverage using the real UI:

```ts
test('narrow source drawer returns focus and does not cover results by default', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMidiSample(page);
  const opener = page.getByRole('button', { name: 'Show sources', exact: true });
  await expect(page.getByRole('dialog', { name: 'Sources' })).toBeHidden();
  await opener.click();
  const drawer = page.getByRole('dialog', { name: 'Sources' });
  await expect(drawer).toBeVisible();
  await drawer.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
});
```

  Update `openMidiSample` in `e2e/support/app.ts` to wait for the ready Tables region to be
  attached when the narrow drawer is closed, instead of requiring its Browse button visible.
  Test helpers that intend to interact with Browse must open Sources first at narrow widths.
  Do not remove waits for actual readiness.

- [ ] Run focus/menu/shortcut/Workbench tests, web check, and trace-workspace + open-query-inspect
  browser tests. Inspect 390×844 and 1024×768 views, coarse-pointer targets and 200% zoom.

Checkpoint subject: `feat(web): make trace workspace navigation responsive and accessible`.

## Task 8: Results, values, downloads, viewers, and all state surfaces

**Files:** Modify `ResultGrid.svelte`, `Inspector.svelte`, `ResultsDownload.svelte`,
`AudioViewer.svelte`, `StatusBar.svelte`, `Workbench.svelte`, component styles and relevant existing
tests. Add `Inspector.test.ts` if value/range cases are not covered by Workbench tests.

**Interfaces:** Preserve ResultGrid's props, demand functions, generation key, and row/cell semantics.
Inspector uses the optional sourceFiles prop from Task 5. No export/controller/viewer API changes.

- [ ] Add/adjust tests for unlinked aggregate rows, zero rows, page error retry, selected global
  rows outside the decoded window, and a missing source. Ensure no-source state has no Inspect
  source control and never retains a previous row's range. Reuse existing Arrow fixtures.
- [ ] Apply the 36 px grid row treatment, header/type hierarchy, right numeric alignment, and
  selected-row inset bracket. Use an inset shadow or positioned pseudo-element for the bracket;
  do not change row height/border-box sizing. Mark the workspace with
  `data-trace-linked={traceSummary.kind === 'linked'}` so the bracket only becomes ochre for
  validated provenance. Keep `.grid-scroll` as sole grid scroll owner:

```css
.grid-row { height: 36px; font-size: 13px; line-height: 20px; }
.grid-row.selected {
  background: var(--color-selection);
  box-shadow: inset 3px 0 var(--color-focus);
}
[data-trace-linked='true'] .grid-row.selected { box-shadow: inset 3px 0 var(--color-evidence); }
.grid-row [role='gridcell'] { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.grid-row .cell-numeric { text-align: right; font-variant-numeric: tabular-nums; }
```

  This functional inset marker is permitted even though decorative pane shadows are removed.
  Keep hidden-column controls and aria indices tied to actual fields. No new row-number data
  column, column sorting, eager result materialization, or fixed row limit.

- [ ] Remove duplicate Query console/Ask the capture and Result set/Results headings. Use Query
  and Results with spec sizing. Keep `.results-heading-meta` and current count strings so demand
  and export tests continue asserting truthful values. Zero rows keeps schema headers and shows
  “No rows returned. Adjust the query and run again.”, not the no-file intake screen.
- [ ] Restyle Values as a compact key/value list. Preserve full string/byte formatting behavior,
  distinguish NULL, and keep Provenance as a labelled region. Use the shared range validator for
  links. Do not require all results to have row provenance.
- [ ] Restyle existing downloads without changing its state machine. Keep all statuses and
  format/provenance controls, capability explanations, cancel/save/retry routes, and a visible
  Close download options control. Use a viewport-clamped width of 360 px, max `calc(100vw - 24px)`,
  with internal vertical scrolling. Keep native `<select>` and inputs.
- [ ] Apply tokens to AudioViewer/ViewerMenu; no hard-coded old colors/shadows remain. Audio
  opens in Values and closes back to values. Use existing registry eligibility and completeTable
  limits. Appearance and width changes do not change activeViewerId or dispose audio.
- [ ] Apply state treatments from spec §5.7: startup retry, parsing/progress/cancel, query alert,
  format/coverage reason, page retry, hex read retry, partial diagnostic summary, export failure,
  and ready-to-save. Keep alerts in their owning surface. Use phase-only polite announcements in
  status; leave throughput metrics outside the live region.
- [ ] Run:

```bash
pnpm --filter @byteql/web exec vitest run src/components/Workbench.test.ts src/components/ResultGrid.demand.test.ts src/components/ResultsDownload.test.ts src/components/AudioViewer.test.ts src/components/StatusBar.test.ts
pnpm --filter @byteql/web test:e2e -- query-result-scrolling.spec.ts results-download.spec.ts audio.spec.ts recovery.spec.ts zip.spec.ts multi-file.spec.ts
```

Checkpoint subject: `style(web): complete trace workspace tool and state surfaces`.

## Task 9: Appearance stability, privacy, provenance, and visual acceptance

**Files:** Extend `e2e/trace-workspace.spec.ts`, `e2e/privacy.spec.ts`, `e2e/zip.spec.ts`,
`e2e/hex-provenance.spec.ts`, and source component tests only where a discovered regression requires
it. Use existing sample/fixture helpers. Do not modify engine code to make presentation tests pass.

**Interfaces:** No new runtime API. Reuse `[data-app-ready]`, `[data-hex-pane]`, `[data-trace-dock]`,
`[data-trace-state]`, `.grid-scroll`, and existing test-harness hooks solely in e2e builds.

- [ ] Add the following appearance regression, with the existing support imports:

```ts
test('appearance preserves row and byte selection', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMidiSample(page);
  await page.getByRole('button', { name: 'Browse events' }).click();
  const row = page.getByRole('row', { name: 'Row 3', exact: true });
  await row.click();
  const pane = page.locator('[data-hex-pane]');
  const before = await pane.getAttribute('data-hex-highlight');
  await page.getByLabel('Go to offset').fill('0x10');
  await page.getByLabel('Go to offset').press('Enter');
  await page.getByRole('button', { name: 'Use dark appearance' }).click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(pane).toHaveAttribute('data-hex-highlight', before!);
  await expect(pane).toHaveAttribute('data-hex-caret', '16');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
```

  Add a separate undo-history assertion: type an edit, toggle appearance, return focus to SQL,
  invoke Undo, and verify the pre-edit text returns. Capture `.grid-scroll.scrollTop` before
  switching and assert within 1 px after it. Test both directions.

- [ ] Extend the existing privacy test after `waitForAppReady`: toggle dark and light, open and
  close a menu and the inspection dock, then keep all existing file/query/export/audio sentinel
  actions and the final `requests === []` assertion. Do not filter out same-origin fonts or
  move readiness later than the actual font/engine-ready boundary to hide late component loads.
- [ ] Add a font-failure browser case that intercepts the three `.woff2` URLs before navigation
  and aborts them. Verify `data-fonts="fallback"`, readiness, a working sample, and byte selection
  alignment. For loaded fonts, click a known byte position derived from computed font measurement
  and the existing `columnLayout`/`hexByteX` helpers; assert the expected offset, including the
  first byte after the eight-byte gap and an ASCII-column click. No hard-coded old pixel guesses.
- [ ] Extend ZIP coverage with the existing `makeZip` helper, `select * from local_files`, a selected
  member, source highlight, goto its start, and Enter revealing the row. Assert original archive
  offsets, not decompressed content provenance. Keep the two-archive auto-switch test.
- [ ] Re-run existing MIDI/pcap round trips and multi-file following. For an aggregate query
  (`select count(*) as n from events`), select the row and assert the unlinked trace message,
  absent Inspect source button, retained Values, and no stale highlight.
- [ ] Capture actual screenshots for the spec's matrix using Playwright `page.screenshot` or the
  connected browser. For screenshot files use `testInfo.outputPath('name.png')` so routine test
  output does not become a committed artifact. Record the fixture, SQL, viewport and appearance
  in the implementation handoff. Disable only nonessential animation and wait for fonts/results;
  do not hide error states or replace real content.
- [ ] **Visual checkpoint 2:** compare every required screen against spec sections 4–5. Verify
  readable small text, correct brand proportions, no stray navy/glow/card styling, full-width
  results, shared dock, meaningful evidence color, confined overflow, all actions reachable,
  and legible light/dark error/selection states. Check forced-colors focus/labels and reduced motion.
  Fix the actual component styles; do not cover drift with a final override stylesheet.

Checkpoint subject: `test(web): verify trace workspace interactions and privacy`.

## Task 10: Final regression gate and handoff

**Files:** Only files required by failures from the preceding tasks; update the spec/plan status
to implemented only after the user has authorized implementation and the gates are met. Do not
rewrite historical specs or add unrelated reports as part of this plan.

- [ ] Format only touched files and run `git diff --check`. Audit the diff: no changes to parsers,
  session reducer, database, result paging, worker protocol, export encoding, or asset artwork.
  `src/lib/session/result-scroll.ts` should still declare `RESULT_ROW_HEIGHT = 36`.
- [ ] Run the repository gate from root:

```bash
pnpm check
pnpm lint
pnpm -r test -- --run
pnpm --filter @byteql/web check:bundle
pnpm --filter @byteql/web test:e2e
git diff --check
git status --short
```

  `pnpm check` includes the normal production build, package checks and formatting; it does not
  include the separate eslint command. Browser acceptance builds `dist-e2e`. Never deploy it.
  If full tests have baseline/environment failures, distinguish them from change regressions
  with evidence; do not disable tests or claim the full gate passed.

- [ ] Check spec coverage using this map:

| Spec acceptance | Implemented/tested in tasks |
| --- | --- |
| A1 identity | 1, 2, 3, 6, 8, 9 |
| A2 intake | 3, 4, 7, 10 |
| A3 query/data | 4, 5, 8, 9 |
| A4 scale | 6, 8, 10 |
| A5 trace | 5, 6, 9 |
| A6 geometry | 6, 7, 9 |
| A7 appearance/fonts | 1, 2, 3, 9 |
| A8 accessibility | 1, 3, 4, 7, 9 |
| A9 complete states | 3, 5, 8, 9 |
| A10 privacy | 2, 9, 10 |

- [ ] If commit authority exists, stage only the task's explicit changed files and use the
  conventional checkpoint subjects or a final scoped commit. No AI/co-author trailers. Do not
  use `git add .` in a dirty worktree, push, open a PR, or deploy without that workflow being in
  scope. If commit authority is absent, hand off the verified working tree.
- [ ] Final handoff reports: design delivered, preserved workflows, test commands/results,
  screenshot locations and inspected states, remaining browser/usability limitations, and exact
  Git status. Human unaided sample→row→bytes usability review is separate from automated tests.
  Do not declare it passed on the user's behalf.

## Recovery rules for the executor

If layout breaks provenance, inspect the component mounting, visibility, reset-key identities,
source-following and font metrics before touching coverage algorithms. If rows disappear, inspect
CSS height/overflow and mounted scroll elements before touching paging. If privacy fails, identify
the exact request; do not allowlist fonts, analytics, or sample fetches after readiness. If colors
fail contrast, adjust the relevant semantic token in both spec and implementation and rerun the
affected pair checks; do not lower the threshold. If the approved visual direction changes,
revise the spec and plan together before continuing implementation.
