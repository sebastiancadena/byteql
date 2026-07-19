<script lang="ts">
  import type { SessionState } from '../lib/session/state.js';

  interface Props {
    state: SessionState;
  }

  let { state }: Props = $props();

  const statusLabel = $derived(
    state.phase === 'idle'
      ? 'Ready for a local source'
      : state.phase === 'ready'
        ? 'Ready'
        : state.phase === 'querying'
          ? 'Query running'
          : state.phase === 'failed'
            ? 'Session failed'
            : (state.progress?.label ?? 'Preparing session'),
  );

  // Percentage is generic: it applies to any bounded progress, byte-based or not (e.g. MIDI
  // track counts), so it only requires a non-null total.
  const progressPercent = $derived(
    state.progress && state.progress.total !== null && state.progress.total > 0
      ? Math.floor(Math.min(100, (100 * state.progress.completed) / state.progress.total))
      : null,
  );

  // MB/s only makes sense once the total is byte-sized (>= 1 MB) and enough wall-clock time has
  // elapsed since the open began for the rate to be meaningful (not dominated by startup noise).
  const progressRate = $derived.by(() => {
    const { progress, openStartedAt } = state;
    if (!progress || progress.total === null || progress.total < 1_000_000) return null;
    if (openStartedAt === null) return null;
    const elapsedMs = Date.now() - openStartedAt;
    if (elapsedMs < 500) return null;
    const megabytes = progress.completed / 1e6;
    const seconds = elapsedMs / 1000;
    return `${(megabytes / seconds).toFixed(1)} MB/s`;
  });

  const formatByteRange = ({ start, end }: { start: number; end: number }): string =>
    `0x${start.toString(16)}–0x${(end - 1).toString(16)} · ${end - start} bytes`;
</script>

<footer class="status-bar">
  <div class="status-primary">
    <span
      class:active={state.phase !== 'idle' && state.phase !== 'failed'}
      class:failed={state.phase === 'failed'}
      class="status-dot"
    ></span>
    <span>{statusLabel}</span>
  </div>
  <div class="status-metrics">
    {#if progressPercent !== null}
      <span>{progressPercent}%</span>
    {/if}
    {#if progressRate !== null}
      <span>{progressRate}</span>
    {/if}
    {#if state.result}
      <span>{state.result.numRows.toLocaleString()} rows</span>
    {/if}
    {#if state.queryElapsedMs !== null}
      <span>{state.queryElapsedMs.toFixed(1)} ms</span>
    {/if}
    {#if state.byteSelection}
      <span class="tabular">{formatByteRange(state.byteSelection)}</span>
    {/if}
    <span>Local processing</span>
  </div>
</footer>
