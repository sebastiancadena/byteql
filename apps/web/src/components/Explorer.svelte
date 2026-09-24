<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';

  import type { QueryLibrary } from '../lib/queries/library.js';
  import type { LibraryNotice } from '../lib/queries/notice.js';
  import type { SavedQuery } from '../lib/queries/types.js';
  import type { SessionState } from '../lib/session/state.js';
  import QueryLibraryPanel from './QueryLibraryPanel.svelte';
  import Icon from './ui/Icon.svelte';

  interface Props {
    state: SessionState;
    collapsed?: boolean;
    /** The source whose bytes the viewer is showing; marked, never inferred from selection. */
    currentFile?: string | null;
    onquery: (sql: string) => void;
    onbrowse: (table: string) => void;
    onselectsource?: (file: string) => void;
    library?: QueryLibrary | null;
    onloadquery?: (sql: string, saved: SavedQuery | null) => void;
    onsaverecent?: (sql: string) => void;
    onnotice?: (notice: LibraryNotice) => void;
  }

  // The public prop stays `state`; it is bound to another name because a local `state`
  // identifier would make the `$state` rune parse as a store read.
  let {
    state: session,
    collapsed = false,
    currentFile = null,
    onquery,
    onbrowse,
    onselectsource = () => undefined,
    library = null,
    onloadquery = () => undefined,
    onsaverecent = () => undefined,
    onnotice = () => undefined,
  }: Props = $props();

  const DIAGNOSTICS_CAP = 50;
  const shownIssues = $derived(session.issues.slice(0, DIAGNOSTICS_CAP));
  const extraIssueCount = $derived(Math.max(0, session.issues.length - DIAGNOSTICS_CAP));

  // Keyed by table name, but the DOM ids below come from the index — a table name is not a
  // safe id or CSS selector. SvelteSet makes membership changes reactive on mutation.
  let expandedTables = new SvelteSet<string>();

  function toggleSchema(name: string): void {
    if (!expandedTables.delete(name)) expandedTables.add(name);
  }

  // Only a new batch of sources resets what the user expanded.
  let lastSource: unknown;
  $effect(() => {
    if (session.source === lastSource) return;
    lastSource = session.source;
    expandedTables.clear();
  });

  function issueTable(issue: unknown): string | undefined {
    return (issue as { table?: string }).table;
  }
</script>

<nav class:collapsed class="explorer" aria-label="Data explorer">
  {#if session.source}
    <section class="explorer-section" aria-labelledby="source-heading">
      <h3 id="source-heading">Sources</h3>
      <ul class="source-list">
        {#each session.source.files as file (file.name)}
          <li>
            <button
              class="source-row"
              type="button"
              title={file.name}
              aria-current={file.name === currentFile ? 'true' : undefined}
              onclick={() => onselectsource(file.name)}
            >
              <span class="source-glyph" aria-hidden="true"><Icon name="file" /></span>
              <span class="min-width-zero">
                <span class="source-name truncate">{file.name}</span>
                <!-- The marker sits with the size, so the filename keeps the full row width.
                     It wraps rather than truncating: a half-shown state marker says nothing. -->
                <span class="source-meta">
                  {file.size.toLocaleString()} bytes{#if file.name === currentFile}<span
                      class="source-current">· Viewing bytes</span
                    >{/if}
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
      {#if session.format}
        <span class="format-badge">{session.format.title}</span>
      {/if}
    </section>
  {/if}

  {#if session.tables.length > 0}
    <section class="explorer-section" aria-labelledby="tables-heading">
      <div class="section-title-row">
        <h3 id="tables-heading">Tables</h3>
        <span>{session.tables.length}</span>
      </div>
      <ul class="table-list">
        {#each session.tables as table, tableIndex (table.name)}
          <li class="table-entry">
            <div class="table-entry-heading">
              <button
                class="table-disclosure"
                type="button"
                aria-expanded={expandedTables.has(table.name)}
                aria-controls={`schema-${tableIndex}`}
                onclick={() => toggleSchema(table.name)}
              >
                <span class="table-name truncate">{table.name}</span>
                <span class="row-count truncate">{table.rowCount.toLocaleString()} rows</span>
              </button>
              <button
                class="table-browse"
                type="button"
                aria-label={`Browse ${table.name}`}
                onclick={() => onbrowse(table.name)}>Browse</button
              >
            </div>
            <dl id={`schema-${tableIndex}`} hidden={!expandedTables.has(table.name)} class="schema-list">
              {#each table.columns as column (column.name)}
                <div>
                  <dt>{column.name}</dt>
                  <dd>{column.type}{column.nullable ? '?' : ''}</dd>
                </div>
              {/each}
            </dl>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if library && session.format}
    <QueryLibraryPanel {library} format={session.format.id} onload={onloadquery} {onsaverecent} {onnotice} />
  {/if}

  {#if session.queries.length > 0}
    <section class="explorer-section query-section" aria-labelledby="queries-heading">
      <h3 id="queries-heading">Example queries</h3>
      <ul class="query-list">
        {#each session.queries as query (query.id)}
          <li>
            <button type="button" onclick={() => onquery(query.sql)}>
              <span class="query-glyph" aria-hidden="true"><Icon name="arrow" /></span>
              <span class="truncate">{query.title}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if session.issues.length > 0}
    <section class="explorer-section issue-summary" aria-label="Parse diagnostics">
      <details>
        <summary>
          <strong
            >{session.issues.length} parse {session.issues.length === 1
              ? 'diagnostic'
              : 'diagnostics'}</strong
          >
          <span>Partial data may still be queryable.</span>
        </summary>
        <ul class="diagnostics-list">
          {#each shownIssues as issue, index (index)}
            <li>
              <span class="diagnostic-code">{issue.code}</span>
              {#if issueTable(issue)}
                <span class="diagnostic-table">{issueTable(issue)}</span>
              {/if}
              <span class="diagnostic-message">{issue.message}</span>
            </li>
          {/each}
          {#if extraIssueCount > 0}
            <li class="diagnostic-more">…and {extraIssueCount} more</li>
          {/if}
        </ul>
      </details>
    </section>
  {/if}
</nav>
