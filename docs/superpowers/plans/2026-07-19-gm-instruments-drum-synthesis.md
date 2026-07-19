# GM instruments + drum-channel synthesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MIDI audio viewer render each channel with a
General-MIDI-appropriate instrument timbre and play channel 9 as drums
instead of pitched notes.

**Architecture:** Three independently-testable layers plus viewer
plumbing. (1) The playback SQL queries resolve each note's active program
with a per-channel ASOF join. (2) A new pure `gm-voices.ts` module maps GM
programs to 8 instrument families and GM drum notes to percussion voices.
(3) The Tone engine routes each note to a melodic voice (by family) or a
drum voice (channel 9), converting MIDI note numbers to frequency.

**Tech Stack:** TypeScript, Svelte 5, Tone.js 15, DuckDB (via generated
SQL), Vitest, Playwright.

## Global Constraints

- **Node** >= 22.12.0; package manager is **pnpm** with workspaces.
- **No external hosts.** No `https://`, `cdn.jsdelivr`, or `unpkg`
  references in shipped code (`apps/web/scripts/check-bundle.mjs`
  enforces). The audio worker must issue zero network requests
  (`apps/web/scripts/check-worker-privacy.mjs`).
- **No new runtime dependencies.** Use only Tone.js nodes already bundled
  (`Synth`, `PolySynth`, `MembraneSynth`, `NoiseSynth`, `MetalSynth`,
  `Frequency`).
- **Runtime JS budget** 5 MiB (`check-bundle.mjs`). No sample assets.
- **Generated files are not hand-edited.** `midi-queries.generated.ts` is
  produced from `queries.yaml` by
  `packages/formats/midi/scripts/generate-pack.mjs`.
- **Commit style:** Conventional Commits. No `Co-Authored-By`, no AI-assistant
  branding.
- **Update `CHANGELOG.md`** if one exists at commit time.

---

## File Structure

- Create: `apps/web/src/lib/viewers/gm-voices.ts` — pure GM program→family
  and drum-note→voice mapping, plus per-family synth specs. No Tone import.
- Create: `apps/web/src/lib/viewers/gm-voices.test.ts` — unit tests for the
  mapping module.
- Modify: `packages/formats/midi/queries.yaml` — add `program_map` CTE and
  `program` output column to the three `playback` queries.
- Modify (generated, via script): `packages/formats/midi/src/midi-queries.generated.ts`.
- Modify: `apps/web/src/lib/viewers/tone-engine.ts` — `AudioRow.program`,
  new DI seam, voice routing, note-off synth tracking, local Tone
  implementation with MIDI→Hz melodic voices and drum synthesis.
- Modify: `apps/web/src/lib/viewers/tone-engine.test.ts` — update fakes to
  the new seam; add routing and note-off-across-program-change tests.
- Modify: `apps/web/src/components/AudioViewer.svelte` — read the optional
  `program` column in `parseRows`.
- Modify: `apps/web/src/components/AudioViewer.test.ts` — add `program` to
  expected rows; add a program-column test.

---

## Task 1: GM voice mapping module

**Files:**

- Create: `apps/web/src/lib/viewers/gm-voices.ts`
- Test: `apps/web/src/lib/viewers/gm-voices.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type GmFamily = 'piano' | 'organ' | 'guitar' | 'bass' | 'strings' | 'brass' | 'reed' | 'synth'`
  - `type DrumVoice = 'kick' | 'snare' | 'hat' | 'tom' | 'cymbal'`
  - `interface VoiceSpec { oscillator: { type: 'triangle' | 'sawtooth' | 'square' | 'sine' }; envelope: { attack: number; decay: number; sustain: number; release: number } }`
  - `function gmFamily(program: number): GmFamily`
  - `function melodicVoiceSpec(family: GmFamily): VoiceSpec`
  - `function drumVoiceSpec(note: number): DrumVoice`
- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/viewers/gm-voices.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { drumVoiceSpec, gmFamily, melodicVoiceSpec } from './gm-voices.js';

describe('gmFamily', () => {
  it('maps GM program bands to families', () => {
    expect(gmFamily(0)).toBe('piano');
    expect(gmFamily(7)).toBe('piano');
    expect(gmFamily(8)).toBe('organ');
    expect(gmFamily(23)).toBe('organ');
    expect(gmFamily(24)).toBe('guitar');
    expect(gmFamily(31)).toBe('guitar');
    expect(gmFamily(32)).toBe('bass');
    expect(gmFamily(39)).toBe('bass');
    expect(gmFamily(40)).toBe('strings');
    expect(gmFamily(55)).toBe('strings');
    expect(gmFamily(56)).toBe('brass');
    expect(gmFamily(63)).toBe('brass');
    expect(gmFamily(64)).toBe('reed');
    expect(gmFamily(79)).toBe('reed');
    expect(gmFamily(80)).toBe('synth');
    expect(gmFamily(127)).toBe('synth');
  });

  it('clamps out-of-range or non-integer programs to piano', () => {
    expect(gmFamily(-1)).toBe('piano');
    expect(gmFamily(128)).toBe('piano');
    expect(gmFamily(1.5)).toBe('piano');
    expect(gmFamily(Number.NaN)).toBe('piano');
  });
});

describe('melodicVoiceSpec', () => {
  it('returns a distinct, well-formed spec for every family', () => {
    const families = [
      'piano', 'organ', 'guitar', 'bass', 'strings', 'brass', 'reed', 'synth',
    ] as const;
    for (const family of families) {
      const spec = melodicVoiceSpec(family);
      expect(['triangle', 'sawtooth', 'square', 'sine']).toContain(spec.oscillator.type);
      expect(spec.envelope.attack).toBeGreaterThanOrEqual(0);
      expect(spec.envelope.sustain).toBeGreaterThanOrEqual(0);
      expect(spec.envelope.sustain).toBeLessThanOrEqual(1);
    }
    expect(melodicVoiceSpec('strings').oscillator.type).toBe('sawtooth');
    expect(melodicVoiceSpec('bass').oscillator.type).toBe('triangle');
  });
});

describe('drumVoiceSpec', () => {
  it('maps standard GM drum notes to percussion voices', () => {
    expect(drumVoiceSpec(35)).toBe('kick');
    expect(drumVoiceSpec(36)).toBe('kick');
    expect(drumVoiceSpec(38)).toBe('snare');
    expect(drumVoiceSpec(40)).toBe('snare');
    expect(drumVoiceSpec(42)).toBe('hat');
    expect(drumVoiceSpec(46)).toBe('hat');
    expect(drumVoiceSpec(45)).toBe('tom');
    expect(drumVoiceSpec(50)).toBe('tom');
    expect(drumVoiceSpec(49)).toBe('cymbal');
    expect(drumVoiceSpec(51)).toBe('cymbal');
  });

  it('falls back for out-of-range drum notes and unlisted in-range notes', () => {
    expect(drumVoiceSpec(34)).toBe('kick'); // below 35
    expect(drumVoiceSpec(82)).toBe('tom'); // above 81
    expect(drumVoiceSpec(60)).toBe('hat'); // in-range but unlisted
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/viewers/gm-voices.test.ts`
Expected: FAIL — cannot resolve `./gm-voices.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/viewers/gm-voices.ts`:

```ts
export type GmFamily =
  | 'piano'
  | 'organ'
  | 'guitar'
  | 'bass'
  | 'strings'
  | 'brass'
  | 'reed'
  | 'synth';

export type DrumVoice = 'kick' | 'snare' | 'hat' | 'tom' | 'cymbal';

export interface VoiceSpec {
  oscillator: { type: 'triangle' | 'sawtooth' | 'square' | 'sine' };
  envelope: { attack: number; decay: number; sustain: number; release: number };
}

// General MIDI groups its 128 programs into 16 families of 8. We collapse
// those into 8 broader families that map cleanly onto distinct synth timbres.
export function gmFamily(program: number): GmFamily {
  if (!Number.isInteger(program) || program < 0 || program > 127) return 'piano';
  if (program <= 7) return 'piano';
  if (program <= 23) return 'organ';
  if (program <= 31) return 'guitar';
  if (program <= 39) return 'bass';
  if (program <= 55) return 'strings';
  if (program <= 63) return 'brass';
  if (program <= 79) return 'reed';
  return 'synth';
}

const MELODIC_VOICES: Record<GmFamily, VoiceSpec> = {
  piano: { oscillator: { type: 'triangle' }, envelope: { attack: 0.005, decay: 0.3, sustain: 0.2, release: 0.8 } },
  organ: { oscillator: { type: 'sine' }, envelope: { attack: 0.01, decay: 0.05, sustain: 0.9, release: 0.2 } },
  guitar: { oscillator: { type: 'triangle' }, envelope: { attack: 0.005, decay: 0.4, sustain: 0.1, release: 0.4 } },
  bass: { oscillator: { type: 'triangle' }, envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.3 } },
  strings: { oscillator: { type: 'sawtooth' }, envelope: { attack: 0.15, decay: 0.2, sustain: 0.8, release: 0.6 } },
  brass: { oscillator: { type: 'square' }, envelope: { attack: 0.05, decay: 0.1, sustain: 0.7, release: 0.3 } },
  reed: { oscillator: { type: 'sawtooth' }, envelope: { attack: 0.08, decay: 0.1, sustain: 0.7, release: 0.3 } },
  synth: { oscillator: { type: 'square' }, envelope: { attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.4 } },
};

export function melodicVoiceSpec(family: GmFamily): VoiceSpec {
  return MELODIC_VOICES[family];
}

// Standard GM percussion key map (channel 10 / index 9). Notes not listed
// here map to the nearest reasonable voice via drumVoiceSpec's fallbacks.
const DRUM_MAP: Record<number, DrumVoice> = {
  35: 'kick', 36: 'kick',
  37: 'snare', 38: 'snare', 39: 'snare', 40: 'snare',
  41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom',
  42: 'hat', 44: 'hat', 46: 'hat',
  49: 'cymbal', 51: 'cymbal', 52: 'cymbal', 53: 'cymbal', 55: 'cymbal', 57: 'cymbal', 59: 'cymbal',
};

export function drumVoiceSpec(note: number): DrumVoice {
  if (!Number.isInteger(note) || note < 35) return 'kick';
  if (note > 81) return 'tom';
  return DRUM_MAP[note] ?? 'hat';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/viewers/gm-voices.test.ts`
Expected: PASS (3 describe blocks, all assertions green).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/viewers/gm-voices.ts apps/web/src/lib/viewers/gm-voices.test.ts
git commit -m "feat(web): add GM program-to-family and drum-note voice mapping"
```

---

## Task 2: Resolve each note's program in the playback queries

**Files:**

- Modify: `packages/formats/midi/queries.yaml` (queries `play_all`, `drums`, `bassline`)
- Modify (generated): `packages/formats/midi/src/midi-queries.generated.ts`

**Interfaces:**

- Consumes: `events` table columns `channel`, `tick`, `program`, `note`,
  `kind` (already present; `program` is populated on `kind='program_change'`
  rows).
- Produces: each `playback` query now selects a `program` column
  (0–127 or `null`) in addition to `seconds, note, velocity, kind, channel`.

**Background (verified with DuckDB 1.4.4):** a second `ASOF LEFT JOIN`
resolves each note's active program per channel and coexists with the
existing tempo `ASOF JOIN`. LEFT is required so notes with no prior
program change on their channel are kept with `program = NULL`.

- [ ] **Step 1: Edit `queries.yaml` — add the CTE and column to `play_all`**

In `packages/formats/midi/queries.yaml`, in the `play_all` query, the CTE
chain currently ends with the `tempo_map` CTE like this:

```text
      ), tempo_map as (
        select tick,
               us_per_quarter,
               sum((tick - previous_tick) * previous_tempo / h.division / 1000000.0)
                 over (order by tick rows unbounded preceding) as seconds_at_tick
        from boundaries
        cross join header h
      )
      select case
```

Change the closing of `tempo_map` and the SELECT to add `program_map` and
the `program` column (note the `)` after `tempo_map`'s body becomes `),`):

```text
      ), tempo_map as (
        select tick,
               us_per_quarter,
               sum((tick - previous_tick) * previous_tempo / h.division / 1000000.0)
                 over (order by tick rows unbounded preceding) as seconds_at_tick
        from boundaries
        cross join header h
      ), program_map as (
        select channel, tick, program
        from events
        where kind = 'program_change' and program is not null
      )
      select case
               when h.division > 0 then
                 tm.seconds_at_tick
                   + (e.tick - tm.tick) * tm.us_per_quarter / h.division / 1000000.0
             end as seconds,
             e.note, e.velocity, e.kind, e.channel, pm.program
      from events e
      asof join tempo_map tm on e.tick >= tm.tick
      asof left join program_map pm on e.channel = pm.channel and e.tick >= pm.tick
      cross join header h
      where e.note is not null
      order by seconds, e.event_id
      limit 100000;
```

- [ ] **Step 2: Apply the identical CTE + join + column change to `drums` and `bassline`**

Both queries share the same CTE chain and SELECT shape as `play_all`,
differing only in their `where` clause (`drums` adds `and e.channel = 9`;
`bassline` adds `and e.note < 48`). Make the same three edits to each:

1. Add the `, program_map as (...)` CTE after `tempo_map`.
2. Add `, pm.program` to the SELECT list.
3. Add the `asof left join program_map pm on e.channel = pm.channel and e.tick >= pm.tick`
   line immediately after the existing `asof join tempo_map ...` line.
Leave each query's own `where` and `order by` untouched.

- [ ] **Step 3: Regenerate the pack**

Run: `pnpm --filter @byteql/midi build`
(If the pack has a dedicated generate script wired separately, also run
`node packages/formats/midi/scripts/generate-pack.mjs` — the build script
invokes it. Check `packages/formats/midi/package.json` `scripts` if unsure.)

- [ ] **Step 4: Verify the generated queries contain the new SQL**

Run:

```bash
grep -c "program_map" packages/formats/midi/src/midi-queries.generated.ts
grep -c "asof left join program_map" packages/formats/midi/src/midi-queries.generated.ts
grep -c "e.channel, pm.program" packages/formats/midi/src/midi-queries.generated.ts
```

Expected: each prints `3` (one per playback query: `play_all`, `drums`,
`bassline`).

- [ ] **Step 5: Run the MIDI pack tests**

Run: `pnpm --filter @byteql/midi test`
Expected: PASS (no query regressions; generated file compiles).

- [ ] **Step 6: Commit**

```bash
git add packages/formats/midi/queries.yaml packages/formats/midi/src/midi-queries.generated.ts
git commit -m "feat(midi): resolve each note's active program in playback queries"
```

---

## Task 3: Route notes to GM instrument and drum voices in the engine

**Files:**

- Modify: `apps/web/src/lib/viewers/tone-engine.ts`
- Test: `apps/web/src/lib/viewers/tone-engine.test.ts`

**Interfaces:**

- Consumes: `gmFamily`, `melodicVoiceSpec`, `drumVoiceSpec`, `VoiceSpec`,
  `GmFamily`, `DrumVoice` from `./gm-voices.js` (Task 1).
- Produces:
  - `AudioRow` gains `program: number | null`.
  - `ToneEngineDependencies` replaces `createSynth(channel: number | null): SynthPort`
    with `createMelodicVoice(spec: VoiceSpec): SynthPort` and
    `createDrumVoice(): SynthPort`.
  - `SynthPort` interface is unchanged
    (`triggerAttack(note, time, velocity)`, `triggerRelease(note, time)`,
    `releaseAll()`, `dispose()`), where `note` is a MIDI note number.
- [ ] **Step 1: Update the existing engine tests to the new seam (still passing behavior)**

In `apps/web/src/lib/viewers/tone-engine.test.ts`:

1. Add `program: null` to every `AudioRow` literal. For example the shared
   `rows` fixture becomes:

```ts
const rows: readonly AudioRow[] = [
  { seconds: 0.5, note: 60, velocity: 64, kind: 'note_on', channel: 0, program: null },
  { seconds: 1.25, note: 60, velocity: 0, kind: 'note_off', channel: 0, program: null },
];
```

Apply the same `program: null` addition to the inline row arrays in the
"interleaved same-pitch" and "null-channel" tests.

2. Replace the `setup` helper's synth wiring. The fakes are now keyed by a
   voice key string instead of channel. Replace the `createSynth` factory
   and `synthFor` helper with:

```ts
function setup(startAudio: () => Promise<void> = async () => undefined) {
  const transport = new FakeTransport();
  const synths = new Map<string, SynthPort>();
  const makeSynth = (key: string): SynthPort => {
    const synth: SynthPort = {
      triggerAttack: vi.fn(),
      triggerRelease: vi.fn(),
      releaseAll: vi.fn(),
      dispose: vi.fn(),
    };
    synths.set(key, synth);
    return synth;
  };
  const dependencies: ToneEngineDependencies = {
    startAudio: vi.fn(startAudio),
    createMelodicVoice: vi.fn((spec) => makeSynth(`melodic:${spec.oscillator.type}`)),
    createDrumVoice: vi.fn(() => makeSynth('drum')),
    transport,
  };
  const synthFor = (key: string): SynthPort => {
    const synth = synths.get(key);
    if (!synth) throw new Error(`No synth was created for key ${key}.`);
    return synth;
  };
  return { engine: new ToneAudioEngine(dependencies), transport, synthFor, synths, dependencies };
}
```

3. Update assertions that referenced `createSynth`/`synthFor(channel)`.
   All existing fixtures use `program: null`, so `gmFamily(0)` → `piano` →
   `melodicVoiceSpec('piano').oscillator.type` is `'triangle'`. The melodic
   synth key is therefore `melodic:triangle`. Update the two impacted tests:

   - "starts audio only from play …": replace
     `expect(dependencies.createSynth).not.toHaveBeenCalled();` with
     `expect(dependencies.createMelodicVoice).not.toHaveBeenCalled();`;
     replace `expect(dependencies.createSynth).toHaveBeenCalledOnce();` and
     `expect(dependencies.createSynth).toHaveBeenCalledWith(0);` with
     `expect(dependencies.createMelodicVoice).toHaveBeenCalledOnce();`;
     replace `synthFor(0)` with `synthFor('melodic:triangle')`.
   - "removes completed timeline events …", "clears fired and pending …",
     "releases notes and clears every callback …",
     "pauses, seeks, stops, and disposes …": replace every `synthFor(0)`
     with `synthFor('melodic:triangle')`.
   - "releases interleaved same-pitch notes through their own channel
     synths": channels 0 and 1 both use `program: null` → both map to
     `melodic:triangle`, i.e. **the same** synth now (voice keyed by
     `channel:family`, so channel 0 → `0:piano`, channel 1 → `1:piano` are
     still distinct synths). Keep them distinct by keying the fake per
     voice key including channel — see Step 3's `voiceKeyFor`. Update this
     test to assert on distinct per-channel keys once the engine is
     implemented (revisit after Step 3); for now change `synthFor(0)`→
     `synthFor('0:melodic:triangle')` and `synthFor(1)`→
     `synthFor('1:melodic:triangle')` and update the fake key accordingly
     (Step 3 finalizes the exact key string — align this test to it).
   - "keeps null-channel rows in their own synth domain …": null channel →
     key `none:melodic:triangle`; channel 0 → `0:melodic:triangle`.
   - the two "pending play" tests: replace
     `expect(dependencies.createSynth).not.toHaveBeenCalled();` with
     `expect(dependencies.createMelodicVoice).not.toHaveBeenCalled();` and
     `expect(dependencies.createSynth).toHaveBeenCalledOnce();` with
     `expect(dependencies.createMelodicVoice).toHaveBeenCalledOnce();`.

   Note: the fake's `makeSynth(key)` in Step 1 must use the **same** key
   string the engine passes conceptually. Since the fake only sees the
   `spec` (melodic) or nothing (drum), include the channel by having the
   engine own the map and the fake key on `spec.oscillator.type` only, then
   assert per-channel separation via call counts. To keep per-channel
   assertions working, change `createMelodicVoice` fake to also record
   creation order; simplest is to assert on `synths` map size and
   `triggerAttack` call targets. Concretely, finalize this test in Step 4
   after the engine keys are known.

- [ ] **Step 2: Add new failing tests for drum routing and program families**

Append these tests inside the `describe('ToneAudioEngine', …)` block:

```ts
it('routes channel 9 notes to a drum voice and ignores note-off release', async () => {
  const { engine, transport, synthFor, dependencies } = setup();
  await engine.load([
    { seconds: 0, note: 36, velocity: 100, kind: 'note_on', channel: 9, program: null },
    { seconds: 0.2, note: 36, velocity: 0, kind: 'note_off', channel: 9, program: null },
  ]);
  await engine.play();
  transport.run(0);
  transport.run(0.2);

  expect(dependencies.createDrumVoice).toHaveBeenCalledOnce();
  expect(dependencies.createMelodicVoice).not.toHaveBeenCalled();
  const drum = synthFor('drum');
  expect(drum.triggerAttack).toHaveBeenCalledWith(36, 0, 100 / 127);
  expect(drum.triggerRelease).not.toHaveBeenCalled();
});

it('selects a melodic voice from the note program family', async () => {
  const { engine, dependencies } = setup();
  await engine.load([
    { seconds: 0, note: 40, velocity: 100, kind: 'note_on', channel: 3, program: 48 },
  ]);
  await engine.play();

  // program 48 → 'strings' → sawtooth oscillator
  expect(dependencies.createMelodicVoice).toHaveBeenCalledWith(
    expect.objectContaining({ oscillator: { type: 'sawtooth' } }),
  );
});

it('releases a note on the synth that attacked it across a program change', async () => {
  const { engine, transport, dependencies, synths } = setup();
  await engine.load([
    { seconds: 0, note: 60, velocity: 100, kind: 'note_on', channel: 3, program: 0 }, // piano/triangle
    { seconds: 0.5, note: 60, velocity: 0, kind: 'note_off', channel: 3, program: 40 }, // strings/sawtooth
  ]);
  await engine.play();
  transport.run(0);
  transport.run(0.5);

  const attacker = synths.get('3:piano');
  const other = synths.get('3:strings');
  expect(attacker?.triggerAttack).toHaveBeenCalledWith(60, 0, 100 / 127);
  expect(attacker?.triggerRelease).toHaveBeenCalledWith(60, 0.5);
  // the later-program voice must not receive the release for a note it never attacked
  expect(other?.triggerRelease ?? (() => undefined)).not.toHaveBeenCalled?.();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/viewers/tone-engine.test.ts`
Expected: FAIL — `createMelodicVoice`/`createDrumVoice` do not exist on
`ToneEngineDependencies`; `AudioRow` has no `program`.

- [ ] **Step 4: Implement the engine changes**

Edit `apps/web/src/lib/viewers/tone-engine.ts`.

4a. Update imports at the top:

```ts
import { Frequency, getTransport, MembraneSynth, MetalSynth, NoiseSynth, PolySynth, start, Synth } from 'tone';

import { drumVoiceSpec, gmFamily, melodicVoiceSpec, type VoiceSpec } from './gm-voices.js';

const Tone = { Frequency, getTransport, MembraneSynth, MetalSynth, NoiseSynth, PolySynth, start, Synth };
```

4b. Add `program` to `AudioRow`:

```ts
export interface AudioRow {
  seconds: number;
  note: number;
  velocity: number;
  kind: 'note_on' | 'note_off';
  channel: number | null;
  program: number | null;
}
```

4c. Replace `createSynth` in `ToneEngineDependencies`:

```ts
export interface ToneEngineDependencies {
  startAudio(): Promise<void>;
  createMelodicVoice(spec: VoiceSpec): SynthPort;
  createDrumVoice(): SynthPort;
  transport: TransportPort;
}
```

4d. Replace `localToneDependencies` with local voice builders that convert
MIDI→Hz for melodic voices and synthesize drums by note. Insert above the
`keyFor` definition:

```ts
const midiToHz = (note: number): number => Tone.Frequency(note, 'midi').toFrequency();

const buildMelodicVoice = (spec: VoiceSpec): SynthPort => {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: spec.oscillator,
    envelope: spec.envelope,
  }).toDestination();
  return {
    triggerAttack: (note, time, velocity) => synth.triggerAttack(midiToHz(note), time, velocity),
    triggerRelease: (note, time) => synth.triggerRelease(midiToHz(note), time),
    releaseAll: () => synth.releaseAll(),
    dispose: () => {
      synth.dispose();
    },
  };
};

const buildDrumVoice = (): SynthPort => {
  const kick = new Tone.MembraneSynth().toDestination();
  const tom = new Tone.MembraneSynth({ pitchDecay: 0.1, octaves: 4 }).toDestination();
  const snare = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.2, sustain: 0 } }).toDestination();
  const hat = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.05, sustain: 0 } }).toDestination();
  const cymbal = new Tone.MetalSynth().toDestination();
  const all = [kick, tom, snare, hat, cymbal];
  return {
    triggerAttack: (note, time, velocity) => {
      switch (drumVoiceSpec(note)) {
        case 'kick':
          kick.triggerAttackRelease('C1', '8n', time, velocity);
          break;
        case 'tom':
          tom.triggerAttackRelease('G2', '8n', time, velocity);
          break;
        case 'snare':
          snare.triggerAttackRelease('16n', time, velocity);
          break;
        case 'hat':
          hat.triggerAttackRelease('32n', time, velocity);
          break;
        case 'cymbal':
          cymbal.triggerAttackRelease('C4', '4n', time, velocity);
          break;
      }
    },
    triggerRelease: () => undefined,
    releaseAll: () => undefined,
    dispose: () => {
      for (const node of all) node.dispose();
    },
  };
};

const localToneDependencies: ToneEngineDependencies = {
  startAudio: () => Tone.start(),
  createMelodicVoice: (spec) => buildMelodicVoice(spec),
  createDrumVoice: () => buildDrumVoice(),
  transport: Tone.getTransport(),
};
```

4e. Add voice-key helpers next to `keyFor` (keep `keyFor` for note
identity — it stays `${channel}:${note}`):

```ts
const keyFor = ({ note, channel }: AudioRow): string => `${channel ?? 'none'}:${note}`;

const voiceKeyFor = ({ channel, program }: AudioRow): string =>
  channel === 9 ? `${channel}:drum` : `${channel ?? 'none'}:${gmFamily(program ?? 0)}`;
```

4f. Change the `synths` map key type and the `activeNotes` value type:

```ts
private readonly activeNotes = new Map<string, { synth: SynthPort; count: number }>();
private readonly synths = new Map<string, SynthPort>();
```

4g. Replace `ensureSynths` to pre-create one synth per distinct voice key:

```ts
private ensureSynths(): void {
  for (const row of this.rows) {
    const key = voiceKeyFor(row);
    if (!this.synths.has(key)) {
      this.synths.set(
        key,
        row.channel === 9
          ? this.dependencies.createDrumVoice()
          : this.dependencies.createMelodicVoice(melodicVoiceSpec(gmFamily(row.program ?? 0))),
      );
    }
  }
}
```

4h. Rewrite the scheduled callback body in `scheduleFrom` so note-on records
its synth and note-off releases on that same synth:

```ts
id = this.dependencies.transport.scheduleOnce((time) => {
  this.scheduledIds.delete(id);
  if (this.disposed) return;
  const key = keyFor(row);
  if (row.kind === 'note_on') {
    const synth = this.synths.get(voiceKeyFor(row));
    if (!synth) return;
    const active = this.activeNotes.get(key);
    if (active) active.count += 1;
    else this.activeNotes.set(key, { synth, count: 1 });
    synth.triggerAttack(row.note, time, Math.min(127, Math.max(0, row.velocity)) / 127);
    return;
  }

  const active = this.activeNotes.get(key);
  if (!active) return;
  if (active.count === 1) this.activeNotes.delete(key);
  else active.count -= 1;
  active.synth.triggerRelease(row.note, time);
}, row.seconds);
```

4i. `releaseAndClear` already iterates `this.synths.values()` calling
`releaseAll()` and `activeNotes.clear()` — no change needed since the value
types changed but the iteration is over synths. Confirm it still reads:

```ts
private releaseAndClear(): void {
  for (const id of this.scheduledIds) this.dependencies.transport.clear(id);
  this.scheduledIds.clear();
  this.activeNotes.clear();
  for (const synth of this.synths.values()) synth.releaseAll();
}
```

- [ ] **Step 5: Finalize the per-channel test fakes to match the engine keys**

Now that the voice key is `${channel}:${family}` for melodic and
`${channel}:drum` for drums, update the `setup` fake so its map key equals
the engine's `voiceKeyFor`. Since the fake only receives the `spec`, thread
the channel through by having the engine's local map own keying and the
fake key on the spec — simplest correct approach: change the fake factories
to record every created synth in call order and assert via the engine's
`synths` internals is not accessible, so instead key the fake on a counter
and assert through `triggerAttack` targets.

Concrete resolution: expose the created synths by spec+creation and assert
behavior through transport runs (which is what the new tests in Step 2
already do via `synths.get('3:piano')`). To make `synths.get('<channel>:<family>')`
work in the fake, update `createMelodicVoice`/`createDrumVoice` to receive
no channel — therefore the fake cannot know the channel. Resolve by keying
the fake map inside the engine test on the **spec** and adjusting the Step 2
tests to look up by spec-derived key:

Replace the Step 1 `setup` synth map wiring with this final version:

```ts
function setup(startAudio: () => Promise<void> = async () => undefined) {
  const transport = new FakeTransport();
  const created: { spec: VoiceSpec | null; synth: SynthPort }[] = [];
  const makeSynth = (spec: VoiceSpec | null): SynthPort => {
    const synth: SynthPort = {
      triggerAttack: vi.fn(),
      triggerRelease: vi.fn(),
      releaseAll: vi.fn(),
      dispose: vi.fn(),
    };
    created.push({ spec, synth });
    return synth;
  };
  const dependencies: ToneEngineDependencies = {
    startAudio: vi.fn(startAudio),
    createMelodicVoice: vi.fn((spec: VoiceSpec) => makeSynth(spec)),
    createDrumVoice: vi.fn(() => makeSynth(null)),
    transport,
  };
  const melodicByOsc = (type: VoiceSpec['oscillator']['type']): SynthPort => {
    const match = created.find((entry) => entry.spec?.oscillator.type === type);
    if (!match) throw new Error(`No melodic synth with oscillator ${type}.`);
    return match.synth;
  };
  const drumSynth = (): SynthPort => {
    const match = created.find((entry) => entry.spec === null);
    if (!match) throw new Error('No drum synth created.');
    return match.synth;
  };
  return { engine: new ToneAudioEngine(dependencies), transport, created, melodicByOsc, drumSynth, dependencies };
}
```

Then update the Step 1 legacy tests to use `melodicByOsc('triangle')` in
place of `synthFor(0)` / `synthFor('melodic:triangle')`, and the Step 2
drum/program tests to use `drumSynth()` and `melodicByOsc('sawtooth')` /
`melodicByOsc('triangle')` instead of `synths.get(...)`. For the
"interleaved same-pitch through their own channel synths" test, both
channels use `program: null` (piano/triangle) but **different channels**, so
the engine creates two `melodic:triangle` synths under keys `0:piano` and
`1:piano`; assert via `created.filter(e => e.spec?.oscillator.type === 'triangle')`
having length 2 and that each received exactly one `triggerAttack` and one
`triggerRelease` for note 60. For the "null-channel" test, likewise assert
two triangle synths (keys `none:piano` and `0:piano`) each disposed once.

- [ ] **Step 6: Run the engine tests to verify they pass**

Run: `pnpm --filter @byteql/web exec vitest run src/lib/viewers/tone-engine.test.ts`
Expected: PASS (legacy behavior tests + new drum/program/release tests).

- [ ] **Step 7: Type-check the web package**

Run: `pnpm --filter @byteql/web check`
Expected: no TypeScript/Svelte errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/viewers/tone-engine.ts apps/web/src/lib/viewers/tone-engine.test.ts
git commit -m "feat(web): route MIDI notes to GM instrument and drum voices"
```

---

## Task 4: Read the program column in the audio viewer

**Files:**

- Modify: `apps/web/src/components/AudioViewer.svelte`
- Test: `apps/web/src/components/AudioViewer.test.ts`

**Interfaces:**

- Consumes: `AudioRow.program` (Task 3).
- Produces: `parseRows` emits `program` on every `AudioRow`
  (`null` when the column is absent or the value is not an integer 0–127).
- [ ] **Step 1: Update the failing tests**

In `apps/web/src/components/AudioViewer.test.ts`:

1. In the "loads valid Arrow rows …" test, add `program: null` to the two
   expected rows:

```ts
expect(engine.load).toHaveBeenCalledWith([
  { seconds: 0.5, note: 60, velocity: 64, kind: 'note_on', channel: 0, program: null },
  { seconds: 1.25, note: 60, velocity: 0, kind: 'note_off', channel: 0, program: null },
]);
```

2. Add a new test that a present `program` column is read through:

```ts
it('passes the program column through to audio rows when present', async () => {
  const table = tableFromArrays({
    seconds: [0, 0.5],
    note: [60, 40],
    velocity: [100, 90],
    kind: ['note_on', 'note_on'],
    channel: [4, 3],
    program: [48, 35],
  });
  const engine = fakeEngine();
  render(AudioViewer, { table, engineFactory: () => engine, onclose: vi.fn() });
  await vi.waitFor(() =>
    expect(engine.load).toHaveBeenCalledWith([
      { seconds: 0, note: 60, velocity: 100, kind: 'note_on', channel: 4, program: 48 },
      { seconds: 0.5, note: 40, velocity: 90, kind: 'note_on', channel: 3, program: 35 },
    ]),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @byteql/web exec vitest run src/components/AudioViewer.test.ts`
Expected: FAIL — emitted rows lack `program`.

- [ ] **Step 3: Implement `program` parsing in `parseRows`**

In `apps/web/src/components/AudioViewer.svelte`, inside `parseRows`:

1. Add a program column handle alongside the others:

```ts
const channelColumn = value.getChild('channel');
const programColumn = value.getChild('program');
```

2. Inside the per-row loop, after computing `channel`, derive `program`
   (invalid/absent → `null`; never a reason to discard the row):

```ts
const programValue = programColumn?.get(index);
const programNumber = programColumn ? numeric(programValue) : null;
const program =
  programNumber !== null && Number.isInteger(programNumber) && programNumber >= 0 && programNumber <= 127
    ? programNumber
    : null;
```

3. Change the push to include `program`:

```ts
valid.push({ seconds, note, velocity, kind, channel, program });
```

Do **not** add `program` to the validity gate; leave the existing invalid-row
conditions unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @byteql/web exec vitest run src/components/AudioViewer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/AudioViewer.svelte apps/web/src/components/AudioViewer.test.ts
git commit -m "feat(web): read the program column into audio playback rows"
```

---

## Task 5: Full verification and manual check against the reference file

**Files:** none (verification only), plus `CHANGELOG.md` if present.

- [ ] **Step 1: Run the full web unit suite**

Run: `pnpm --filter @byteql/web test`
Expected: PASS, including `test:worker-privacy` (zero network requests —
confirms no external asset was introduced).

- [ ] **Step 2: Run the repo build + checks + lint**

Run: `pnpm build && pnpm -r check && pnpm lint && pnpm format:check`
Expected: all green. If `format:check` fails, run `pnpm format` and
re-commit.

- [ ] **Step 3: Run the bundle guard**

Run: `pnpm check:bundle`
Expected: PASS — runtime JS under 5 MiB, no forbidden external references.

- [ ] **Step 4: Run the audio e2e**

Run: `pnpm --filter @byteql/web test:e2e`
Expected: `apps/web/e2e/audio.spec.ts` passes. If it asserts on the old
single-synth behavior or the old `AudioRow` shape, update those assertions
to the new voice routing (drum voice for channel 9, program-derived melodic
voice otherwise) and re-run.

- [ ] **Step 5: Manual listen against the reference file**

The dev server runs via `pnpm --filter @byteql/web dev`. In the app:

1. Load `~/Downloads/the_winner_takes_it_all.mid`.
2. Run the **Play all notes** query and press Play.
3. Confirm: the drum track (channel 9, ~1,267 hits) now sounds like
   percussion rather than pitched notes; the bass/piano/guitar/choir
   channels have audibly distinct timbres; pitches are in the correct
   register (MIDI→Hz conversion — no more sub-bass rumble).
4. Run the **Percussion channel** query → only drums. Run **Low notes** →
   bass-register melodic voice.

- [ ] **Step 6: Update the changelog and commit**

If `CHANGELOG.md` exists, add an entry under the appropriate heading, e.g.:

```text
- MIDI playback now renders per-channel General MIDI instrument timbres,
  plays the GM percussion channel (9) as drums, and corrects note pitch
  (MIDI note numbers were previously played as raw hertz).
```

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for GM instruments and drum-channel playback"
```

---

## Self-Review

**Spec coverage:**

- Query layer `program_map` + LEFT asof join → Task 2. ✓
- 8-family `gmFamily`, `melodicVoiceSpec`, `drumVoiceSpec` fallbacks →
  Task 1. ✓
- `AudioRow.program`, ch9→drum routing, `(channel, voiceType)` keying,
  note-off synth tracking, DI seam rename, drum node synthesis → Task 3. ✓
- `parseRows` optional program, `program` not in validity gate,
  `registry.ts` unchanged → Task 4 (registry needs no edit — confirmed the
  optional column does not affect `accepts`). ✓
- Testing (gm-voices tests, engine routing/release tests, viewer program
  test, pack tests, e2e) → Tasks 1–5. ✓
- Constraints (no external host, no new deps, bundle budget) → Task 5
  Steps 1–3. ✓
- Bonus fix surfaced during design: MIDI→Hz pitch conversion is folded into
  Task 3's `buildMelodicVoice` (documented in the changelog, Task 5 Step 6).

**Type consistency:** `GmFamily`, `DrumVoice`, `VoiceSpec`, `gmFamily`,
`melodicVoiceSpec`, `drumVoiceSpec` (Task 1) are consumed with identical
signatures in Task 3. `createMelodicVoice(spec)`/`createDrumVoice()`
(Task 3 seam) match the fakes in the Task 3 tests. `AudioRow.program`
(Task 3) matches the `parseRows` output (Task 4) and the engine test
fixtures.

**Placeholder scan:** No TBD/TODO; every code step includes complete code.
Task 3 Step 1 defers the exact per-channel fake-key assertions to Step 5,
where the final `setup` helper and lookup by oscillator type are given in
full — this is a sequencing note, not a placeholder.
