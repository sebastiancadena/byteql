<script lang="ts">
  /* global HTMLElement, KeyboardEvent, navigator */

  import { onMount } from 'svelte';

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();
  let panel = $state<HTMLElement>();

  const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl';

  const shortcuts: Array<{ action: string; keys: string }> = [
    { action: 'Run query', keys: `${mod}+Enter` },
    { action: 'Open file', keys: `${mod}+O` },
    { action: 'Go to offset', keys: `${mod}+G` },
    { action: 'Toggle explorer', keys: `${mod}+B` },
    { action: 'Toggle inspector', keys: `${mod}+I` },
    { action: 'Hex: move caret', keys: 'Arrows' },
    { action: 'Hex: extend selection', keys: 'Shift+Arrows' },
    { action: 'Hex: reveal row', keys: 'Enter' },
    { action: 'Hex: select record', keys: 'Double-click' },
    { action: 'Hex: copy bytes', keys: `${mod}+C` },
    { action: 'This overlay', keys: '?' },
  ];

  onMount(() => {
    panel?.focus();
  });

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
  }
</script>

<div class="shortcuts-backdrop">
  <div
    bind:this={panel}
    class="shortcuts-panel"
    role="dialog"
    aria-modal="true"
    aria-label="Keyboard shortcuts"
    tabindex="-1"
    {onkeydown}
  >
    <div class="shortcuts-heading">
      <h2>Keyboard shortcuts</h2>
      <button class="icon-button" type="button" aria-label="Close shortcuts" onclick={onclose}>×</button>
    </div>
    <dl class="shortcuts-list">
      {#each shortcuts as shortcut (shortcut.action)}
        <dt>{shortcut.action}</dt>
        <dd><kbd>{shortcut.keys}</kbd></dd>
      {/each}
    </dl>
  </div>
</div>

<style>
  .shortcuts-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 45%);
  }

  .shortcuts-panel {
    display: grid;
    gap: 1rem;
    width: min(28rem, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    overflow-y: auto;
    padding: 1.25rem 1.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-pane);
  }

  .shortcuts-panel:focus {
    outline: none;
  }

  .shortcuts-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .shortcuts-heading h2 {
    margin: 0;
    color: var(--color-text);
    font-size: 1rem;
  }

  .shortcuts-list {
    display: grid;
    grid-template-columns: 1fr auto;
    row-gap: 0.6rem;
    column-gap: 1rem;
    margin: 0;
  }

  .shortcuts-list dt {
    color: var(--color-text-muted);
    font-size: 0.8rem;
  }

  .shortcuts-list dd {
    margin: 0;
    text-align: right;
  }

  .shortcuts-list kbd {
    padding: 0.15rem 0.45rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    background: var(--color-surface-inset);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }
</style>
