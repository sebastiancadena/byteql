<script lang="ts">
  interface Props {
    sourceName?: string | null;
    explorerCollapsed?: boolean;
    inspectorCollapsed?: boolean;
    ontoggleexplorer?: () => void;
    ontoggleinspector?: () => void;
  }

  let {
    sourceName = null,
    explorerCollapsed = false,
    inspectorCollapsed = false,
    ontoggleexplorer = () => undefined,
    ontoggleinspector = () => undefined,
  }: Props = $props();
</script>

<header class="app-header">
  <div class="header-leading">
    <button
      class="icon-button"
      type="button"
      aria-label={explorerCollapsed ? 'Show explorer' : 'Hide explorer'}
      aria-pressed={!explorerCollapsed}
      onclick={ontoggleexplorer}
    >
      <span aria-hidden="true">☷</span>
    </button>
    <a class="wordmark" href="/" aria-label="ByteQL home">ByteQL</a>
    <span class="product-kicker">Inspector Workbench</span>
  </div>

  <div class="header-context" aria-live="polite">
    {#if sourceName}
      <span class="source-pulse" aria-hidden="true"></span>
      <span class="truncate">{sourceName}</span>
    {:else}
      <span>Local session</span>
    {/if}
  </div>

  <button
    class="icon-button"
    type="button"
    aria-label={inspectorCollapsed ? 'Show inspector' : 'Hide inspector'}
    aria-pressed={!inspectorCollapsed}
    onclick={ontoggleinspector}
  >
    <span aria-hidden="true">◫</span>
  </button>
</header>
