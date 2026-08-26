<script lang="ts">
  /* global HTMLDivElement, HTMLElement, KeyboardEvent */

  import { createVirtualizer } from '@tanstack/svelte-virtual';
  import type { Table } from 'apache-arrow';
  import { untrack } from 'svelte';

  interface Props {
    table: Table;
    selectedRow?: number | null;
    hiddenPrefix?: string;
    onselect: (row: number) => void;
  }

  let { table, selectedRow = null, hiddenPrefix = '_', onselect }: Props = $props();
  let scrollElement = $state<HTMLDivElement | null>(null);
  let showHidden = $state(false);
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: untrack(() => table.numRows),
    getScrollElement: () => scrollElement,
    estimateSize: () => 36,
    overscan: 8,
    initialRect: { width: 960, height: 360 },
  });

  const columns = $derived(
    table.schema.fields
      .map((field, index) => ({ field, index }))
      .filter(({ field }) => showHidden || !field.name.startsWith(hiddenPrefix)),
  );
  const hiddenCount = $derived(
    table.schema.fields.filter((field) => field.name.startsWith(hiddenPrefix)).length,
  );
  const gridColumns = $derived(`repeat(${Math.max(1, columns.length)}, minmax(9rem, 1fr))`);

  const numeric = (type: string): boolean => /^(u?int|float|decimal)/iu.test(type);

  $effect(() => {
    const row = selectedRow;
    if (row !== null) untrack(() => $virtualizer.scrollToIndex(row, { align: 'auto' }));
  });

  $effect(() => {
    const element = scrollElement;
    const count = table.numRows;
    untrack(() => $virtualizer.setOptions({ count, getScrollElement: () => element }));
  });

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
      const prefix = `${value.byteLength} B · `;
      return preview.length > 100 ? `${prefix}${preview.slice(0, 100)}…` : `${prefix}${preview}`;
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
  aria-colcount={table.schema.fields.length}
>
  <div class="grid-header" role="row" style:grid-template-columns={gridColumns}>
    {#each columns as { field, index } (field.name)}
      <div
        role="columnheader"
        aria-colindex={index + 1}
        title={field.type.toString()}
        class:cell-numeric={numeric(field.type.toString())}
      >
        <span>{field.name}</span>
        <small>{field.type.toString()}</small>
      </div>
    {/each}
    {#if hiddenCount > 0}
      <button
        class="hidden-chip"
        type="button"
        aria-label="Toggle hidden columns"
        aria-pressed={showHidden}
        onclick={() => (showHidden = !showHidden)}>{showHidden ? '− hide' : `+${hiddenCount} hidden`}</button
      >
    {/if}
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
          {#each columns as { field, index } (field.name)}
            {@const value = valueAt(virtualRow.index, index)}
            <div
              role="gridcell"
              aria-colindex={index + 1}
              class:null-value={value === null || value === undefined}
              class:cell-numeric={numeric(field.type.toString())}
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
