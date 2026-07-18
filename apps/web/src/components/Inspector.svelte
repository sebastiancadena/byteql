<script lang="ts">
  import type { Table } from 'apache-arrow';

  interface Props {
    table?: Table | null;
    selectedRow?: number | null;
    collapsed?: boolean;
    mobileOpen?: boolean;
  }

  let { table = null, selectedRow = null, collapsed = false, mobileOpen = false }: Props = $props();

  const provenanceNames = new Set(['_src_start', '_src_end']);

  function valueAt(columnIndex: number): unknown {
    if (!table || selectedRow === null) return null;
    return table.getChildAt(columnIndex)?.get(selectedRow) ?? null;
  }

  function formatValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) {
      return Array.from(value.subarray(0, 32), (byte) => byte.toString(16).padStart(2, '0')).join(' ');
    }
    const text = String(value);
    return text.length > 100 ? `${text.slice(0, 100)}…` : text;
  }
</script>

<aside class:collapsed class:mobile-open={mobileOpen} class="inspector" aria-label="Inspector">
  <div class="pane-heading inspector-heading">
    <div>
      <p class="eyebrow">Context</p>
      <h2>Inspector</h2>
    </div>
    {#if selectedRow !== null}
      <span class="selection-chip">Row {selectedRow + 1}</span>
    {/if}
  </div>

  {#if table && selectedRow !== null}
    <section class="inspector-section" aria-labelledby="values-heading">
      <h3 id="values-heading">Values</h3>
      <dl class="value-list">
        {#each table.schema.fields as field, columnIndex (field.name)}
          {#if !provenanceNames.has(field.name)}
            <div>
              <dt>{field.name}</dt>
              <dd class:null-value={valueAt(columnIndex) === null}>{formatValue(valueAt(columnIndex))}</dd>
            </div>
          {/if}
        {/each}
      </dl>
    </section>

    <section class="inspector-section provenance" aria-labelledby="provenance-heading">
      <p class="eyebrow">Original source</p>
      <h3 id="provenance-heading">Provenance</h3>
      <dl>
        {#each table.schema.fields as field, columnIndex (field.name)}
          {#if provenanceNames.has(field.name)}
            <div>
              <dt>{field.name}</dt>
              <dd>{formatValue(valueAt(columnIndex))}</dd>
            </div>
          {/if}
        {/each}
      </dl>
    </section>
  {:else if table}
    <section class="inspector-section" aria-labelledby="schema-heading">
      <h3 id="schema-heading">Result schema</h3>
      <p class="muted-copy">Select a result row to inspect its values and source range.</p>
      <dl class="schema-inspector">
        {#each table.schema.fields as field (field.name)}
          <div>
            <dt>{field.name}</dt>
            <dd>{field.type.toString()}</dd>
          </div>
        {/each}
      </dl>
    </section>
  {:else}
    <div class="inspector-placeholder">
      <span aria-hidden="true">◇</span>
      <p>Run a query, then select a row to inspect its values and source range.</p>
    </div>
  {/if}
</aside>
