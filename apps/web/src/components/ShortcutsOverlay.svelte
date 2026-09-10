<script lang="ts">
  /* global HTMLElement, navigator */

  import { containFocus } from '../lib/ui/focus.js';
  import Icon from './ui/Icon.svelte';

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();
  let panel = $state<HTMLElement>();

  const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl';

  const shortcuts: Array<{ action: string; keys: string }> = [
    { action: 'Run query', keys: `${mod}+Enter` },
    { action: 'Open file', keys: `${mod}+O` },
    { action: 'Show or hide sources', keys: `${mod}+B` },
    { action: 'Show or hide values', keys: `${mod}+I` },
    { action: 'Inspect bytes at an offset', keys: `${mod}+G` },
    { action: 'Bytes: move caret', keys: 'Arrows' },
    { action: 'Bytes: extend selection', keys: 'Shift+Arrows' },
    { action: 'Bytes: reveal row', keys: 'Enter' },
    { action: 'Bytes: select record', keys: 'Double-click' },
    { action: 'Bytes: copy selection', keys: `${mod}+C` },
    { action: 'This overlay', keys: '?' },
  ];

  // A modal surface: Tab stays inside, Escape closes, and focus returns to the opener.
  $effect(() => {
    const element = panel;
    if (!element) return;
    return containFocus(element, onclose);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="shortcuts-backdrop"
  onclick={(event) => {
    if (event.target === event.currentTarget) onclose();
  }}
>
  <div
    bind:this={panel}
    class="shortcuts-panel"
    role="dialog"
    aria-modal="true"
    aria-label="Keyboard shortcuts"
    tabindex="-1"
  >
    <div class="shortcuts-heading">
      <h2>Keyboard shortcuts</h2>
      <button class="icon-button" type="button" aria-label="Close shortcuts" onclick={onclose}>
        <Icon name="close" />
      </button>
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
    z-index: var(--layer-dialog);
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 45%);
  }

  .shortcuts-panel {
    display: grid;
    width: min(28rem, calc(100vw - var(--space-6)));
    max-height: calc(100vh - var(--space-6));
    gap: var(--space-4);
    overflow-y: auto;
    padding: var(--space-4);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-overlay);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-overlay);
  }

  .shortcuts-panel:focus {
    outline: none;
  }

  .shortcuts-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .shortcuts-heading h2 {
    margin: 0;
    color: var(--color-text);
    font-size: var(--text-md);
    font-weight: 600;
  }

  .shortcuts-list {
    display: grid;
    grid-template-columns: 1fr auto;
    margin: 0;
    row-gap: var(--space-2);
    column-gap: var(--space-4);
  }

  .shortcuts-list dt {
    color: var(--color-text-muted);
    font-size: var(--text-md);
  }

  .shortcuts-list dd {
    margin: 0;
    text-align: right;
  }

  .shortcuts-list kbd {
    padding: 2px var(--space-2);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-control);
    color: var(--color-text);
    background: var(--color-surface-inset);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
</style>
