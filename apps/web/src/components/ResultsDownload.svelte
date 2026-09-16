<script lang="ts">
  /* global HTMLButtonElement, HTMLElement, KeyboardEvent, Node, PointerEvent, document, navigator */

  import { tick } from 'svelte';

  import { selectExportColumns, type ExportFormat, type ExportOptions } from '../lib/export/options.js';
  import { isResultSorting } from '../lib/session/result-sort.js';
  import type { SessionController } from '../lib/session/controller.js';
  import type { SessionState } from '../lib/session/state.js';
  import { parquetColumnNames, type ParquetColumnName } from '@byteql/db/result-columns';
  import Icon from './ui/Icon.svelte';

  type DownloadController = Pick<
    SessionController,
    'downloadResults' | 'cancelResultsDownload' | 'saveResultsDownload' | 'dismissResultsDownload'
  >;

  interface Props {
    controller: DownloadController;
    session: SessionState;
  }

  let { controller, session }: Props = $props();
  let open = $state(false);
  let opener = $state<HTMLButtonElement>();
  let dialog = $state<HTMLElement>();
  let boundaryError = $state<string | null>(null);
  let options = $state<ExportOptions>({ format: 'csv', includeProvenance: true });

  const PARQUET_PREVIEW_ID = 'results-download-parquet-preview';

  const parquetAvailable = $derived(
    typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function',
  );
  const csvError = $derived(validationError('csv'));
  const parquetError = $derived(validationError('parquet'));
  const selectedError = $derived(options.format === 'csv' ? csvError : parquetError);
  const alternateFormat = $derived<ExportFormat>(options.format === 'csv' ? 'parquet' : 'csv');
  const alternateError = $derived.by(() => {
    const alternative = options.format === 'csv' ? parquetError : csvError;
    if (!alternative || !selectedError) return alternative;
    return alternative.replace(/^CSV: /u, '') === selectedError.replace(/^CSV: /u, '') ? null : alternative;
  });
  // Mirrors what the controller captures in downloadResults: same schema, same selection, same
  // allocator, so the preview can never drift from the file the click actually produces.
  const parquetColumnPreview = $derived.by<readonly ParquetColumnName[]>(() => {
    const result = session.result;
    if (!result || options.format !== 'parquet' || selectedError !== null) return [];
    try {
      // Defensive only: the selectedError !== null guard above already rules out the inputs that
      // could make selectExportColumns throw, and parquetColumnNames cannot throw on a selection
      // that function produced. Kept in case that invariant ever weakens.
      const selected = selectExportColumns(result.schema, options);
      return parquetColumnNames(result.schema, selected).filter((column) => column.label !== column.name);
    } catch {
      return [];
    }
  });
  const downloadDescribedBy = $derived(
    [
      selectedError ? disabledReasonId(options.format) : null,
      parquetColumnPreview.length > 0 ? PARQUET_PREVIEW_ID : null,
    ]
      .filter((id): id is string => id !== null)
      .join(' ') || undefined,
  );
  const download = $derived(session.download);
  const active = $derived(
    download !== null && ['picking', 'loading', 'encoding', 'saving'].includes(download.phase),
  );
  const terminal = $derived(
    download !== null && ['ready-to-save', 'saved', 'cancelled', 'failed'].includes(download.phase),
  );
  const formatDescriptionIds = $derived(
    [
      'results-download-format-help',
      selectedError ? disabledReasonId(options.format) : null,
      alternateError ? disabledReasonId(alternateFormat) : null,
    ]
      .filter((id): id is string => id !== null)
      .join(' '),
  );

  function disabledReasonId(format: ExportFormat): string {
    return `results-download-${format}-disabled-reason`;
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : 'The result could not be downloaded.';
  }

  function validationError(format: ExportFormat): string | null {
    const result = session.result;
    if (!result) return 'Run a query before downloading results.';
    if (!session.resultIsCurrent) return 'Run the query again before downloading results.';
    // A file is written from the order on display, so it cannot be started while that order is
    // being replaced.
    if (isResultSorting(session)) return 'Finish or cancel the sort before downloading results.';
    if (result.pageError) return 'Retry or rerun the query before downloading results.';
    if (format === 'parquet' && !parquetAvailable) {
      return 'Parquet requires OPFS, which is not available in this browser.';
    }

    try {
      selectExportColumns(result.schema, {
        format,
        includeProvenance: options.includeProvenance,
      });
      return null;
    } catch (error) {
      const detail = errorMessage(error);
      return format === 'csv' ? `CSV: ${detail}` : detail;
    }
  }

  function close(): void {
    open = false;
    void tick().then(() => opener?.focus());
  }

  function toggle(): void {
    if (open) {
      close();
      return;
    }

    open = true;
    void tick().then(() => dialog?.focus());
  }

  function handleKeys(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  }

  // Nonmodal: an outside click dismisses it, but Tab is never trapped and the rest of the
  // workspace stays reachable while it is open.
  $effect(() => {
    const panel = dialog;
    if (!open || !panel) return;
    const onPointerdown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && !panel.contains(target) && !opener?.contains(target)) close();
    };
    document.addEventListener('pointerdown', onPointerdown, true);
    return () => document.removeEventListener('pointerdown', onPointerdown, true);
  });

  function startDownload(): void {
    boundaryError = null;
    // Do not await before this call: destination acquisition must remain in the click gesture.
    void controller.downloadResults({ ...options }).catch((error: unknown) => {
      boundaryError = errorMessage(error);
    });
  }

  function cancelDownload(): void {
    boundaryError = null;
    void controller.cancelResultsDownload().catch((error: unknown) => {
      boundaryError = errorMessage(error);
    });
  }

  function dismissDownload(): void {
    boundaryError = null;
    void controller.dismissResultsDownload().catch((error: unknown) => {
      boundaryError = errorMessage(error);
    });
  }

  function statusMessage(): string {
    if (!download) return '';
    if (download.message) return download.message;
    switch (download.phase) {
      case 'picking':
        return 'Choosing where to save…';
      case 'loading':
        return 'Loading remaining rows…';
      case 'encoding':
        return `Preparing ${options.format === 'parquet' ? 'Parquet' : 'CSV'} file…`;
      case 'saving':
        return 'Saving file…';
      case 'cancelling':
        return 'Cancelling download…';
      case 'ready-to-save':
        return 'File ready. Choose Save file to download it.';
      case 'saved':
        return 'Download handed to the browser.';
      case 'cancelled':
        return 'Download cancelled.';
      case 'failed':
        return 'The result could not be downloaded.';
    }
  }
</script>

<div class="results-download">
  <button
    bind:this={opener}
    class="button button-secondary"
    type="button"
    disabled={!session.result}
    aria-describedby={!session.result ? 'results-download-unavailable' : undefined}
    aria-expanded={open}
    aria-controls="results-download-options"
    onclick={toggle}
  >
    Download results
  </button>

  {#if !session.result}
    <span id="results-download-unavailable" class="visually-hidden">
      Run a query before downloading results.
    </span>
  {/if}

  {#if open}
    <div
      bind:this={dialog}
      id="results-download-options"
      class="results-download-popover"
      role="dialog"
      aria-labelledby="results-download-title"
      tabindex="-1"
      onkeydown={handleKeys}
    >
      <div class="results-download-heading">
        <h3 id="results-download-title">Download results</h3>
        <button class="icon-button" type="button" aria-label="Close download options" onclick={close}>
          <Icon name="close" />
        </button>
      </div>

      {#if active || download?.phase === 'cancelling'}
        <p class="results-download-status" role="status">
          {statusMessage()}
          {#if download && download.rows > 0}
            <span>{download.rows.toLocaleString()} rows processed</span>
          {/if}
        </p>
        {#if active}
          <button class="button button-secondary" type="button" onclick={cancelDownload}>Cancel</button>
        {:else}
          <button class="button button-secondary" type="button" disabled>Cancelling…</button>
        {/if}
      {:else}
        <label for="results-download-format">Format</label>
        <select
          id="results-download-format"
          bind:value={options.format}
          aria-describedby={formatDescriptionIds}
        >
          <option value="csv" disabled={csvError !== null}>CSV</option>
          <option value="parquet" disabled={parquetError !== null}>Parquet</option>
        </select>
        <p id="results-download-format-help" class="results-download-help">
          {#if options.format === 'csv'}
            CSV is widely compatible. Spreadsheet software may interpret cells as formulas; import them as
            text when needed.
          {:else}
            Parquet preserves typed columns in a compressed file.
          {/if}
        </p>

        <label class="results-download-check">
          <input type="checkbox" bind:checked={options.includeProvenance} />
          <span>Include hidden columns and byte provenance</span>
        </label>
        <p class="results-download-help">
          When present, hidden provenance columns identify the source file and byte range. Turning this off
          removes all columns whose names start with _, including custom aliases.
        </p>

        {#if selectedError}
          <p class="results-download-explanation" id={disabledReasonId(options.format)}>
            {selectedError}
          </p>
        {/if}
        {#if alternateError}
          <p class="results-download-explanation" id={disabledReasonId(alternateFormat)}>
            {alternateError}
          </p>
        {/if}

        {#if parquetColumnPreview.length > 0}
          <div id={PARQUET_PREVIEW_ID} class="results-download-preview">
            <h4 id="results-download-parquet-preview-heading">Parquet column names</h4>
            <table aria-labelledby="results-download-parquet-preview-heading">
              <thead>
                <tr>
                  <th scope="col">Column</th>
                  <th scope="col">SQL label</th>
                  <th scope="col">File name</th>
                </tr>
              </thead>
              <tbody>
                {#each parquetColumnPreview as column (column.columnIndex)}
                  <tr>
                    <td>{column.columnIndex + 1}</td>
                    <td>{column.label || '(empty)'}</td>
                    <td>{column.name}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}

        <button
          class="button button-primary"
          type="button"
          disabled={selectedError !== null}
          aria-describedby={downloadDescribedBy}
          onclick={startDownload}>Download</button
        >
      {/if}

      {#if download?.phase === 'ready-to-save'}
        <p class="results-download-status" role="status">{statusMessage()}</p>
        <button class="button button-primary" type="button" onclick={() => controller.saveResultsDownload()}
          >Save file</button
        >
      {:else if download && download.phase !== 'failed' && terminal}
        <p class="results-download-status" role="status">{statusMessage()}</p>
      {/if}

      {#if download?.phase === 'failed'}
        <p class="results-download-error" role="alert">{statusMessage()}</p>
      {/if}

      {#if terminal}
        <button class="button button-secondary" type="button" onclick={dismissDownload}>Dismiss</button>
      {/if}

      {#if boundaryError}
        <p class="results-download-error" role="alert">{boundaryError}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .results-download {
    position: relative;
  }

  /* Clamped to the viewport and scrolled internally, so a long capability explanation can
     never push the dialog off screen. */
  .results-download-popover {
    z-index: var(--layer-popover);
    position: absolute;
    top: calc(100% + var(--space-1));
    right: 0;
    display: grid;
    width: min(360px, calc(100vw - 24px));
    max-height: min(70vh, 560px);
    gap: var(--space-2);
    overflow-y: auto;
    padding: var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-overlay);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-overlay);
  }

  .results-download-heading,
  .results-download-check {
    display: flex;
    align-items: center;
  }

  .results-download-heading {
    justify-content: space-between;
    gap: var(--space-3);
  }

  .results-download-heading h3,
  .results-download-popover p {
    margin: 0;
  }

  .results-download-heading h3 {
    font-size: var(--text-md);
    font-weight: 600;
    line-height: var(--leading-md);
  }

  .results-download-check {
    gap: var(--space-2);
  }

  .results-download-help,
  .results-download-explanation,
  .results-download-status,
  .results-download-error {
    font-size: var(--text-md);
    line-height: var(--leading-md);
  }

  .results-download-help,
  .results-download-explanation {
    color: var(--color-text-muted);
  }

  .results-download-status span {
    display: block;
    color: var(--color-text-muted);
  }

  .results-download-preview h4 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-md);
    font-weight: 600;
    line-height: var(--leading-md);
  }

  .results-download-preview table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .results-download-preview th,
  .results-download-preview td {
    padding: var(--space-1) var(--space-2) var(--space-1) 0;
    text-align: left;
    word-break: break-word;
  }

  .results-download-preview th {
    color: var(--color-text-muted);
    font-weight: 600;
  }

  .results-download-error {
    color: var(--color-danger);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
