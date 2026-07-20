import {
  Frequency,
  getTransport,
  MembraneSynth,
  MetalSynth,
  NoiseSynth,
  PolySynth,
  start,
  Synth,
} from 'tone';

import { drumVoiceSpec, gmFamily, melodicVoiceSpec, type VoiceSpec } from './gm-voices.js';

const Tone = { Frequency, getTransport, MembraneSynth, MetalSynth, NoiseSynth, PolySynth, start, Synth };

export interface AudioRow {
  seconds: number;
  note: number;
  velocity: number;
  kind: 'note_on' | 'note_off';
  channel: number | null;
  program: number | null;
}

export interface AudioEngine {
  load(rows: readonly AudioRow[]): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  positionSeconds(): number;
  dispose(): void;
}

export interface TransportPort {
  seconds: number;
  scheduleOnce(callback: (time: number) => void, seconds: number): number;
  clear(id: number): void;
  start(): void;
  pause(): void;
  stop(): void;
}

export interface SynthPort {
  triggerAttack(note: number, time: number, velocity: number): void;
  triggerRelease(note: number, time: number): void;
  releaseAll(): void;
  dispose(): void;
}

export interface ToneEngineDependencies {
  startAudio(): Promise<void>;
  createMelodicVoice(spec: VoiceSpec): SynthPort;
  createDrumVoice(): SynthPort;
  transport: TransportPort;
}

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
  const snare = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.2, sustain: 0 },
  }).toDestination();
  const hat = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.05, sustain: 0 },
  }).toDestination();
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

const keyFor = ({ note, channel }: AudioRow): string => `${channel ?? 'none'}:${note}`;

const voiceKeyFor = ({ channel, program }: AudioRow): string =>
  channel === 9 ? `${channel}:drum` : `${channel ?? 'none'}:${gmFamily(program ?? 0)}`;

export class ToneAudioEngine implements AudioEngine {
  private readonly dependencies: ToneEngineDependencies;
  private rows: readonly AudioRow[] = [];
  private readonly scheduledIds = new Set<number>();
  private readonly activeNotes = new Map<string, { synth: SynthPort; count: number }>();
  private readonly synths = new Map<string, SynthPort>();
  private audioStarted: Promise<void> | null = null;
  private operationGeneration = 0;
  private playing = false;
  private disposed = false;

  constructor(dependencies: ToneEngineDependencies = localToneDependencies) {
    this.dependencies = dependencies;
  }

  async load(rows: readonly AudioRow[]): Promise<void> {
    this.assertUsable();
    this.stop();
    this.disposeSynths();
    this.rows = [...rows];
  }

  async play(): Promise<void> {
    this.assertUsable();
    if (this.playing) return;
    const operation = ++this.operationGeneration;
    this.audioStarted ??= this.dependencies.startAudio().catch((error: unknown) => {
      this.audioStarted = null;
      throw error;
    });
    await this.audioStarted;
    if (!this.isCurrent(operation)) return;
    this.ensureSynths();
    this.scheduleFrom(this.positionSeconds());
    this.dependencies.transport.start();
    this.playing = true;
  }

  pause(): void {
    if (this.disposed) return;
    this.invalidatePendingPlay();
    this.dependencies.transport.pause();
    this.releaseAndClear();
    this.playing = false;
  }

  stop(): void {
    if (this.disposed) return;
    this.invalidatePendingPlay();
    this.dependencies.transport.stop();
    this.releaseAndClear();
    this.playing = false;
  }

  seek(seconds: number): void {
    if (this.disposed) return;
    this.invalidatePendingPlay();
    const resume = this.playing;
    if (resume) this.dependencies.transport.pause();
    this.releaseAndClear();
    this.dependencies.transport.seconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    if (resume) {
      this.scheduleFrom(this.dependencies.transport.seconds);
      this.dependencies.transport.start();
    }
  }

  positionSeconds(): number {
    const seconds = this.dependencies.transport.seconds;
    return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposeSynths();
    this.rows = [];
    this.audioStarted = null;
    this.disposed = true;
  }

  private scheduleFrom(position: number): void {
    if (this.scheduledIds.size > 0) return;

    for (const row of this.rows) {
      if (row.seconds < position) continue;
      let id = 0;
      id = this.dependencies.transport.scheduleOnce((time) => {
        this.scheduledIds.delete(id);
        if (this.disposed) return;
        const key = keyFor(row);
        if (row.kind === 'note_on') {
          const synth = this.synths.get(voiceKeyFor(row));
          if (!synth) return;
          // Drums are one-shot; do not track them for release so a matching
          // note_off never triggers a (meaningless) release on the drum voice.
          if (row.channel !== 9) {
            const active = this.activeNotes.get(key);
            if (active) active.count += 1;
            else this.activeNotes.set(key, { synth, count: 1 });
          }
          synth.triggerAttack(row.note, time, Math.min(127, Math.max(0, row.velocity)) / 127);
          return;
        }

        const active = this.activeNotes.get(key);
        if (!active) return;
        if (active.count === 1) this.activeNotes.delete(key);
        else active.count -= 1;
        active.synth.triggerRelease(row.note, time);
      }, row.seconds);
      this.scheduledIds.add(id);
    }
  }

  private releaseAndClear(): void {
    for (const id of this.scheduledIds) this.dependencies.transport.clear(id);
    this.scheduledIds.clear();
    this.activeNotes.clear();
    for (const synth of this.synths.values()) synth.releaseAll();
  }

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

  private disposeSynths(): void {
    for (const synth of this.synths.values()) synth.dispose();
    this.synths.clear();
  }

  private invalidatePendingPlay(): void {
    this.operationGeneration += 1;
  }

  private isCurrent(operation: number): boolean {
    return !this.disposed && operation === this.operationGeneration;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('The audio engine is disposed.');
  }
}
