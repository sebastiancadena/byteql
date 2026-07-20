# Design: pcap sample picker + Für Elise MIDI sample

Date: 2026-07-20
Status: Approved (pending written-spec review)
Branch: `worktree-feature+pcap-sample-picker`

## Problem

The empty-state "Try sample" button is hard-wired to a single bundled MIDI file
(`apps/web/src/assets/demo.mid`). ByteQL now ships rich pcap support (tables
`packets`, `ip`, `tcp`, `udp`, `dns`, `icmp`, `icmpv6`, `tls`, `streams`) and
multi-file sessions, but a first-time visitor has no one-click way to see pcap
querying. We also want a more engaging default MIDI than the current "dull" demo.

## Goals

- Let a visitor load a real network-capture sample in one click, exercising as
  many pcap tables as possible (IPv4 + IPv6 + DNS + ICMP/ICMPv6, cross-file).
- Replace the bundled MIDI sample with `fur_Elise_opening.mid`.
- Keep the change small, reuse existing ingest machinery, and respect the
  Cloudflare Pages deploy contract without modifying it.

## Non-goals

- No TLS/`streams` showcase from a real capture. Confirmed during research: every
  classic-libpcap file on the Wireshark wiki lacks TLS-over-443; all TLS traces
  there are pcapng, which ByteQL does not parse (`pcap.ksy` magic switch has no
  `0x0a0d0d0a`). ByteQL's `streams`/`tls` tables only populate for TCP/443 or
  TCP/53 flows. Demoing SNI-over-reassembly stays a synthetic-fixture concern and
  is out of scope here. (It is the motivating argument for a future pcapng-ingest
  feature, tracked separately.)
- No general "examples gallery". Just the sample picker.
- No changes to any `demo.mid` test/e2e/package fixture.

## Chosen samples (verified with tshark against the live captures)

Both are classic libpcap, linktype 1 (Ethernet) — fully supported by ByteQL's
`ethernet_frame → ipv4/ipv6` dissect chain.

- **`SkypeIRC.cap`** (~411 KB, IPv4, 2263 packets): 707 DNS queries, ICMP
  type 11/3 errors, IRC over TCP, Skype over UDP. Lights up `packets`, `ip`,
  `tcp`, `udp`, `dns`, `icmp`. Flagship / default.
- **`v6.pcap`** (~28 KB, IPv6-only, 161 packets): full ICMPv6 Neighbor Discovery
  + ping (types 133/134/135/136/128/129, errors 1/3), IPv6 DNS incl. `ip6.int`
  PTRs. Lights up the IPv6 branch of `ip`, plus `udp`, `dns`, `icmpv6`.

Loaded together as one multi-file session, they cover every pcap table except
`tls`/`streams`, and make `select _src_file, count(*) from packets group by 1` a
natural IPv4-vs-IPv6 demonstration of multi-file sessions.

- **`fur_Elise_opening.mid`** (945 B, Type-1 MIDI, 3 tracks, division 384):
  replaces `demo.mid` as the bundled MIDI sample.

## Architecture

### Sample registry (`apps/web/src/lib/session/samples.ts`, new)

A data-only module — the single source of truth for "what samples exist":

```ts
export type SampleId = 'pcap' | 'midi';

export interface SampleFile {
  name: string;   // filename shown in the _files catalog / hex switcher
  url: string;    // ?url asset import, resolved at build time
}

export interface SampleDefinition {
  id: SampleId;
  label: string;  // menu-item text
  files: readonly SampleFile[];
}

// pcap first ⇒ default/primary item in the menu
export const SAMPLES: readonly SampleDefinition[] = [ /* pcap, midi */ ];
```

Asset URLs come from relative `?url` imports (exactly like today's
`import demoUrl from '../../assets/demo.mid?url'`):
`SkypeIRC.cap`, `v6.pcap`, `fur_Elise_opening.mid` under `apps/web/src/assets/`.

**Deploy guardrail:** this file must contain **no `http(s)://` string** (not even
in comments). `check:bundle`'s source-URL audit scans runtime `.ts`/`.svelte`
and fails the build on any external URL. Provenance URLs live only in
`PROVENANCE.md` (`.md` is not scanned).

### Controller (`apps/web/src/lib/session/controller.ts`)

Generalise `openSample()` to `openSample(id: SampleId)`:

1. `await this.initialize()` (ensures the DB is ready) — replaces today's
   `if (!this.sampleBytes) …` guard.
2. Look up the `SampleDefinition` in `SAMPLES`.
3. For each `SampleFile`, fetch its `url` (via existing `this.fetchSample`,
   under the same abort-signal machinery) into bytes → `BatchEntry`
   `{ name, size, blob }`.
4. Delegate to the existing `openBatch(entries)` — unchanged. Multi-file is
   already supported (that is how dropping N files works).

**Fetch strategy: lazy-only, with a small in-memory cache keyed by URL** so a
second click is instant. This is a deliberate simplification of today's design:
the eager sample prefetch in `initializeOnce` (`sampleBytes` +
`fetchSample(demoUrl)`) is **removed**. Since the default sample is now pcap,
there is nothing worth prefetching at startup, and `initializeOnce` becomes
purely DB init + orphan sweep — it no longer depends on any bundled asset (the
"bundled demo MIDI could not be loaded" init failure path goes away; a
sample-fetch failure now surfaces only when a sample is actually chosen, via the
normal `perform()` error path). Samples are same-origin, content-hashed static
assets, so a first click's fetch is effectively instant and the button already
shows a busy state.

Loaded file names come from the registry (`fur_Elise_opening.mid`, `SkypeIRC.cap`,
`v6.pcap`) — not the literal `'demo.mid'` currently hardcoded at the `openBatch`
call site.

**Test injection:** the `demoUrl` option/field is removed. Tests already inject a
`fetch` stub via the `fetch` option to supply sample bytes; that stays. An
optional `sampleUrlOverrides?: Partial<Record<SampleId, readonly string[]>>`
option (default = registry URLs) lets a test assert/redirect the fetched URLs,
replacing the single-purpose `demoUrl`.

### UI

- **`apps/web/src/components/SampleMenu.svelte`** (new): dropdown mirroring the
  existing `ViewerMenu.svelte` pattern — a `button` labelled `Try sample ▾` with
  `aria-expanded`, an options container `role="menu"` with `role="menuitem"`
  entries rendered from `SAMPLES`, closing on select / Escape / click-outside.
  Emits `onselect(id: SampleId)`. pcap is first ⇒ visually the default.
- **`apps/web/src/components/EmptyState.svelte`**: replace the single
  `Try sample` button with `SampleMenu`. The `onsample` prop changes from
  `() => void` to `(id: SampleId) => void`.
- **`apps/web/src/components/Workbench.svelte`**: wire
  `onsample={(id) => perform(() => controller.openSample(id))}`.

### Assets & provenance

- Add `apps/web/src/assets/SkypeIRC.cap`, `apps/web/src/assets/v6.pcap`,
  `apps/web/src/assets/fur_Elise_opening.mid`.
- Remove `apps/web/src/assets/demo.mid` (the bundled UI sample only).
- Add `apps/web/src/assets/PROVENANCE.md` recording: the two pcaps
  (Wireshark wiki SampleCaptures, with source URLs + note that redistribution
  follows the wiki's terms) and the MIDI (Beethoven *Für Elise*, public-domain
  composition; MIDI file user-supplied). Follows the
  `packages/formats/pcap/network/PROVENANCE.md` pattern.
- Update `CHANGELOG.md`.

## Data flow

Click `Try sample ▾` → choose `Network capture (pcap)` →
`controller.openSample('pcap')` → fetch `SkypeIRC.cap` + `v6.pcap` `?url` assets →
`openBatch([...])` → existing multi-file ingest → `_files` catalog shows both
files; `ip` populates v4 (Skype/IRC) and v6 (6bone); `dns`, `icmp`, `icmpv6`
populate. Identical path to a user dropping the two files by hand.

## Error handling

Fetch failure propagates through the existing `perform()` → `EmptyState error`
surface, the same path as a failed `initializeOnce`. No new error surface.

## Deploy impact

`release:pages` = `check` → `check:bundle` → `prepare-pages-artifact` →
`verify-pages-artifact` → `wrangler pages deploy`. No pipeline change needed; the
design respects three hard constraints:

1. **`check:bundle` source-URL audit** fails on any `http(s)://` in runtime
   source → provenance URLs only in `PROVENANCE.md`; asset imports are relative.
2. **`verify-pages-artifact` 25 MiB per-file limit** — all three assets are far
   under; no file-type allowlist, so extra binaries pass.
3. **`_headers` exact-equality check** — pcap/MIDI need no header entry (fetched
   as `arrayBuffer`; Vite content-hashes them into `dist/assets/`; MIME is
   irrelevant to parsing). The design must **not** touch `_headers`.

Transparent: the JS 5 MiB size gate applies only to `.js` chunks (pcaps class as
"Other"); `prepare-pages-artifact` only gzips `.wasm`. Net artifact delta ≈
+440 KB (pcaps) − demo.mid.

## Testing

- `samples.test.ts` (new): registry shape and order (pcap first; expected file
  names/counts per entry).
- `controller.test.ts`: `openSample('pcap')` builds a 2-entry batch;
  `openSample('midi')` a 1-entry batch named `fur_Elise_opening.mid`. Update the
  sample-specific assertions (~lines 292–305, 982–990, 1076–1090) and drop/adjust
  any that assert an init-time sample fetch or set `demoUrl` (init no longer
  fetches a sample; injection is via the `fetch` stub / `sampleUrlOverrides`). The
  other `demo.mid` occurrences are arbitrary batch-entry names in unrelated
  multi-file tests and stay.
- `SampleMenu.test.ts` (new) / `EmptyState.test.ts`: menu opens, lists both
  entries, selecting emits the right id; update the existing `Try sample`
  assertion.
- e2e (`apps/web/e2e/pcap.spec.ts` or a small sample spec): click menu → pcap →
  assert `_files` has 2 rows and `dns` / `icmpv6` populate.
- Leave `packages/formats/midi` and `apps/web/e2e/fixtures` `demo.mid` fixtures
  untouched (they assert distinct parse properties, e.g. PPQN 480).

## Files touched

New: `samples.ts`, `SampleMenu.svelte`, `samples.test.ts`, `SampleMenu.test.ts`,
`assets/SkypeIRC.cap`, `assets/v6.pcap`, `assets/fur_Elise_opening.mid`,
`assets/PROVENANCE.md`.
Modified: `controller.ts`, `EmptyState.svelte`, `Workbench.svelte`,
`controller.test.ts`, `EmptyState.test.ts`, `pcap.spec.ts` (or new e2e),
`CHANGELOG.md`.
Removed: `assets/demo.mid`.
