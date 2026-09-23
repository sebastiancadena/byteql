import { projectedTableToArrow, tableToIpc } from '../arrow/build.js';
import { IssueCollector } from '../issues.js';
import {
  ProjectionFieldError,
  type CompiledProjection,
  type ProvenanceResolver,
} from '../projection/project.js';
import { createProjectionSession, type FinishedTable } from '../projection/session.js';
import type {
  BatchTransfer,
  ByteSource,
  FormatCapability,
  OpenOptions,
  RecordSource,
  SourceFinish,
} from '../protocol.js';
import type { DriverOptions, FramedRecord, Framer, FramerContext, FramerIssue } from './framer.js';
import { createYield } from './yield.js';

const DEFAULT_FLUSH_ROWS = 65_536;
const DEFAULT_YIELD_INTERVAL = 256;

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(2);

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return;
  signal.throwIfAborted();
  throw new DOMException('The operation was aborted.', 'AbortError');
};

/** rowCount off arrow.numRows: correct for drain() batches and finish() residuals alike. */
const toBatches = (finished: readonly FinishedTable[]): BatchTransfer[] =>
  finished.map((table) => ({
    table: table.name,
    ipc: tableToIpc(table.arrow),
    rowCount: table.arrow.numRows,
  }));

const resolverFor = (record: FramedRecord): ProvenanceResolver => {
  const provenance = record.provenance;
  return typeof provenance === 'function' ? { resolve: provenance } : { resolve: () => provenance };
};

const defaultRecordIssue = (record: FramedRecord, error: unknown): FramerIssue => {
  const range = typeof record.provenance === 'function' ? null : record.provenance;
  return {
    stage: 'projecting',
    code: 'PROJECTION_FAILED',
    message: error instanceof Error ? error.message : String(error),
    ordinal: record.ordinal ?? null,
    sourceStart: range?.start ?? null,
    sourceEnd: range?.end ?? null,
  };
};

const report = (collector: IssueCollector, issue: FramerIssue, stage: string): void =>
  collector.report({
    stage: issue.stage ?? stage,
    code: issue.code,
    message: issue.message,
    recoverable: issue.recoverable ?? true,
    ordinal: issue.ordinal ?? null,
    sourceStart: issue.sourceStart ?? null,
    sourceEnd: issue.sourceEnd ?? null,
  });

/**
 * Generic pull-driven RecordSource over a Framer: projects each record into one session,
 * drains at `flushRowThreshold`, yields every `yieldInterval` records, and at EOF emits the
 * non-empty residual tables then always `errors` (framer issues first, then engine issues).
 */
export const openFramedSource = (
  compiled: CompiledProjection,
  framer: Framer,
  source: ByteSource,
  opts: OpenOptions,
  options: DriverOptions,
): RecordSource => {
  const threshold = options.flushRowThreshold ?? DEFAULT_FLUSH_ROWS;
  const yieldInterval = options.yieldInterval ?? DEFAULT_YIELD_INTERVAL;
  // Per-call, not module-level: the MessageChannel fallback's single pending-resolver slot
  // (see yield.ts) is only safe under one strictly sequential pump loop. Two openFramedSource
  // calls pumping concurrently in the same worker must not share one yield instance.
  const yieldToWorker = createYield();
  const framerIssues = new IssueCollector({ ordinalColumn: options.ordinalColumn });
  const engineIssues = new IssueCollector({ ordinalColumn: options.ordinalColumn });
  const session = createProjectionSession(compiled, {
    issues: engineIssues,
    flushRowThreshold: threshold,
    strictFields: options.strictFields ?? false,
  });
  let consumed: number | null = null;
  let reportedConsumed: number | null = null;
  // `force` bypasses the dedup guard: the tail flush (finishTail) must always emit one final
  // byte-progress event once the framer has reported any consumption, even when that count is
  // unchanged since the last yield-cadence flush (e.g. the record count lands exactly on a
  // yieldInterval boundary) — matching the pre-kit pcap driver, which always reported progress at EOF.
  const flushBytes = (force = false): void => {
    if (consumed === null) return;
    if (!force && consumed === reportedConsumed) return;
    reportedConsumed = consumed;
    opts.onProgress?.({
      stage: 'projecting',
      completed: consumed,
      total: source.size,
      label: `${mb(consumed)} of ${mb(source.size)} MB`,
    });
  };
  const ctx: FramerContext = {
    signal: opts.signal,
    chunkBytes: options.chunkBytes,
    report: (issue) => report(framerIssues, issue, 'framing'),
    progress: (progress) => opts.onProgress?.(progress),
    bytes: (value) => {
      consumed = value;
    },
  };
  const records = framer(source, ctx);

  let pending: BatchTransfer[] = [];
  let tailEmitted = false;
  let drained = false;
  let failure: { error: unknown } | null = null;
  let finalIssues: IssueCollector | null = null;
  let capabilities: Readonly<Record<string, FormatCapability>> = {};
  let sinceYield = 0;

  const finishTail = (): void => {
    const finished = session.finish();
    const ordered = new IssueCollector({ ordinalColumn: options.ordinalColumn });
    for (const issue of [...framerIssues.issues(), ...engineIssues.issues()]) {
      ordered.report({ ...issue, ordinal: issue.track });
    }
    finalIssues = ordered;
    const errors = ordered.table();
    pending = [
      ...toBatches(finished.filter((table) => table.arrow.numRows > 0)),
      ...toBatches([{ name: errors.name, arrow: projectedTableToArrow(errors), rowCount: errors.rowCount }]),
    ];
    tailEmitted = true;
    flushBytes(true);
  };

  const pump = async (): Promise<void> => {
    for (;;) {
      throwIfAborted(opts.signal);
      const step = await records.next();
      if (step.done) {
        if (step.value?.capabilities) capabilities = step.value.capabilities;
        finishTail();
        return;
      }
      const record = step.value;
      try {
        if (record.tables) {
          session.project(record.root, resolverFor(record), { tables: record.tables });
        } else {
          session.project(record.root, resolverFor(record));
        }
      } catch (error) {
        if (error instanceof ProjectionFieldError) throw error;
        report(engineIssues, record.onError?.(error) ?? defaultRecordIssue(record, error), 'projecting');
      }
      sinceYield += 1;
      if (sinceYield >= yieldInterval) {
        sinceYield = 0;
        await yieldToWorker();
        throwIfAborted(opts.signal);
        flushBytes();
      }
      if (session.pendingRowCount() >= threshold) {
        pending = toBatches(session.drain());
        if (pending.length > 0) return;
      }
    }
  };

  return {
    async nextBatch() {
      if (failure) throw failure.error;
      try {
        throwIfAborted(opts.signal);
        while (pending.length === 0 && !tailEmitted) await pump();
      } catch (error) {
        failure = { error };
        // A framer's `finally` block can itself reject on return(); swallow it here so it
        // never surfaces as an unhandled rejection — the original `error` is what we throw.
        void records.return(undefined).catch(() => {});
        throw error;
      }
      const next = pending.shift();
      if (next) return next;
      drained = true;
      return null;
    },
    finish(): SourceFinish {
      if (failure) throw failure.error;
      if (!drained) throw new Error('RECORD_SOURCE_NOT_DRAINED: call nextBatch() until null before finish()');
      return { issues: finalIssues?.issues() ?? [], capabilities };
    },
  };
};
