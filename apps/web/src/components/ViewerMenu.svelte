<script lang="ts">
  import type { ViewerCapability } from '../lib/viewers/registry.js';

  interface Props {
    viewers: readonly ViewerCapability[];
    onselect: (viewer: ViewerCapability) => void;
  }

  let { viewers, onselect }: Props = $props();
  let open = $state(false);

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
      <div class="viewer-options" role="menu" aria-label="Compatible viewers">
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
    position: absolute;
    z-index: 10;
    top: calc(100% + 0.3rem);
    right: 0;
    min-width: 10rem;
    padding: 0.3rem;
    border: 1px solid var(--color-border);
    border-radius: 0.45rem;
    background: var(--color-surface-raised);
    box-shadow: 0 0.7rem 1.5rem rgb(0 0 0 / 18%);
  }

  .viewer-options button {
    width: 100%;
    padding: 0.55rem 0.65rem;
    border: 0;
    border-radius: 0.3rem;
    text-align: left;
    background: transparent;
    cursor: pointer;
  }

  .viewer-options button:hover,
  .viewer-options button:focus-visible {
    background: var(--color-surface-hover);
  }
</style>
