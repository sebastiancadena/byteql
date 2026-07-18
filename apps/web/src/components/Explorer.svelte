<script lang="ts">
  import type { SessionState } from '../lib/session/state.js';

  interface QueryDefinition {
    id: string;
    title: string;
    sql: string;
  }

  interface Props {
    state: SessionState;
    queries?: readonly QueryDefinition[];
    collapsed?: boolean;
    onquery: (sql: string) => void;
  }

  let { state, queries = [], collapsed = false, onquery }: Props = $props();
</script>

<nav class:collapsed class="explorer" aria-label="Data explorer">
  <div class="pane-heading">
    <div>
      <p class="eyebrow">Session</p>
      <h2>Explorer</h2>
    </div>
  </div>

  {#if state.source}
    <section class="explorer-section" aria-labelledby="source-heading">
      <h3 id="source-heading">Source</h3>
      <div class="source-card">
        <span class="file-glyph" aria-hidden="true">◇</span>
        <div class="min-width-zero">
          <strong class="truncate">{state.source.name}</strong>
          <span>{state.source.size.toLocaleString()} bytes</span>
        </div>
      </div>
      {#if state.format}
        <span class="format-badge">{state.format.title}</span>
      {/if}
    </section>
  {/if}

  {#if state.tables.length > 0}
    <section class="explorer-section" aria-labelledby="tables-heading">
      <div class="section-title-row">
        <h3 id="tables-heading">Tables</h3>
        <span>{state.tables.length}</span>
      </div>
      <ul class="table-list">
        {#each state.tables as table (table.name)}
          <li>
            <details>
              <summary>
                <span class="table-name"><span aria-hidden="true">▦</span> {table.name}</span>
                <span class="row-count">{table.rowCount.toLocaleString()} rows</span>
              </summary>
              <dl class="schema-list">
                {#each table.columns as column (column.name)}
                  <div>
                    <dt>{column.name}</dt>
                    <dd>{column.type}{column.nullable ? '?' : ''}</dd>
                  </div>
                {/each}
              </dl>
            </details>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if queries.length > 0}
    <section class="explorer-section query-section" aria-labelledby="queries-heading">
      <h3 id="queries-heading">Saved queries</h3>
      <ul class="query-list">
        {#each queries as query (query.id)}
          <li>
            <button type="button" onclick={() => onquery(query.sql)}>
              <span aria-hidden="true">↗</span>
              <span>{query.title}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if state.issues.length > 0}
    <section class="explorer-section issue-summary" aria-label="Parse diagnostics">
      <strong>{state.issues.length} parse {state.issues.length === 1 ? 'diagnostic' : 'diagnostics'}</strong>
      <span>Partial data may still be queryable.</span>
    </section>
  {/if}
</nav>
