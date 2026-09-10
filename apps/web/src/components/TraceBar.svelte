<script lang="ts">
  import type { TraceSummary } from '../lib/ui/trace.js';

  interface Props {
    summary: TraceSummary;
    collapsed: boolean;
    onreveal: () => void;
    ontoggle: () => void;
  }

  let { summary, collapsed, onreveal, ontoggle }: Props = $props();
</script>

<!-- The signature strip: source file → SQL result → original bytes, stated in one line.
     It stays mounted while the dock below it is collapsed. -->
<div class="trace-bar" role="region" aria-label="Source trace" data-trace-state={summary.kind}>
  <div class="trace-readout">
    {#if summary.kind === 'linked'}
      <span class="trace-row">Row {summary.row.toLocaleString()}</span>
      <span class="trace-arrow" aria-hidden="true">→</span>
      <span class="trace-file truncate" title={summary.range.file}>{summary.range.file}</span>
      <span class="trace-arrow" aria-hidden="true">→</span>
      <span class="trace-range" title="Inclusive byte offsets in the source file">{summary.label}</span>
    {:else}
      <span class="trace-message">{summary.message}</span>
    {/if}
  </div>

  <div class="trace-actions">
    {#if summary.kind === 'linked'}
      <button class="button button-secondary button-compact" type="button" onclick={onreveal}>
        Inspect source
      </button>
    {/if}
    <button
      class="button button-quiet button-compact"
      type="button"
      aria-expanded={!collapsed}
      onclick={ontoggle}
    >
      {collapsed ? 'Show inspection' : 'Hide inspection'}
    </button>
  </div>
</div>
