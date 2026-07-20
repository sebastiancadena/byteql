# pcap Sample Picker + Für Elise MIDI Sample — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a first-time visitor load a real multi-file pcap sample (or a MIDI) in one click from the empty state, and replace the dull bundled `demo.mid` with `fur_Elise_opening.mid`.

**Architecture:** A data-only sample registry (`samples.ts`) is the single source of truth for which samples exist and which bundled asset files each maps to. `SessionController.openSample(id)` fetches each file lazily (cached) and reuses the existing multi-file `openBatch`. A `SampleMenu` dropdown (mirroring `ViewerMenu`) surfaces the registry in `EmptyState`.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vite (`?url` asset imports), Vitest + `@testing-library/svelte`, Playwright (e2e), pnpm workspaces.

## Global Constraints

- **No `http(s)://` string in any runtime `.ts`/`.svelte`/`.js`/`.css` source.** `check:bundle`'s source-URL audit fails the build on external URLs. Provenance URLs live **only** in `PROVENANCE.md` (Markdown is not scanned). Asset imports are relative (`../../assets/x.cap?url`).
- **Do not modify `apps/web/public/_headers`.** `verify-pages-artifact.mjs` asserts it byte-for-byte.
- **Per-file asset limit 25 MiB** (all three assets are far under; no action needed, just don't add anything huge).
- **Leave every `demo.mid` test/e2e/package fixture untouched** — only the bundled UI asset `apps/web/src/assets/demo.mid` is removed. The fixtures in `packages/formats/midi/**` and `apps/web/e2e/fixtures/**` assert distinct parse properties and stay.
- Commit messages: conventional commits, no `Co-Authored-By`, no AI-assistant branding.
- Run all commands from the worktree root: `~/worktrees/byteql/feature+pcap-sample-picker`.
- Single test file run: `pnpm --filter @byteql/web exec vitest run <path>`.

---

### Task 1: Sample registry + bundled assets + provenance

**Files:**
- Create: `apps/web/src/lib/session/samples.ts`
- Create: `apps/web/src/lib/session/samples.test.ts`
- Create (binary): `apps/web/src/assets/SkypeIRC.cap`, `apps/web/src/assets/v6.pcap`, `apps/web/src/assets/fur_Elise_opening.mid`
- Create: `apps/web/src/assets/PROVENANCE.md`

**Interfaces:**
- Produces: `type SampleId = 'pcap' | 'midi'`; `interface SampleFile { name: string; url: string }`; `interface SampleDefinition { id: SampleId; label: string; files: readonly SampleFile[] }`; `const SAMPLES: readonly SampleDefinition[]` (order: `pcap` first, then `midi`).

- [ ] **Step 1: Place the three bundled asset files**

The two pcaps were downloaded and verified during design (classic libpcap, Ethernet). Copy the verified copies from the scratchpad and the MIDI from Downloads:

```bash
cd ~/worktrees/byteql/feature+pcap-sample-picker
SP=/tmp/byteql-scratch
cp "$SP/SkypeIRC.cap" apps/web/src/assets/SkypeIRC.cap
cp "$SP/v6.pcap"      apps/web/src/assets/v6.pcap
cp ~/Downloads/fur_Elise_opening.mid apps/web/src/assets/fur_Elise_opening.mid
```

Fallback if the scratchpad copies are gone (URLs verified 200 in design):

```bash
B=https://wiki.wireshark.org/uploads/__moin_import__/attachments/SampleCaptures
curl -sL -o apps/web/src/assets/SkypeIRC.cap "$B/SkypeIRC.cap"
curl -sL -o apps/web/src/assets/v6.pcap      "$B/v6.pcap"
```

- [ ] **Step 2: Verify the asset magic bytes**

Run:

```bash
cd ~/worktrees/byteql/feature+pcap-sample-picker/apps/web/src/assets
for f in SkypeIRC.cap v6.pcap; do printf '%s: ' "$f"; xxd -l4 "$f" | awk '{print $2$3}'; done
printf 'fur_Elise_opening.mid: '; xxd -l4 fur_Elise_opening.mid | awk '{print $2$3}'
```

Expected: both pcaps print `d4c3b2a1` (classic libpcap little-endian magic); the MIDI prints `4d546864` (`MThd`).

- [ ] **Step 3: Write the failing registry test**

Create `apps/web/src/lib/session/samples.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { SAMPLES } from './samples.js';

describe('sample registry', () => {
  it('lists pcap first (default), then midi', () => {
    expect(SAMPLES.map((sample) => sample.id)).toEqual(['pcap', 'midi']);
  });

  it('maps the pcap sample to the two Wireshark captures', () => {
    const pcap = SAMPLES.find((sample) => sample.id === 'pcap');
    expect(pcap?.files.map((file) => file.name)).toEqual(['SkypeIRC.cap', 'v6.pcap']);
  });

  it('maps the midi sample to the single Für Elise file', () => {
    const midi = SAMPLES.find((sample) => sample.id === 'midi');
    expect(midi?.files.map((file) => file.name)).toEqual(['fur_Elise_opening.mid']);
  });

  it('gives every file a non-empty resolved url and a menu label per entry', () => {
    for (const sample of SAMPLES) {
      expect(sample.label.length).toBeGreaterThan(0);
      for (const file of sample.files) expect(file.url.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/session/samples.test.ts`
Expected: FAIL — cannot resolve `./samples.js`.

- [ ] **Step 5: Write the registry**

Create `apps/web/src/lib/session/samples.ts`. Note: NO external URLs anywhere in this file (see Global Constraints).

```ts
import skypeIrcUrl from '../../assets/SkypeIRC.cap?url';
import v6Url from '../../assets/v6.pcap?url';
import furEliseUrl from '../../assets/fur_Elise_opening.mid?url';

export type SampleId = 'pcap' | 'midi';

export interface SampleFile {
  /** Filename shown in the _files catalog and the hex file switcher. */
  name: string;
  /** Build-time-resolved URL of the bundled asset. */
  url: string;
}

export interface SampleDefinition {
  id: SampleId;
  /** Menu-item text in the sample picker. */
  label: string;
  files: readonly SampleFile[];
}

/**
 * The single source of truth for the empty-state sample picker. Order is
 * significant: the first entry is the picker's default/primary item.
 * pcap is the flagship because it exercises the most tables at once.
 */
export const SAMPLES: readonly SampleDefinition[] = [
  {
    id: 'pcap',
    label: 'Network capture (pcap)',
    files: [
      { name: 'SkypeIRC.cap', url: skypeIrcUrl },
      { name: 'v6.pcap', url: v6Url },
    ],
  },
  {
    id: 'midi',
    label: 'MIDI song (.mid)',
    files: [{ name: 'fur_Elise_opening.mid', url: furEliseUrl }],
  },
];
```

- [ ] **Step 6: Write PROVENANCE.md** (external URLs are allowed here — `.md` is not scanned)

Create `apps/web/src/assets/PROVENANCE.md`:

```markdown
# Bundled sample assets — provenance

These files back the empty-state "Try sample" picker (`src/lib/session/samples.ts`).

## Network captures

- `SkypeIRC.cap` — Wireshark wiki, SampleCaptures.
  Source: https://wiki.wireshark.org/uploads/__moin_import__/attachments/SampleCaptures/SkypeIRC.cap
  Contents: Skype, IRC, and DNS traffic over IPv4 (classic libpcap, Ethernet).
- `v6.pcap` — Wireshark wiki, SampleCaptures.
  Source: https://wiki.wireshark.org/uploads/__moin_import__/attachments/SampleCaptures/v6.pcap
  Contents: IPv6 (6bone) and ICMPv6 packets (classic libpcap, Ethernet).

Redistribution follows the Wireshark wiki SampleCaptures terms
(https://wiki.wireshark.org/SampleCaptures).

## MIDI

- `fur_Elise_opening.mid` — opening of Beethoven's *Für Elise* (WoO 59).
  The composition is public domain; the MIDI file was user-supplied.
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/session/samples.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
cd ~/worktrees/byteql/feature+pcap-sample-picker
git add apps/web/src/lib/session/samples.ts apps/web/src/lib/session/samples.test.ts apps/web/src/assets/SkypeIRC.cap apps/web/src/assets/v6.pcap apps/web/src/assets/fur_Elise_opening.mid apps/web/src/assets/PROVENANCE.md
git commit -m "feat(web): add sample registry with pcap + Für Elise assets"
```

---

### Task 2: Generalize `openSample(id)` with lazy cached fetch; drop the init prefetch

**Files:**
- Modify: `apps/web/src/lib/session/controller.ts` (imports, `SessionControllerOptions`, fields, `openSample`, `initializeOnce`, `dispose` reset)
- Modify: `apps/web/src/lib/session/controller.test.ts` (sample tests ~lines 285–312, 976–996, 1070–1095)
- Delete: `apps/web/src/assets/demo.mid`

**Interfaces:**
- Consumes: `SAMPLES`, `SampleId`, `SampleDefinition` from Task 1; `openBatch(entries: readonly BatchEntry[])` and `BatchEntry { name; size; blob }` (existing).
- Produces: `openSample(id: SampleId): Promise<void>`; new option `sampleUrlOverrides?: Partial<Record<SampleId, readonly string[]>>` on `SessionControllerOptions` (replaces the removed `demoUrl`).

- [ ] **Step 1: Rewrite the sample controller tests (failing)**

In `apps/web/src/lib/session/controller.test.ts`, replace the three sample tests so they no longer assume an init-time fetch and use the new API. Replace the test starting `it('fetches and retains the bundled sample during initialize and never refetches it to open', …)` (≈line 285) with:

```ts
  it('fetches the midi sample lazily on open and caches it across opens', async () => {
    const sample = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 1, 2, 3]);
    const fetchSample = vi.fn().mockResolvedValue(new Response(sample));
    const controller = new SessionController({
      database,
      parser,
      fetch: fetchSample,
      sampleUrlOverrides: { midi: ['/assets/fur_Elise_opening.mid'] },
      stopViewer,
    });

    await controller.initialize();
    // Init no longer fetches any sample.
    expect(fetchSample).not.toHaveBeenCalled();

    const opening = controller.openSample('midi');
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    expect(fetchSample).toHaveBeenCalledWith(
      '/assets/fur_Elise_opening.mid',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(parser.calls[0]?.name).toBe('fur_Elise_opening.mid');
    expect(Array.from(new Uint8Array(await parser.calls[0]!.blob.arrayBuffer()))).toEqual(Array.from(sample));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'events', rowCount: 3 }];
    parser.calls[0]!.finish(streamedResult('events', 3));
    await resolveFilesAppend(sessions[0]!);
    await opening;

    // Second open reuses the cache — no second fetch for the same url.
    const reopening = controller.openSample('midi');
    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    expect(fetchSample).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[1]!.finalizeResult = [{ name: 'events', rowCount: 3 }];
    parser.calls[1]!.finish(streamedResult('events', 3));
    await resolveFilesAppend(sessions[1]!);
    await reopening;
  });

  it('opens the pcap sample as a two-file batch', async () => {
    const sample = new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1, 1, 2, 3]);
    const fetchSample = vi.fn().mockResolvedValue(new Response(sample));
    const controller = new SessionController({
      database,
      parser,
      fetch: fetchSample,
      sampleUrlOverrides: { pcap: ['/assets/SkypeIRC.cap', '/assets/v6.pcap'] },
      stopViewer,
    });
    await controller.initialize();

    const opening = controller.openSample('pcap');
    await vi.waitFor(() => expect(parser.calls).toHaveLength(1));
    expect(fetchSample).toHaveBeenCalledTimes(2);
    expect(parser.calls[0]!.name).toBe('SkypeIRC.cap');
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0]!.finalizeResult = [{ name: 'packets', rowCount: 2 }];
    parser.calls[0]!.finish(streamedResult('packets', 1));
    await vi.waitFor(() => expect(parser.calls).toHaveLength(2));
    expect(parser.calls[1]!.name).toBe('v6.pcap');
    parser.calls[1]!.finish(streamedResult('packets', 1));
    await resolveFilesAppend(sessions[0]!);
    await opening;
  });
```

For the other two sample tests (≈lines 976 and 1070), make these edits in place:
- Delete the `demoUrl: '/assets/demo.mid',` line and add `sampleUrlOverrides: { midi: ['/assets/fur_Elise_opening.mid'] },` in the options object.
- Change `controller.openSample()` → `controller.openSample('midi')`.
- Change every `'demo.mid'` string in those two tests to `'fur_Elise_opening.mid'` (they appear in `parser.calls[0]!.name` and `controller.getSourceBlob(...)` assertions).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/session/controller.test.ts`
Expected: FAIL — `openSample` takes no argument / `sampleUrlOverrides` not an option / `demoUrl` still referenced by production code.

- [ ] **Step 3: Update the controller imports and options**

In `apps/web/src/lib/session/controller.ts`, remove the demo import (line 4):

```ts
// DELETE: import demoUrl from '../../assets/demo.mid?url';
```

Add the registry import near the other `./session/*` imports:

```ts
import { SAMPLES, type SampleDefinition, type SampleId } from './samples.js';
```

In `SessionControllerOptions`, remove `demoUrl?: string;` and add:

```ts
  /** Test override of per-sample asset URLs; production uses the samples.ts registry. */
  sampleUrlOverrides?: Partial<Record<SampleId, readonly string[]>>;
```

- [ ] **Step 4: Replace the controller fields**

Remove `private sampleBytes: Uint8Array | null = null;` (line 65) and `private readonly demoUrl: string;` (line 60). Add:

```ts
  private readonly sampleUrlOverrides: Partial<Record<SampleId, readonly string[]>> | undefined;
  private readonly sampleCache = new Map<string, Uint8Array>();
```

In the constructor, remove `this.demoUrl = options.demoUrl ?? demoUrl;` and add:

```ts
    this.sampleUrlOverrides = options.sampleUrlOverrides;
```

- [ ] **Step 5: Rewrite `openSample` and add the loader helpers**

Replace the whole `openSample()` method (lines 129–137) with:

```ts
  openSample(id: SampleId): Promise<void> {
    this.assertUsable();
    const definition = SAMPLES.find((sample) => sample.id === id);
    if (!definition) return Promise.reject(new Error(`Unknown sample: ${id}`));
    return this.initialize().then(() => this.loadSample(definition));
  }

  private async loadSample(definition: SampleDefinition): Promise<void> {
    const urls = this.sampleUrlOverrides?.[definition.id] ?? definition.files.map((file) => file.url);
    const entries: BatchEntry[] = [];
    for (const [index, file] of definition.files.entries()) {
      const bytes = await this.fetchSampleBytes(urls[index]!);
      if (this.disposed) throw disposedError();
      const blob = new Blob([bytes as BlobPart]);
      entries.push({ name: file.name, size: blob.size, blob });
    }
    return this.openBatch(entries);
  }

  private async fetchSampleBytes(url: string): Promise<Uint8Array> {
    const cached = this.sampleCache.get(url);
    if (cached) return cached;
    const response = await this.fetchSample(url, { signal: this.initializationAbort.signal });
    if (!response.ok) throw new Error('A bundled sample could not be loaded.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.sampleCache.set(url, bytes);
    return bytes;
  }
```

- [ ] **Step 6: Drop the init-time sample prefetch**

Replace `initializeOnce` (lines 210–221) with a version that no longer fetches a sample:

```ts
  private async initializeOnce(): Promise<void> {
    await Promise.all([
      this.database.initialize(),
      // Best-effort: reclaim any OPFS spill directories orphaned by a prior crashed session.
      // No generation is "kept" — a fresh controller never inherits an in-flight ingest.
      sweepSpillOrphans([]).catch(() => undefined),
    ]);
    if (this.disposed) throw disposedError();
  }
```

In `dispose` (line 193), remove `this.sampleBytes = null;` and add `this.sampleCache.clear();` in its place.

- [ ] **Step 7: Delete the old bundled MIDI asset**

```bash
cd ~/worktrees/byteql/feature+pcap-sample-picker
git rm apps/web/src/assets/demo.mid
```

- [ ] **Step 8: Run the controller tests to verify they pass**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/session/controller.test.ts`
Expected: PASS (all controller tests, including the three rewritten sample tests).

- [ ] **Step 9: Typecheck the web package**

Run: `pnpm --filter @byteql/web check`
Expected: no `svelte-check` errors (confirms no remaining `demoUrl`/`sampleBytes`/`demo.mid` references).

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/session/controller.ts apps/web/src/lib/session/controller.test.ts
git commit -m "feat(web): open named samples via lazy cached multi-file batch"
```

---

### Task 3: `SampleMenu` dropdown component

**Files:**
- Create: `apps/web/src/components/SampleMenu.svelte`
- Create: `apps/web/src/components/SampleMenu.test.ts`

**Interfaces:**
- Consumes: `SAMPLES`, `SampleId` from Task 1.
- Produces: `SampleMenu` with props `{ busy?: boolean; onselect: (id: SampleId) => void }`. Trigger button accessible name is exactly `Try sample` (the ▾ caret is decorative, `aria-hidden`).

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/components/SampleMenu.test.ts`:

```ts
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SampleMenu from './SampleMenu.svelte';

describe('SampleMenu', () => {
  afterEach(() => cleanup());

  it('keeps the menu closed until the trigger is clicked', () => {
    render(SampleMenu, { onselect: vi.fn() });
    const trigger = screen.getByRole('button', { name: 'Try sample' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens and lists both samples with pcap first', async () => {
    render(SampleMenu, { onselect: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Try sample' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'Network capture (pcap)',
      'MIDI song (.mid)',
    ]);
  });

  it('emits the chosen sample id and closes', async () => {
    const onselect = vi.fn();
    render(SampleMenu, { onselect });
    await fireEvent.click(screen.getByRole('button', { name: 'Try sample' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Network capture (pcap)' }));
    expect(onselect).toHaveBeenCalledWith('pcap');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('disables the trigger while busy', () => {
    render(SampleMenu, { onselect: vi.fn(), busy: true });
    expect((screen.getByRole('button', { name: 'Try sample' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @byteql/web exec vitest run src/components/SampleMenu.test.ts`
Expected: FAIL — cannot resolve `./SampleMenu.svelte`.

- [ ] **Step 3: Write the component** (mirrors `ViewerMenu.svelte`)

Create `apps/web/src/components/SampleMenu.svelte`:

```svelte
<script lang="ts">
  import { SAMPLES, type SampleId } from '../lib/session/samples.js';

  interface Props {
    busy?: boolean;
    onselect: (id: SampleId) => void;
  }

  let { busy = false, onselect }: Props = $props();
  let open = $state(false);

  function choose(id: SampleId): void {
    open = false;
    onselect(id);
  }
</script>

<div class="sample-menu">
  <button
    class="button button-secondary"
    type="button"
    disabled={busy}
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    Try sample <span aria-hidden="true">▾</span>
  </button>
  {#if open}
    <div class="sample-options" role="menu" aria-label="Sample files">
      {#each SAMPLES as sample (sample.id)}
        <button type="button" role="menuitem" onclick={() => choose(sample.id)}>{sample.label}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .sample-menu {
    position: relative;
    display: inline-block;
  }

  .sample-options {
    position: absolute;
    z-index: 10;
    top: calc(100% + 0.3rem);
    left: 0;
    min-width: 13rem;
    padding: 0.3rem;
    border: 1px solid var(--color-border);
    border-radius: 0.45rem;
    background: var(--color-surface-raised);
    box-shadow: 0 0.7rem 1.5rem rgb(0 0 0 / 18%);
  }

  .sample-options button {
    width: 100%;
    padding: 0.55rem 0.65rem;
    border: 0;
    border-radius: 0.3rem;
    text-align: left;
    background: transparent;
    cursor: pointer;
  }

  .sample-options button:hover,
  .sample-options button:focus-visible {
    background: var(--color-surface-hover);
  }
</style>
```

Note on the accessible name: the trigger's text is `Try sample ▾`, but the `▾` is inside an `aria-hidden="true"` span, so its accessible name computes to `Try sample` — matching the tests here and the Workbench test in Task 4.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @byteql/web exec vitest run src/components/SampleMenu.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/SampleMenu.svelte apps/web/src/components/SampleMenu.test.ts
git commit -m "feat(web): add Try sample dropdown menu"
```

---

### Task 4: Wire the picker into `EmptyState` and `Workbench`

**Files:**
- Modify: `apps/web/src/components/EmptyState.svelte` (import + `onsample` prop type + swap button for `SampleMenu`)
- Modify: `apps/web/src/components/Workbench.svelte:383` (pass the id through)
- Modify: `apps/web/src/components/Workbench.test.ts` (≈lines 71, 168–171)

**Interfaces:**
- Consumes: `SampleMenu` (Task 3), `SampleId` (Task 1), `controller.openSample(id)` (Task 2).
- Produces: `EmptyState` prop `onsample: (id: SampleId) => void`.

- [ ] **Step 1: Update the Workbench test (failing)**

In `apps/web/src/components/Workbench.test.ts`, the `openSample` mock (line 71) currently is `openSample = vi.fn(async () => undefined);`. Change it to accept an id:

```ts
  openSample = vi.fn(async (_id: string) => undefined);
```

Replace the assertion block (≈lines 168–171) that clicks `Try sample`:

```ts
    expect((screen.getByRole('button', { name: 'Try sample' }) as HTMLButtonElement).disabled).toBe(false);

    await fireEvent.click(screen.getByRole('button', { name: 'Try sample' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Network capture (pcap)' }));
    expect(controller.openSample).toHaveBeenCalledWith('pcap');
```

- [ ] **Step 2: Run the Workbench test to verify it fails**

Run: `pnpm --filter @byteql/web exec vitest run src/components/Workbench.test.ts`
Expected: FAIL — after clicking `Try sample` there is no `menuitem` yet (still a plain button), so the second click / assertion fails.

- [ ] **Step 3: Wire `EmptyState` to `SampleMenu`**

In `apps/web/src/components/EmptyState.svelte`:

Add the imports at the top of `<script>` (below the existing `BrandLockup` import):

```ts
  import SampleMenu from './SampleMenu.svelte';
  import type { SampleId } from '../lib/session/samples.js';
```

Change the `onsample` prop type in the `Props` interface from:

```ts
    onsample: () => void;
```

to:

```ts
    onsample: (id: SampleId) => void;
```

Replace the `Try sample` button element:

```svelte
      <button class="button button-secondary" type="button" disabled={busy} onclick={onsample}>
        Try sample
      </button>
```

with:

```svelte
      <SampleMenu {busy} onselect={onsample} />
```

- [ ] **Step 4: Pass the id through in `Workbench.svelte`**

At `apps/web/src/components/Workbench.svelte:383`, change:

```svelte
        onsample={() => perform(() => controller.openSample())}
```

to:

```svelte
        onsample={(id) => perform(() => controller.openSample(id))}
```

- [ ] **Step 5: Run the component tests to verify they pass**

Run: `pnpm --filter @byteql/web exec vitest run src/components/Workbench.test.ts src/components/EmptyState.test.ts`
Expected: PASS. (The existing `EmptyState` tests still pass: they pass `onsample: vi.fn()`, which satisfies the new signature, and none of them clicked `Try sample`.)

- [ ] **Step 6: Full web unit run + typecheck**

Run: `pnpm --filter @byteql/web test && pnpm --filter @byteql/web check`
Expected: all unit tests pass; no svelte-check errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/EmptyState.svelte apps/web/src/components/Workbench.svelte apps/web/src/components/Workbench.test.ts
git commit -m "feat(web): surface the sample picker in the empty state"
```

---

### Task 5: e2e coverage and deploy-gate check

**Files:**
- Modify: `apps/web/e2e/pcap.spec.ts` (append one test)

(No changelog: the repo has no `CHANGELOG.md`, and the project convention is to update one only if it exists.)

**Interfaces:**
- Consumes: `waitForAppReady`, `runSql` from `./support/app.js` (existing); the running app served from the e2e build (which bundles `src/assets/*`).

- [ ] **Step 1: Append the sample-picker e2e**

At the end of `apps/web/e2e/pcap.spec.ts`, add:

```ts
test('loads the bundled pcap sample as a two-file session from the picker', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);

  // Open the "Try sample" dropdown and pick the flagship pcap sample.
  await page.getByRole('button', { name: 'Try sample' }).click();
  await page.getByRole('menuitem', { name: 'Network capture (pcap)' }).click();

  // Both captures land in one multi-file session — the _files catalog lists both.
  await expect(page.getByRole('region', { name: 'Tables' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await runSql(page, 'select name from _files order by name');
  await expect(page.getByRole('gridcell', { name: 'SkypeIRC.cap' })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'v6.pcap' })).toBeVisible();

  // v6.pcap exercises the IPv6 + DNS path: a recognizable query name proves it parsed.
  await runSql(page, "select query_name from dns where query_name = 'www.wide.ad.jp'");
  await expect(page.getByRole('gridcell', { name: 'www.wide.ad.jp' })).toBeVisible();
});
```

- [ ] **Step 2: Run the pcap e2e spec**

Run: `pnpm --filter @byteql/web test:e2e pcap.spec.ts`
(The `test:e2e` runner forwards args to `playwright test`, so the trailing `pcap.spec.ts` filters to that file.)
Expected: PASS (all tests in `pcap.spec.ts`, including the new one).

- [ ] **Step 3: Run the bundle + Pages deploy gates against the design's guardrails**

Build and run the exact gates `release:pages` runs, to prove the new assets and `samples.ts` don't trip them:

```bash
cd ~/worktrees/byteql/feature+pcap-sample-picker
pnpm build
pnpm check:bundle
pnpm prepare:pages
pnpm verify:pages
```

Expected: `check:bundle` prints "Source URL audit: … passed" and "Bundle audit passed"; `verify:pages` prints "Pages artifact verified". A failure in `check:bundle` naming `samples.ts` means an external URL leaked into runtime source (fix per Global Constraints). Note: `prepare:pages`/`verify:pages` mutate `apps/web/dist` in place — discard afterward with `git -C apps/web checkout -- dist 2>/dev/null || true` and do not stage `dist`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/pcap.spec.ts
git commit -m "test(e2e): cover the pcap sample picker"
```

---

## Self-Review

**Spec coverage:**
- Samples chosen (SkypeIRC.cap + v6.pcap, Für Elise) → Task 1 assets + registry.
- Registry `samples.ts` (data-only, no external URLs) → Task 1.
- `openSample(id)` reusing `openBatch`, lazy cached fetch, no init prefetch → Task 2.
- Test injection via `fetch` stub + `sampleUrlOverrides` (demoUrl removed) → Task 2.
- Remove bundled `demo.mid`, keep fixtures → Task 2 Step 7 + Global Constraints.
- `SampleMenu` mirroring `ViewerMenu`, pcap first, accessible name `Try sample` → Task 3.
- `EmptyState`/`Workbench` wiring, `onsample: (id) => void` → Task 4.
- Deploy guardrails (no http(s) in source; don't touch `_headers`; 25 MiB) → Global Constraints + Task 5 Step 3 verifies.
- Tests: samples, controller, SampleMenu, EmptyState/Workbench, e2e → Tasks 1–5.
- Provenance → Task 1 Step 6. (No CHANGELOG — none exists in the repo.)
- Non-goal (no TLS/streams showcase) → respected; no task attempts it.

**Placeholder scan:** No TBD/TODO; every code step shows full code. The CHANGELOG bullet placement is conditional on the file's existing structure, which is a real formatting instruction, not a placeholder.

**Type consistency:** `SampleId`/`SampleDefinition`/`SampleFile`/`SAMPLES` defined in Task 1 and consumed unchanged in Tasks 2–4. `openSample(id: SampleId)` defined in Task 2, called with `'pcap'`/`'midi'` in Tasks 2/4/5. `SampleMenu` prop `onselect: (id: SampleId) => void` (Task 3) matches `EmptyState` `onsample` (Task 4). Trigger accessible name `Try sample` consistent across Tasks 3–5.
