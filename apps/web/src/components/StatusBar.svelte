<script lang="ts">
  import type { SessionState } from '../lib/session/state.js';
  import { formatByteRange } from '../lib/ui/trace.js';

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

  const fileMarker = $derived(
    state.progress && state.progress.fileCount > 1
      ? ` (${state.progress.fileIndex}/${state.progress.fileCount})`
      : '',
  );

  const skippedCount = $derived(state.issues.filter((issue) => issue.code === 'FILE_SKIPPED').length);
  const batchSummary = $derived.by(() => {
    if (!state.source || state.source.files.length <= 1) return null;
    const megabytes = (state.source.totalSize / 1e6).toFixed(1);
    const base = `${state.source.files.length} files · ${megabytes} MB`;
    return skippedCount > 0 ? `${base} · ${skippedCount} skipped` : base;
  });

  // One shared range formatter, so the footer, the values list and the trace strip can never
  // disagree about which bytes a selection covers.
  const selectionLabel = $derived(
    state.byteSelection ? formatByteRange(state.byteSelection.start, state.byteSelection.end) : null,
  );
</script>

<footer class="status-bar">
  <!-- Only the phase is announced. Throughput and timings change continuously; putting them in
       a live region would narrate every tick of a parse. -->
  <div class="status-primary" aria-live="polite">
    <span
      class:active={state.phase !== 'idle' && state.phase !== 'failed'}
      class:failed={state.phase === 'failed'}
      class="status-dot"
    ></span>
    <span>{statusLabel}{fileMarker}</span>
    {#if state.phase === 'ready' && batchSummary}
      <span>{batchSummary}</span>
    {/if}
  </div>
  <div class="status-metrics" aria-live="off">
    {#if progressPercent !== null}
      <span>{progressPercent}%</span>
    {/if}
    {#if progressRate !== null}
      <span>{progressRate}</span>
    {/if}
    {#if state.result}
      <span>
        {state.result.complete
          ? `${state.result.loadedRows.toLocaleString()} rows`
          : `${state.result.loadedRows.toLocaleString()} loaded · more available`}
      </span>
      <span>{state.result.elapsedMs.toFixed(1)} ms {state.result.complete ? 'total' : 'streaming'}</span>
    {/if}
    {#if selectionLabel}
      <span class="tabular" title="Inclusive byte offsets in the source file">{selectionLabel}</span>
    {/if}
    <span>Local processing</span>
  </div>
</footer>
