<script lang="ts">
  /* global HTMLButtonElement, HTMLElement, KeyboardEvent, navigator */

  import { tick } from 'svelte';

  import { selectExportColumns, type ExportFormat, type ExportOptions } from '../lib/export/options.js';
  import type { SessionController } from '../lib/session/controller.js';
  import type { SessionState } from '../lib/session/state.js';

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
        <button class="icon-button" type="button" aria-label="Close download options" onclick={close}
          >×</button
        >
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

        <button
          class="button button-primary"
          type="button"
          disabled={selectedError !== null}
          aria-describedby={selectedError ? disabledReasonId(options.format) : undefined}
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

  .results-download-popover {
    position: absolute;
    z-index: 20;
    top: calc(100% + 0.4rem);
    right: 0;
    display: grid;
    gap: 0.65rem;
    width: min(22rem, calc(100vw - 1rem));
    padding: 0.9rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-pane);
  }

  .results-download-heading,
  .results-download-check {
    display: flex;
    align-items: center;
  }

  .results-download-heading {
    justify-content: space-between;
    gap: 0.75rem;
  }

  .results-download-heading h3,
  .results-download-popover p {
    margin: 0;
  }

  .results-download-heading h3 {
    font-size: var(--text-base);
  }

  .results-download-check {
    gap: 0.5rem;
  }

  .results-download-help,
  .results-download-explanation,
  .results-download-status,
  .results-download-error {
    font-size: var(--text-sm);
    line-height: 1.45;
  }

  .results-download-help,
  .results-download-explanation {
    color: var(--color-text-muted);
  }

  .results-download-status span {
    display: block;
    color: var(--color-text-muted);
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
