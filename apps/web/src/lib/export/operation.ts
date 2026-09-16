import type { QueryResultView, QuerySession } from '@byteql/db';

import type { CsvClientPort } from './csv-client.js';
import type { ExportDestination } from './destination.js';
import type { ExportFormat } from './options.js';

export interface ExportState {
  generation: number;
  phase:
    | 'picking'
    | 'loading'
    | 'encoding'
    | 'saving'
    | 'cancelling'
    | 'ready-to-save'
    | 'saved'
    | 'cancelled'
    | 'failed';
  rows: number;
  totalRows: number | null;
  bytes: number;
  message: string | null;
}

export type ExportDestinationFactory = (filename: string, format: ExportFormat) => Promise<ExportDestination>;

export interface ExportDependencies {
  readonly csvClient: CsvClientPort;
  readonly prepareDestination: ExportDestinationFactory;
}

export interface ExportOperation {
  readonly generation: number;
  readonly resultGeneration: number;
  /** The cursor-backed result. Only this can be drained; a derived view is already complete. */
  readonly base: QuerySession;
  /** The view whose committed order the file must reproduce. */
  readonly result: QueryResultView;
  /** The committed order at the moment the download was requested. */
  readonly orderRevision: number;
  readonly parquetColumnNames: readonly string[] | null;
  readonly abortController: AbortController;
  destination: ExportDestination | null;
  destinationAbort: Promise<void> | null;
  settlement: Promise<void>;
}
