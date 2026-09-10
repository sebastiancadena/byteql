<script lang="ts">
  /* global HTMLElement */
  import { popoverMenu } from '../lib/ui/menu.js';
  import type { ViewerCapability } from '../lib/viewers/registry.js';

  interface Props {
    viewers: readonly ViewerCapability[];
    onselect: (viewer: ViewerCapability) => void;
  }

  let { viewers, onselect }: Props = $props();
  let open = $state(false);
  let menu = $state<HTMLElement | null>(null);

  $effect(() => {
    const element = menu;
    if (!open || !element) return;
    return popoverMenu(element, () => (open = false));
  });

  function select(viewer: ViewerCapability): void {
    open = false;
    onselect(viewer);
  }
</script>

{#if viewers.length > 0}
  <div class="viewer-menu">
    <button
      class="button button-secondary button-compact"
      type="button"
      aria-expanded={open}
      onclick={() => (open = !open)}>Open in…</button
    >
    {#if open}
      <div bind:this={menu} class="viewer-options" role="menu" aria-label="Compatible viewers">
        {#each viewers as viewer (viewer.id)}
          <button type="button" role="menuitem" onclick={() => select(viewer)}>{viewer.label}</button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .viewer-menu {
    position: relative;
  }

  .viewer-options {
    z-index: var(--layer-popover);
    position: absolute;
    top: calc(100% + var(--space-1));
    right: 0;
    min-width: 10rem;
    padding: var(--space-1);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-overlay);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-overlay);
  }

  .viewer-options button {
    width: 100%;
    min-height: var(--control-height);
    padding: var(--space-2);
    border: 0;
    border-radius: var(--radius-control);
    color: var(--color-text);
    background: transparent;
    font-size: var(--text-md);
    text-align: left;
    cursor: pointer;
  }

  .viewer-options button:hover,
  .viewer-options button:focus-visible {
    background: var(--color-surface-hover);
  }
</style>
