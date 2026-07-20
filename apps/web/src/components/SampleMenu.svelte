<script lang="ts">
  import { SAMPLES, type SampleId } from '../lib/session/samples.js';

  interface Props {
    busy?: boolean;
    onselect: (id: SampleId) => void;
  }

  let { busy = false, onselect }: Props = $props();
  let open = $state(false);

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
    Try sample <span aria-hidden="true">▾</span>
  </button>
  {#if open}
    <div class="sample-options" role="menu" aria-label="Sample files">
      {#each SAMPLES as sample (sample.id)}
        <button type="button" role="menuitem" onclick={() => choose(sample.id)}>{sample.label}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .sample-menu {
    position: relative;
    display: inline-block;
  }

  .sample-options {
    position: absolute;
    z-index: 10;
    top: calc(100% + 0.3rem);
    left: 0;
    min-width: 13rem;
    padding: 0.3rem;
    border: 1px solid var(--color-border);
    border-radius: 0.45rem;
    background: var(--color-surface-raised);
    box-shadow: 0 0.7rem 1.5rem rgb(0 0 0 / 18%);
  }

  .sample-options button {
    width: 100%;
    padding: 0.55rem 0.65rem;
    border: 0;
    border-radius: 0.3rem;
    text-align: left;
    background: transparent;
    cursor: pointer;
  }

  .sample-options button:hover,
  .sample-options button:focus-visible {
    background: var(--color-surface-hover);
  }
</style>
