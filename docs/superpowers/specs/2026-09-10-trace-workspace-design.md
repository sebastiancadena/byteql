# ByteQL Trace Workspace — UI/UX and design system specification

Date: 2026-09-10

Status: Implemented on `feature/trace-workspace`. The precision-instrument direction and the light
default with dark mode were confirmed by the user; the detailed design below was then built and
verified against the acceptance gates in §7. Deviations found while building are recorded in the
plan's handoff notes.

Companion: [Implementation plan](../plans/2026-09-10-trace-workspace.md).

## 1. Decision and purpose

Make ByteQL feel like a purpose-built instrument for examining binary files. Its identity comes
from a visible relationship: **source file → SQL result → original bytes**. Call the design
direction **Trace Workspace** internally; keep **ByteQL** as the product name.

The confirmed appearance choice is a warm light workspace with an equally complete dark mode. Flat
surfaces, fine rules, structured type, and a restrained ochre trace color establish the visual
language. The principal layout change is a wide results surface above a shared inspection dock:
selected values and original bytes sit beside each other rather than in disconnected panes.

The user confirmed both the precision-instrument personality and light default with dark mode.
The detailed palette, typography, layout, and interactions below develop those choices; they are
not separate recorded user approvals. Keep the confirmed choices fixed during implementation and
revise this spec and its plan together if the user requests changes to the detailed design.

### Alternatives considered

| Direction | Strength | Cost or weakness | Decision |
| --- | --- | --- | --- |
| Precision instrument | Makes source inspection recognizable; supports dense work | Requires deliberate layout and canvas integration | Confirmed by the user; developed here |
| Editorial field notebook | Welcoming typography and explanatory space | More suitable to reading reports than sustained table inspection | Do not mix its oversized editorial treatment into this workspace |
| Industrial terminal | Familiar technical character and strong contrast | Easily becomes another dark IDE or neon dashboard | Retain keyboard efficiency, without terminal decoration |

### What success looks like

A newcomer can open a sample, browse a table, select a row, identify the source file and byte
range, and reveal that range without interpreting a slogan or searching a secondary sidebar.
An experienced user gains results width and a quieter interface without losing existing tools.
The app should be recognizable in grayscale from its layout, typographic hierarchy, range strip,
and connected inspection surfaces.

## 2. Evidence and scope

This is a source-level audit at commit `af54133`. No connected browser was available during
planning. Descriptions below are supported by markup, CSS, and tests; rendered quality and
usability have not been validated. The plan requires screenshot and interaction review.

The July Command Deck spec is historical. This proposal supersedes its presentation decisions
only after acceptance; preserve the original document.

| Current evidence | UX consequence | Redesign decision |
| --- | --- | --- |
| `app.css`: navy gradients, glass header, multiple glows and shadows | Generic dashboard visual language | Opaque surfaces, structural rules, shadows only for overlays |
| `EmptyState.svelte`: hero slogan, format badges, proof cards, Open and Browse actions | Space and competing actions precede the actual task | An intake work surface with one visible file action and explicit samples |
| `Workbench.svelte`: source sidebar + center editor/results/hex + full-height inspector | Available results width competes with an often-empty panel | Two-column shell; values move into the lower inspection dock |
| Pane eyebrow plus title pairs | Repeated headings consume vertical space | One compact header per tool |
| `Explorer.svelte`: “Saved queries” are format-pack queries | Implies a save/history feature that does not exist | “Example queries” |
| `BrandLockup.svelte` uses the supplied square SVG; header uses live text | Existing artwork is already selected | Preserve artwork; give it a purposeful intake placement |
| `HexPane.svelte` measures a hard-coded font but paints from CSS | A font change can desynchronize rendering and hit testing | One measured canvas font contract |
| `ResultGrid.svelte` and `result-scroll.ts`: 36 px virtual rows, bounded windows | Styling can break demand loading and scroll compensation | Keep 36 px row height and the paging algorithm |
| September results download UI is present | Older orientation docs omit shipped behavior | Redesign download states and preserve CSV/Parquet workflows |

### Included

The entire web presentation: startup, intake, source catalog, query editor, result grid,
inspection dock, byte viewer, audio viewer, downloads, diagnostics, menus, shortcuts, focus,
responsive layouts, typography, tokens, appearance persistence, and local font loading.
Presentation helpers and bounded component extraction are included where required by this design.

### Excluded

New format support, parser/engine/database/worker/export-pipeline changes, result sorting or column
resizing, query history or saved queries, projects, accounts, tabs for multiple query documents,
AI chat, live capture, binary editing, new branding artwork, and deployment. The UI supports the
currently shipped MIDI, pcap, and ZIP capabilities; roadmap features are not navigation items.

## 3. Binding constraints

- Keep Svelte 5, TypeScript, CodeMirror 6, TanStack Virtual, and the canvas hex renderer.
- Add no UI framework, component kit, icon package, animation package, or runtime font service.
- Serve all runtime assets locally; emit zero network requests after application readiness.
- Keep `RESULT_ROW_HEIGHT = 36`, the 16,384-row result window, and existing demand-loading logic.
- Preserve the selected ByteQL logo artwork; do not crop, recolor, redraw, or replace it.
- Keep source ranges end-exclusive internally; display the last included byte as `end - 1`.
- Keep presentation preferences out of `SessionState`, query data, and source-file persistence.
- Preserve existing query, intake, export, playback, cancellation, recovery, and provenance behavior.
- This planning deliverable consists only of this spec and its companion plan; do not implement,
  commit, push, deploy, install skills, or modify earlier documents during planning.

Privacy precedence is the current binding repository constraint, not the PRD's older suggestion
that optional analytics might be possible. Row provenance is available only when the query carries
usable source columns. Do not repeat the PRD's broad cell-level provenance claim in the interface.

## 4. Visual identity and foundations

### 4.1 Composition

Use one connected work surface, with 1 px rules delineating tools. Source lists, results, and
values are rows rather than rounded cards. Align tool headings, data gutters, and range labels.
Use square panel corners, 3 px control corners, and 6 px overlay corners. No background gradients,
glows, glass effects, decorative grids, fake byte streams, or continuously pulsing status lights.

The signature treatment is a **trace strip** immediately above the inspection dock. It displays
the selected global row, source filename, exact inclusive display range, byte count, and reveal
action. An ochre bracket at a selected row with validated provenance and a matching byte highlight connect it to
the source. Focus remains blue; an error remains red. Meaning also appears in labels and borders.

### 4.2 Typography

Bundle IBM Plex Sans Regular (400) and SemiBold (600), and IBM Plex Mono Regular (400), as local
WOFF2 assets. Use Sans for navigation, labels, instructions, and values that are prose. Use Mono
for SQL, table data, filenames, identifiers, numeric metadata, ranges, and hex. Disable ligatures
in code and data. Use tabular numerals. Do not synthesize bold Mono or rely on installed fonts.

IBM supplies the families and font files under the OFL in the [official Plex repository](https://github.com/IBM/plex).
Preserve its license alongside the three files. Store the upstream revision and SHA-256 values
in a font provenance note during execution. Network access to obtain build assets is distinct
from runtime asset delivery; no font stylesheet may reference a remote URL.

| Role | Size / line height | Weight |
| --- | --- | --- |
| Intake heading | 32 / 36 px desktop; 26 / 32 px narrow | Sans 600 |
| Wordmark text | 18 / 24 px | Sans 600 |
| Section header | 14 / 20 px | Sans 600 |
| Controls and body copy | 14 / 20 px | Sans 400 or 600 |
| SQL | 14 / 22 px | Mono 400 |
| Result cells and field values | 13 / 20 px | Mono 400 or Sans 400 for prose |
| Metadata, type labels, byte canvas | 12 / 18 px | Mono 400 |

No information-bearing text below 12 px. Body instructions have a maximum 64-character measure.
Small structural labels may use uppercase with 0.06 em tracking; headings and buttons use sentence
case. Hex stays 12 px with 18 px rows and 16 bytes per row. Grid rows remain exactly 36 px.

### 4.3 Color tokens

The following values are the implementation source of truth. Declare light values on `:root`
and dark overrides on `:root[data-theme='dark']` in `styles/tokens.css`.

| CSS token | Light | Dark | Meaning |
| --- | --- | --- | --- |
| `--color-canvas` | `#f1f0e9` | `#181b18` | Outer work surface |
| `--color-surface` | `#faf9f4` | `#20251f` | Tool surface |
| `--color-surface-inset` | `#eeede5` | `#151915` | SQL/hex bed |
| `--color-surface-raised` | `#ffffff` | `#2b322a` | Menus and dialogs |
| `--color-surface-hover` | `#e5e7df` | `#333b31` | Hover row |
| `--color-border` | `#c7cdc0` | `#465041` | Decorative divisions |
| `--color-border-strong` | `#77816f` | `#8f9b85` | Control boundaries |
| `--color-text` | `#222820` | `#eeeee4` | Main text |
| `--color-text-muted` | `#50594d` | `#bdc4b7` | Supporting text |
| `--color-text-subtle` | `#596152` | `#b0baa9` | Small metadata |
| `--color-accent` | `#28392e` | `#e4e9da` | Primary action fill |
| `--color-accent-strong` | `#19261e` | `#f4f6ef` | Primary action hover |
| `--color-accent-ink` | `#faf9f4` | `#20251f` | Primary action text |
| `--color-selection` | `#dce8ec` | `#2a4149` | Selected table row |
| `--color-focus` | `#215b86` | `#9ccbe4` | Keyboard focus |
| `--color-evidence` | `#80520a` | `#e4b967` | Source link and trace bracket |
| `--color-hex-highlight` | `#f1d99f` | `#554326` | Row-linked byte range |
| `--color-hex-selection` | `#cbdfea` | `#274853` | Explicit byte selection |
| `--color-shade-a` | `#e6e9df` | `#232e25` | Alternating record extent A |
| `--color-shade-b` | `#dce5df` | `#293831` | Alternating record extent B |
| `--color-hex-placeholder` | `#c7cdc0` | `#465041` | Unread byte placeholder |
| `--color-danger` | `#a82f2d` | `#ffa89a` | Errors |
| `--color-danger-surface` | `#fbe8e4` | `#462b27` | Error background |
| `--color-warning` | `#795b10` | `#e9cf8d` | Recoverable warning text |
| `--color-warning-surface` | `#eee5c7` | `#3d3726` | Warning background |
| `--color-success` | `#346039` | `#afcda3` | Completed operation |
| `--color-syntax-keyword` | `#345a83` | `#a5c5e9` | SQL keyword |
| `--color-syntax-string` | `#795017` | `#e6c48b` | SQL string |
| `--color-syntax-number` | `#655184` | `#c8b7e7` | SQL number |
| `--color-syntax-comment` | `#596152` | `#b0baa9` | SQL comment |
| `--color-syntax-operator` | `#50594d` | `#bdc4b7` | SQL punctuation/operator |

Resolve existing editor tokens with semantic aliases: editor text and syntax name → text;
editor background → inset; editor caret → focus; editor selection and active line → selection;
editor gutter text → subtle; gutter background → inset; editor border → border;
syntax invalid → danger. Set `--color-transparent: transparent`. Replace remaining old
`accent-dim` references with an appropriate semantic token. Remove old halo, glass, glow, and
accent-wash variables after consumers are migrated. Canvas code must obtain resolved colors,
not unresolved `var(...)` strings.

Preliminary contrast calculation across the principal surface/selection/highlight backgrounds
gives minimum subtle-text ratios of 4.65:1 light and 4.70:1 dark. These are limited palette checks,
not an accessibility audit. Execution must test all actual text/color combinations, syntax,
controls, and composited states. Normal text needs at least 4.5:1; see
[WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
Focus and meaningful control boundaries must reach 3:1 against adjacent surfaces. Decorative
rules are not a substitute for a visible control boundary.

### 4.4 Dimensions, controls, and motion

Spacing scale: 4, 8, 12, 16, 24, 32, 48 px. Header 48 px, status 28 px, panel toolbar 36 px,
trace strip 40 px minimum. Controls are at least 32 px tall on pointer devices and 44 px under
`(pointer: coarse)`. Icon buttons are 32 × 32 px, with 16 px inline SVG icons on a 24-unit viewBox
and 1.5-unit strokes. Use text labels for Run, Open, Download, and source-reveal actions.

Primary button: accent fill/ink, 1 px matching border. Secondary: surface/strong border.
Quiet action: transparent fill and ordinary text with a visible hover/focus treatment.
Disabled controls keep their label and a nearby reason where capability-dependent. Never rely on
hover to reveal essential actions. Destructive/error actions use danger only when appropriate.

Focus: 2 px focus outline, 2 px offset, never clipped. Overlays use one shadow:
`0 8px 24px rgb(0 0 0 / 18%)` in light, `0 8px 24px rgb(0 0 0 / 40%)` in dark.
Workspace panes have no shadow. Layer order: normal 0, sticky headings 10, drawer/backdrop 30,
popover 40, dialog 50, file-drop overlay 60; an inactive drop overlay cannot intercept input.

Hover/focus transitions: 100 ms; drawer opacity: 140 ms. No layout, scroll, or height animation.
Reduced motion removes transitions and byte flash. Progress uses real numeric state when available;
unknown progress is labelled, with no fabricated percentage or elapsed countdown.

## 5. Information architecture and screens

### 5.1 Startup and intake

Startup uses a compact supplied mark and “Starting the local query engine…” with existing error
details and Retry startup. Load all three fonts before setting the existing readiness marker.
If fonts fail, use system fallbacks for the entire session and still allow engine initialization.

Idle is the first work surface, not a marketing landing page. The header remains visible. The
main content has a left aligned title **“Open a binary file.”** and explanation:
“Query its tables with SQL. Select a row to inspect its source bytes.”

At widths at least 960 px, use a 5:3 split, maximum width 1120 px, with 32 px page padding.
The leading area is a ruled intake region with Open file, supported formats, and a drop hint.
The trailing area is “Explore a sample”, with two descriptive rows sourced from `SAMPLES`:
Network capture (pcap), and MIDI song (.mid). Preserve the existing Try sample menu as the
keyboard-compatible selector; descriptive rows explain choices without duplicating click targets.
Do not display a ZIP sample action because no ZIP sample is registered.

Use the existing uncropped square brand artwork at 80 × 80 px next to the intake title; 64 px
on narrow screens. Keep the header wordmark live text. Avoid duplicate large marks on startup.
Show one privacy sentence: “Files are processed in this browser. Nothing is uploaded.”
The drop affordance says “Drop MIDI, pcap, or ZIP files anywhere to open.” Do not imply mixed-format
sessions are supported; existing intake validation remains authoritative.

There is one visible Open file action. Keep both input and File System Access paths behind it:
use the native picker when supported, otherwise click the labelled file input. Invoke the native
picker directly from the user gesture. Cancellation is silent; other picker failures produce an
inline error and a “Use file input” fallback. Keep a resettable multi-file input for drag/drop,
automation, and fallback. Opening new files retains current replacement semantics.

### 5.2 Loaded desktop: 1440 × 900 reference

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│ ByteQL  /  Binary file workspace      Open file       Appearance    Shortcuts  │ 48
├───────────────────┬────────────────────────────────────────────────────────────┤
│ SOURCES           │ Query                                      Run query       │ 36
│ capture.pcap      │ select * from packets                                      │
│ 2.4 MB · pcap     │                                                            │ 116
│                   ├────────────────────────────────────────────────────────────┤
│ TABLES            │ Results       300 rows · 4.2 ms          Download results  │ 36
│ packets    300    ├────────────────────────────────────────────────────────────┤
│ ip         300    │ packet_id       timestamp           length                  │
│ tcp        240    │ 1               …                   74                      │
│ dns         12    │▏2               …                   98                      │ flexible
│                   │ 3               …                   66                      │
│ EXAMPLE QUERIES   ├────────────────────────────────────────────────────────────┤
│ Packet overview  │ Row 2 → capture.pcap → 0x00000062–0x000000c3 · 98 bytes      │ 40
│ DNS questions    │                                       Inspect source  Hide │
│                   ├─────────────────────┬──────────────────────────────────────┤
│ DIAGNOSTICS      │ Values              │ Bytes     Source file ▾    Go to …   │
│ 2 warnings       │ packet_id       2   │ 00000060   …                          │ 208
│                   │ length         98   │ 00000070   … [matched byte range] …  │
├───────────────────┴─────────────────────┴──────────────────────────────────────┤
│ Ready                       300 rows · 4.2 ms                 Local processing │ 28
└────────────────────────────────────────────────────────────────────────────────┘
```

The numbers above illustrate a layout, not a bundled fixture or a claimed benchmark. Runtime
values always come from the current session. The source column is 224 px; the workspace consumes
the remainder. Inspector is 256 px within the dock; bytes take the remainder. Results receive all
workspace width, including the area formerly occupied by the inspector.

Workspace grid rows: 36 px query toolbar, 116 px editor, automatic notices, 36 px results toolbar,
`minmax(128px, 1fr)` results, and inspection dock (248 px initial height including its 40 px strip).
Use `min-width: 0` and `min-height: 0` on every flex/grid child that owns constrained content.
On short screens (height below 760 px) reduce the editor to 80 px; clamp the dock to available
space. If minimum chrome cannot fit, use workspace vertical overflow rather than clipping actions.

### 5.3 Source catalog

Rename visible Explorer heading to **Sources**; preserve the `Data explorer` navigation landmark.
Show each source in a compact row with full filename available on focus/hover and size beneath it.
Selecting a source changes the byte viewer's active source only; it does not silently filter or
rerun SQL. Mark that source with “Viewing bytes”. Existing source-switching logic remains central
in Workbench, including auto-follow when a selected row refers to another file.

Tables show name and row count with a separate schema disclosure and Browse action. Avoid nested
interactive controls inside a summary: use a row containing a disclosure button and Browse button;
the disclosure controls the following schema list. Browse continues to run `select * from` the
quoted table name. Do not introduce implicit SQL sort/filter controls.

Example queries load SQL into the editor and focus it without running; the existing initial
overview query still auto-runs once. Diagnostics keep the 50-item display cap and remainder count,
and reveal existing code/message details. Use normal text warnings, not evidence-colored pills.

### 5.4 Query and results

Use the single header **Query**, with Run query or Cancel query and the platform-correct shortcut.
Preserve CodeMirror's document, selection, history, and editable state across appearance and layout
changes. Error details appear immediately below the editor. A failed query must retain the SQL.

Results occupy the main visual area. Keep data aligned, numeric cells right-aligned, type metadata
under headers, NULL distinct from an empty string, and hidden source columns toggleable. Preserve
global row indices and keyboard selection. Add a 3 px inset bracket to a selected row, using the
evidence color only when its trace is valid and the focus color otherwise,
with no width/height change. Do not add a synthetic data column for this bracket.

Use existing truthful counts: “300 rows” only when complete; otherwise
“1,024 loaded · more available”. Retain page errors, retry, loading indicator, terminal row count,
and bounded window behavior. Do not render placeholder rows to match an unknown total.

`.grid-scroll` remains the only result-grid scroll owner on both axes. Neither the result wrapper
nor the workspace may introduce a second horizontal scrollbar. Hex may have its own horizontal
viewport overflow because it is a separate data surface. Source names and notices must not widen
the page. Export remains in the results toolbar with existing column/type eligibility rules.

### 5.5 Trace strip and inspection dock

The dock owns height, collapse state, Values/Bytes visibility, and its horizontal resize separator.
The strip stays visible when collapsed. Default height 248 px, minimum expanded height 152 px
with side-by-side content or 188 px with tabs; add any trace-strip wrapping beyond its first 40 px.
Maximum is the current height plus available result space above the 128 px results minimum,
minus any workspace overflow. Clamp stored values and re-evaluate on resize. ArrowUp/ArrowDown
on the separator adjust 18 px; Home sets minimum; End sets current maximum. Provide separator
value/min/max and a label. A pointer-cancel ends dragging without leaving pointer capture active.

Persist the user's existing `byteql.hexpane.height` and `byteql.hexpane.collapsed` preferences,
now interpreted as dock preferences. Catch storage errors. Invalid heights fall back to 248 px.
Do not add a second resizer inside the dock. Keep standalone HexPane support for isolated tests.

| Condition | Trace strip content | Action |
| --- | --- | --- |
| No result | “Run a query to inspect source bytes.” | None |
| Result, no selected row | “Select a row to trace its source bytes.” | Values control remains available |
| Valid source range | Row, filename, inclusive display range, byte count | “Inspect source” |
| Selected row without usable source columns | “This row has no source byte range.” | Values remain inspectable |
| Selected global row outside the current decoded window | “Selected row is outside the loaded window.” | Do not borrow another row's range |
| Referenced file no longer present or invalid range | “Source bytes are unavailable for this row.” | No misleading reveal action |

Ranges are valid only with a known source file and safe integer offsets satisfying
`0 <= start < end <= fileSize`. Display lowercase hex with at least eight digits. For `[12, 20)`,
show `0x0000000c–0x00000013 · 8 bytes`; expose “inclusive byte offsets” in accessible detail.
Never infer an exact source range for an aggregate or join result that has dropped provenance.
Coverage/reveal applies to the current decoded result window, not a claimed whole-result index.

Inspect source opens the dock, activates Bytes on compact layouts, reveals the current range,
then focuses the hex viewport. Row selection itself updates values and highlights without stealing
keyboard focus or reopening a dock the user collapsed. Values and Bytes remain mounted across
appearance, dock, and responsive changes so navigation does not reset caret, scroll, or playback.

Values shows the selected global row, field/value list, and Provenance section. Display the same
inclusive range there and in the footer. `Inspector.svelte` remains responsible for value formatting
and viewer rendering. Use the shared range formatter; never subtract one in domain state.

Bytes retains source selection, goto validation, cached canvas rendering, custom vertical scroll,
16-byte grouping, arrow navigation, range extension, copy, filter-to-selection, covering-row
cycling, read retry, and existing provenance notices. Row highlight and explicit byte selection
remain separate states. Theme repaint must not scroll or clear either state.

### 5.6 Responsive behavior

| Viewport width | Catalog | Inspection dock | Query/results |
| --- | --- | --- | --- |
| At least 1280 px | 224 px, user collapsible | Values 256 px beside Bytes | Full remaining width |
| 960–1279 px | 208 px, user collapsible | Values/Bytes tabs, Bytes initially active | Full remaining width |
| Below 960 px | Closed by default; opaque 280 px modal drawer, max 88vw | Values/Bytes tabs | Full width |
| Below 700 px | Same drawer | Initially collapsed unless user preference exists | 80 px editor; toolbars wrap |

Replace whole-workbench Results/Inspector tabs with dock-local Values/Bytes tabs. Use roving tab
focus, ArrowLeft/ArrowRight, Home/End, `aria-controls`, and hidden inactive panels. Only the active
panel is keyboard reachable, but preserve mounted component state. At small widths the trace strip
wraps to fit, filename truncates with full accessible text, and its height may exceed 40 px.

Drawer opening moves focus inside; Tab is trapped; Escape, Close, or backdrop closes and returns
focus to Sources. Selecting a Browse action or example query closes the narrow drawer and focuses
the destination. Selecting a source for bytes opens Bytes. Do not cover the workspace with an
unrequested open drawer on first load. At 390 px and 200% zoom, controls stay reachable; horizontal
overflow is confined to the grid/hex content. This is responsive resilience, not a new mobile
product support claim.

### 5.7 Remaining surfaces

- Downloads: restyle the existing options dialog, format selector, provenance toggle, capability
  reason, progress, cancellation, ready-to-save, saved, and failed states. Preserve gesture-bound
  destination acquisition, both save methods, and the literal “Download handed to the browser.”
- Audio: keep Open in… and Audio playback capability gating; use the same typography and controls.
  Opening audio reveals Values; appearance changes do not restart audio. Close returns to values.
- Menus: use one opaque raised surface, keyboard navigation, Escape and outside-click dismissal,
  and focus return. Do not give native selects a custom JavaScript replacement.
- Shortcuts: retain all current actions, correct Ctrl/⌘ by platform, visible header access, focus
  containment and restoration. `Mod+B` controls Sources, `Mod+I` shows/hides Values, `Mod+G` opens
  Bytes and focuses goto. Editable elements retain their ordinary typing behavior.
- Status: phase and bounded progress are primary; row count, query timing and byte range are
  secondary; Local processing is factual. Wrap or omit duplicate metrics at narrow widths.
  Announce phase transitions, not every changing throughput number.
- Errors: retain startup retry, session recovery, invalid input, partial parse diagnostics,
  query failure, paging retry, hex read retry, export failure, and unsupported spill explanations.
  Actionable errors stay inline next to their owning tool, not transient toast-only messages.

## 6. Component and state architecture

```text
App: engine lifecycle + asset readiness
└─ Workbench: existing controller subscription, queries, source/row/byte coordination
   ├─ AppHeader: Open, Sources, Values, appearance, shortcuts
   ├─ EmptyState OR Explorer + query/result workspace
   ├─ SqlEditor + ResultGrid + ResultsDownload
   ├─ TraceDock: geometry + collapsed presentation
   │  ├─ TraceBar: validated summary + Inspect source action
   │  ├─ Inspector: values/provenance or capability-gated viewer
   │  └─ HexPane: embedded canvas/navigation with parent-owned geometry
   └─ StatusBar
```

Keep domain state and current provenance memoization in Workbench. Add only presentation helpers
under `lib/ui/` and small presentation components. `TraceDock` uses Svelte snippets to compose
Values and Bytes; it must not acquire the controller or fetch data. Workbench passes an explicit
reference to the results viewport for resize budgeting; never depend on previous-sibling order.

Add an embedded HexPane mode with externally controlled visibility; it fills its parent, suppresses
its own resize/collapse chrome, and does not read/write standalone geometry preferences in that
mode. Preserve `focusGoto()` and `revealRange()`; add `focusViewport()` for the explicit Inspect
source action. Workbench reveals the dock before invoking these methods.

Appearance is `light | dark`, light by default, with `byteql.ui.theme.v1` persistence. Apply a
validated stored theme synchronously before mount. A header toggle switches appearances and
announces its resulting action (“Use dark appearance” / “Use light appearance”). No system-follow
mode or animation. CodeMirror uses a theme compartment for its light/dark flag; CSS tokens provide
colors. Hex repaint observes appearance explicitly. Neither change remounts the data components.

Move the 1,661-line global stylesheet into `styles/tokens.css`, `base.css`, `workbench.css`, and
`components.css`, imported in that order by `app.css`. Keep specialized component-scoped behavior
styles where they already belong, but remove hard-coded colors, radii, and shadows from them.
Do not retain a complete old theme underneath a new override sheet.

## 7. Acceptance and review gates

| ID | Required evidence |
| --- | --- |
| A1 Identity | Light and dark idle/loaded screenshots show ruled surfaces, restrained type, wide results, shared dock; no Command Deck slogans/glows |
| A2 Intake | Both samples, file input, native picker cancellation/failure fallback, multi-file intake, and window drop work |
| A3 Query/data | Overview once, example query fill, editing, run/cancel/error, NULL/hidden columns and truthful result counts work |
| A4 Scale | Existing 300-row, million-row/window, tail, replacement, retry and single-scroller checks pass |
| A5 Trace | MIDI, pcap and ZIP row→bytes→row checks; multi-file following; absent/out-of-window/invalid provenance is truthful |
| A6 Geometry | Dock resize works by pointer and keyboard, honors limits/persistence, leaves results at least 128 px tall when the viewport can fit minimum chrome |
| A7 Appearance/fonts | Theme changes preserve document/history/row/caret/scroll; measured font matches painted font; failed fonts have usable fallbacks |
| A8 Accessibility | Keyboard-only complete workflow, drawer/dialog focus containment/return, visible focus, both-theme contrast, reduced motion, 200% zoom |
| A9 Complete states | Startup failure, parsing/cancel, partial data, zero rows, SQL/page/read/export errors, viewer eligibility, and audio controls reviewed |
| A10 Privacy | Existing bundle/worker/privacy gates pass, including theme toggle and all font loads before readiness |

Screenshot matrix: 1440×900 and 1280×720 in both appearances; 1024×768 loaded in both; 390×844
idle and loaded with drawer closed, drawer open, and dock expanded. Include selected MIDI, selected
pcap, ZIP entry provenance, an aggregate without provenance, SQL failure, and download options.
Record fixture/query and appearance with each image. Use deterministic existing fixtures, never
fabricated result screenshots. Review at the foundation/intake milestone and final integration.

Automated checks cannot certify a unique identity or effortless use. At final review, a human
should reproduce sample → table → row → bytes unaided and judge the visuals against this spec.
Do not mark this evidence as passed merely because the test suite passes.

## 8. Skill assessment and executor guidance

The installed brainstorming and writing-plans skills are sufficient for these documents. Browser
review tools are installed, but no browser connection was available in this session.

No additional skill installation is required. An optional frontend-design skill can assist with
visual execution; installation is separate from this planning task.

Do not make installation a prerequisite. The executor follows this spec's choices; a generic
design skill must not replace them with its own layout, typeface, palette, framework, or mock data.
No Figma integration, image generation, or additional component library is required.

The accompanying plan is deliberately sequential with small reviewable milestones. Read only the
shared constraints and the current task's source files when working through it. The expensive
decisions—visual direction, semantics, layout ownership, and regressions—are recorded here so a
less expensive model can concentrate on implementing and verifying each step.
