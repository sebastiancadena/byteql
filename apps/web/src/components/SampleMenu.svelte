<script lang="ts">
  /* global HTMLElement */
  import { SAMPLES, type SampleId } from '../lib/session/samples.js';
  import { popoverMenu } from '../lib/ui/menu.js';
  import Icon from './ui/Icon.svelte';

  interface Props {
    busy?: boolean;
    onselect: (id: SampleId) => void;
  }

  let { busy = false, onselect }: Props = $props();
  let open = $state(false);
  let menu = $state<HTMLElement | null>(null);

  $effect(() => {
    const element = menu;
    if (!open || !element) return;
    return popoverMenu(element, () => (open = false));
  });

  function choose(id: SampleId): void {
    open = false;
    onselect(id);
  }
</script>

<div class="sample-menu">
  <button
    class="button button-secondary"
    type="button"
    disabled={busy}
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    Try sample
    <span class="sample-menu-chevron"><Icon name="chevron" /></span>
  </button>
  {#if open}
    <div bind:this={menu} class="sample-options" role="menu" aria-label="Sample files">
      {#each SAMPLES as sample (sample.id)}
        <button type="button" role="menuitem" onclick={() => choose(sample.id)}>{sample.label}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .sample-menu {
    display: inline-block;
    position: relative;
  }

  .sample-menu-chevron {
    display: inline-flex;
    margin-left: var(--space-1);
    /* Points down at rest; the shared glyph is drawn pointing right. */
    transform: rotate(90deg);
  }

  .sample-options {
    z-index: var(--layer-popover);
    position: absolute;
    top: calc(100% + var(--space-1));
    left: 0;
    min-width: 13rem;
    padding: var(--space-1);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-overlay);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-overlay);
  }

  .sample-options button {
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

  .sample-options button:hover,
  .sample-options button:focus-visible {
    background: var(--color-surface-hover);
  }
</style>
