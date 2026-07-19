<script lang="ts">
  interface Props {
    sourceName?: string | null;
    sourceSize?: number | null;
    formatTitle?: string | null;
    explorerCollapsed?: boolean;
    inspectorCollapsed?: boolean;
    ontoggleexplorer?: () => void;
    ontoggleinspector?: () => void;
    onopen?: (() => void) | undefined;
  }

  let {
    sourceName = null,
    sourceSize = null,
    formatTitle = null,
    explorerCollapsed = false,
    inspectorCollapsed = false,
    ontoggleexplorer = () => undefined,
    ontoggleinspector = () => undefined,
    onopen,
  }: Props = $props();

  function formatBytes(n: number): string {
    return n < 1e6
      ? `${(n / 1e3).toFixed(0)} KB`
      : n < 1e9
        ? `${(n / 1e6).toFixed(1)} MB`
        : `${(n / 1e9).toFixed(2)} GB`;
  }
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
    {#if onopen}
      <button class="button button-secondary button-compact" type="button" onclick={onopen}> Open </button>
    {/if}
  </div>

  <div class="header-context" aria-live="polite">
    {#if sourceName}
      <span class="source-chip">
        <span class="source-pulse" aria-hidden="true"></span>
        <span class="truncate">{sourceName}</span>
        {#if sourceSize != null}
          <span>{formatBytes(sourceSize)}</span>
        {/if}
        {#if formatTitle}
          <span>{formatTitle}</span>
        {/if}
      </span>
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
