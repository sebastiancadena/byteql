<script lang="ts">
  /* global HTMLElement */
  // Test-only harness: snippets cannot be passed through Testing Library's props, so this
  // supplies two identifiable panels and forwards every other prop unchanged.
  import type { TraceSummary } from '../lib/ui/trace.js';
  import TraceDock from './TraceDock.svelte';

  interface Props {
    summary: TraceSummary;
    collapsed: boolean;
    oncollapsedchange: (collapsed: boolean) => void;
    compact: boolean;
    showValues: boolean;
    tab: 'values' | 'bytes';
    ontabchange: (tab: 'values' | 'bytes') => void;
    onreveal: () => void;
    resultsElement?: HTMLElement | null;
  }

  let { resultsElement = null, ...rest }: Props = $props();
</script>

{#snippet values()}
  <p data-testid="values-panel">values</p>
{/snippet}

{#snippet bytes()}
  <p data-testid="bytes-panel">bytes</p>
{/snippet}

<TraceDock {...rest} {resultsElement} {values} {bytes} />
