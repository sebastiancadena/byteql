import type { QuerySession } from '@byteql/db';

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
  readonly result: QuerySession;
  readonly abortController: AbortController;
  destination: ExportDestination | null;
  destinationAbort: Promise<void> | null;
  settlement: Promise<void>;
}
