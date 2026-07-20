# ByteQL Command Deck UI redesign

**Date:** 2026-07-20  
**Status:** Approved for implementation planning

## Objective

Give ByteQL a polished, contest-ready visual identity that is immediately distinct from Supabase
while preserving the product's existing behavior. The redesign should make ByteQL's signature
interaction—the link between relational results and exact source bytes—obvious within the first
few seconds of a demonstration.

## Approved direction

The approved direction is **Command Deck**: a focused, browser-native binary analysis environment
with deep navy surfaces, cobalt and cyan illumination, bold typography, and amber evidence accents.
It should feel energetic enough to catch a judge's attention while retaining the precision and
density expected from a serious analysis tool.

The direction deliberately avoids Supabase's recognizable combination of neutral charcoal
surfaces, green primary actions, generic rounded dashboard cards, and centered SaaS-style empty
states.

## Visual language

### Palette

- Deep ink navy is the canvas rather than neutral black.
- Layered blue-black surfaces distinguish navigation, work, and inspection zones.
- Electric cyan is the primary action and active-engine color.
- Cobalt supports selected surfaces, focus states, and structural depth.
- Warm amber is reserved for byte provenance, evidence highlights, and cautionary state—not
  general decoration.
- Muted blue-gray text replaces generic neutral gray.

All text, focus, selection, and interactive colors must retain accessible contrast. The existing
privacy and no-external-resource constraints remain binding.

### Typography and geometry

- The system sans stack remains the primary interface face so no font asset or network dependency
  is introduced.
- Monospace typography identifies engine state, source metadata, table counts, SQL-adjacent labels,
  offsets, and byte-oriented content.
- Headings use stronger scale and tighter tracking than the current shell.
- Corners remain controlled: medium radii for contained tools and small radii for controls. Large,
  generic floating cards are avoided.
- Fine blue structural borders, restrained glows, and localized gradients add depth without
  reducing information density.

### Motion

Motion is limited to brief surface transitions, drag feedback, and a subtle active-engine glow.
No decorative motion should delay intake or querying. Existing `prefers-reduced-motion` behavior
must disable nonessential animation.

## Brand asset strategy

Introduce a small reusable brand-mark component backed by `apps/web/src/assets/byteql.svg`. This is
the icon-only vector asset and is the best fit for the application because it is scalable, sharp,
and substantially lighter than the PNG variant. Pair the mark with live `ByteQL` text so the brand
remains crisp, responsive, and accessible at every shell size.

Use the icon mark in:

- the persistent application header;
- the startup/loading state; and
- the idle hero as a supporting signature, not an oversized centerpiece.

Keep `byteql-bare.svg`, the full promotional lockup, in the asset set for future promotional or
documentation use. Do not force its large white badge into compact application chrome. The PNG
variants are not needed by the web runtime because the vectors are sharper and much smaller.

The brand component must preserve a text alternative at the composed-brand level while treating
the decorative image itself as hidden from assistive technology.

## Shell design

### Header

The header becomes a compact command bar:

- brand mark, `ByteQL`, and a restrained `Forensic Workbench` descriptor on the leading edge;
- current file, format, and size grouped as the central source context;
- file-open and pane controls on the trailing edge; and
- a clear local-engine status treatment without implying a remote connection.

Existing explorer and inspector toggle semantics and the conditional open-file action remain
unchanged.

### Idle experience

Replace the centered generic card with an asymmetric Command Deck hero. The content hierarchy is:

1. a concise category line identifying browser-native binary intelligence;
2. the judge-facing promise, **Query the file. Prove the answer.**;
3. a short explanation connecting generated tables, SQL, and byte provenance;
4. the primary file-open action plus the sample and supported picker actions; and
5. visible proof points: supported formats and local-only processing.

The intake target and proof panel may sit side by side at wide widths and stack at narrow widths.
Drag-active feedback must remain obvious across both arrangements.

### Loaded workbench

Retain the existing three-pane information architecture and behavior while sharpening its meaning:

- the explorer reads as a **Capture map** of source, projected tables, saved queries, and issues;
- the center reads as **Ask the capture**, combining SQL, results, and the linked hex pane;
- the inspector reads as **Selected evidence**, surfacing row values, viewers, and provenance; and
- the status bar reports the local engine, processing state, performance, and row/source metrics.

Selection uses cobalt/cyan. Provenance linking and highlighted source bytes use amber so the
product's signature relationship is visually distinct from ordinary selection.

### Responsive behavior

Keep the established breakpoints and interaction model:

- wide screens retain the three-pane command deck;
- medium screens collapse the inspector behind the existing results/inspector tabs; and
- small screens use the existing explorer drawer and stacked intake actions.

Brand text and secondary descriptors may progressively hide, but the brand mark, main action, and
current task state must remain visible. No redesign element may introduce horizontal scrolling at
supported viewport widths.

## Component boundaries

The implementation is restricted to web presentation code:

- add a reusable brand-mark component;
- update `AppHeader`, `EmptyState`, and the startup state to use it;
- make focused markup changes where new labels or visual wrappers are necessary;
- update the central design tokens and component styles in `app.css`; and
- adjust co-located component tests for new rendered content.

The projection engine, format packs, database, workers, session controller, and session state remain
unchanged. Existing DOM semantics, accessible labels, keyboard shortcuts, data flow, file intake,
query behavior, viewer behavior, and provenance selection contracts remain binding.

## State and error treatment

The redesign must cover the full existing state model rather than only the ideal screenshots:

- startup and startup failure;
- idle and drag-active intake;
- probing, parsing, ingesting, querying, and cancellation;
- ready, empty-result, and selected-result states;
- query errors and fatal session errors; and
- parse diagnostics and spill capability errors.

Danger states remain unambiguous and are not recolored as ordinary amber evidence. Copy and recovery
actions retain their current meaning. A poison record must still surface through diagnostics without
disrupting the surrounding shell.

## Data flow

No product data flow changes are part of this redesign. The path remains:

```text
local file -> parse worker -> Arrow batches -> DuckDB-WASM
           -> result grid -> provenance selection -> hex pane
```

The redesign changes only how those existing states and relationships are presented.

## Verification

Implementation must use TDD for new or changed component behavior. Verification includes:

- component coverage for the brand mark, startup treatment, revised idle content, and preserved
  intake/header actions;
- existing web component and session tests;
- `pnpm --filter @byteql/web check`;
- `pnpm --filter @byteql/web test -- --run`;
- `pnpm --filter @byteql/web check:bundle` to preserve the zero-network and local-asset guarantees;
- focused Playwright acceptance for idle intake, responsive shell behavior, privacy, and hex
  provenance; and
- fresh desktop and mobile screenshots of the idle and loaded states for visual review.

The final implementation must not weaken existing e2e selectors, accessibility landmarks, focus
indicators, touch targets, privacy assertions, or reduced-motion behavior.

## Out of scope

- Parser, projection, database, worker, and protocol changes.
- New product workflows, navigation destinations, or account concepts.
- Theme switching or a second color theme.
- External fonts, remote images, analytics, or any new network dependency.
- Reworking the supplied logo artwork or generating replacement assets.
