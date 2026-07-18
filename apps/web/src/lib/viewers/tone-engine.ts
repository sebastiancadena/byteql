import { getTransport, PolySynth, start, Synth } from 'tone';

const Tone = { getTransport, PolySynth, start, Synth };

export interface AudioRow {
  seconds: number;
  note: number;
  velocity: number;
  kind: 'note_on' | 'note_off';
  channel: number | null;
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
  schedule(callback: (time: number) => void, seconds: number): number;
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
  createSynth(channel: number | null): SynthPort;
  transport: TransportPort;
}

const localToneDependencies: ToneEngineDependencies = {
  startAudio: () => Tone.start(),
  createSynth: () => new Tone.PolySynth(Tone.Synth).toDestination(),
  transport: Tone.getTransport(),
};

const keyFor = ({ note, channel }: AudioRow): string => `${channel ?? 'none'}:${note}`;

export class ToneAudioEngine implements AudioEngine {
  private readonly dependencies: ToneEngineDependencies;
  private rows: readonly AudioRow[] = [];
  private readonly scheduledIds = new Set<number>();
  private readonly activeNotes = new Map<string, number>();
  private readonly synths = new Map<number | null, SynthPort>();
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
      id = this.dependencies.transport.schedule((time) => {
        this.scheduledIds.delete(id);
        const synth = this.synths.get(row.channel);
        if (this.disposed || !synth) return;
        const key = keyFor(row);
        if (row.kind === 'note_on') {
          this.activeNotes.set(key, (this.activeNotes.get(key) ?? 0) + 1);
          synth.triggerAttack(row.note, time, Math.min(127, Math.max(0, row.velocity)) / 127);
          return;
        }

        const count = this.activeNotes.get(key) ?? 0;
        if (count === 0) return;
        if (count === 1) this.activeNotes.delete(key);
        else this.activeNotes.set(key, count - 1);
        synth.triggerRelease(row.note, time);
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
      if (!this.synths.has(row.channel)) {
        this.synths.set(row.channel, this.dependencies.createSynth(row.channel));
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
