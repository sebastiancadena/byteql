<script lang="ts">
  /* global HTMLDivElement, HTMLElement, KeyboardEvent */

  import type { ResultSort } from '@byteql/db';
  import { resultColumnLabel } from '@byteql/db/result-columns';
  import { createVirtualizer } from '@tanstack/svelte-virtual';
  import type { Table } from 'apache-arrow';
  import { untrack } from 'svelte';

  import {
    RESULT_ROW_HEIGHT,
    resultDemand,
    scrollCompensation,
    visibleResultRange,
  } from '../lib/session/result-scroll.js';
  import { fieldLabel, nextResultSort, sortActionLabel } from '../lib/session/result-sort.js';

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
    /** Bumped only when a new display order is committed; drives the in-place reset below. */
    orderRevision?: number;
    sort?: ResultSort | null;
    sortBusy?: boolean;
    sortInteractionBlocked?: boolean;
    sortDisabledReason?: string | null;
    onselect: (globalRow: number) => void;
    onloadmore: () => void;
    onloadwindow: (globalRow: number) => void;
    onretry: () => void;
    onsort?: (sort: ResultSort | null) => void;
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
    orderRevision = 0,
    sort = null,
    sortBusy = false,
    sortInteractionBlocked = false,
    sortDisabledReason = null,
    onselect,
    onloadmore,
    onloadwindow,
    onretry,
    onsort = () => undefined,
  }: Props = $props();
  let scrollElement = $state<HTMLDivElement | null>(null);
  let tailSentinel = $state<HTMLDivElement | null>(null);
  let showHidden = $state(false);
  let demandGuard: string | null = null;
  let demandSuppressed = false;
  let rebaseFrame: number | null = null;
  let demandFrame: number | null = null;
  let previousWindowStart = 0;
  /**
   * The scroll offset the last window rebase wrote. Held until the reader actually moves, so a
   * position the grid produced is never mistaken for the reader asking for earlier rows. Not
   * cleared by the rebase effect's teardown: Svelte runs that before every re-run, which would
   * drop the guard while the viewport is still parked where the rebase left it.
   */
  let rebaseTop: number | null = null;
  let hasPreviousWindowStart = false;
  /**
   * The revision this grid has already reset for. Shared with the scroll-compensation effect so an
   * order change never relies on which effect Svelte happens to run first.
   */
  let lastSeenRevision = untrack(() => orderRevision);
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: untrack(() => table.numRows),
    getScrollElement: () => scrollElement,
    estimateSize: () => RESULT_ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 960, height: 360 },
  });

  // `index` is the ORIGINAL schema position and survives hidden-field filtering: sorting and the
  // aria column indexes both address columns by it, and duplicate names make it the only safe key.
  const columns = $derived(
    table.schema.fields
      .map((field, index) => ({ field, index }))
      .filter(({ field }) => showHidden || !resultColumnLabel(field).startsWith(hiddenPrefix)),
  );
  const sortHelpId = 'result-sort-help';
  const sortUnavailable = $derived(sortDisabledReason !== null);
  const headerBlocked = (index: number): boolean =>
    sortInteractionBlocked || (nextResultSort(sort, index) !== null && sortUnavailable);
  const hiddenCount = $derived(
    table.schema.fields.filter((field) => resultColumnLabel(field).startsWith(hiddenPrefix)).length,
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

  /**
   * An order change replaces every row in place. The grid keeps its DOM, its mounted children and
   * its horizontal scroll, but everything that describes a position in the previous order — the
   * demand guard, the rebase anchor, the vertical offset — has to go.
   */
  $effect(() => {
    const revision = orderRevision;
    const element = scrollElement;
    if (revision === lastSeenRevision) return;
    lastSeenRevision = revision;
    if (demandFrame !== null) globalThis.cancelAnimationFrame(demandFrame);
    if (rebaseFrame !== null) globalThis.cancelAnimationFrame(rebaseFrame);
    demandFrame = null;
    rebaseFrame = null;
    demandGuard = null;
    rebaseTop = null;
    demandSuppressed = true;
    previousWindowStart = untrack(() => windowStart);
    hasPreviousWindowStart = true;
    const scrollLeft = element?.scrollLeft ?? 0;
    untrack(() => {
      $virtualizer.setOptions({ count: table.numRows, getScrollElement: () => element });
      $virtualizer.scrollToOffset(0);
    });
    if (element) {
      element.scrollTop = 0;
      // Horizontal position is about which COLUMNS the reader is looking at, which a reorder does
      // not change.
      element.scrollLeft = scrollLeft;
    }
    globalThis.requestAnimationFrame(() => {
      demandSuppressed = false;
      scheduleDemandInspection();
    });
  });

  $effect(() => {
    const nextStart = windowStart;
    const element = scrollElement;
    // The order-change effect above owns this transition; ordinary compensation would drag the
    // viewport toward a row position that no longer means anything.
    if (orderRevision !== lastSeenRevision) {
      previousWindowStart = nextStart;
      return;
    }
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
      rebaseTop = element.scrollTop;
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
    if (!first || !last || loadingMore || pageError || demandSuppressed || sortBusy) return;
    const physicalRange =
      scrollElement && scrollElement.clientHeight > 0
        ? visibleResultRange(scrollElement.scrollTop, scrollElement.clientHeight, table.numRows)
        : null;
    const firstVisible = physicalRange?.firstVisible ?? first.index;
    const lastVisible = physicalRange?.lastVisible ?? last.index;
    if (rebaseTop !== null && scrollElement && scrollElement.scrollTop !== rebaseTop) rebaseTop = null;
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
    // While the viewport is still parked exactly where a rebase put it, nobody has scrolled, so
    // there is no demand to infer in EITHER direction: paging backward would undo the rebase, and
    // paging forward from a rebase that happened to land at the window tail would run away from
    // the rows the reader was just taken to. Any real scroll clears this guard.
    if (rebaseTop !== null) return;
    const key = `${direction}:${windowStart + firstVisible}:${windowStart + lastVisible}`;
    if (demandGuard === key) return;
    demandGuard = key;
    if (direction === 'forward') {
      // Reading the next STORED window and fetching more cursor rows are different requests. A
      // sorted result is complete from the moment it exists, yet most of it is still ahead.
      const nextStoredRow = windowStart + table.numRows;
      if (nextStoredRow < loadedRows) onloadwindow(nextStoredRow);
      else if (!complete) onloadmore();
    } else onloadwindow(windowStart - 1);
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
    void windowStart;
    void loadedRows;
    void complete;
    void loadingMore;
    void pageError;
    scheduleDemandInspection();
  });

  $effect(() => {
    const sentinel = tailSentinel;
    const atLoadedTail = windowStart + table.numRows >= loadedRows;
    // A complete result whose window stops short of the loaded rows still has somewhere to go.
    if (
      !sentinel ||
      (complete && atLoadedTail) ||
      loadingMore ||
      pageError ||
      sortBusy ||
      !globalThis.IntersectionObserver
    ) {
      return;
    }
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
    if (sortBusy) return;
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
  aria-busy={loadingMore || sortBusy}
>
  <div class="grid-scroll" bind:this={scrollElement} onscroll={inspectAfterScroll}>
    <div class="grid-header" role="row" style:grid-template-columns={gridColumns}>
      {#each columns as { field, index } (index)}
        {@const active = sort?.columnIndex === index}
        {@const blocked = headerBlocked(index)}
        <div
          role="columnheader"
          aria-colindex={index + 1}
          aria-sort={active ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : undefined}
          title={field.type.toString()}
          class:cell-numeric={numeric(field.type.toString())}
          aria-label={`${fieldLabel(table.schema, index)} ${field.type.toString()}`}
        >
          <!-- The header is named explicitly because its only child is a button whose own label
               describes the sort ACTION. Without this the column a cell belongs to would be
               announced as "Sort note ascending" instead of "note Uint8". -->
          <button
            type="button"
            class="result-sort-button"
            data-column-index={index}
            aria-label={sortActionLabel(table.schema, sort, index)}
            aria-describedby={sortHelpId}
            aria-disabled={blocked}
            onclick={() => {
              if (headerBlocked(index)) return;
              onsort(nextResultSort(sort, index));
            }}
          >
            <span>{resultColumnLabel(field)}</span>
            <small>{field.type.toString()}</small>
            <svg
              width="12"
              height="16"
              viewBox="0 0 12 16"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              {#if !active || sort!.direction === 'asc'}<path d="M2 6 L6 2 L10 6" />{/if}
              {#if !active || sort!.direction === 'desc'}<path d="M2 10 L6 14 L10 10" />{/if}
            </svg>
          </button>
        </div>
      {/each}
      {#if hiddenCount > 0}
        <button
          class="hidden-chip"
          type="button"
          aria-label="Toggle hidden columns"
          aria-pressed={showHidden}
          onclick={() => (showHidden = !showHidden)}
          >{showHidden ? '− hide' : `+${hiddenCount} hidden`}</button
        >
      {/if}
    </div>

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
          onclick={() => {
            if (!sortBusy) onselect(globalRow);
          }}
          onkeydown={(event) => selectFromKeyboard(event, virtualRow.index)}
        >
          {#each columns as { field, index } (index)}
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
    {#if table.numRows === 0 && complete && !pageError}
      <!-- The schema headers above stay: an empty result still describes its shape. -->
      <p class="grid-empty">No rows returned. Adjust the query and run again.</p>
    {/if}

    <p id={sortHelpId} class="visually-hidden">
      Activating a column header sorts every row of this result: ascending, then descending, then the original
      query order.{sortDisabledReason ? ` ${sortDisabledReason}` : ''}
    </p>

    <div bind:this={tailSentinel} class="result-sentinel" role="status">
      {#if pageError}
        <span>{pageError}</span>
        {#if pageErrorRetryable}
          <button type="button" onclick={onretry}>Retry loading rows</button>
        {/if}
      {:else if loadingMore}
        <span class="activity-spinner" aria-hidden="true"></span>
        <span>Loading more rows</span>
      {:else if windowStart + table.numRows < loadedRows}
        <span>More stored rows</span>
      {:else if complete}
        <span>End of result · {loadedRows.toLocaleString()} rows</span>
      {:else}
        <span>More rows available</span>
      {/if}
    </div>
  </div>
</div>
