<script lang="ts">
  /* global HTMLElement, HTMLInputElement, KeyboardEvent, navigator */
  import { tick } from 'svelte';

  import { relativeTime, sqlPreview } from '../lib/queries/display.js';
  import type { QueryLibrary } from '../lib/queries/library.js';
  import type { LibraryNotice } from '../lib/queries/notice.js';
  import type { SavedQuery } from '../lib/queries/types.js';
  import { popoverMenu } from '../lib/ui/menu.js';
  import Icon from './ui/Icon.svelte';

  interface Props {
    library: QueryLibrary;
    format: string;
    onload: (sql: string, saved: SavedQuery | null) => void;
    onsaverecent: (sql: string) => void;
    onnotice: (notice: LibraryNotice) => void;
  }

  let { library, format, onload, onsaverecent, onnotice }: Props = $props();

  let version = $state(0);
  $effect(() => library.subscribe(() => (version += 1)));

  const saved = $derived.by(() => {
    void version;
    return library.savedFor(format);
  });
  const history = $derived.by(() => {
    void version;
    return library.historyFor(format);
  });
  const persistHistory = $derived.by(() => {
    void version;
    return library.settings.persistHistory;
  });

  let menuFor = $state<string | null>(null);
  let menuElement = $state<HTMLElement | null>(null);
  let renaming = $state<string | null>(null);
  let renameValue = $state('');
  let renameInput = $state<HTMLInputElement | null>(null);
  /** Relative times are computed against this; refreshed whenever the list changes. */
  const now = $derived.by(() => {
    void version;
    return Date.now();
  });

  $effect(() => {
    const element = menuElement;
    if (menuFor === null || !element) return;
    return popoverMenu(element, () => (menuFor = null));
  });

  async function startRename(query: SavedQuery): Promise<void> {
    menuFor = null;
    renaming = query.id;
    renameValue = query.name;
    await tick();
    renameInput?.select();
    renameInput?.focus();
  }

  function renameKeydown(event: KeyboardEvent, query: SavedQuery): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      library.update(query.id, { name: renameValue });
      renaming = null;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      renaming = null;
    }
  }

  function remove(query: SavedQuery): void {
    menuFor = null;
    const removed = library.remove(query.id);
    if (removed) onnotice({ message: `Deleted ${removed.name}`, undo: () => library.restore(removed) });
  }

  async function copy(query: SavedQuery): Promise<void> {
    menuFor = null;
    try {
      await navigator.clipboard.writeText(query.sql);
      onnotice({ message: `Copied ${query.name}` });
    } catch {
      onnotice({ message: 'Copying needs clipboard permission.' });
    }
  }

  function outcome(status: 'ok' | 'error', rowCount: number | null): string {
    if (status === 'error') return 'error';
    return rowCount === null ? 'ok' : `ok · ${rowCount.toLocaleString()} rows`;
  }
</script>

<section class="explorer-section query-section" aria-labelledby="saved-queries-heading">
  <div class="query-library-heading">
    <h3 id="saved-queries-heading">Saved queries</h3>
    <!-- Import and Export controls are added in Task 7. -->
  </div>
  {#if !library.persistent}
    <p class="query-library-note">This browser is blocking storage — queries last until the tab closes.</p>
  {/if}
  {#if saved.length === 0}
    <p class="query-library-empty">Save a query to keep it for later visits.</p>
  {:else}
    <ul class="query-list">
      {#each saved as query (query.id)}
        <li class="saved-query-row">
          {#if renaming === query.id}
            <input
              bind:this={renameInput}
              bind:value={renameValue}
              class="saved-query-rename"
              type="text"
              maxlength="200"
              aria-label={`Rename ${query.name}`}
              onkeydown={(event) => renameKeydown(event, query)}
              onblur={() => (renaming = null)}
            />
          {:else}
            <button type="button" title={query.sql} onclick={() => onload(query.sql, query)}>
              <span class="query-glyph" aria-hidden="true"><Icon name="arrow" /></span>
              <span class="truncate">{query.name}</span>
            </button>
          {/if}
          <div class="saved-query-menu">
            <button
              class="saved-query-more"
              type="button"
              aria-label={`Actions for ${query.name}`}
              aria-expanded={menuFor === query.id}
              onclick={() => (menuFor = menuFor === query.id ? null : query.id)}>⋯</button
            >
            {#if menuFor === query.id}
              <div
                bind:this={menuElement}
                class="saved-query-options"
                role="menu"
                aria-label={`${query.name} actions`}
              >
                <button type="button" role="menuitem" onclick={() => startRename(query)}>Rename</button>
                <button type="button" role="menuitem" onclick={() => copy(query)}>Copy SQL</button>
                <button type="button" role="menuitem" onclick={() => remove(query)}>Delete</button>
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<section class="explorer-section query-section" aria-labelledby="recent-queries-heading">
  <details class="recent-queries">
    <summary><h3 id="recent-queries-heading">Recent</h3></summary>
    {#if history.length > 0}
      <ul class="query-list recent-list">
        {#each history as entry (entry.id)}
          <li class="recent-row">
            <button type="button" title={entry.sql} onclick={() => onload(entry.sql, null)}>
              <span class="truncate recent-sql">{sqlPreview(entry.sql)}</span>
              <span class="recent-meta"
                >{relativeTime(entry.ranAt, now)} · {outcome(entry.status, entry.rowCount)}</span
              >
            </button>
            <button
              class="recent-save"
              type="button"
              aria-label={`Save ${sqlPreview(entry.sql)}`}
              onclick={() => onsaverecent(entry.sql)}>Save</button
            >
          </li>
        {/each}
      </ul>
    {/if}
    <div class="recent-controls">
      <label class="recent-keep">
        <input
          type="checkbox"
          checked={persistHistory}
          onchange={(event) => library.setPersistHistory((event.currentTarget as HTMLInputElement).checked)}
        />
        <span>Keep history after this tab closes</span>
      </label>
      <p class="query-library-note">Stored only in this browser. SQL may contain sensitive values.</p>
      <button
        class="button button-secondary button-compact"
        type="button"
        onclick={() => library.clearHistory()}
      >
        Clear history
      </button>
    </div>
  </details>
</section>

<style>
  /* The Explorer's own `.query-list` rules are scoped to Explorer.svelte, so this panel repeats
     the minimal button/list rules it needs rather than reaching across component boundaries. */
  .query-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .query-list button {
    display: flex;
    width: 100%;
    min-width: 0;
    min-height: 32px;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border: 0;
    border-radius: var(--radius-control);
    color: var(--color-text);
    background: transparent;
    font-size: var(--text-md);
    text-align: left;
    cursor: pointer;
    transition: background var(--duration-quick) ease;
  }

  .query-list button:hover {
    background: var(--color-surface-hover);
  }

  .query-glyph {
    display: flex;
    flex: 0 0 auto;
    color: var(--color-text-subtle);
  }

  .query-library-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 0 var(--space-2);
  }

  .query-library-heading h3 {
    margin: 0;
  }

  .query-library-note,
  .query-library-empty {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .saved-query-row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .saved-query-row > button[type='button']:first-child {
    flex: 1 1 auto;
    min-width: 0;
  }

  .saved-query-rename {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 32px;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-control);
    color: var(--color-text);
    background: var(--color-surface);
    font-size: var(--text-md);
  }

  .saved-query-menu {
    position: relative;
    flex: 0 0 auto;
  }

  .saved-query-more {
    display: flex;
    min-width: 32px;
    min-height: 32px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: var(--radius-control);
    color: var(--color-text-subtle);
    background: transparent;
    cursor: pointer;
    transition: background var(--duration-quick) ease;
  }

  .saved-query-more:hover,
  .saved-query-more:focus-visible {
    background: var(--color-surface-hover);
  }

  .saved-query-options {
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

  .saved-query-options button {
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

  .saved-query-options button:hover,
  .saved-query-options button:focus-visible {
    background: var(--color-surface-hover);
  }

  .recent-queries summary {
    cursor: pointer;
    list-style: none;
  }

  .recent-queries summary::-webkit-details-marker {
    display: none;
  }

  .recent-queries summary h3 {
    display: inline-block;
    margin: 0 0 var(--space-2);
  }

  .recent-row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .recent-row > button[type='button']:first-child {
    flex: 1 1 auto;
    min-width: 0;
    display: grid;
  }

  .recent-sql {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .recent-meta {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .recent-save {
    flex: 0 0 auto;
    min-height: 32px;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-control);
    color: var(--color-text);
    background: var(--color-surface);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .recent-save:hover {
    background: var(--color-surface-hover);
  }

  .recent-controls {
    display: grid;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .recent-keep {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }
</style>
