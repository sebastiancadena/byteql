<script lang="ts">
  import type { Theme } from '../lib/ui/theme.js';
  import AppearanceToggle from './AppearanceToggle.svelte';
  import Icon from './ui/Icon.svelte';

  interface Props {
    sourceName?: string | null;
    sourceSize?: number | null;
    formatTitle?: string | null;
    explorerCollapsed?: boolean;
    inspectorCollapsed?: boolean;
    intakeBusy?: boolean;
    appearance: Theme;
    onappearancechange: (theme: Theme) => void;
    onshortcuts: () => void;
    /** Omitted while idle: the intake screen owns the only file action then. */
    onopen?: (() => void) | undefined;
    /** Omitted while idle: there is nothing to show or hide yet. */
    ontoggleexplorer?: (() => void) | undefined;
    ontoggleinspector?: (() => void) | undefined;
  }

  let {
    sourceName = null,
    sourceSize = null,
    formatTitle = null,
    explorerCollapsed = false,
    inspectorCollapsed = false,
    intakeBusy = false,
    appearance,
    onappearancechange,
    onshortcuts,
    onopen,
    ontoggleexplorer,
    ontoggleinspector,
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
    <a class="wordmark" href="/" aria-label="ByteQL home">
      <span>ByteQL</span>
    </a>
    <span class="product-kicker">Binary file workspace</span>
  </div>

  <div class="header-context" aria-live="polite">
    {#if sourceName}
      <span class="source-chip">
        <span class="truncate">{sourceName}</span>
        {#if sourceSize != null}
          <span>{formatBytes(sourceSize)}</span>
        {/if}
        {#if formatTitle}
          <span>{formatTitle}</span>
        {/if}
      </span>
    {/if}
  </div>

  <div class="header-actions">
    {#if onopen}
      <button
        class="button button-secondary button-compact"
        type="button"
        disabled={intakeBusy}
        onclick={onopen}
      >
        Open file
      </button>
    {/if}
    {#if ontoggleexplorer}
      <button
        class="icon-button"
        type="button"
        aria-label={explorerCollapsed ? 'Show sources' : 'Hide sources'}
        aria-pressed={!explorerCollapsed}
        onclick={ontoggleexplorer}
      >
        <Icon name="sources" />
      </button>
    {/if}
    {#if ontoggleinspector}
      <button
        class="icon-button"
        type="button"
        aria-label={inspectorCollapsed ? 'Show values' : 'Hide values'}
        aria-pressed={!inspectorCollapsed}
        onclick={ontoggleinspector}
      >
        <Icon name="values" />
      </button>
    {/if}
    <AppearanceToggle theme={appearance} onchange={onappearancechange} />
    <button class="icon-button" type="button" aria-label="Keyboard shortcuts" onclick={onshortcuts}>
      <Icon name="shortcuts" />
    </button>
  </div>
</header>
