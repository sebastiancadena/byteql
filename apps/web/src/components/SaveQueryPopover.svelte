<script lang="ts">
  /* global HTMLElement, HTMLInputElement, KeyboardEvent */
  import { onMount } from 'svelte';

  import { defaultQueryName } from '../lib/queries/display.js';
  import type { QueryLibrary } from '../lib/queries/library.js';
  import type { SavedQuery } from '../lib/queries/types.js';
  import { containFocus } from '../lib/ui/focus.js';

  interface Props {
    library: QueryLibrary;
    format: string;
    sql: string;
    /** The saved query the editor was last loaded from, if it belongs to `format`. */
    loaded: SavedQuery | null;
    onsaved: (query: SavedQuery) => void;
    onclose: () => void;
  }

  let { library, format, sql, loaded, onsaved, onclose }: Props = $props();
  let panel = $state<HTMLElement>();
  let input = $state<HTMLInputElement>();
  // Seeded once from the props when the popover opens; the user edits it from there.
  // svelte-ignore state_referenced_locally
  let name = $state(loaded?.name ?? defaultQueryName(sql));

  // svelte-ignore state_referenced_locally
  const unchanged = loaded !== null && loaded.sql === sql;
  // svelte-ignore state_referenced_locally
  const offerUpdate = loaded !== null && !unchanged;

  onMount(() => {
    input?.select();
    input?.focus();
  });

  $effect(() => {
    const element = panel;
    if (!element) return;
    return containFocus(element, onclose);
  });

  function saveNew(): void {
    onsaved(library.save({ format, name, sql }));
  }

  function update(): void {
    // A query deleted in another tab cannot be updated; keep the user's work as a new query.
    const updated = loaded ? library.update(loaded.id, { name, sql }) : null;
    onsaved(updated ?? library.save({ format, name, sql }));
  }

  function primary(): void {
    if (unchanged) return;
    if (offerUpdate) update();
    else saveNew();
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      primary();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
  }
</script>

<div bind:this={panel} class="save-query-popover" role="dialog" aria-label="Save query" tabindex="-1">
  <label>
    <span>Query name</span>
    <input bind:this={input} bind:value={name} type="text" maxlength="200" onkeydown={keydown} />
  </label>
  <div class="save-query-actions">
    {#if unchanged}
      <button class="button button-primary button-compact" type="button" disabled>Already saved</button>
    {:else if offerUpdate}
      <button class="button button-primary button-compact" type="button" onclick={update}>
        Update "{loaded?.name}"
      </button>
      <button class="button button-secondary button-compact" type="button" onclick={saveNew}
        >Save as new</button
      >
    {:else}
      <button class="button button-primary button-compact" type="button" onclick={saveNew}>Save</button>
    {/if}
    <button class="button button-secondary button-compact" type="button" onclick={onclose}>Cancel</button>
  </div>
</div>

<style>
  .save-query-popover {
    z-index: var(--layer-popover);
    position: absolute;
    top: calc(100% + var(--space-1));
    right: 0;
    display: grid;
    gap: var(--space-2);
    min-width: 18rem;
    padding: var(--space-2);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-overlay);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-overlay);
  }

  .save-query-popover label {
    display: grid;
    gap: var(--space-1);
    font-size: var(--text-sm);
  }

  .save-query-popover input {
    min-height: var(--control-height);
    padding: 0 var(--space-2);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-control);
    color: var(--color-text);
    background: var(--color-surface);
    font: inherit;
  }

  .save-query-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: flex-end;
  }
</style>
