// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tableFromArrays } from 'apache-arrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AudioEngine } from '../lib/viewers/tone-engine.js';
import AudioViewer from './AudioViewer.svelte';

function fakeEngine() {
  let position = 0;
  const engine: AudioEngine = {
    load: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    stop: vi.fn(() => {
      position = 0;
    }),
    seek: vi.fn((seconds: number) => {
      position = seconds;
    }),
    positionSeconds: vi.fn(() => position),
    dispose: vi.fn(),
  };
  return engine;
}

describe('AudioViewer', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('loads valid Arrow rows and reports invalid or null rows actionably', async () => {
    const table = tableFromArrays({
      seconds: [0.5, 1.25, null, -1, 2],
      note: [60, 60, 64, 64, 200],
      velocity: [64, 0, 100, 100, 100],
      kind: ['note_on', 'note_off', 'note_on', 'note_on', 'note_on'],
      channel: [0, 0, null, 0, 0],
    });
    const engine = fakeEngine();

    render(AudioViewer, { table, engineFactory: () => engine, onclose: vi.fn() });

    await vi.waitFor(() =>
      expect(engine.load).toHaveBeenCalledWith([
        { seconds: 0.5, note: 60, velocity: 64, kind: 'note_on', channel: 0 },
        { seconds: 1.25, note: 60, velocity: 0, kind: 'note_off', channel: 0 },
      ]),
    );
    expect(screen.getByText('2 scheduled rows')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(
      /3 invalid rows[\s\S]*finite non-negative seconds[\s\S]*0–127/iu,
    );
    expect(screen.getByText('0:00 / 0:01')).toBeTruthy();
  });

  it('starts on the Play gesture and exposes pause, stop, and seek controls', async () => {
    const table = tableFromArrays({
      seconds: [0.5, 1.25],
      note: [60, 60],
      velocity: [64, 0],
      kind: ['note_on', 'note_off'],
    });
    const engine = fakeEngine();
    render(AudioViewer, { table, engineFactory: () => engine, onclose: vi.fn() });
    await vi.waitFor(() => expect(engine.load).toHaveBeenCalledOnce());

    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(engine.play).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(engine.pause).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(engine.stop).toHaveBeenCalledOnce();

    await fireEvent.input(screen.getByRole('slider', { name: 'Seek playback' }), {
      target: { value: '0.75' },
    });
    expect(engine.seek).toHaveBeenCalledWith(0.75);
  });

  it('stops the engine at the result duration so an unmatched attack cannot leak', async () => {
    const table = tableFromArrays({
      seconds: [1],
      note: [60],
      velocity: [127],
      kind: ['note_on'],
    });
    const engine = fakeEngine();
    render(AudioViewer, { table, engineFactory: () => engine, onclose: vi.fn() });
    await vi.waitFor(() => expect(engine.load).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await fireEvent.input(screen.getByRole('slider', { name: 'Seek playback' }), {
      target: { value: '1' },
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(engine.stop).toHaveBeenCalledOnce();
  });

  it('disposes on close and component teardown without double-releasing resources', async () => {
    const table = tableFromArrays({
      seconds: [0],
      note: [60],
      velocity: [127],
      kind: ['note_on'],
    });
    const engine = fakeEngine();
    const onclose = vi.fn();
    const view = render(AudioViewer, { table, engineFactory: () => engine, onclose });
    await vi.waitFor(() => expect(engine.load).toHaveBeenCalledOnce());

    await fireEvent.click(screen.getByRole('button', { name: 'Close audio viewer' }));
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();

    view.unmount();
    expect(engine.dispose).toHaveBeenCalledOnce();
  });
});
