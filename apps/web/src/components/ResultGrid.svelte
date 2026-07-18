<script lang="ts">
  /* global HTMLDivElement, HTMLElement, KeyboardEvent */

  import { createVirtualizer } from '@tanstack/svelte-virtual';
  import type { Table } from 'apache-arrow';
  import { untrack } from 'svelte';

  interface Props {
    table: Table;
    selectedRow?: number | null;
    onselect: (row: number) => void;
  }

  let { table, selectedRow = null, onselect }: Props = $props();
  let scrollElement: HTMLDivElement | null = null;
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: untrack(() => table.numRows),
    getScrollElement: () => scrollElement,
    estimateSize: () => 36,
    overscan: 8,
    initialRect: { width: 960, height: 360 },
  });

  const fields = $derived(table.schema.fields);
  const gridColumns = $derived(`repeat(${Math.max(1, fields.length)}, minmax(9rem, 1fr))`);

  function valueAt(row: number, column: number): unknown {
    return table.getChildAt(column)?.get(row) ?? null;
  }

  function formatValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) {
      const preview = Array.from(value.subarray(0, 32), (byte) => byte.toString(16).padStart(2, '0')).join(
        ' ',
      );
      return preview.length > 100 ? `${preview.slice(0, 100)}…` : preview;
    }
    const text = String(value);
    return text.length > 100 ? `${text.slice(0, 100)}…` : text;
  }

  function selectFromKeyboard(event: KeyboardEvent, row: number): void {
    let next = row;
    if (event.key === 'ArrowDown') next = Math.min(table.numRows - 1, row + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, row - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = table.numRows - 1;
    else if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onselect(next);
    $virtualizer.scrollToIndex(next, { align: 'auto' });
    globalThis.requestAnimationFrame(() => {
      scrollElement?.querySelector<HTMLElement>(`[data-row-index="${next}"]`)?.focus();
    });
  }
</script>

<div
  class="result-grid"
  role="grid"
  aria-label="Query results"
  aria-rowcount={table.numRows + 1}
  aria-colcount={fields.length}
>
  <div class="grid-header" role="row" style:grid-template-columns={gridColumns}>
    {#each fields as field, columnIndex (field.name)}
      <div role="columnheader" aria-colindex={columnIndex + 1} title={field.type.toString()}>
        <span>{field.name}</span>
        <small>{field.type.toString()}</small>
      </div>
    {/each}
  </div>

  <div class="grid-scroll" bind:this={scrollElement}>
    <div class="grid-virtual-space" style:height={`${$virtualizer.getTotalSize()}px`}>
      {#each $virtualizer.getVirtualItems() as virtualRow (virtualRow.key)}
        <div
          class:selected={selectedRow === virtualRow.index}
          class="grid-row"
          role="row"
          aria-label={`Row ${virtualRow.index + 1}`}
          aria-rowindex={virtualRow.index + 2}
          aria-selected={selectedRow === virtualRow.index}
          tabindex={selectedRow === virtualRow.index || (selectedRow === null && virtualRow.index === 0)
            ? 0
            : -1}
          data-row-index={virtualRow.index}
          style:grid-template-columns={gridColumns}
          style:transform={`translateY(${virtualRow.start}px)`}
          onclick={() => onselect(virtualRow.index)}
          onkeydown={(event) => selectFromKeyboard(event, virtualRow.index)}
        >
          {#each fields as field, columnIndex (field.name)}
            {@const value = valueAt(virtualRow.index, columnIndex)}
            <div
              role="gridcell"
              aria-colindex={columnIndex + 1}
              class:null-value={value === null || value === undefined}
              title={formatValue(value)}
            >
              {formatValue(value)}
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </div>
</div>
