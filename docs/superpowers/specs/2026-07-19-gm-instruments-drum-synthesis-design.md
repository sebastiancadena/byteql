# GM instruments + drum-channel synthesis for MIDI playback

**Date:** 2026-07-19
**Status:** Approved, pending implementation plan

## Problem

The MIDI audio viewer plays every channel through a single generic
`Tone.PolySynth(Tone.Synth)` and treats General MIDI channel 9
(percussion) as pitched notes. As a result a multi-instrument file does
not sound like itself:

- **Instruments are ignored.** The `play_all` / `drums` / `bassline`
  queries never emit the `program` column, and `tone-engine.ts` builds an
  identical synth for every channel — its `channel` argument is discarded.
  Bass, piano, guitar, and choir all come out as the same timbre.
- **The drum track plays as pitches.** In General MIDI, channel 9 is
  percussion: the note number selects a drum sound, not a pitch. The
  player renders those note-ons as melodic notes, so the drum part becomes
  a stream of random-sounding pitches layered over everything.

Reference file `the_winner_takes_it_all.mid` (Format 1, 7 tracks,
division 480) exercises both problems: 5 distinct GM programs
(channels 3/4/5/8/9 → programs 35/3/25/52/32) and **1,267 note-ons on
channel 9**.

## Hard constraints

- **No external hosts.** `scripts/check-worker-privacy.mjs` asserts the
  worker issues zero network requests; `scripts/check-bundle.mjs` bans
  `https://` / `cdn.jsdelivr` / `unpkg` references. A hosted GM soundfont
  is therefore impossible.
- **Bundle budget.** `check-bundle.mjs` caps runtime JavaScript at 5 MiB.
  A bundled sample bank would blow it.
- **Consequence:** instruments must be **synth approximations** produced
  entirely by local Tone.js nodes — no samples, no new dependencies. The
  result is audibly distinct instrument families and real-sounding drums,
  not a soundfont-accurate render. This is an accepted, explicit tradeoff.

## Architecture

Three independently-testable layers plus viewer plumbing, matching the
existing find → map → play split.

### 1. Query layer — resolve each note's active instrument

Source: `packages/formats/midi/queries.yaml`, regenerated to
`packages/formats/midi/src/midi-queries.generated.ts` via
`packages/formats/midi/scripts/generate-pack.mjs`. **Edit the YAML and
regenerate; never hand-edit the generated file.**

Add a `program_map` CTE to the three `playback` queries (`play_all`,
`drums`, `bassline`). It selects every `kind = 'program_change'` event as
`(channel, tick, program)`. Each note then resolves its instrument with a
per-channel asof join, mirroring the existing tempo map:

```sql
program_map as (
  select channel, tick, program
  from events
  where kind = 'program_change' and program is not null
)
...
asof join program_map pm on e.channel = pm.channel and e.tick >= pm.tick
```

- Because asof join drops rows with no match, use a **LEFT asof join** so
  notes that sound before any program change on their channel are kept;
  their `program` resolves to `null`.
- New output column: `program` (0–127, or `null`). `null` is treated
  downstream as program 0 (Acoustic Grand Piano).
- Existing output columns (`seconds, note, velocity, kind, channel`) are
  unchanged, so the audio-capability match and every other consumer keep
  working.

Regenerate and confirm `midi-queries.generated.ts` reflects the new SQL.

### 2. GM voice map — new pure module

New file: `apps/web/src/lib/viewers/gm-voices.ts`. Pure functions, no Tone
import, so it is unit-testable without an audio context.

- `gmFamily(program: number): GmFamily` — maps 0–127 to **8 families**
  using General MIDI's standard 8-program bands, grouped as:
  - `piano` (0–7)
  - `organ` (8–23: chromatic percussion + organ)
  - `guitar` (24–31)
  - `bass` (32–39)
  - `strings` (40–55: strings + ensemble)
  - `brass` (56–63)
  - `reed` (64–79: reed + pipe)
  - `synth` (80–127: synth lead/pad/effects/ethnic/percussive/sfx)

  Out-of-range or non-integer input clamps to `piano`.
- `melodicVoiceSpec(family: GmFamily): VoiceSpec` — returns a
  `{ oscillator, envelope }` config per family (e.g. bass → triangle +
  short release; strings → sawtooth + slow attack; brass → square +
  medium attack). Values are plain data consumed by the engine's Tone
  factory.
- `drumVoiceSpec(note: number): DrumVoice` — maps GM drum notes (35–81) to
  `'kick' | 'snare' | 'hat' | 'tom' | 'cymbal'`, with a documented fallback
  (`kick` for < 35, `tom` for > 81) so every note produces a sound.

### 3. Engine layer — `tone-engine.ts`

- `AudioRow` gains `program: number | null`.
- **Routing per note:** `channel === 9` → drum voice (GM percussion
  convention); otherwise → melodic voice selected by
  `gmFamily(program ?? 0)`.
- **Voice keys:** voices are keyed by `(channel, voiceType)` where
  `voiceType` is `'drum'` for channel 9 or the `GmFamily` id otherwise.
  A mid-song program change on a channel therefore spawns the correct new
  timbre rather than being ignored.
- **Note-off correctness:** `activeNotes` changes from a per-key **count**
  to remembering **which `SynthPort` each active `(channel:note)` was
  triggered on** (with overlap count). `note_off` releases on the exact
  synth that attacked the note, preserving the existing interleaved
  same-pitch guarantee even when a program change occurs between a note's
  on and off.
- **Drum voice:** `triggerAttack(note, time, velocity)` selects the
  internal percussion node by `drumVoiceSpec(note)` — `MembraneSynth`
  (kick/tom), `NoiseSynth` (snare/hat), `MetalSynth` (cymbal) — and fires a
  one-shot. `triggerRelease` is a no-op; `releaseAll` silences any ringing
  nodes.
- **DI seam:** replace `createSynth(channel)` in `ToneEngineDependencies`
  with `createMelodicVoice(spec: VoiceSpec): SynthPort` and
  `createDrumVoice(): SynthPort`. The local implementation builds the
  matching Tone nodes; `tone-engine.test.ts` fakes update to the new seam.

### 4. Viewer plumbing — `AudioViewer.svelte` and `registry.ts`

- `parseRows` reads the optional `program` column: `numeric(...)`
  validated to an integer in 0–127, else `null`. A missing column yields
  `null` for every row (melodic default). `program` is **not** part of the
  row-validity gate — an invalid/absent program never discards a row.
- `registry.ts` `audioCapability.accepts` is unchanged; `program` is
  optional and does not affect viewer matching, so non-MIDI packs that
  feed the audio viewer keep working.

## Data flow

```text
events table (with program_change rows)
  → SQL playback query (asof join program_map) → rows with `program`
  → AudioViewer.parseRows → AudioRow[] { seconds, note, velocity, kind, channel, program }
  → ToneAudioEngine: per-note routing
       channel 9 → createDrumVoice() → drumVoiceSpec(note) → percussion node
       else      → createMelodicVoice(melodicVoiceSpec(gmFamily(program))) → tuned synth
```

## Testing

- `gm-voices.test.ts` (new): family boundaries (programs 0, 7, 8, 31, 32,
  55, 79, 80, 127), out-of-range clamp, drum-note mapping including the
  35–81 range and both fallbacks.
- `tone-engine.test.ts` (updated): channel 9 routes to the drum voice and
  ignores `note_off`; a note's `program` selects the correct melodic
  family; `note_off` releases on the synth that attacked the note across a
  mid-note program change; existing interleaved same-pitch and null-channel
  behavior still holds under the new seam.
- MIDI pack tests: regenerated queries emit a `program` column; against the
  reference file, channel-9 rows carry their program but route to drums,
  and channels 3/4/5/8 resolve programs 35/3/25/52.

## Out of scope

- Sample-based / soundfont playback (blocked by constraints).
- Per-program hand-tuned patches (family grouping chosen instead).
- Control-change expression (volume, pan, sustain pedal, pitch bend) —
  playback still uses note/velocity only.
- Melodic channels other than 9 that a file might repurpose as drums via
  non-GM conventions; channel 9 is the sole percussion route.
