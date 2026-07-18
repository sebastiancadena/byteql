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
</script>

<footer class="status-bar">
  <div class="status-primary">
    <span class:active={state.phase !== 'idle' && state.phase !== 'failed'} class="status-dot"></span>
    <span>{statusLabel}</span>
  </div>
  <div class="status-metrics">
    {#if state.result}
      <span>{state.result.numRows.toLocaleString()} rows</span>
    {/if}
    {#if state.queryElapsedMs !== null}
      <span>{state.queryElapsedMs.toFixed(1)} ms</span>
    {/if}
    <span>Local processing</span>
  </div>
</footer>
