import { describe, expect, it, vi } from 'vitest';

import {
  ToneAudioEngine,
  type AudioRow,
  type SynthPort,
  type ToneEngineDependencies,
  type TransportPort,
} from './tone-engine.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

class FakeTransport implements TransportPort {
  seconds = 0;
  readonly callbacks = new Map<number, { at: number; callback: (time: number) => void; once: boolean }>();
  readonly cleared: number[] = [];
  readonly calls: string[] = [];
  private nextId = 1;

  schedule(callback: (time: number) => void, at: number): number {
    return this.add(callback, at, false);
  }

  scheduleOnce(callback: (time: number) => void, at: number): number {
    return this.add(callback, at, true);
  }

  private add(callback: (time: number) => void, at: number, once: boolean): number {
    const id = this.nextId++;
    this.callbacks.set(id, { at, callback, once });
    this.calls.push(`${once ? 'scheduleOnce' : 'schedule'}:${at}`);
    return id;
  }

  clear(id: number): void {
    this.cleared.push(id);
    this.callbacks.delete(id);
    this.calls.push(`clear:${id}`);
  }

  start(): void {
    this.calls.push('start');
  }

  pause(): void {
    this.calls.push('pause');
  }

  stop(): void {
    this.calls.push('stop');
    this.seconds = 0;
  }

  run(at: number): void {
    for (const [id, scheduled] of this.callbacks) {
      if (scheduled.at === at) {
        if (scheduled.once) this.callbacks.delete(id);
        scheduled.callback(at);
      }
    }
    this.seconds = at;
  }
}

const rows: readonly AudioRow[] = [
  { seconds: 0.5, note: 60, velocity: 64, kind: 'note_on', channel: 0 },
  { seconds: 1.25, note: 60, velocity: 0, kind: 'note_off', channel: 0 },
];

function setup(startAudio: () => Promise<void> = async () => undefined) {
  const transport = new FakeTransport();
  const synths = new Map<number | null, SynthPort>();
  const dependencies: ToneEngineDependencies = {
    startAudio: vi.fn(startAudio),
    createSynth: vi.fn((channel: number | null) => {
      const synth: SynthPort = {
        triggerAttack: vi.fn(),
        triggerRelease: vi.fn(),
        releaseAll: vi.fn(),
        dispose: vi.fn(),
      };
      synths.set(channel, synth);
      return synth;
    }),
    transport,
  };
  const synthFor = (channel: number | null): SynthPort => {
    const synth = synths.get(channel);
    if (!synth) throw new Error(`No synth was created for channel ${String(channel)}.`);
    return synth;
  };
  return { engine: new ToneAudioEngine(dependencies), transport, synthFor, synths, dependencies };
}

describe('ToneAudioEngine', () => {
  it('starts audio only from play and schedules exact seconds with normalized velocity', async () => {
    const { engine, transport, synthFor, dependencies } = setup();

    await engine.load(rows);
    expect(dependencies.startAudio).not.toHaveBeenCalled();
    expect(dependencies.createSynth).not.toHaveBeenCalled();

    await engine.play();
    expect(dependencies.startAudio).toHaveBeenCalledOnce();
    expect(dependencies.createSynth).toHaveBeenCalledOnce();
    expect(dependencies.createSynth).toHaveBeenCalledWith(0);
    expect([...transport.callbacks.values()].map(({ at }) => at)).toEqual([0.5, 1.25]);

    transport.run(0.5);
    transport.run(1.25);
    const synth = synthFor(0);
    expect(synth.triggerAttack).toHaveBeenCalledWith(60, 0.5, 64 / 127);
    expect(synth.triggerRelease).toHaveBeenCalledWith(60, 1.25);
  });

  it('removes completed timeline events before replay schedules exactly one copy', async () => {
    const { engine, transport, synthFor } = setup();
    await engine.load(rows);
    await engine.play();

    transport.run(0.5);
    transport.run(1.25);
    engine.stop();
    expect(transport.callbacks.size).toBe(0);

    await engine.play();
    expect(transport.callbacks.size).toBe(rows.length);
    transport.run(0.5);
    expect(synthFor(0).triggerAttack).toHaveBeenCalledTimes(2);
  });

  it('clears fired and pending timeline events before replaying a partial result', async () => {
    const { engine, transport, synthFor } = setup();
    await engine.load(rows);
    await engine.play();

    transport.run(0.5);
    engine.stop();
    expect(transport.callbacks.size).toBe(0);

    await engine.play();
    expect(transport.callbacks.size).toBe(rows.length);
    transport.run(0.5);
    expect(synthFor(0).triggerAttack).toHaveBeenCalledTimes(2);
  });

  it('releases interleaved same-pitch notes through their own channel synths', async () => {
    const { engine, transport, synthFor } = setup();
    await engine.load([
      { seconds: 0, note: 60, velocity: 127, kind: 'note_on', channel: 0 },
      { seconds: 0.1, note: 60, velocity: 127, kind: 'note_on', channel: 1 },
      { seconds: 0.2, note: 60, velocity: 0, kind: 'note_off', channel: 1 },
      { seconds: 0.3, note: 60, velocity: 0, kind: 'note_off', channel: 0 },
    ]);
    await engine.play();

    for (const at of [0, 0.1, 0.2, 0.3]) transport.run(at);
    expect(synthFor(0).triggerAttack).toHaveBeenCalledWith(60, 0, 1);
    expect(synthFor(1).triggerAttack).toHaveBeenCalledWith(60, 0.1, 1);
    expect(synthFor(1).triggerRelease).toHaveBeenCalledWith(60, 0.2);
    expect(synthFor(0).triggerRelease).toHaveBeenCalledWith(60, 0.3);
    expect(synthFor(0).triggerRelease).toHaveBeenCalledOnce();
    expect(synthFor(1).triggerRelease).toHaveBeenCalledOnce();
  });

  it('keeps null-channel rows in their own synth domain and disposes every domain', async () => {
    const { engine, transport, synthFor } = setup();
    await engine.load([
      { seconds: 0, note: 60, velocity: 127, kind: 'note_on', channel: null },
      { seconds: 0.1, note: 60, velocity: 127, kind: 'note_on', channel: 0 },
    ]);
    await engine.play();

    transport.run(0);
    transport.run(0.1);
    const defaultSynth = synthFor(null);
    const channelSynth = synthFor(0);
    engine.dispose();

    expect(defaultSynth.releaseAll).toHaveBeenCalledOnce();
    expect(channelSynth.releaseAll).toHaveBeenCalledOnce();
    expect(defaultSynth.dispose).toHaveBeenCalledOnce();
    expect(channelSynth.dispose).toHaveBeenCalledOnce();
    expect(transport.callbacks.size).toBe(0);
  });

  it('releases notes and clears every callback on stop and before replacement load', async () => {
    const { engine, transport, synthFor } = setup();
    await engine.load(rows);
    await engine.play();
    const synth = synthFor(0);
    const firstIds = [...transport.callbacks.keys()];

    engine.stop();
    expect(synth.releaseAll).toHaveBeenCalledOnce();
    expect(transport.cleared).toEqual(firstIds);
    expect(transport.callbacks.size).toBe(0);

    await engine.play();
    const replacementIds = [...transport.callbacks.keys()];
    await engine.load([{ seconds: 2, note: 72, velocity: 127, kind: 'note_on', channel: null }]);
    expect(transport.cleared).toEqual([...firstIds, ...replacementIds]);
    expect(synth.releaseAll).toHaveBeenCalledTimes(2);
    expect(transport.callbacks.size).toBe(0);
  });

  it('pauses, seeks, stops, and disposes without leaving callbacks or notes behind', async () => {
    const { engine, transport, synthFor } = setup();
    await engine.load(rows);
    await engine.play();
    const synth = synthFor(0);

    transport.run(0.5);
    engine.pause();
    expect(transport.calls).toContain('pause');
    expect(synth.releaseAll).toHaveBeenCalledOnce();

    engine.seek(0.75);
    expect(transport.seconds).toBe(0.75);
    expect(synth.releaseAll).toHaveBeenCalledTimes(2);

    engine.dispose();
    expect(transport.callbacks.size).toBe(0);
    expect(synth.releaseAll).toHaveBeenCalledTimes(3);
    expect(synth.dispose).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'pause', 'seek', 'load', 'dispose'] as const)(
    'invalidates a pending play when %s runs before audio start resolves',
    async (operation) => {
      const audioStart = deferred<void>();
      const { engine, transport, dependencies } = setup(() => audioStart.promise);
      await engine.load(rows);
      const pendingPlay = engine.play();

      if (operation === 'stop') engine.stop();
      else if (operation === 'pause') engine.pause();
      else if (operation === 'seek') engine.seek(0.75);
      else if (operation === 'load') await engine.load(rows);
      else engine.dispose();

      audioStart.resolve(undefined);
      await pendingPlay;
      expect(dependencies.createSynth).not.toHaveBeenCalled();
      expect(transport.callbacks.size).toBe(0);
      expect(transport.calls).not.toContain('start');
    },
  );

  it('lets only the newest pending play create synths, schedule rows, and start transport', async () => {
    const audioStart = deferred<void>();
    const { engine, transport, dependencies } = setup(() => audioStart.promise);
    await engine.load(rows);

    const firstPlay = engine.play();
    const authoritativePlay = engine.play();
    audioStart.resolve(undefined);
    await Promise.all([firstPlay, authoritativePlay]);

    expect(dependencies.startAudio).toHaveBeenCalledOnce();
    expect(dependencies.createSynth).toHaveBeenCalledOnce();
    expect(transport.calls.filter((call) => call === 'start')).toHaveLength(1);
    expect([...transport.callbacks.values()].map(({ at }) => at)).toEqual([0.5, 1.25]);
  });
});
