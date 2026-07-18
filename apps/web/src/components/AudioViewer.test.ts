// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tableFromArrays } from 'apache-arrow';
import { tick } from 'svelte';
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function flushPlayResolution(): Promise<void> {
  await Promise.resolve();
  await tick();
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

  it('stops zero-duration scheduled rows so an unmatched attack cannot leak', async () => {
    const table = tableFromArrays({
      seconds: [0],
      note: [60],
      velocity: [127],
      kind: ['note_on'],
    });
    const engine = fakeEngine();
    render(AudioViewer, { table, engineFactory: () => engine, onclose: vi.fn() });
    await vi.waitFor(() => expect(engine.load).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));

    await vi.advanceTimersByTimeAsync(100);

    expect(engine.stop).toHaveBeenCalledOnce();
  });

  it('keeps Play idle when Stop invalidates a deferred play', async () => {
    const table = tableFromArrays({
      seconds: [0.5, 1.25],
      note: [60, 60],
      velocity: [127, 0],
      kind: ['note_on', 'note_off'],
    });
    const pendingPlay = deferred();
    const engine = fakeEngine();
    vi.mocked(engine.play).mockImplementation(() => pendingPlay.promise);
    render(AudioViewer, { table, engineFactory: () => engine, onclose: vi.fn() });
    await vi.waitFor(() => expect(engine.load).toHaveBeenCalledOnce());

    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    vi.useFakeTimers();
    pendingPlay.resolve();
    await flushPlayResolution();

    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    vi.mocked(engine.positionSeconds).mockClear();
    await vi.advanceTimersByTimeAsync(200);
    expect(engine.positionSeconds).not.toHaveBeenCalled();
  });

  it('keeps Play idle when a result replacement invalidates a deferred play', async () => {
    const firstTable = tableFromArrays({
      seconds: [1],
      note: [60],
      velocity: [127],
      kind: ['note_on'],
    });
    const replacementTable = tableFromArrays({
      seconds: [2],
      note: [72],
      velocity: [127],
      kind: ['note_on'],
    });
    const pendingPlay = deferred();
    const engine = fakeEngine();
    vi.mocked(engine.play).mockImplementation(() => pendingPlay.promise);
    const view = render(AudioViewer, {
      table: firstTable,
      engineFactory: () => engine,
      onclose: vi.fn(),
    });
    await vi.waitFor(() => expect(engine.load).toHaveBeenCalledOnce());

    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await view.rerender({ table: replacementTable, engineFactory: () => engine, onclose: vi.fn() });
    await vi.waitFor(() => expect(engine.load).toHaveBeenCalledTimes(2));
    vi.useFakeTimers();
    pendingPlay.resolve();
    await flushPlayResolution();

    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    vi.mocked(engine.positionSeconds).mockClear();
    await vi.advanceTimersByTimeAsync(200);
    expect(engine.positionSeconds).not.toHaveBeenCalled();
  });

  it('lets only the newest deferred Play update the UI and keeps it idle after Pause', async () => {
    const table = tableFromArrays({
      seconds: [1],
      note: [60],
      velocity: [127],
      kind: ['note_on'],
    });
    const stalePlay = deferred();
    const newestPlay = deferred();
    const engine = fakeEngine();
    vi.mocked(engine.play)
      .mockImplementationOnce(() => stalePlay.promise)
      .mockImplementationOnce(() => newestPlay.promise);
    render(AudioViewer, { table, engineFactory: () => engine, onclose: vi.fn() });
    await vi.waitFor(() => expect(engine.load).toHaveBeenCalledOnce());

    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    newestPlay.resolve();
    await flushPlayResolution();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    vi.useFakeTimers();
    stalePlay.resolve();
    await flushPlayResolution();

    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    vi.mocked(engine.positionSeconds).mockClear();
    await vi.advanceTimersByTimeAsync(200);
    expect(engine.positionSeconds).not.toHaveBeenCalled();
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
