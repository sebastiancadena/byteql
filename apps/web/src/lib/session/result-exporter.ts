import { tableToIpc } from '@byteql/core';
import { QUERY_PAGE_ROWS, type ByteqlDatabase } from '@byteql/db';
import { parquetColumnNames } from '@byteql/db/result-columns';
import { Table } from 'apache-arrow';

import type { CsvClientPort } from '../export/csv-client.js';
import type { ExportDestination } from '../export/destination.js';
import type { ExportDependencies, ExportOperation, ExportState } from '../export/operation.js';
import { exportFilename, selectExportColumns, type ExportOptions } from '../export/options.js';
import type { ResultBusy } from './result-sort.js';
import type { ResultSession } from './result-session.js';
import {
  errorMessage,
  isAbortError,
  isRetryablePageError,
  resultPageFailureMessage,
} from './session-errors.js';
import type { SessionStore } from './session-store.js';

type ExportDestinationOutcome =
  { status: 'fulfilled'; destination: ExportDestination } | { status: 'rejected'; error: unknown };

/**
 * Downloads the current result as CSV or Parquet, in the order on display.
 *
 * Its fence is the export generation: every awaited step re-checks that the operation is still
 * the active one and that the result family, displayed view, and committed order it captured are
 * all unchanged. A finished file the browser could not save directly is retained until the reader
 * saves or dismisses it, or the result moves on.
 */
export class ResultExporter {
  private exportGeneration = 0;
  private activeExport: ExportOperation | null = null;
  private retainedExport: { generation: number; destination: ExportDestination } | null = null;
  private exportCleanup: Promise<void> = Promise.resolve();
  private readonly csvClient: CsvClientPort;
  private readonly prepareDestination: ExportDependencies['prepareDestination'];

  constructor(
    private readonly store: SessionStore,
    private readonly database: ByteqlDatabase,
    private readonly results: ResultSession,
    private readonly busy: ResultBusy,
    dependencies: ExportDependencies,
  ) {
    this.csvClient = dependencies.csvClient;
    this.prepareDestination = dependencies.prepareDestination;
  }

  download(options: ExportOptions): Promise<void> {
    const resultState = this.store.state.result;
    const base = this.results.base;
    const view = this.results.view;
    let columns: number[];
    let capturedNames: string[] | null;
    try {
      if (!resultState || !base || !view || resultState.generation !== this.results.generation) {
        throw new Error('Run a query before downloading results.');
      }
      if (!this.store.state.resultIsCurrent) {
        throw new Error('Run the query again before downloading results.');
      }
      if (this.busy.sortPending()) {
        throw new Error('Finish or cancel the sort before downloading results.');
      }
      if (resultState.pageError) {
        throw new Error('Retry or rerun the query before downloading results.');
      }
      columns = selectExportColumns(resultState.schema, options);
      capturedNames =
        options.format === 'parquet'
          ? parquetColumnNames(resultState.schema, columns).map(({ name }) => name)
          : null;
    } catch (error) {
      return this.publishValidationFailure(error);
    }

    const previousDownload = this.store.state.download?.generation;
    const generation = ++this.exportGeneration;
    const priorCleanup = this.detachResources();
    if (previousDownload !== undefined) {
      this.store.dispatch({ type: 'downloadUpdated', generation: previousDownload, download: null });
    }
    const filename = exportFilename(
      this.store.state.source?.files.map((file) => file.name) ?? [],
      options.format,
    );
    const abortController = new AbortController();
    const operation: ExportOperation = {
      generation,
      resultGeneration: resultState.generation,
      base,
      // Both the view and its revision are captured here: the file must reproduce the order the
      // user was looking at when they asked for it.
      result: view,
      orderRevision: resultState.orderRevision,
      parquetColumnNames: capturedNames === null ? null : [...capturedNames],
      abortController,
      destination: null,
      destinationAbort: null,
      settlement: Promise.resolve(),
    };
    this.activeExport = operation;
    this.results.suspendFetches(generation);
    this.updateDownload(operation, {
      phase: 'picking',
      rows: resultState.loadedRows,
      totalRows: resultState.complete ? resultState.loadedRows : null,
      bytes: 0,
      message: null,
    });

    let destination: Promise<ExportDestination>;
    try {
      // Keep the picker invocation in the caller's user-activation turn.
      destination = this.prepareDestination(filename, options.format);
    } catch (error) {
      destination = Promise.reject(error);
    }
    const destinationOutcome = destination.then<ExportDestinationOutcome, ExportDestinationOutcome>(
      (acquired) => ({ status: 'fulfilled', destination: acquired }),
      (error: unknown) => ({ status: 'rejected', error }),
    );
    operation.settlement = this.performDownload(
      operation,
      destinationOutcome,
      priorCleanup,
      options,
      columns,
    );
    return operation.settlement;
  }

  cancel(): Promise<void> {
    const operation = this.activeExport;
    if (!operation) return Promise.resolve();
    operation.abortController.abort();
    this.updateDownload(operation, {
      phase: 'cancelling',
      message: 'Cancelling download…',
    });
    const aborting = this.abortDestination(operation);
    return Promise.allSettled([aborting, operation.settlement]).then(() => undefined);
  }

  save(): void {
    const retained = this.retainedExport;
    if (!retained || this.store.state.download?.generation !== retained.generation) return;
    try {
      // This must stay synchronous so the fallback anchor click retains user activation.
      retained.destination.save();
      this.store.dispatch({
        type: 'downloadUpdated',
        generation: retained.generation,
        download: {
          ...this.store.state.download,
          phase: 'saved',
          message: 'Download handed to the browser.',
        },
      });
    } catch (error) {
      this.store.dispatch({
        type: 'downloadUpdated',
        generation: retained.generation,
        download: {
          ...this.store.state.download,
          phase: 'failed',
          message: errorMessage(error, 'The prepared file could not be saved.'),
        },
      });
    }
  }

  /** Clears the download from view and releases whatever it still holds. */
  dismiss(): Promise<void> {
    return this.supersede();
  }

  /**
   * Invalidates any download of the current result, joins the cleanup of everything it held, and
   * removes it from view. Every change to the result family — a new query, file, sort, or
   * cancellation — calls this first.
   */
  supersede(): Promise<void> {
    const generation = this.store.state.download?.generation;
    ++this.exportGeneration;
    const cleanup = this.detachResources();
    if (generation !== undefined) {
      this.store.dispatch({ type: 'downloadUpdated', generation, download: null });
    }
    return cleanup;
  }

  private async performDownload(
    operation: ExportOperation,
    destinationOutcome: Promise<ExportDestinationOutcome>,
    priorCleanup: Promise<void>,
    options: ExportOptions,
    columns: readonly number[],
  ): Promise<void> {
    let destination: ExportDestination | null = null;
    let keepDestination = false;
    try {
      await priorCleanup;
      const acquired = await destinationOutcome;
      if (acquired.status === 'rejected') throw acquired.error;
      destination = acquired.destination;
      operation.destination = destination;
      this.assertCurrent(operation);

      this.results.suspendFetches(operation.generation);
      this.updateDownload(operation, {
        phase: 'loading',
        message: 'Loading remaining rows…',
      });
      const pendingDemand = this.results.demand;
      if (pendingDemand) await pendingDemand.catch(() => undefined);
      this.assertCurrent(operation);
      if (this.store.state.result?.pageError) {
        throw new Error('Retry or rerun the query before downloading results.');
      }

      // Only the cursor-backed base can be asked for more rows. A derived view is complete by
      // construction, so reaching for fetchNext on one would be a category error.
      if (operation.result !== operation.base && !operation.result.status().complete) {
        throw new Error('A sorted result must be complete before it can be downloaded.');
      }
      while (operation.result === operation.base && !operation.base.status().complete) {
        this.throwIfAborted(operation);
        try {
          await operation.base.fetchNext(QUERY_PAGE_ROWS);
        } catch (error) {
          throw new Error(this.publishPageFailure(operation, error), { cause: error });
        }
        this.assertCurrent(operation);
        this.results.refreshCounts(operation.result, operation.resultGeneration, operation.orderRevision);
        const status = operation.result.status();
        this.updateDownload(operation, {
          phase: 'loading',
          rows: status.loadedRows,
          totalRows: status.complete ? status.loadedRows : null,
          message: status.complete ? 'All rows loaded.' : 'Loading remaining rows…',
        });
      }

      this.results.refreshCounts(operation.result, operation.resultGeneration, operation.orderRevision);
      const totalRows = operation.result.status().loadedRows;
      this.updateDownload(operation, {
        phase: 'encoding',
        rows: 0,
        totalRows,
        message: options.format === 'csv' ? 'Preparing CSV file…' : 'Preparing Parquet file…',
      });

      let bytes = 0;
      if (options.format === 'csv') {
        const pages = operation.result.pages();
        if (pages.length === 0) {
          await this.csvClient.encode(
            tableToIpc(new Table(operation.result.schema)),
            columns,
            true,
            async (chunk) => {
              await destination!.write(chunk);
              bytes += chunk.byteLength;
              this.updateDownload(operation, { phase: 'encoding', bytes });
            },
            operation.abortController.signal,
          );
        } else {
          let rows = 0;
          for (const [index, summary] of pages.entries()) {
            this.throwIfAborted(operation);
            const storedPage = await operation.result.readPage(summary.index);
            this.assertCurrent(operation);
            await this.csvClient.encode(
              tableToIpc(storedPage.table),
              columns,
              index === 0,
              async (chunk) => {
                await destination!.write(chunk);
                bytes += chunk.byteLength;
                this.updateDownload(operation, { phase: 'encoding', bytes });
              },
              operation.abortController.signal,
            );
            rows += summary.rowCount;
            this.updateDownload(operation, { phase: 'encoding', rows, bytes });
          }
        }
      } else {
        if (operation.parquetColumnNames === null) {
          throw new Error('Parquet column names were not captured for this export.');
        }
        const artifact = await this.database.exportParquet(operation.result, {
          columns,
          columnNames: operation.parquetColumnNames,
          signal: operation.abortController.signal,
          onProgress: (rows) => {
            this.updateDownload(operation, { phase: 'encoding', rows });
          },
        });
        try {
          this.assertCurrent(operation);
          bytes = await this.copyFileToDestination(operation, artifact.file, destination, totalRows);
        } finally {
          await artifact.dispose();
        }
      }

      this.updateDownload(operation, {
        phase: 'saving',
        rows: totalRows,
        totalRows,
        bytes,
        message: 'Saving file…',
      });
      // The identity check and invocation intentionally share one synchronous turn. Once close
      // starts, supersession aborts the sink and joins this promise before disposing the query.
      this.assertCurrent(operation);
      const committing = destination.commit();
      const outcome = await committing;
      this.assertCurrent(operation);
      if (outcome === 'ready-to-save') {
        keepDestination = true;
        this.retainedExport = { generation: operation.generation, destination };
        this.updateDownload(operation, {
          phase: 'ready-to-save',
          message: 'File ready. Choose Save file to download it.',
        });
      } else {
        await destination.dispose();
        destination = null;
        this.updateDownload(operation, {
          phase: 'saved',
          message: 'File saved.',
        });
      }
    } catch (error) {
      if (destination) {
        await this.abortDestination(operation);
        await destination.dispose().catch(() => undefined);
      } else {
        void destinationOutcome.then(async (outcome) => {
          if (outcome.status === 'rejected') return;
          await outcome.destination.abort().catch(() => undefined);
          await outcome.destination.dispose().catch(() => undefined);
        });
      }
      if (this.activeExport === operation && operation.generation === this.exportGeneration) {
        const cancelled = operation.abortController.signal.aborted || isAbortError(error);
        this.updateDownload(operation, {
          phase: cancelled ? 'cancelled' : 'failed',
          message: cancelled
            ? 'Download cancelled.'
            : errorMessage(error, 'The result could not be downloaded.'),
        });
      }
    } finally {
      this.results.resumeFetches(operation.generation);
      if (this.activeExport === operation) this.activeExport = null;
      if (!keepDestination && this.retainedExport?.generation === operation.generation) {
        this.retainedExport = null;
      }
    }
  }

  private async copyFileToDestination(
    operation: ExportOperation,
    file: File,
    destination: ExportDestination,
    totalRows: number,
  ): Promise<number> {
    const reader = file.stream().getReader();
    const cancelReader = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    operation.abortController.signal.addEventListener('abort', cancelReader, { once: true });
    let bytes = 0;
    try {
      while (true) {
        this.throwIfAborted(operation);
        const next = await reader.read();
        if (next.done) return bytes;
        this.assertCurrent(operation);
        await destination.write(next.value);
        bytes += next.value.byteLength;
        this.updateDownload(operation, {
          phase: 'saving',
          rows: totalRows,
          totalRows,
          bytes,
          message: 'Saving file…',
        });
      }
    } finally {
      operation.abortController.signal.removeEventListener('abort', cancelReader);
      reader.releaseLock();
    }
  }

  private publishValidationFailure(error: unknown): Promise<void> {
    const previousDownload = this.store.state.download?.generation;
    const generation = ++this.exportGeneration;
    const cleanup = this.detachResources();
    if (previousDownload !== undefined) {
      this.store.dispatch({ type: 'downloadUpdated', generation: previousDownload, download: null });
    }
    this.store.dispatch({
      type: 'downloadUpdated',
      generation,
      download: {
        generation,
        phase: 'failed',
        rows: this.store.state.result?.loadedRows ?? 0,
        totalRows: this.store.state.result?.complete ? this.store.state.result.loadedRows : null,
        bytes: 0,
        message: errorMessage(error, 'The result cannot be downloaded.'),
      },
    });
    return cleanup;
  }

  private updateDownload(operation: ExportOperation, update: Partial<Omit<ExportState, 'generation'>>): void {
    if (operation.generation !== this.exportGeneration) return;
    const current = this.store.state.download;
    if (current && current.generation !== operation.generation) return;
    const base: ExportState = current ?? {
      generation: operation.generation,
      phase: 'picking',
      rows: 0,
      totalRows: null,
      bytes: 0,
      message: null,
    };
    this.store.dispatch({
      type: 'downloadUpdated',
      generation: operation.generation,
      download: { ...base, ...update },
    });
  }

  private publishPageFailure(operation: ExportOperation, error: unknown): string {
    const message = resultPageFailureMessage(error, 'More query rows could not be loaded.');
    if (!this.isCurrent(operation)) return message;
    this.store.dispatch({
      type: 'queryPageFailed',
      message,
      retryable: isRetryablePageError(error),
    });
    return message;
  }

  private throwIfAborted(operation: ExportOperation): void {
    if (operation.abortController.signal.aborted) {
      throw new DOMException('The download was cancelled.', 'AbortError');
    }
  }

  private assertCurrent(operation: ExportOperation): void {
    this.throwIfAborted(operation);
    if (!this.isCurrent(operation)) {
      throw new DOMException('The download was replaced.', 'AbortError');
    }
  }

  private isCurrent(operation: ExportOperation): boolean {
    return (
      !this.store.disposed &&
      this.exportGeneration === operation.generation &&
      this.activeExport === operation &&
      this.results.base === operation.base &&
      this.results.view === operation.result &&
      this.results.generation === operation.resultGeneration &&
      this.store.state.result?.generation === operation.resultGeneration &&
      this.store.state.result.orderRevision === operation.orderRevision
    );
  }

  private detachResources(): Promise<void> {
    const priorCleanup = this.exportCleanup;
    const active = this.activeExport;
    const retained = this.retainedExport;
    this.activeExport = null;
    this.retainedExport = null;
    active?.abortController.abort();
    const aborting = active ? this.abortDestination(active) : Promise.resolve();
    const disposingRetained = retained?.destination.dispose().catch(() => undefined) ?? Promise.resolve();
    this.exportCleanup = Promise.allSettled([
      priorCleanup,
      aborting,
      active?.settlement ?? Promise.resolve(),
      disposingRetained,
    ]).then(() => undefined);
    return this.exportCleanup;
  }

  private abortDestination(operation: ExportOperation): Promise<void> {
    if (!operation.destination) return Promise.resolve();
    operation.destinationAbort ??= operation.destination.abort().catch(() => undefined);
    return operation.destinationAbort;
  }
}
