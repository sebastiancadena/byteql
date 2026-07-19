# Hex-provenance UI & polish — Phase 1 slice 3 design

Date: 2026-07-19
Status: approved design, pre-implementation

## Context

Slices 1 and 2 delivered the pcap pack and the scaled intake path; every projected table
already carries the engine-emitted `_src_start`/`_src_end` provenance columns
(`packages/core/src/projection/project.ts` reserves them), and `SessionController` retains the
source `File` for the whole session. What's missing is the product's signature interaction
(PRD §4, §6): a hex view where SQL results light up bytes and byte selections find rows, plus
the professional visual pass across the Svelte shell. This is the last Phase 1 slice; its exit
criterion is "hex↔grid round-trip works on every gallery format" (MIDI and pcap).

## Scope decisions (settled)

- **Full-shell polish pass**, not hex-only: design-token refresh plus a component-by-component
  sweep (empty state, header, explorer, grid, inspector, status bar, progress/error states,
  keyboard model). (Rejected: hex-centric-only — leaves the last pre-exit slice with an
  unfinished shell; full redesign — the teal identity is not the problem.)
- **Refined dark theme only.** No light theme, no new visual identity. The analyst audience
  runs dark tooling; one theme done well over two done adequately.
- **Hex pane is a bottom pane** in the center column, under the results grid (Wireshark's
  model): full width buys a comfortable 16-bytes-per-row layout and vertical adjacency makes
  the row↔bytes round-trip legible. Inspector stays where it is. (Rejected: inspector tab —
  hides the signature interaction in a side pane; full-height right column — squeezes the grid
  and competes with the Inspector.)
- **Hex→grid is non-destructive "reveal in results"**: clicking a byte selects the covering
  row(s) in the *current* result. An explicit toolbar action applies a real SQL filter.
  (Rejected: auto-rewriting the user's query per click — destructive and surprising;
  cross-table "what's here" lookup — future slice, layers on top of this.)
- **In-slice hex extras: structure shading and offset goto/keyboard navigation.**
  (Deferred: byte search — needs a scanning worker + progress UI; inspector value decoding.)
- **Architecture A: canvas renderer + provenance read from the result itself.** Custom canvas
  with its own scroll math; an LRU page cache over the retained `Blob`; both link directions
  and shading computed from the `_src_start`/`_src_end` Arrow columns already on the main
  thread. Zero per-interaction DuckDB round-trips, no new worker/engine capability.
  (Rejected: virtualized DOM — a 4 GB file is ~268 M rows × 18 px ≈ 4.8 G px, far past the
  browser's ~33 M px element-height cap, so it cannot scroll without paging hacks; worker +
  OffscreenCanvas + SQL range queries — heavy machinery to render ~40 visible rows, and SQL
  round-trips make each click slower.)

## Architecture

New pure-TS modules under `apps/web/src/lib/hex/` (logic out of Svelte, unit-testable), one new
component, and small controller/state extensions.

### `byte-cache.ts` — ByteCache

Wraps a `Blob`. 64 KiB pages via `blob.slice(start, end).arrayBuffer()`; LRU with an ~8 MiB
budget; in-flight request coalescing (one read per page regardless of callers); prefetch of
adjacent pages in scroll direction. Every async delivery carries the session generation; stale
deliveries are dropped.

Controller change: retain the current source `Blob` per generation (openFile already retains
the `File`, which is a `Blob`; openSample retains `sampleBytes` — wrap once in a `Blob`) and
expose it to the UI. Cleared on supersession/dispose like `retainedFile` today.

### `layout.ts` — scroll & layout math

Pure functions: fixed 16 bytes/row; offset↔row↔pixel mapping; visible-range computation;
custom-scrollbar geometry (proportional thumb with a minimum size, thumb↔row-space mapping).
The canvas has no real scroll height — only a row index — so multi-GB files scroll smoothly
and float math stays exact (offsets ≪ 2^53).

### `coverage.ts` — provenance index

Built lazily on first hex interaction, once per query result, from the `_src_start`/`_src_end`
Arrow columns into sorted typed arrays. Answers: (a) offset → covering rows, ordered smallest
interval first; (b) viewport byte range → covered spans for shading. Capped at ~2 M rows;
past the cap, shading and reveal degrade (quiet hint), while grid→hex stays live (it reads the
selected row's columns directly, no index).

### `selection.ts` — caret/selection state machine

Pure reducer for click, drag, shift-extend, double-click (select covering record's range), and
keyboard motion (arrows by byte, Up/Down by row, PgUp/PgDn by viewport, Mod+Home/End to file
ends — "Mod" is ⌘ on macOS, Ctrl elsewhere, throughout this spec). Rendered by the canvas, testable without it.

### `HexPane.svelte`

Thin composition: toolbar (offset/byte readout, goto input, "Filter results to selection",
provenance status, collapse toggle), DPR-aware canvas viewport, custom scrollbar, resize
handle. Redraws only on scroll/selection/data/resize/theme change. Colors read from the CSS
custom properties at draw time.

### Session state

One new field, through the existing reducer: `byteSelection: { start: number; end: number } |
null` (+ `selectByteRange` controller method / `byteRangeSelected` event). Status bar, grid,
and hex pane share it as the single source of truth, like `selectedRow` today. Cleared on new
result/source. Pane height + collapsed state persist in `localStorage`.

## The provenance link

**Activation.** The link is active iff the current result contains both `_src_start` and
`_src_end`. Two shell changes make that the common path:

- **Explorer tables become clickable**: clicking a table loads and runs
  `select * from <table> limit 10000`.
- **The grid hides `_`-prefixed columns** by default, with a "+N hidden" chip in the grid
  header toggling visibility.

**Grid → hex.** Selecting a row reads its `_src_start`/`_src_end` directly from the result,
scrolls the hex pane to the range (instant when far, animated when near), and paints the bright
selection highlight.

**Hex → grid.** Clicking a byte asks the coverage index for covering rows; best match is the
smallest covering interval (most specific record). The grid selects and scrolls to it
(`ResultGrid` gains scroll-on-external-selection; today it only scrolls on keyboard). The
status bar reports `offset 0x1A2B · N covering rows`; repeated clicks on the same byte cycle
smallest→largest.

**Structure shading.** Visible bytes covered by any result row get a subtle tint, alternating
intensity between adjacent records so boundaries read while scrolling. A filtered query shades
only its matching bytes — the query is a highlighter over the file.

**Filter action.** With a byte selection and provenance active, the toolbar action writes a
transparent wrapped query into the editor and runs it:
`select * from (<current sql>) where _src_start <= <selEnd> and _src_end >= <selStart>`.
The button is not rendered when provenance is absent.

**No-provenance fallback.** Aggregate results don't link: the pane stays fully browsable,
shading off, with a quiet hint — "No byte provenance in this result — browse a table to link
bytes to rows." Nothing errors; nothing looks disabled.

## Hex pane rendering & interaction

- **Layout:** offset gutter (hex, zero-padded to the file's width), 16 byte pairs grouped 8+8
  with a wider mid-gap, ASCII gutter (printables; `·` otherwise). `--font-mono` token.
- **Scrolling:** custom scrollbar (drag, track-click paging), wheel = 3 rows (Shift = page),
  thumb maps to row space so every position of a multi-GB file is reachable. Missing pages
  render as dim placeholder blocks and repaint on delivery — scrolling never blocks on I/O.
- **Goto:** input accepts `0x1a2b`, decimal, and `+16`/`-16` relative jumps; Enter jumps, sets
  the caret, and briefly flashes the target row. `Mod+G` (or `g` with canvas focus) focuses
  the input. Invalid input: inline shake + message.
- **Selection:** click caret, drag range, Shift extend, double-click = covering record range.
  `Mod+C` copies the selection as space-separated hex. Caret offset + byte value in the
  toolbar; selection range (`0x40–0x77 · 56 bytes`) in the status bar.
- **Accessibility:** canvas focusable, `role="application"` with descriptive label; caret and
  selection changes announced via a visually-hidden `aria-live` region; keyboard-complete;
  focus ring matches the shell focus token; `prefers-reduced-motion` disables flash and smooth
  scroll.
- **Sizing:** default ~35 % of the center column; drag-resize (min toolbar + 4 rows, max
  70 %); collapses to the toolbar strip. Compact mode: lives inside the Results tab, collapsed
  by default.

## Full-shell polish pass

Token refresh first, then the component sweep — fixes land in the system, not per-component.

**Tokens** (extending the existing `:root`, keeping the teal identity): 4-step type scale with
line-heights; 4/8 px spacing scale; `--font-mono` (JetBrains Mono → ui-monospace fallbacks)
shared by editor, grid values, hex pane, status bar; one interactive-state recipe
(hover/active/focus-visible/disabled); `tabular-nums` wherever numbers align.

**Component sweep:**

- **Empty state** — landing moment: format badges (MIDI, pcap), the privacy line ("your file
  never leaves this browser"), and app-wide drag-and-drop with a full-window drop overlay.
- **Header** — app bar: wordmark, open action, source as a chip (name · size · format), pane
  toggles with pressed states.
- **Explorer** — clickable tables with hover "browse" affordance; kind glyphs on saved
  queries; type-colored schema badges consistent with grid headers; the parse-diagnostics card
  becomes expandable to list actual issues (present in state, currently never shown).
- **Grid** — numeric columns right-aligned in tabular figures; binary columns mono with byte
  count; `NULL` dimmed italic; hover wash; accent selection; hidden-columns chip; footer strip
  (rows · elapsed ms — elapsed exists in state, unused today).
- **Inspector** — per-type value formatting; the row's byte range as a clickable link focusing
  the hex pane.
- **Status bar** — live readout rail: phase chip, ingest throughput (from `progress.bytes` +
  `openStartedAt`), query timing, row count, caret/selection readout.
- **Progress & errors** — byte-accurate ingest bar with throughput and cancel; query
  diagnostics styled distinctly from fatal errors; one shared spinner component.
- **Micro-interactions** — 120–160 ms ease-out on collapse/resize/hover/jump-flash, all gated
  on `prefers-reduced-motion`.
- **Keyboard model** — `Mod+Enter` run (exists), `Mod+O` open, `Mod+G` goto, `Mod+B`/`Mod+I`
  toggle explorer/inspector, `?` opens a small shortcuts overlay (doubles as hex-interaction
  discoverability).

## Error handling

- **Stale async:** page deliveries carry the session generation; late arrivals are dropped.
  New file resets cache, coverage, selection, scroll.
- **Read failures:** a rejected slice read (file moved/changed on disk; Chromium
  `NotReadableError`) shows a non-fatal strip in the pane with retry — the rest of the
  workbench keeps working. Size mismatch invalidates rather than corrupts.
- **Quiet degradation:** no provenance → browsable + hint; coverage cap → shading/reveal off,
  grid→hex live; font-load failure falls down the mono stack.
- **Filter action** has no error path — it is only rendered when provenance columns exist.

## Testing

- **Unit (vitest):** `layout.ts` offset↔row↔pixel round-trips incl. 4 GB+ row counts and
  scrollbar mapping edges; `byte-cache.ts` LRU eviction, coalescing, prefetch, generation
  invalidation (counting fake Blob); `coverage.ts` smallest-interval choice, cycling order,
  viewport spans, cap behavior; `selection.ts` full state machine; filter-SQL wrapping;
  hidden-column filtering; `byteSelection` reducer cases.
- **Component (vitest + happy-dom):** `HexPane` against a fake 2D context recording draw calls
  — asserts what would paint (placeholders, shading spans, selection rects) without pixels;
  toolbar/goto/aria behavior via DOM.
- **E2E (Playwright, real Chromium):** the signature round-trip on both gallery formats —
  sample MIDI and a pcap fixture: browse table → select row → hex scroll/highlight; click hex
  byte → grid selection; double-click → record range; filter-to-selection shrinks rows; goto
  lands; drag-and-drop intake; hidden-columns chip. Assertions via data attributes/exposed
  state, not pixels. This discharges the Phase 1 exit criterion.
- **Manual/visual:** screenshot pass at desktop and compact widths during implementation.

## Out of scope

Light theme; new visual identity; byte search; inspector value decoding; cross-table
"what's-here" lookup; any engine/worker/DB change beyond the controller retaining the source
`Blob`; column-level provenance.
