import { describe, expect, it, vi } from 'vitest';

import {
  ToneAudioEngine,
  type AudioRow,
  type SynthPort,
  type ToneEngineDependencies,
  type TransportPort,
} from './tone-engine.js';

class FakeTransport implements TransportPort {
  seconds = 0;
  readonly callbacks = new Map<number, { at: number; callback: (time: number) => void }>();
  readonly cleared: number[] = [];
  readonly calls: string[] = [];
  private nextId = 1;

  schedule(callback: (time: number) => void, at: number): number {
    const id = this.nextId++;
    this.callbacks.set(id, { at, callback });
    this.calls.push(`schedule:${at}`);
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
        this.callbacks.delete(id);
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

function setup() {
  const transport = new FakeTransport();
  const synth: SynthPort = {
    triggerAttack: vi.fn(),
    triggerRelease: vi.fn(),
    releaseAll: vi.fn(),
    dispose: vi.fn(),
  };
  const dependencies: ToneEngineDependencies = {
    startAudio: vi.fn(async () => undefined),
    createSynth: vi.fn(() => synth),
    transport,
  };
  return { engine: new ToneAudioEngine(dependencies), transport, synth, dependencies };
}

describe('ToneAudioEngine', () => {
  it('starts audio only from play and schedules exact seconds with normalized velocity', async () => {
    const { engine, transport, synth, dependencies } = setup();

    await engine.load(rows);
    expect(dependencies.startAudio).not.toHaveBeenCalled();
    expect(dependencies.createSynth).not.toHaveBeenCalled();

    await engine.play();
    expect(dependencies.startAudio).toHaveBeenCalledOnce();
    expect(dependencies.createSynth).toHaveBeenCalledOnce();
    expect([...transport.callbacks.values()].map(({ at }) => at)).toEqual([0.5, 1.25]);

    transport.run(0.5);
    transport.run(1.25);
    expect(synth.triggerAttack).toHaveBeenCalledWith(60, 0.5, 64 / 127);
    expect(synth.triggerRelease).toHaveBeenCalledWith(60, 1.25);
  });

  it('balances repeated and channel-overlapping notes without dropping releases', async () => {
    const { engine, transport, synth } = setup();
    await engine.load([
      { seconds: 0, note: 60, velocity: 127, kind: 'note_on', channel: 0 },
      { seconds: 0.1, note: 60, velocity: 127, kind: 'note_on', channel: 1 },
      { seconds: 0.2, note: 60, velocity: 0, kind: 'note_off', channel: 1 },
      { seconds: 0.3, note: 60, velocity: 0, kind: 'note_off', channel: 0 },
    ]);
    await engine.play();

    for (const at of [0, 0.1, 0.2, 0.3]) transport.run(at);
    expect(synth.triggerAttack).toHaveBeenCalledTimes(2);
    expect(synth.triggerRelease).toHaveBeenCalledTimes(2);
  });

  it('releases notes and clears every callback on stop and before replacement load', async () => {
    const { engine, transport, synth } = setup();
    await engine.load(rows);
    await engine.play();
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
    const { engine, transport, synth } = setup();
    await engine.load(rows);
    await engine.play();

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
});
