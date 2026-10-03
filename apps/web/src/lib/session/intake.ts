import type { ParseIssue, TableOverview } from '@byteql/core';
import { hasDbErrorCode, type ByteqlDatabase, type IngestSession } from '@byteql/db';

import type { ParseClientPort, ParseProgress, StreamedParseResult } from '../parse-worker-client.js';
import { REGISTERED_PACKS } from '../packs.js';
import {
  buildFilesTableIpc,
  mergeTableOverviews,
  planBatch,
  type BatchEntry,
  type FilesRow,
  type PlannedFile,
} from './batch.js';
import { errorMessage, isAbortError } from './session-errors.js';
import type { SessionStore } from './session-store.js';
import type { SourceFile } from './state.js';
import { TIER_THRESHOLD_BYTES, chooseTier } from './tiering.js';

export interface IntakeOptions {
  parser: ParseClientPort;
  /** Test/e2e override of the tiering thresholds; production uses the tiering.ts defaults. */
  tiering: { tierThresholdBytes?: number; rotationBytes?: number } | undefined;
}

const bytesToMb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/**
 * Turns a batch of local files into ingested tables: probes and plans the batch, parses each file
 * in the worker, streams its batches into one ingest session, and publishes the ready catalog.
 *
 * Its fence is the session generation, opened by the caller before `open`: every awaited step
 * re-checks it, and a superseded batch aborts its ingest rather than publishing.
 */
export class IntakeOrchestrator {
  private readonly parser: ParseClientPort;
  private readonly tiering: IntakeOptions['tiering'];
  private retainedBlobs = new Map<string, Blob>();
  private batchFileIndex = 0;
  private batchFileCount = 0;
  /** Cumulative IPC bytes ingested this open, and the last parser-reported stage, for progress. */
  private bytesIngested = 0;
  private lastProgress: ParseProgress | null = null;
  /**
   * Resolves once the ingest session currently (or most recently) owned by this intake has
   * fully settled — its `finalize()` or `abort()` call has resolved or rejected. Starts resolved
   * (no ingest owned yet). `completeBatchOpen` awaits this before its own `beginIngest` call, so a
   * quick supersession never races the real DB's single-open-session invariant (I1).
   */
  private ingestSettlement: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: SessionStore,
    private readonly database: ByteqlDatabase,
    options: IntakeOptions,
  ) {
    this.parser = options.parser;
    this.tiering = options.tiering;
  }

  /** The bytes of a successfully opened file, by display name, for the hex pane. */
  sourceBlob(file: string): Blob | null {
    return this.retainedBlobs.get(file) ?? null;
  }

  dispose(): void {
    this.retainedBlobs = new Map();
    try {
      this.parser.dispose();
    } catch {
      // Continue releasing independently-owned resources.
    }
  }

  /**
   * Plans, parses, and ingests one batch under the session generation the caller just opened.
   * `queryCancellation` settles once the previous result family has closed; ingestion starts only
   * after it does.
   */
  async open(
    entries: readonly BatchEntry[],
    generation: number,
    queryCancellation: Promise<void>,
  ): Promise<void> {
    this.bytesIngested = 0;
    this.lastProgress = null;

    const plan = await planBatch(entries, REGISTERED_PACKS);
    if (!this.store.isCurrent(generation)) return;
    const okFiles = plan.files.filter((file) => file.status === 'ok');
    if (plan.formatId === null || okFiles.length === 0) {
      this.store.dispatch({ type: 'failed', message: 'No registered format recognizes the selected files.' });
      return;
    }

    this.retainedBlobs = new Map(okFiles.map((file) => [file.displayName, file.blob]));
    this.batchFileIndex = 1;
    this.batchFileCount = okFiles.length;
    this.store.dispatch({
      type: 'opening',
      source: {
        files: okFiles.map((file) => ({ name: file.displayName, size: file.size })),
        totalSize: plan.totalSize,
      },
    });
    return this.completeBatchOpen(generation, plan.formatId, plan.files, queryCancellation);
  }

  private async completeBatchOpen(
    generation: number,
    formatId: string,
    planned: readonly PlannedFile[],
    queryCancellation: Promise<void>,
  ): Promise<void> {
    await queryCancellation;
    if (!this.store.isCurrent(generation)) return;

    const tierThresholdBytes = this.tiering?.tierThresholdBytes ?? TIER_THRESHOLD_BYTES;
    const okPlanned = planned.filter((file) => file.status === 'ok');
    const totalSize = okPlanned.reduce((sum, file) => sum + file.size, 0);
    const tier = chooseTier(totalSize, tierThresholdBytes);
    if (tier === 'spill') {
      void navigator.storage?.persist?.().catch(() => undefined);
    }

    const rotationBytes = this.tiering?.rotationBytes;
    await this.ingestSettlement;
    if (!this.store.isCurrent(generation)) return;

    let ingest: IngestSession;
    try {
      ingest = await this.database.beginIngest({
        tier,
        generation,
        ...(rotationBytes !== undefined ? { rotationBytes } : {}),
      });
    } catch (error) {
      if (this.store.isCurrent(generation)) {
        this.store.dispatch({ type: 'failed', message: this.openFailureMessage(error, tierThresholdBytes) });
      }
      return;
    }

    let settleIngest!: () => void;
    this.ingestSettlement = new Promise<void>((resolve) => {
      settleIngest = resolve;
    });

    try {
      if (!this.store.isCurrent(generation)) {
        await ingest.abort().catch(() => undefined);
        return;
      }

      // Batch-skip bookkeeping: planner skips carry over; mid-parse failures join them.
      const skipped = new Map<string, string>(
        planned.filter((file) => file.status === 'skipped').map((f) => [f.displayName, f.error ?? '']),
      );
      const results: StreamedParseResult[] = [];
      const succeededFiles: SourceFile[] = [];
      const issues: ParseIssue[] = [];

      try {
        for (const [index, file] of okPlanned.entries()) {
          if (!this.store.isCurrent(generation)) {
            await ingest.abort().catch(() => undefined);
            return;
          }
          this.batchFileIndex = index + 1;
          this.lastProgress = null;
          await ingest.beginFile(file.displayName);

          const pendingAppends: Promise<void>[] = [];
          try {
            const result = await this.parser.parse(
              { name: file.displayName, blob: file.blob, formatId },
              {
                onProgress: (progress) => {
                  if (this.store.isCurrent(generation)) this.progress(generation, progress);
                },
                onBatch: async (batch) => {
                  if (!this.store.isCurrent(generation)) return;
                  this.bytesIngested += batch.ipc.byteLength;
                  this.progressBytes(generation);
                  const append = ingest.appendBatch(batch.table, batch.ipc);
                  pendingAppends.push(append);
                  await append;
                },
              },
            );
            await Promise.all(pendingAppends);
            if (!this.store.isCurrent(generation)) {
              await ingest.abort().catch(() => undefined);
              return;
            }
            results.push(result);
            succeededFiles.push({ name: file.displayName, size: file.size });
            issues.push(...result.issues);
          } catch (error) {
            await Promise.allSettled(pendingAppends);
            if (isAbortError(error)) throw error;
            const message = errorMessage(error, 'The local file could not be parsed.');
            // Environment-level failures (quota, unsupported spill) doom the whole batch.
            if (hasDbErrorCode(error, 'SPILL_QUOTA_EXCEEDED', 'SPILL_UNSUPPORTED')) {
              throw error;
            }
            if (!this.store.isCurrent(generation)) {
              await ingest.abort().catch(() => undefined);
              return;
            }
            await ingest.discardCurrentFile();
            this.retainedBlobs.delete(file.displayName);
            skipped.set(file.displayName, message);
          }
        }

        if (!this.store.isCurrent(generation)) {
          await ingest.abort().catch(() => undefined);
          return;
        }
        if (results.length === 0) {
          const reasons = [...skipped.values()].filter(Boolean);
          throw new Error(reasons[0] ?? 'None of the selected files could be ingested.');
        }

        for (const [displayName, reason] of skipped) {
          issues.push({
            stage: 'framing',
            track: null,
            code: 'FILE_SKIPPED',
            message: `${displayName} was skipped: ${reason}`,
            recoverable: true,
            sourceStart: null,
            sourceEnd: null,
          });
        }

        const filesRows: FilesRow[] = planned.map((file, order) => ({
          file: file.displayName,
          originalName: file.originalName,
          size: file.size,
          ingestOrder: order,
          status: skipped.has(file.displayName) || file.status === 'skipped' ? 'skipped' : 'ok',
          error: skipped.get(file.displayName) ?? file.error,
        }));
        await ingest.appendBatch('_files', buildFilesTableIpc(filesRows));

        const first = results[0]!;
        const summaries = await ingest.finalize(first.schemas);
        if (!this.store.isCurrent(generation)) return;

        const rowCounts = new Map(summaries.map((summary) => [summary.name, summary.rowCount]));
        const mergedTables = mergeTableOverviews(results.map((result) => result.tables));
        const populatedNames = new Set(mergedTables.map((table) => table.name));
        const backfilledTables = first.schemas
          .filter((schema) => !populatedNames.has(schema.name))
          .map((schema) => ({ name: schema.name, rowCount: 0, columns: schema.columns }));
        const filesOverview: TableOverview = {
          name: '_files',
          rowCount: filesRows.length,
          columns: [
            { name: 'file', type: 'Utf8', nullable: false },
            { name: 'original_name', type: 'Utf8', nullable: false },
            { name: 'size', type: 'Uint64', nullable: false },
            { name: 'ingest_order', type: 'Int32', nullable: false },
            { name: 'status', type: 'Utf8', nullable: false },
            { name: 'error', type: 'Utf8', nullable: true },
          ],
        };
        this.store.dispatch({
          type: 'ready',
          format: first.format,
          files: succeededFiles,
          tables: [...mergedTables, ...backfilledTables, filesOverview].map((table) => ({
            ...table,
            rowCount: rowCounts.get(table.name) ?? table.rowCount,
          })),
          issues,
          queries: first.queries,
          capabilities: first.capabilities,
        });
      } catch (error) {
        await ingest.abort().catch(() => undefined);
        if (!this.store.isCurrent(generation)) return;
        if (isAbortError(error)) {
          this.store.dispatch({ type: 'cancelled' });
          return;
        }
        this.store.dispatch({ type: 'failed', message: this.openFailureMessage(error, tierThresholdBytes) });
      }
    } finally {
      settleIngest();
    }
  }

  private openFailureMessage(error: unknown, tierThresholdBytes: number): string {
    const raw = errorMessage(error, 'The local file could not be parsed.');
    if (hasDbErrorCode(error, 'SPILL_UNSUPPORTED')) {
      return `This browser cannot analyze files over ${bytesToMb(tierThresholdBytes)} MB.`;
    }
    if (hasDbErrorCode(error, 'SPILL_QUOTA_EXCEEDED')) {
      return 'Local storage ran out of space while analyzing this file. Free up space and try again.';
    }
    return raw;
  }

  private progress(generation: number, progress: ParseProgress): void {
    if (!this.store.isCurrent(generation)) return;
    this.lastProgress = progress;
    this.store.dispatch({
      type: 'progress',
      ...progress,
      bytes: this.bytesIngested,
      fileIndex: this.batchFileIndex,
      fileCount: this.batchFileCount,
    });
  }

  private progressBytes(generation: number): void {
    if (!this.store.isCurrent(generation)) return;
    const base = this.lastProgress ?? {
      stage: 'parsing' as const,
      completed: 0,
      total: null,
      label: 'Streaming data into the local database',
    };
    this.store.dispatch({
      type: 'progress',
      ...base,
      bytes: this.bytesIngested,
      fileIndex: this.batchFileIndex,
      fileCount: this.batchFileCount,
    });
  }

  cancelParse(): void {
    try {
      this.parser.cancel();
    } catch {
      // The client terminates its worker as the authoritative cancellation path.
    }
  }
}
