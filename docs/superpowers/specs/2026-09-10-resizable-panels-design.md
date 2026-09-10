# Resizable ByteQL panels — design

Date: 2026-09-10

Status: Proposed design and execution handoff; application changes are not implemented.
The user confirmed keeping the current arrangement. The detailed sizing choices below are
recommendations for review, not claims of separate user approval.

Companion: [Implementation plan](../plans/2026-09-10-resizable-panels.md).

## 1. Recommendation

Keep the Trace Workspace arrangement and add four consistent, accessible dividers:

1. Sources ↔ workspace: changes Sources width.
2. Query ↕ Results: changes the editor body height, with notices staying below Query.
3. Results ↕ inspection: changes the complete inspection dock height.
4. Values ↔ Bytes: changes Values width within the expanded, side-by-side dock.

Results take the remaining width and height. Bytes take the remaining dock width. These are
resizable panels through their shared boundaries; they do not need independent size settings.
Audio/viewers occupy Values and resize with it. Headers, status, and individual catalog sections
are content/chrome, not additional split panes. Drawer width stays fixed on narrow screens.

Use a small controlled `ResizeHandle` component, pure geometry functions, and one Workbench-owned
layout state. Remove the dock's independent vertical size calculation when the shared calculation
lands. Keep geometry completely outside session/query state.

```text
Header
Sources │ Query toolbar
        │ Editor                    ← preferred height; internally scrollable
        │ Notices                   ← content height, with a bounded scroll area
        ├──────── Query divider ──────────────────────────
        │ Results toolbar
        │ Results                   ← remaining height; minimum 128 px
        ├──────── Inspection divider ─────────────────────
        │ Trace strip               ← remains when dock is collapsed
        │ Values       │ Bytes      ← widths controlled by their divider
Status
```

The query divider gives a long SQL document useful space without changing its text, caret,
selection, undo history, or result generation. Its End key takes all space Results can spare.
Hiding inspection with the existing control makes more room available for Query.

### Alternatives

| Approach | Benefit | Problem | Decision |
| --- | --- | --- | --- |
| Controlled dividers + one layout calculation | Fits the existing DOM and lifecycle; testable sizing rules | Requires deliberate input/accessibility work | Recommended |
| CSS `resize` on each panel | Very small initial change | Independent sizes do not arbitrate shared minima, persistence, keyboard behavior, or responsive modes | Reject |
| General split/docking framework | Useful for arbitrary arrangements and docking | Adds a dependency and reconciliation layer; still needs app-specific budgeting, persistence and lifecycle tests | Defer until movable panels are requested |

No new runtime dependency is necessary. This is not an arbitrary panel tree, docking engine,
multiple-query layout, or result-column resizing feature. Do not add snap-to-collapse, automatic
content-height growth, fullscreen Query, or panel movement to this implementation.

## 2. Evidence and current gotchas

Audited checkout: `3672e87e4ceadfda50aaa789dfa5d9c8f9a0a7ec`. Working tree was clean initially.
Read PRD §9 and Appendix A, the current Trace Workspace design, implementation, and regression tests.
The current source supersedes July orientation details for presentation. No connected browser was
available; rendered geometry, touch usability, and screen-reader behavior remain execution gates.

| Evidence in current source | Consequence for this change |
| --- | --- |
| `styles/workbench.css`: Sources 224/208 px; editor 116/80 px; Values 256 px | Replace every competing fixed-size rule, including height/width media-query overrides |
| `.sql-workspace` has six positional rows | Inserting handles silently shifts rows unless areas are named |
| `TraceDock.svelte` measures Results and workspace overflow to derive its own maximum | Two independent resizers can fight; replace, do not copy this ownership model |
| `dock-layout.ts` always returns `max >= min`, even when the viewport cannot fit minima | A legal bound does not prove the layout fits; model unavoidable overflow explicitly |
| Dock separator's ARIA calculation reads nonreactive DOM sizes separately from drag bounds | Accessibility values and pointer limits can disagree; derive both from one numeric snapshot |
| Query/results toolbars use 36 px rows but wrap at narrow widths | Measure intrinsic toolbar heights; a fixed row can overlap following content |
| Notices and trace strip can change after query errors, selection, source changes, and wrapping | Recalculate on content/container changes, not only `window.resize` |
| Dock compact mode is based only on viewport width 1280 px | A widened Sources panel can leave too little space for two dock columns |
| `.explorer-drawer` is `display: contents` on desktop | It has no useful desktop box to measure or position a divider against |
| `.sql-editor` already has `overflow: auto`; CodeMirror owns `.cm-scroller` | Make CodeMirror the editor's sole scrolling owner |
| `.grid-scroll` owns both result axes; paging depends on measured viewport | Preserve that ownership and test resize-driven demand without an artificial scroll |
| `HexPane` paints a fixed-width, 16-byte canvas; `.hex-viewport` is `overflow: hidden` | Narrowing Bytes clips data today; horizontal access is a prerequisite |
| Hex hit testing subtracts the canvas bounding rectangle | Preserve that coordinate system after horizontal scroll; do not add scrollLeft a second time |
| Hex viewport observer tracks height; viewport/canvas are conditionally rendered when visible | Keep component state stable and restore horizontal scroll when its viewport is recreated |
| Dock uses `byteql.hexpane.height`; standalone HexPane also has independent support | Migrate preference once; embedded HexPane must not become another size owner |
| `hex-resize.spec.ts` tests a past handle/toolbar overlap failure | Put new handles in their own tracks; retain the real hit-test regression |
| Inspector and hex/cache/viewer state already survive outer layout changes | Do not branch or key mounted components by dimensions, mode, theme, or active tab |

## 3. Binding constraints

- Keep Svelte 5, TypeScript, CodeMirror 6, TanStack Virtual, and the existing canvas renderer.
- Add no runtime dependency, external asset, network request, or persisted file/query content.
- Keep `RESULT_ROW_HEIGHT = 36`, the 16,384-row result window, and existing paging safeguards.
- Preserve query, export, cancellation, byte provenance, source switching, and audio behavior.
- Store presentation preferences outside `SessionState` and the controller.
- Resize must not remount SqlEditor, ResultGrid, Inspector, or HexPane components.
- Keep the existing result-generation key; never key results by size or responsive mode.
- This task produces only this design and its companion plan; do not implement, commit, push,
  deploy, or overwrite earlier design documents during planning.

## 4. Geometry contract

All sizes below are CSS pixels, not device pixels. Preferences describe border-box sizes.
Constants are initial product choices, subject to rendered review; do not silently change them.

| Dimension | Default | Minimum | Maximum / behavior |
| --- | --- | --- | --- |
| Sources width | 224 at viewport ≥1280; otherwise 208 | 192 | `min(420, shellWidth - sourceGutter - 640)` on desktop |
| Editor body height | 116; 80 at viewport height <760 or width <700 | 80 | Available budget after the current dock and Results minimum |
| Expanded dock total height | 248 | `strip + tabs + bodyMin` | Available budget after the current editor and Results minimum |
| Dock body height | Remainder | `max(112, hexChrome + 72)` when Bytes visible; otherwise 112 | Internal Values content scrolls |
| Values width | 256 | 200 | `min(480, dockWidth - valuesGutter - 360)` |
| Results panel height | Remainder | 128 | No separate preference |
| Divider track | 8 for fine pointer; 24 for coarse pointer | Same | Measured once from the CSS token/media rule |

`strip` is measured and at least 40. `tabs` is the actual tab row height in compact mode, else
zero. `hexChrome` includes the embedded hex toolbar, hint, read-error UI, pane borders, and
horizontal scrollbar thickness. Measure `.hex-chrome` plus those non-drawing pixels.
The extra 72 px leaves four hex rows visible. Re-measure
when source selector/filter/error controls wrap. Values, including its audio viewer, scrolls
inside the existing Values surface rather than forcing its intrinsic content height on the dock.

The query divider sits AFTER notices and BEFORE the Results toolbar. Only editor body height is
the user preference. Notices use natural height capped at `min(160px, 25dvh)` with local vertical
scrolling; all diagnostic text remains reachable. It must wrap long unbroken strings.

### 4.1 One vertical budget

Let `H` be the measured `.workbench-main` client height (not the overflowing workspace height).
Let `C` be the query toolbar + notices + Results toolbar + query divider + expanded-dock divider.
When inspection is collapsed, omit its divider and use the measured trace-strip height as `D`.
The strip is counted in `D`, never also in `C`.

```text
B = H - C
Qmin = 80
Rmin = 128
Dmin = collapsed ? strip : strip + tabs + bodyMin

Passive reconciliation, including first load:
Q = clamp(preferredQuery, Qmin, max(Qmin, B - Dmin - Rmin))
D = collapsed ? strip : clamp(preferredDock, Dmin, max(Dmin, B - Q - Rmin))
R = max(Rmin, B - Q - D)
overflow = max(0, C + Q + R + D - H)
```

This protects the desired editor height first when the screen shrinks: shrink inspection toward
its useful minimum, then Query toward 80. Results retains 128. When even the minimum set cannot
fit, use `.workbench-main` vertical scrolling. Do not clip actions or invent negative tracks.
When space returns, reconcile from preferences, not the clamped values.

For direct dragging or a keyboard step, freeze the OTHER vertical pane at its effective height:

```text
query bounds = [80, max(80, B - currentDock - 128)]
dock bounds  = [Dmin, max(Dmin, B - currentQuery - 128)]
```

Moving a divider exchanges space only with Results. It does not silently collapse a neighbor.
When no space is available the handle can explain its limit through value text, and End is a
no-op. The existing Hide inspection control provides an explicit route to more editor room.

During a vertical preview, solve from a copy of the effective query/dock pair with only the
active value changed. On a successful vertical commit, adopt BOTH effective expanded sizes as
the new intended vertical arrangement. This prevents a previously clamped neighbor jumping back
to an old preference at pointerup. When the dock is collapsed, preserve its expanded preference.
This deliberate user action differs from passive resizing, which never saves clamped sizes.

Worked examples, using 36 px toolbars, no notices, 8 px handles, expanded side-by-side dock,
strip 40, bodyMin 112, Query preference 116 and dock preference 248:

| H | C | Query | Dock | Results | Overflow |
| --- | --- | --- | --- | --- | --- |
| 800 | 88 | 116 | 248 | 348 | 0 |
| 500 | 88 | 116 | 168 | 128 | 0 |
| 300 | 88 | 80 | 152 | 128 | 148 |

At H=800 a query drag +100 yields Query=216, dock=248, Results=248. A following inspection drag
up 100 yields Query=216, dock=348, Results=148. These are test fixtures, not measured screenshots.

### 4.2 Horizontal layout and responsive modes

Sources and its divider use explicit shell columns. Give the desktop drawer wrapper a real
grid/flex box instead of `display: contents`; preserve the same Explorer instance. Hide the
source divider and remove its track when Sources is collapsed or viewport width is below 960.
The existing modal drawer, 280 px/max 88vw width, focus containment, and independent column/drawer
visibility choices remain unchanged.

Dock tabs remain mandatory below viewport width 1280. At larger widths also enter compact mode
if measured dock width is below 900; return to side-by-side only at 924 or above. Inside the
900–923 band preserve the previous mode; first measurement defaults to compact. This hysteresis
avoids mode flapping when a vertical scrollbar changes usable width. Measure the dock/container,
not Values, Bytes, or their content. Do not derive mode from the chosen Values width.

Hide/remove the Values divider track when compact, collapsed, or Values is hidden. Restore its
preferred width when two columns return. Keep both snippets mounted in the same places.
Tab mode uses the existing dock tab selection. If a transition would hide a focused child,
activate that child's tab first. If Values is explicitly hidden, select Bytes in compact mode.
If a focused Values divider disappears, move focus to the active dock tab. Do not otherwise
steal focus on a geometry change.

All constrained children have `min-width: 0; min-height: 0`. Sources never horizontally scrolls;
filenames truncate/wrap with full text accessible. Results scrolls only in `.grid-scroll`.
Bytes gains its own horizontal viewport scroll with the fixed canvas width retained. Shell and
workspace do not gain horizontal scrollbars.

## 5. Input, accessibility, and cancellation

Use one controlled component for all four handles. It owns pointer/keyboard mechanics only;
the caller owns bounds, geometry, commits, storage, and optional reset.

| Handle name | Orientation | Positive pointer movement | Arrow behavior |
| --- | --- | --- | --- |
| Resize sources | vertical | Right grows Sources | Left/Right: -/+18 px |
| Resize query | horizontal | Down grows Query | Up/Down: -/+18 px |
| Resize inspection | horizontal | Down shrinks inspection | Up/Down: +/-18 px |
| Resize values | vertical | Right grows Values | Left/Right: -/+18 px |

Shift+appropriate arrow uses 72 px. Home/End chooses min/max primary-pane size. Ignore unrelated
keys and Ctrl/Meta/Alt combinations; Tab leaves the handle. Escape cancels an active drag and
restores the pre-drag preferences/effective arrangement under current constraints. Double-click
resets that dimension to its responsive default within current bounds. A visible “Reset panel
sizes” button in the shortcuts dialog resets all four preferences; it preserves theme, source,
selection, dock collapse, and tab. Add concise divider help there.

Each handle has `role="separator"`, focusability, its stated orientation/name, `aria-controls`
referencing the primary pane ID, and numeric min/now/max from the same resolved snapshot used
for clamping. Use pixels, with `aria-valuetext` such as “216 pixels high”; no live announcement
on every pointermove. Existing explicit controls own collapse; Enter does not collapse these
handles. This adapts the APG pattern and does not claim complete pattern conformance.
[WAI-ARIA window splitter guidance](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/).

Accept only primary left-button pointerdown; track its pointerId. Capture it on the handle,
focus the handle with preventScroll, and use client-coordinate deltas. Ignore other pointers.
Only active drag suppresses selection and sets the document cursor. Do not install an opaque
overlay over controls. Handles have real 8/24 px tracks, a centered fine rule, visible hover/focus,
and no overlapping hit-area trick. `touch-action: none` applies to the handles, not the shell.
Capture ensures movement continues outside the handle. [Pointer capture reference](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture).

Pointerup commits the final pointer coordinate even if the last move's animation frame is pending.
If the final size equals its starting size, finish through cancellation without saving; do not
leave the coordinator in an active transaction. When a drag hits a bound, rebase its pointer
origin to the clamped size so reversing direction moves immediately without dead travel.
Pointercancel, unexpected lostpointercapture, Escape, window blur, document becoming hidden,
unmount, and disabling/removing the handle cancel without storage writes. Cleanup is idempotent:
release capture if still held, cancel pending work, remove listeners, and restore prior body
cursor/user-select. Mark the drag inactive BEFORE releasing capture so the ensuing lost event
cannot roll back a successful commit. Restore preferences and reconcile against current geometry
on cancellation; never restore obsolete pixel bounds after a viewport change.

Cancel a vertical drag if its available height, intrinsic chrome, dock mode, or collapse changes.
Cancel source/Values drags on external viewport changes or when their handle disappears. Own
width changes are expected input: they must not cancel themselves. Opening any modal cancels
active dragging before focus containment begins. If the handle is hidden, return focus to its
existing visibility toggle or active dock tab, as appropriate.

Programmatic cancellation must end the input action too, not just clear the coordinator's
preview. Pass a monotonically increasing `cancelEpoch` to every handle; changing it cancels
an active pointer transaction and its capture/listeners. Ignore stale callbacks after cancel.

## 6. Preferences and component ownership

Persist only versioned numeric preferences under `byteql.ui.layout.v1`:

```ts
interface LayoutPreferences {
  version: 1;
  sourcesWidth: number | null;
  queryHeight: number | null;
  dockHeight: number | null;
  valuesWidth: number | null;
}
```

Null means “follow the responsive default until the user chooses a size.” Validate JSON shape,
version and each field independently. Accept finite positive numbers ≤10,000, round to integer,
then clamp to the applicable minimum during resolution. Do not coerce numeric strings. Invalid
fields become null; malformed/unsupported-version JSON uses defaults. An absent v1 record may
import a valid legacy `byteql.hexpane.height` into dockHeight. A present but invalid v1 record
does not repeatedly fall back to legacy. Catch storage access/parse/quota failures; retain usable
in-memory preferences. Do not write on mount, passive resize, preview, or cancellation.

Successful pointerup, keyboard resize, or reset writes once. Reset-all stores a v1 null-valued
record (it prevents re-importing the legacy key); do not clear all localStorage. Leave legacy
height untouched for standalone HexPane compatibility. Continue using the separate existing
`byteql.hexpane.collapsed` preference. Ignore cross-tab storage synchronization in v1.

A no-motion/no-op input does not write. Reset-one uses the default clamped against the current
neighbor: store null if the default fits, otherwise the clamped number. Adopt the effective
other vertical pane as on a normal vertical commit; do not reset unrelated horizontal sizes.

| Owner | Responsibility |
| --- | --- |
| `panel-layout.ts` | Pure bounds, vertical solution, defaults, responsive compact decision |
| `layout-preferences.ts` | Validated read/write and one-time legacy fallback |
| `resize-handle.ts` + `ResizeHandle.svelte` | Input transaction and accessible controlled handle |
| `use-panel-layout.svelte.ts` | Workbench-local preferences, effective geometry, DOM measurement lifecycle, preview/commit/cancel/reset |
| Workbench | Wires explicit element refs, layout state, shell/query/dock tracks and existing modal/visibility state |
| TraceDock | Controlled height/Values width; reports strip/tabs measurements, renders stable panels and Values handle |
| HexPane | Reports its chrome height; keeps byte/cache/caret logic; horizontal byte access |

The coordinator is presentation-only and must not import the session controller. Use named
CSS grid areas for the workspace: query heading, editor, notices, query handle, Results heading,
Results, inspection handle, dock. Do not extract or duplicate the entire query/result subtree.

Observe explicit refs for shell/workbench/dock width and the intrinsic chrome blocks. Copy DOM
measurements into one numeric snapshot. Schedule at most one measurement/resolve/write per frame;
read all dimensions before applying changes. Compare rounded/epsilon-stable values before writes.
Do not observe the dimensions you control as inputs to their own preferred sizes. Never derive
available height from scrollHeight. Reserve a stable workspace scrollbar gutter where supported.
Disconnect and cancel scheduled callbacks when refs or lifecycle change. Deferring with rAF
does not by itself fix cyclic dependencies. [ResizeObserver guidance](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver).

CodeMirror already observes its scroll DOM in the installed dependency. Set the constrained
editor outer height and put overflow on `.cm-scroller`; do not recreate EditorView or dispatch a
document replacement during resize. Add explicit `requestMeasure` only if an acceptance test
demonstrates it is necessary. [CodeMirror styling guidance](https://codemirror.net/examples/styling/).

ResultGrid's virtualizer should observe its scroll viewport. Verify new visible rows load when
its height grows without scrolling. If that fails, connect ResizeObserver to the existing
`scheduleDemandInspection` function, preserving cancellation/rebase/error guards; do not add
parallel paging logic. Resizing can legitimately demand more rows or more cached hex bytes;
it must not rerun SQL, recreate the query session, or reopen the source.

For Bytes, retain 16-byte rows and fixed canvas metrics. Add horizontal scrolling to the existing
viewport, preserve its scrollLeft across visibility-driven viewport recreation, and ensure caret
navigation/goto/reveal horizontally exposes the target hex-byte cell. Keep vertical scrolling
custom. Horizontal or Shift+wheel gestures must not be consumed as vertical-byte scrolling;
plain vertical wheel retains the current behavior. Do not multiply pointer coordinates by DPR.
Check clientHeight after the horizontal scrollbar appears; it consumes canvas drawing space.

## 7. Acceptance gates

| ID | Observable requirement |
| --- | --- |
| G1 | All four visible dividers work in both pointer directions and by keyboard; labels and ARIA bounds match actual sizes within 1 px |
| G2 | Query +100 px consumes exactly 100 px of Results when unconstrained; inspection stays put; its opposite divider also works |
| G3 | Passive shrinking yields dock then Query, restores preferences when enlarged, and never saves passive clamps |
| G4 | Insufficient height uses workspace vertical scrolling; Run, diagnostics, Results, inspection and status remain reachable |
| G5 | Source collapse/drawer transitions and dock tabs remove inactive handles; focus remains meaningful and component state survives |
| G6 | Long SQL has one editor scroll owner; selection/undo/scroll survive resize, theme switch, and responsive changes |
| G7 | Wide/paged results retain one scroller, row height, global selection, tail reachability, and resize-driven demand |
| G8 | Narrow Bytes exposes all hex and ASCII columns; hit-testing after horizontal scroll gives the exact byte; goto/arrows keep caret visible |
| G9 | Pointer interruption leaves no capture/listener/cursor/selection lock or storage write, including pending-frame pointerup |
| G10 | Invalid/blocked storage and legacy migration are safe; reset affects layout sizes only; no hidden handles remain tabbable |
| G11 | Query errors, coverage notices, wrapped trace/hex chrome and export states change bounds without overlap or observer loops |
| G12 | Source selection, hex provenance, audio playback, downloads, privacy, and existing functional regressions still pass |

Review matrix: 1440×900, 1280×720, 1024×768, 960×600, 959×600, 390×844, 844×390, and 1440×480.
Exercise 1279/1280 and measured 899/900/923/924 transitions, coarse-pointer 24 px handles, light
and dark appearance, and 200% real browser zoom. Device scale factor is not browser zoom.
Include an SQL error, a very long SQL line, 300-row wide results, a paged result beyond 16,384
rows, selected MIDI/pcap/ZIP bytes, a multi-file selector, and an audio viewer.

Tests must inspect physical pane rectangles, scrollers, and data behavior, not just style values
or ARIA attributes. Unit tests cover deterministic budget/cancellation/storage logic. Browser
tests cover hit testing, CodeMirror, virtualizer, canvas, focus, and real overflow. Do not treat
jsdom's zero layout dimensions as geometry evidence. No application tests were run for this
planning-only change; the companion plan supplies the commands and executable starting tests.
