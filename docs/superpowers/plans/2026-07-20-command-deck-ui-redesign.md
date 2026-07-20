# Command Deck UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ByteQL's Supabase-like visual shell with the approved Command Deck identity and
integrate the supplied logo without changing product behavior.

**Architecture:** Keep the existing Svelte component tree, session data flow, accessible landmarks,
and responsive pane behavior. Add one presentation-only `BrandMark` component, make focused copy and
wrapper changes in the shell components, and centralize the new navy/cobalt/cyan/amber language in
`app.css`.

**Tech Stack:** Svelte 5, TypeScript, CSS custom properties, Vitest, Testing Library, Playwright,
Vite local assets.

## Global Constraints

- No parser, projection, database, worker, protocol, session-controller, or session-state changes.
- No external URLs, fonts, images, analytics, runtime-loaded code, or new dependencies.
- Preserve all existing file intake, query, viewer, keyboard, provenance, and cancellation behavior.
- Preserve existing accessible names, landmarks, focus indicators, touch targets, and reduced-motion
  behavior unless this plan names an exact copy change.
- Use `apps/web/src/assets/byteql.svg` in the runtime; preserve the other supplied assets without
  modifying or deleting them.
- Use cyan for primary actions and active engine state, cobalt for selection, amber for provenance,
  and red for danger.
- Keep the established 1099 px and 700 px responsive breakpoints.
- Arrow, DuckDB, format packs, and privacy behavior remain unchanged.

---

## File structure

- Create `apps/web/src/components/BrandMark.svelte`: one reusable, decorative rendering of the
  icon-only vector with explicit size variants.
- Create `apps/web/src/components/BrandMark.test.ts`: asset and accessibility contract.
- Create `apps/web/e2e/command-deck.spec.ts`: desktop/mobile identity and overflow acceptance.
- Modify `apps/web/index.html`: local SVG favicon.
- Modify `apps/web/src/App.svelte`: branded startup and startup-failure state.
- Modify `apps/web/src/App.test.ts`: startup brand regression.
- Modify `apps/web/src/components/AppHeader.svelte`: persistent brand composition and command-bar
  copy.
- Modify `apps/web/src/components/EmptyState.svelte`: approved asymmetric idle hero structure.
- Modify `apps/web/src/components/EmptyState.test.ts`: hero and intake regressions.
- Modify `apps/web/src/components/Explorer.svelte`: Capture map hierarchy.
- Modify `apps/web/src/components/Inspector.svelte`: Selected evidence hierarchy.
- Modify `apps/web/src/components/Workbench.svelte`: Ask the capture and result-set hierarchy.
- Modify `apps/web/src/components/Workbench.test.ts`: loaded-shell copy and behavior regression.
- Modify `apps/web/src/components/SqlEditor.theme.test.ts`: Command Deck token contract.
- Modify `apps/web/src/app.css`: visual tokens, shell, states, and responsive presentation.

---

### Task 1: Brand mark and persistent chrome

**Files:**

- Create: `apps/web/src/components/BrandMark.svelte`
- Create: `apps/web/src/components/BrandMark.test.ts`
- Modify: `apps/web/src/components/AppHeader.svelte`
- Modify: `apps/web/src/App.svelte`
- Modify: `apps/web/src/App.test.ts`
- Modify: `apps/web/index.html`
- Add existing asset: `apps/web/src/assets/byteql.svg`

**Interfaces:**

- Consumes: Vite's static asset import support.
- Produces: `BrandMark` with `size?: 'small' | 'medium' | 'large'`; callers provide the accessible
  `ByteQL` text, while the component's image remains decorative.
- [ ] **Step 1: Write the failing brand component test**

Create `apps/web/src/components/BrandMark.test.ts`:

```ts
// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import BrandMark from './BrandMark.svelte';

describe('BrandMark', () => {
  afterEach(cleanup);

  it('renders the local vector as a decorative image with an explicit size', () => {
    const { container } = render(BrandMark, { size: 'large' });
    const mark = container.querySelector('[data-brand-mark]');
    const image = container.querySelector('img');

    expect(mark?.getAttribute('data-size')).toBe('large');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(image?.getAttribute('src')).toContain('byteql');
    expect(image?.getAttribute('alt')).toBe('');
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @byteql/web test -- --run src/components/BrandMark.test.ts
```

Expected: FAIL because `BrandMark.svelte` does not exist.

- [ ] **Step 3: Implement the reusable mark**

Create `apps/web/src/components/BrandMark.svelte`:

```svelte
<script lang="ts">
  import brandMarkUrl from '../assets/byteql.svg';

  interface Props {
    size?: 'small' | 'medium' | 'large';
  }

  let { size = 'small' }: Props = $props();
</script>

<span class="brand-mark" data-brand-mark data-size={size} aria-hidden="true">
  <img src={brandMarkUrl} alt="" />
</span>

<style>
  .brand-mark {
    display: inline-grid;
    width: 2rem;
    height: 2rem;
    flex: 0 0 auto;
    overflow: hidden;
    place-items: center;
  }

  .brand-mark[data-size='medium'] {
    width: 3rem;
    height: 3rem;
  }

  .brand-mark[data-size='large'] {
    width: 4.5rem;
    height: 4.5rem;
  }

  img {
    display: block;
    width: 255%;
    max-width: none;
  }
</style>
```

- [ ] **Step 4: Integrate the mark into startup and the command bar**

In `apps/web/src/App.svelte`, import `BrandMark` and replace the `startup-mark` span with:

```svelte
<BrandMark size="large" />
<p class="startup-kicker">Browser-native binary intelligence</p>
<h1>ByteQL</h1>
```

Keep the existing startup error, retry button, and local-inspector loading copy unchanged.

In `apps/web/src/components/AppHeader.svelte`, import `BrandMark` and replace the text-only wordmark
with:

```svelte
<a class="wordmark" href="/" aria-label="ByteQL home">
  <BrandMark size="small" />
  <span>ByteQL</span>
</a>
<span class="product-kicker">Forensic Workbench</span>
```

Add this local favicon inside `apps/web/index.html`'s `<head>`:

```html
<link rel="icon" type="image/svg+xml" href="/src/assets/byteql.svg" />
```

- [ ] **Step 5: Extend the startup regression**

In the first test in `apps/web/src/App.test.ts`, add assertions before initialization resolves:

```ts
expect(screen.getByText('Browser-native binary intelligence')).toBeTruthy();
expect(view.container.querySelector('[data-brand-mark] img')).toBeTruthy();
```

Do not change the assertions that the workbench remains hidden until initialization completes.

- [ ] **Step 6: Run the component tests and verify they pass**

Run:

```bash
pnpm --filter @byteql/web test -- --run src/components/BrandMark.test.ts src/App.test.ts \
  src/components/Workbench.test.ts
```

Expected: PASS with pristine output.

- [ ] **Step 7: Commit the brand integration**

```bash
git add apps/web/index.html apps/web/src/App.svelte apps/web/src/App.test.ts \
  apps/web/src/assets/byteql.svg apps/web/src/components/AppHeader.svelte \
  apps/web/src/components/BrandMark.svelte apps/web/src/components/BrandMark.test.ts
git commit -m "feat(web): integrate ByteQL brand mark"
```

---

### Task 2: Contest-ready idle experience

**Files:**

- Modify: `apps/web/src/components/EmptyState.svelte`
- Modify: `apps/web/src/components/EmptyState.test.ts`
- Modify: `apps/web/src/app.css`

**Interfaces:**

- Consumes: `BrandMark size="medium"` from Task 1 and the existing `onopen`/`onsample` callbacks.
- Produces: an `empty-hero-copy`, `empty-intake`, and `empty-proof-grid` layout without changing any
  file-picker behavior or accessible action names.
- [ ] **Step 1: Write failing hero-content assertions**

Replace the final test in `apps/web/src/components/EmptyState.test.ts` with:

```ts
it('presents the Command Deck promise, formats, and local-only proof', () => {
  const { container } = render(EmptyState, { props: { onopen: vi.fn(), onsample: vi.fn() } });

  expect(screen.getByRole('heading', { name: 'Query the file. Prove the answer.' })).toBeTruthy();
  expect(screen.getByText('Browser-native binary intelligence')).toBeTruthy();
  expect(screen.getByText('No upload. No server.')).toBeTruthy();
  expect(screen.getByText(/files never leave this browser/iu)).toBeTruthy();
  expect(screen.getByText('MIDI')).toBeTruthy();
  expect(screen.getByText('pcap')).toBeTruthy();
  expect(container.querySelector('[data-brand-mark]')).toBeTruthy();
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @byteql/web test -- --run src/components/EmptyState.test.ts
```

Expected: FAIL because the approved heading and proof copy are absent.

- [ ] **Step 3: Implement the approved idle structure**

Import `BrandMark` into `EmptyState.svelte`. Keep `chooseFile`, `dropFile`, `browseFiles`, the hidden
file input, button names, disabled states, diagnostic role, and section drag handlers unchanged.
Replace only the section contents with this hierarchy:

```svelte
<div class="empty-hero-copy">
  <BrandMark size="medium" />
  <p class="eyebrow">Browser-native binary intelligence</p>
  <h1 id="empty-title">Query the file. <span>Prove the answer.</span></h1>
  <p class="empty-copy">
    Turn local binary files into queryable tables, then trace every result back to its exact source
    bytes. Files never leave this browser.
  </p>
  <ul class="format-badges" aria-label="Supported formats">
    <li>MIDI</li>
    <li>pcap</li>
  </ul>
</div>

<div class="empty-intake">
  <p class="empty-intake-label">Start a local investigation</p>
  <div class="empty-actions">
    <label class="button button-primary">
      Open file
      <input type="file" aria-label="Open file" disabled={busy} onchange={chooseFile} />
    </label>
    <button class="button button-secondary" type="button" disabled={busy} onclick={onsample}>
      Try sample
    </button>
    {#if filePickerSupported}
      <button class="button button-secondary" type="button" disabled={busy} onclick={browseFiles}>
        Browse files
      </button>
    {/if}
  </div>
  <p class="drop-hint">Drop a binary file anywhere in this panel</p>
</div>

<div class="empty-proof-grid" aria-label="Privacy guarantees">
  <div><strong>No upload. No server.</strong><span>Parsing, storage, and SQL stay on this device.</span></div>
  <div><strong>Source-linked evidence.</strong><span>Every projected row retains its byte range.</span></div>
</div>
```

Place the existing diagnostic immediately after `empty-proof-grid`.

- [ ] **Step 4: Apply the Command Deck idle CSS**

In `apps/web/src/app.css`, replace the old centered-card rules for `.empty-main` through
`.drop-hint` with these layout values while preserving the existing input-visually-hidden and
focus-within declarations:

```css
.empty-main {
  grid-column: explorer / inspector;
  display: grid;
  overflow: auto;
  place-items: center;
  background:
    radial-gradient(circle at 75% 18%, rgb(25 132 255 / 18%), transparent 34%),
    linear-gradient(135deg, rgb(16 29 56 / 35%), transparent 55%);
}

.empty-state {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(17rem, 0.75fr);
  width: min(68rem, calc(100% - 3rem));
  padding: clamp(2rem, 5vw, 4.5rem);
  gap: 1.25rem 3rem;
  border: 1px solid var(--color-border);
  border-radius: 1rem;
  background: rgb(13 20 38 / 86%);
  box-shadow: var(--shadow-pane);
  text-align: left;
}

.empty-hero-copy h1 {
  max-width: 12ch;
  margin: 1rem 0 0;
  font-size: clamp(2.5rem, 6vw, 5rem);
  line-height: 0.94;
  letter-spacing: -0.065em;
}

.empty-hero-copy h1 span { display: block; }
.empty-copy { max-width: 36rem; margin: 1.25rem 0; }
.format-badges { justify-content: flex-start; margin-bottom: 0; }

.empty-intake {
  align-self: center;
  padding: 1.35rem;
  border: 1px solid var(--color-accent-dim);
  border-radius: var(--radius-md);
  background: rgb(18 32 59 / 88%);
  box-shadow: 0 0 2.5rem var(--color-accent-halo);
}

.empty-intake-label {
  margin: 0 0 1rem;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: 700;
}

.empty-actions { justify-content: flex-start; flex-wrap: wrap; }
.empty-proof-grid { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
.empty-proof-grid > div { padding: 1rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.empty-proof-grid strong, .empty-proof-grid span { display: block; }
.empty-proof-grid strong { margin-bottom: 0.35rem; color: var(--color-text); }
.empty-proof-grid span { color: var(--color-text-muted); font-size: var(--text-sm); }
```

Within the existing `@media (max-width: 700px)` block, add:

```css
.empty-state { grid-template-columns: 1fr; width: min(100% - 1rem, 38rem); padding: 1.5rem; }
.empty-proof-grid { grid-template-columns: 1fr; }
.empty-hero-copy h1 { font-size: clamp(2.4rem, 14vw, 4rem); }
```

- [ ] **Step 5: Run the idle-state regressions**

Run:

```bash
pnpm --filter @byteql/web test -- --run src/components/EmptyState.test.ts \
  src/components/Workbench.test.ts src/App.test.ts
```

Expected: PASS; file input, sample, and picker tests remain green.

- [ ] **Step 6: Commit the idle experience**

```bash
git add apps/web/src/components/EmptyState.svelte apps/web/src/components/EmptyState.test.ts \
  apps/web/src/app.css
git commit -m "feat(web): redesign local intake experience"
```

---

### Task 3: Loaded Command Deck hierarchy and theme

**Files:**

- Modify: `apps/web/src/components/Explorer.svelte`
- Modify: `apps/web/src/components/Inspector.svelte`
- Modify: `apps/web/src/components/Workbench.svelte`
- Modify: `apps/web/src/components/Workbench.test.ts`
- Modify: `apps/web/src/components/SqlEditor.theme.test.ts`
- Modify: `apps/web/src/app.css`

**Interfaces:**

- Consumes: the existing session state and component callbacks without signature changes.
- Produces: stable visible labels `Capture map`, `Ask the capture`, `Result set`, and
  `Selected evidence`, plus the Command Deck color-token contract.
- [ ] **Step 1: Write failing loaded-shell assertions**

In the `shows source context...` test in `Workbench.test.ts`, add:

```ts
expect(within(navigation).getByText('Capture map')).toBeTruthy();
expect(within(workspace).getByRole('heading', { name: 'Ask the capture' })).toBeTruthy();
expect(within(workspace).getByText('Result set')).toBeTruthy();
expect(
  within(screen.getByRole('complementary', { name: 'Inspector' })).getByText('Selected evidence'),
).toBeTruthy();
```

In `SqlEditor.theme.test.ts`, add the shell tokens and forbidden Supabase-like mint assertion:

```ts
const commandDeckTokens = [
  '--color-canvas',
  '--color-surface',
  '--color-surface-inset',
  '--color-surface-raised',
  '--color-accent',
  '--color-accent-dim',
  '--color-evidence',
] as const;

it('defines the Command Deck shell without the former mint accent', () => {
  for (const token of commandDeckTokens) expect(appCss).toContain(`${token}:`);
  expect(appCss).not.toContain('#55d8be');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
pnpm --filter @byteql/web test -- --run src/components/Workbench.test.ts \
  src/components/SqlEditor.theme.test.ts
```

Expected: FAIL on the four new labels, missing tokens, and old mint value.

- [ ] **Step 3: Apply the loaded-shell copy hierarchy**

Make these exact text changes without changing surrounding landmarks or event handlers:

```svelte
<!-- Explorer.svelte pane heading -->
<p class="eyebrow">Capture map</p>
<h2>Explorer</h2>

<!-- Workbench.svelte editor heading -->
<p class="eyebrow">Query console</p>
<h1>Ask the capture</h1>

<!-- Workbench.svelte results heading -->
<p class="eyebrow">Result set</p>
<h2>Results</h2>

<!-- Inspector.svelte pane heading -->
<p class="eyebrow">Selected evidence</p>
<h2>Inspector</h2>
```

- [ ] **Step 4: Replace the core theme tokens**

At the top of `app.css`, replace the current color and depth tokens with:

```css
--color-canvas: #080d18;
--color-surface: #0d1424;
--color-surface-inset: #070c16;
--color-surface-raised: #121c33;
--color-surface-hover: #182746;
--color-border: #263352;
--color-border-strong: #3a4d74;
--color-text: #edf5ff;
--color-text-muted: #9baaca;
--color-text-subtle: #71809f;
--color-accent: #36c2ff;
--color-accent-strong: #72d8ff;
--color-accent-dim: #167fbd;
--color-accent-ink: #04131e;
--color-evidence: #ffbd66;
--color-danger: #ff8f91;
--color-danger-surface: #331820;
--color-selection: #102e49;
--color-focus: #ffbd66;
--color-editor-text: #e4efff;
--color-editor-background: #070c16;
--color-editor-caret: #72d8ff;
--color-editor-selection: #143b5a;
--color-editor-gutter-text: #61708e;
--color-editor-gutter-background: #0d1424;
--color-editor-border: #263352;
--color-editor-active-line: #101c32;
--color-syntax-keyword: #60d1ff;
--color-syntax-string: #ffbd66;
--color-syntax-number: #a8b8ff;
--color-syntax-comment: #71809f;
--color-syntax-operator: #d5a7ff;
--color-syntax-name: #edf5ff;
--color-syntax-invalid: #ff8f91;
--color-shade-a: rgb(54 194 255 / 9%);
--color-shade-b: rgb(83 109 255 / 9%);
--color-hex-highlight: rgb(255 189 102 / 38%);
--color-hex-placeholder: rgb(58 77 116 / 45%);
--color-canvas-glow: rgb(25 132 255 / 17%);
--color-header-glass: rgb(13 20 36 / 94%);
--color-accent-halo: rgb(54 194 255 / 15%);
--color-accent-wash: rgb(54 194 255 / 8%);
--shadow-pane: 0 24px 64px rgb(0 0 0 / 32%);
--shadow-header: 0 8px 28px rgb(0 0 0 / 22%);
--shadow-grid: 0 5px 16px rgb(0 0 0 / 24%);
```

- [ ] **Step 5: Restyle the loaded shell by existing boundaries**

Keep the current grid templates and breakpoints. Update these selector groups in `app.css` with the
following exact presentation rules; retain their existing structural declarations where not
overridden:

```css
.app-shell {
  background:
    radial-gradient(circle at 72% -12%, var(--color-canvas-glow), transparent 34%),
    linear-gradient(135deg, rgb(20 35 66 / 22%), transparent 50%),
    var(--color-canvas);
}

.app-header { padding-inline: 0.85rem; background: var(--color-header-glass); }
.wordmark { display: inline-flex; align-items: center; gap: 0.4rem; }
.product-kicker { font-family: var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
.source-chip { border-radius: var(--radius-md); background: var(--color-surface-raised); }

.explorer, .inspector { background: rgb(13 20 36 / 96%); }
.pane-heading { min-height: 4.75rem; background: linear-gradient(180deg, rgb(24 39 70 / 35%), transparent); }
.eyebrow { color: var(--color-accent); font-family: var(--font-mono); }

.table-list details[open],
.source-card,
.selection-chip {
  border-color: var(--color-border-strong);
  background: var(--color-surface-raised);
}

.editor-heading, .results-heading { background: rgb(13 20 36 / 72%); }
.button-primary { box-shadow: 0 0 1.5rem var(--color-accent-halo); }
.result-grid [aria-selected='true'] { box-shadow: inset 2px 0 var(--color-accent); }
.provenance-link, .hex-readout-offset { color: var(--color-evidence); }
.hex-pane { background: var(--color-surface-inset); }
.status-bar { font-family: var(--font-mono); letter-spacing: 0.01em; }
```

Review every remaining literal mint RGB value in `app.css` and replace it with the corresponding
cyan token. Do not replace danger reds or the new amber evidence value.

- [ ] **Step 6: Run loaded-shell tests, check, and formatting**

Run:

```bash
pnpm --filter @byteql/web test -- --run src/components/Workbench.test.ts \
  src/components/SqlEditor.theme.test.ts src/components/HexPane.test.ts \
  src/components/StatusBar.test.ts
pnpm --filter @byteql/web check
```

Expected: all tests PASS and Svelte check reports zero errors.

- [ ] **Step 7: Commit the loaded workbench**

```bash
git add apps/web/src/app.css apps/web/src/components/Explorer.svelte \
  apps/web/src/components/Inspector.svelte apps/web/src/components/Workbench.svelte \
  apps/web/src/components/Workbench.test.ts apps/web/src/components/SqlEditor.theme.test.ts
git commit -m "feat(web): apply Command Deck workbench theme"
```

---

### Task 4: Responsive and browser acceptance

**Files:**

- Create: `apps/web/e2e/command-deck.spec.ts`
- Modify: `apps/web/src/app.css` only if the failing acceptance test exposes overflow.

**Interfaces:**

- Consumes: stable brand selectors and visible hierarchy from Tasks 1-3.
- Produces: desktop and mobile acceptance coverage for identity, intake, loaded shell, and width.
- [ ] **Step 1: Write the browser acceptance test**

Create `apps/web/e2e/command-deck.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

import { waitForAppReady } from './support/app.js';

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
}

test('presents the Command Deck identity from intake through the loaded workbench', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  await waitForAppReady(page);

  await expect(page.locator('[data-brand-mark]').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Query the file. Prove the answer.' })).toBeVisible();
  await expect(page.getByText('No upload. No server.')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'Try sample' }).click();
  await expect(page.getByText('Capture map')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ask the capture' })).toBeVisible();
  await expect(page.getByText('Result set')).toBeVisible();
  await expect(page.getByText('Selected evidence')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('keeps the brand and local intake usable on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await waitForAppReady(page);

  await expect(page.locator('[data-brand-mark]').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Query the file. Prove the answer.' })).toBeVisible();
  await expect(page.getByLabel('Open file')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Try sample' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
```

- [ ] **Step 2: Run the new acceptance test and fix only evidenced overflow**

Run:

```bash
pnpm --filter @byteql/web test:e2e -- command-deck.spec.ts
```

Expected: PASS. If width fails, inspect the overflowing element and constrain that exact selector
with `min-width: 0`, wrapping, or the existing 700 px media block; do not add global overflow hiding.

- [ ] **Step 3: Run privacy and provenance acceptance**

Run:

```bash
pnpm --filter @byteql/web test:e2e -- privacy.spec.ts hex-provenance.spec.ts \
  open-query-inspect.spec.ts
```

Expected: PASS with zero post-readiness network events and preserved hex/result round trips.

- [ ] **Step 4: Commit acceptance coverage**

```bash
git add apps/web/e2e/command-deck.spec.ts apps/web/src/app.css
git commit -m "test(web): cover Command Deck responsive shell"
```

---

### Task 5: Full verification and visual review

**Files:**

- Verify only; no source files are expected to change.

**Interfaces:**

- Consumes: completed Tasks 1-4.
- Produces: evidence that the redesign is type-safe, regression-safe, private, responsive, and
  visually consistent.
- [ ] **Step 1: Run the full web gate**

```bash
pnpm --filter @byteql/web check
pnpm --filter @byteql/web test -- --run
pnpm --filter @byteql/web check:bundle
pnpm --filter @byteql/web build
```

Expected: every command exits 0 with pristine test output and no external bundle references.

- [ ] **Step 2: Run the full browser suite**

```bash
pnpm --filter @byteql/web test:e2e
```

Expected: all Playwright projects PASS.

- [ ] **Step 3: Capture fresh review screenshots**

Start the app:

```bash
pnpm --filter @byteql/web dev --host 127.0.0.1
```

In a second terminal, capture the desktop idle state:

```bash
pnpm --filter @byteql/web exec playwright screenshot --viewport-size=1440,960 \
  --wait-for-timeout=9000 http://127.0.0.1:5173/ /tmp/byteql-command-deck-desktop.png
```

Capture the mobile idle state:

```bash
pnpm --filter @byteql/web exec playwright screenshot --viewport-size=390,844 \
  --wait-for-timeout=9000 http://127.0.0.1:5173/ /tmp/byteql-command-deck-mobile.png
```

Inspect both images for clipped copy, weak hierarchy, accidental mint/green remnants, logo crop,
focus loss, and horizontal overflow. Correct only concrete issues, rerun the affected test, and
repeat the corresponding screenshot.

- [ ] **Step 4: Confirm repository scope**

```bash
git status --short
git log --oneline -5
```

Expected: only the user's unused supplied logo variants may remain untracked; implementation commits
contain no generated `dist`, `dist-e2e`, screenshot, benchmark, or report artifacts.
