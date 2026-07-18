<script lang="ts">
  /* global Event, HTMLInputElement */

  import type { Table } from 'apache-arrow';
  import { onDestroy, untrack } from 'svelte';

  import { ToneAudioEngine, type AudioEngine, type AudioRow } from '../lib/viewers/tone-engine.js';

  interface Props {
    table: Table;
    engineFactory?: (() => AudioEngine) | undefined;
    onclose: () => void;
  }

  let { table, engineFactory = () => new ToneAudioEngine(), onclose }: Props = $props();
  const engine = untrack(() => engineFactory());
  let rows = $state<readonly AudioRow[]>([]);
  let invalidRows = $state(0);
  let duration = $state(0);
  let elapsed = $state(0);
  let playing = $state(false);
  let error = $state<string | null>(null);
  let ticker: ReturnType<typeof globalThis.setInterval> | null = null;
  let playGeneration = 0;
  let disposed = false;

  $effect(() => {
    const parsed = parseRows(table);
    untrack(() => {
      invalidatePendingPlay();
      rows = parsed.rows;
      invalidRows = parsed.invalidRows;
      duration = parsed.duration;
      elapsed = 0;
      playing = false;
      error = null;
      stopTicker();
      void engine.load(parsed.rows).catch((reason: unknown) => {
        if (disposed) return;
        error = message(reason, 'The audio rows could not be loaded.');
      });
    });
  });

  onDestroy(disposeOnce);

  function numeric(value: unknown): number | null {
    if (typeof value !== 'number' && typeof value !== 'bigint') return null;
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : null;
  }

  function parseRows(value: Table): {
    rows: readonly AudioRow[];
    invalidRows: number;
    duration: number;
  } {
    const secondsColumn = value.getChild('seconds');
    const noteColumn = value.getChild('note');
    const velocityColumn = value.getChild('velocity');
    const kindColumn = value.getChild('kind');
    const channelColumn = value.getChild('channel');
    const valid: AudioRow[] = [];
    let invalid = 0;

    for (let index = 0; index < value.numRows; index += 1) {
      const seconds = numeric(secondsColumn?.get(index));
      const note = numeric(noteColumn?.get(index));
      const velocity = numeric(velocityColumn?.get(index));
      const kind = kindColumn?.get(index);
      const channelValue = channelColumn?.get(index);
      const channel = channelColumn ? numeric(channelValue) : null;
      if (
        seconds === null ||
        seconds < 0 ||
        note === null ||
        !Number.isInteger(note) ||
        note < 0 ||
        note > 127 ||
        velocity === null ||
        !Number.isInteger(velocity) ||
        velocity < 0 ||
        velocity > 127 ||
        (kind !== 'note_on' && kind !== 'note_off') ||
        (channelColumn !== null &&
          channelValue !== null &&
          channelValue !== undefined &&
          (channel === null || !Number.isInteger(channel) || channel < 0 || channel > 15))
      ) {
        invalid += 1;
        continue;
      }
      valid.push({ seconds, note, velocity, kind, channel });
    }

    return {
      rows: valid,
      invalidRows: invalid,
      duration: valid.reduce((maximum, row) => Math.max(maximum, row.seconds), 0),
    };
  }

  function message(reason: unknown, fallback: string): string {
    return reason instanceof Error && reason.message ? reason.message : fallback;
  }

  async function play(): Promise<void> {
    const generation = ++playGeneration;
    error = null;
    try {
      await engine.play();
      if (disposed || generation !== playGeneration) return;
      playing = true;
      startTicker();
    } catch (reason) {
      if (disposed || generation !== playGeneration) return;
      error = message(reason, 'Playback could not start. Check browser audio permissions and try again.');
    }
  }

  function pause(): void {
    invalidatePendingPlay();
    engine.pause();
    playing = false;
    elapsed = engine.positionSeconds();
    stopTicker();
  }

  function stop(): void {
    invalidatePendingPlay();
    engine.stop();
    playing = false;
    elapsed = 0;
    stopTicker();
  }

  function seek(event: Event): void {
    invalidatePendingPlay();
    const seconds = Number((event.currentTarget as HTMLInputElement).value);
    engine.seek(seconds);
    elapsed = seconds;
  }

  function startTicker(): void {
    stopTicker();
    ticker = globalThis.setInterval(() => {
      elapsed = Math.min(duration, engine.positionSeconds());
      if (rows.length > 0 && elapsed >= duration) {
        engine.stop();
        playing = false;
        stopTicker();
      }
    }, 100);
  }

  function stopTicker(): void {
    if (ticker !== null) globalThis.clearInterval(ticker);
    ticker = null;
  }

  function invalidatePendingPlay(): void {
    playGeneration += 1;
  }

  function disposeOnce(): void {
    if (disposed) return;
    invalidatePendingPlay();
    disposed = true;
    stopTicker();
    engine.dispose();
  }

  function close(): void {
    disposeOnce();
    onclose();
  }

  function formatTime(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }
</script>

<section class="audio-viewer" aria-labelledby="audio-viewer-heading">
  <div class="audio-viewer-heading">
    <div>
      <p class="eyebrow">Specialized viewer</p>
      <h3 id="audio-viewer-heading">Audio playback</h3>
    </div>
    <button class="icon-button" type="button" aria-label="Close audio viewer" onclick={close}>×</button>
  </div>

  <div class="audio-controls">
    {#if playing}
      <button class="button button-secondary button-compact" type="button" onclick={pause}>Pause</button>
    {:else}
      <button
        class="button button-primary button-compact"
        type="button"
        disabled={rows.length === 0}
        onclick={play}>Play</button
      >
    {/if}
    <button class="button button-secondary button-compact" type="button" onclick={stop}>Stop</button>
  </div>

  <label class="audio-seek">
    <span>Seek playback</span>
    <input
      type="range"
      aria-label="Seek playback"
      min="0"
      max={duration}
      step="0.01"
      value={elapsed}
      oninput={seek}
    />
  </label>

  <div class="audio-metrics" aria-live="polite">
    <span>{formatTime(elapsed)} / {formatTime(duration)}</span>
    <span>{rows.length.toLocaleString()} scheduled rows</span>
  </div>

  {#if invalidRows > 0}
    <p class="inline-diagnostic" role="alert">
      Skipped {invalidRows.toLocaleString()} invalid {invalidRows === 1 ? 'row' : 'rows'}. Query rows must use
      finite non-negative seconds, notes and velocities from 0–127, note_on or note_off kind, and optional
      channels from 0–15.
    </p>
  {/if}

  {#if error}
    <p class="inline-diagnostic" role="alert">{error}</p>
  {/if}
</section>

<style>
  .audio-viewer {
    display: grid;
    gap: 1rem;
    padding: 1rem 1.1rem;
    border-bottom: 1px solid var(--color-border);
  }

  .audio-viewer-heading,
  .audio-controls,
  .audio-metrics {
    display: flex;
    align-items: center;
  }

  .audio-viewer-heading,
  .audio-metrics {
    justify-content: space-between;
    gap: 0.75rem;
  }

  .audio-viewer-heading h3 {
    margin: 0.15rem 0 0;
    color: var(--color-text);
    font-size: 0.9rem;
  }

  .audio-controls {
    gap: 0.5rem;
  }

  .audio-seek {
    display: grid;
    gap: 0.45rem;
    color: var(--color-text-muted);
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .audio-seek input {
    width: 100%;
    accent-color: var(--color-accent);
  }

  .audio-metrics {
    color: var(--color-text-muted);
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
  }

  .inline-diagnostic {
    margin: 0;
    font-size: 0.72rem;
    line-height: 1.5;
  }
</style>
