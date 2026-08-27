<script lang="ts">
  import type { Table } from 'apache-arrow';

  import { provenanceOfRow } from '../lib/hex/coverage.js';
  import type { AudioEngine } from '../lib/viewers/tone-engine.js';
  import type { ViewerCapability } from '../lib/viewers/registry.js';
  import ViewerMenu from './ViewerMenu.svelte';

  interface Props {
    table?: Table | null;
    viewerTable?: Table | null;
    selectedRow?: number | null;
    selectedGlobalRow?: number | null;
    collapsed?: boolean;
    mobileOpen?: boolean;
    viewers?: readonly ViewerCapability[];
    activeViewer?: ViewerCapability | null;
    audioEngineFactory?: (() => AudioEngine) | undefined;
    onopenviewer?: (viewer: ViewerCapability) => void;
    oncloseviewer?: () => void;
    onrevealrange?: (range: { start: number; end: number }) => void;
  }

  let {
    table = null,
    viewerTable = null,
    selectedRow = null,
    selectedGlobalRow = null,
    collapsed = false,
    mobileOpen = false,
    viewers = [],
    activeViewer = null,
    audioEngineFactory,
    onopenviewer = () => undefined,
    oncloseviewer = () => undefined,
    onrevealrange = () => undefined,
  }: Props = $props();

  const provenanceNames = new Set(['_src_start', '_src_end']);

  const provenanceRange = $derived(
    table && selectedRow !== null ? provenanceOfRow(table, selectedRow) : null,
  );

  function valueAt(columnIndex: number): unknown {
    if (!table || selectedRow === null) return null;
    return table.getChildAt(columnIndex)?.get(selectedRow) ?? null;
  }

  function isNumeric(value: unknown): boolean {
    return typeof value === 'bigint' || typeof value === 'number';
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
      <p class="eyebrow">Selected evidence</p>
      <h2>Inspector</h2>
    </div>
    <div class="inspector-actions">
      {#if selectedGlobalRow !== null}
        <span class="selection-chip">Row {selectedGlobalRow + 1}</span>
      {/if}
      {#if viewers.length > 0}
        <ViewerMenu {viewers} onselect={onopenviewer} />
      {/if}
    </div>
  </div>

  {#if viewerTable && activeViewer}
    {@const Viewer = activeViewer.component}
    <Viewer table={viewerTable} engineFactory={audioEngineFactory} onclose={oncloseviewer} />
  {:else if table && selectedRow !== null}
    <section class="inspector-section" aria-labelledby="values-heading">
      <h3 id="values-heading">Values</h3>
      <dl class="value-list">
        {#each table.schema.fields as field, columnIndex (field.name)}
          {#if !provenanceNames.has(field.name)}
            {@const value = valueAt(columnIndex)}
            <div>
              <dt>{field.name}</dt>
              <dd class:null-value={value === null} class:tabular={isNumeric(value)}>{formatValue(value)}</dd>
            </div>
          {/if}
        {/each}
      </dl>
    </section>

    <section class="inspector-section provenance" aria-labelledby="provenance-heading">
      <p class="eyebrow">Original source</p>
      <h3 id="provenance-heading">Provenance</h3>
      {#if provenanceRange}
        <dl>
          <div>
            <dt>Source range</dt>
            <dd>
              <button
                class="provenance-link"
                type="button"
                onclick={() => onrevealrange(provenanceRange as { start: number; end: number })}
                >0x{provenanceRange.start.toString(16)} – 0x{provenanceRange.end.toString(16)}</button
              >
            </dd>
          </div>
        </dl>
      {:else}
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
      {/if}
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

<style>
  .inspector-actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
</style>
