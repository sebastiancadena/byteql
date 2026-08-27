<script lang="ts">
  /* global HTMLDivElement, HTMLElement, KeyboardEvent */

  import { createVirtualizer } from '@tanstack/svelte-virtual';
  import type { Table } from 'apache-arrow';
  import { untrack } from 'svelte';

  import {
    RESULT_ROW_HEIGHT,
    resultDemand,
    scrollCompensation,
    visibleResultRange,
  } from '../lib/session/result-scroll.js';

  interface Props {
    table: Table;
    windowStart: number;
    loadedRows: number;
    complete: boolean;
    loadingMore: boolean;
    pageError: string | null;
    pageErrorRetryable: boolean;
    selectedRow?: number | null;
    hiddenPrefix?: string;
    onselect: (globalRow: number) => void;
    onloadmore: () => void;
    onloadwindow: (globalRow: number) => void;
    onretry: () => void;
  }

  let {
    table,
    windowStart,
    loadedRows,
    complete,
    loadingMore,
    pageError,
    pageErrorRetryable,
    selectedRow = null,
    hiddenPrefix = '_',
    onselect,
    onloadmore,
    onloadwindow,
    onretry,
  }: Props = $props();
  let scrollElement = $state<HTMLDivElement | null>(null);
  let tailSentinel = $state<HTMLDivElement | null>(null);
  let showHidden = $state(false);
  let demandGuard: string | null = null;
  let demandSuppressed = false;
  let rebaseFrame: number | null = null;
  let demandFrame: number | null = null;
  let previousWindowStart = 0;
  let hasPreviousWindowStart = false;
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: untrack(() => table.numRows),
    getScrollElement: () => scrollElement,
    estimateSize: () => RESULT_ROW_HEIGHT,
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
    const globalRow = selectedRow;
    const localRow = globalRow === null ? null : globalRow - windowStart;
    if (localRow !== null && localRow >= 0 && localRow < table.numRows) {
      untrack(() => $virtualizer.scrollToIndex(localRow, { align: 'auto' }));
    }
  });

  $effect(() => {
    const element = scrollElement;
    const count = table.numRows;
    untrack(() => $virtualizer.setOptions({ count, getScrollElement: () => element }));
  });

  $effect(() => {
    const nextStart = windowStart;
    const element = scrollElement;
    if (!hasPreviousWindowStart) {
      previousWindowStart = nextStart;
      hasPreviousWindowStart = true;
      return;
    }
    if (element && nextStart !== previousWindowStart) {
      if (demandFrame !== null) {
        globalThis.cancelAnimationFrame(demandFrame);
        demandFrame = null;
      }
      demandSuppressed = true;
      if (rebaseFrame !== null) globalThis.cancelAnimationFrame(rebaseFrame);
      const adjustment = scrollCompensation(previousWindowStart, nextStart, RESULT_ROW_HEIGHT);
      element.scrollTop = Math.max(0, element.scrollTop + adjustment);
      rebaseFrame = globalThis.requestAnimationFrame(() => {
        rebaseFrame = null;
        demandSuppressed = false;
      });
    }
    previousWindowStart = nextStart;
    return () => {
      if (rebaseFrame !== null) globalThis.cancelAnimationFrame(rebaseFrame);
      rebaseFrame = null;
      demandSuppressed = false;
    };
  });

  function inspectDemand(): void {
    const items = $virtualizer.getVirtualItems();
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last || loadingMore || pageError || demandSuppressed) return;
    const physicalRange =
      scrollElement && scrollElement.clientHeight > 0
        ? visibleResultRange(scrollElement.scrollTop, scrollElement.clientHeight, table.numRows)
        : null;
    const firstVisible = physicalRange?.firstVisible ?? first.index;
    const lastVisible = physicalRange?.lastVisible ?? last.index;
    const direction = resultDemand({
      firstVisible,
      lastVisible,
      windowStart,
      windowRows: table.numRows,
      loadedRows,
      complete,
    });
    if (!direction) {
      demandGuard = null;
      return;
    }
    const key = `${direction}:${windowStart + firstVisible}:${windowStart + lastVisible}`;
    if (demandGuard === key) return;
    demandGuard = key;
    if (direction === 'forward') onloadmore();
    else onloadwindow(windowStart - 1);
  }

  function inspectAfterScroll(): void {
    scheduleDemandInspection();
  }

  function scheduleDemandInspection(): void {
    if (demandFrame !== null) return;
    demandFrame = globalThis.requestAnimationFrame(() => {
      demandFrame = null;
      inspectDemand();
    });
  }

  $effect(() => {
    return () => {
      if (demandFrame !== null) globalThis.cancelAnimationFrame(demandFrame);
      demandFrame = null;
    };
  });

  $effect(() => {
    $virtualizer.getVirtualItems();
    windowStart;
    loadedRows;
    complete;
    loadingMore;
    pageError;
    scheduleDemandInspection();
  });

  $effect(() => {
    const sentinel = tailSentinel;
    if (!sentinel || complete || loadingMore || pageError || !globalThis.IntersectionObserver) return;
    const observer = new globalThis.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) inspectDemand();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
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

  function selectFromKeyboard(event: KeyboardEvent, localRow: number): void {
    let next = localRow;
    if (event.key === 'ArrowDown') next = Math.min(table.numRows - 1, localRow + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, localRow - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = table.numRows - 1;
    else if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onselect(windowStart + next);
    $virtualizer.scrollToIndex(next, { align: 'auto' });
    globalThis.requestAnimationFrame(() => {
      scrollElement?.querySelector<HTMLElement>(`[data-row-index="${windowStart + next}"]`)?.focus();
    });
  }
</script>

<div
  class="result-grid"
  role="grid"
  aria-label="Query results"
  aria-rowcount={complete ? loadedRows + 1 : -1}
  aria-colcount={table.schema.fields.length}
  aria-busy={loadingMore}
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

  <div class="grid-scroll" bind:this={scrollElement} onscroll={inspectAfterScroll}>
    <div class="grid-virtual-space" style:height={`${$virtualizer.getTotalSize()}px`}>
      {#each $virtualizer.getVirtualItems() as virtualRow (windowStart + virtualRow.index)}
        {@const globalRow = windowStart + virtualRow.index}
        <div
          class:selected={selectedRow === globalRow}
          class="grid-row"
          role="row"
          aria-label={`Row ${globalRow + 1}`}
          aria-rowindex={globalRow + 2}
          aria-selected={selectedRow === globalRow}
          tabindex={selectedRow === globalRow || (selectedRow === null && virtualRow.index === 0) ? 0 : -1}
          data-row-index={globalRow}
          style:grid-template-columns={gridColumns}
          style:transform={`translateY(${virtualRow.start}px)`}
          onclick={() => onselect(globalRow)}
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
    <div bind:this={tailSentinel} class="result-sentinel" role="status">
      {#if pageError}
        <span>{pageError}</span>
        {#if pageErrorRetryable}
          <button type="button" onclick={onretry}>Retry loading rows</button>
        {/if}
      {:else if loadingMore}
        <span class="activity-spinner" aria-hidden="true"></span>
        <span>Loading more rows</span>
      {:else if complete}
        <span>End of result · {loadedRows.toLocaleString()} rows</span>
      {:else}
        <span>More rows available</span>
      {/if}
    </div>
  </div>
</div>
