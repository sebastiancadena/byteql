import { createExportFiles, type ExportFiles } from '@byteql/db';

import type { ExportFormat } from './options.js';

const CSV_BLOB_LIMIT_BYTES = 64 * 1024 * 1024;
const FALLBACK_FILE = 'result';

type SinkState = 'open' | 'committing' | 'committed' | 'aborted' | 'disposed';

export interface ExportDestination {
  write(bytes: Uint8Array): Promise<void>;
  commit(): Promise<'saved' | 'ready-to-save'>;
  save(): void;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

interface DestinationBackend {
  write(bytes: Uint8Array): Promise<void>;
  commit(): Promise<'saved' | 'ready-to-save'>;
  save(): void;
  abort(reason: unknown): Promise<void>;
  dispose(): Promise<void>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

type PromiseOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

const abortError = (): DOMException => new DOMException('The export was aborted.', 'AbortError');

const stateError = (state: SinkState): Error => new Error(`Export destination is ${state}.`);

const errorName = (error: unknown): unknown =>
  error instanceof Error ? error.name : (error as { name?: unknown } | null)?.name;

const isOpfsUnavailable = (error: unknown): boolean => {
  const name = errorName(error);
  return name === 'NotSupportedError' || name === 'SecurityError';
};

const hasOpfs = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';

const getSaveFilePicker = (): SaveFilePicker | null => {
  const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  return typeof picker === 'function' ? picker.bind(globalThis) : null;
};

const settle = <T>(promise: Promise<T>): Promise<PromiseOutcome<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );

const pickerOptions = (filename: string, format: ExportFormat): SaveFilePickerOptions => ({
  suggestedName: filename,
  types: [
    format === 'csv'
      ? { description: 'CSV file', accept: { 'text/csv': ['.csv'] } }
      : {
          description: 'Parquet file',
          accept: { 'application/vnd.apache.parquet': ['.parquet'] },
        },
  ],
});

const startDownload = (url: string, filename: string): void => {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
};

class ManagedDestination implements ExportDestination {
  private state: SinkState = 'open';
  private readonly writes = new Set<Promise<void>>();
  private failure: unknown = null;
  private abortBackendPromise: Promise<void> | null = null;
  private backendDisposePromise: Promise<void> | null = null;
  private commitPromise: Promise<'saved' | 'ready-to-save'> | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly backend: DestinationBackend) {}

  write(bytes: Uint8Array): Promise<void> {
    if (this.state !== 'open') return Promise.reject(stateError(this.state));

    const operation = this.backend.write(bytes).catch(async (error: unknown) => {
      this.failure ??= error;
      if (this.state === 'open' || this.state === 'committing') this.state = 'aborted';
      try {
        await this.abortBackend(error);
      } catch {
        // Preserve the write failure.
      }
      throw error;
    });
    this.writes.add(operation);
    void operation.then(
      () => this.writes.delete(operation),
      () => this.writes.delete(operation),
    );
    return operation;
  }

  commit(): Promise<'saved' | 'ready-to-save'> {
    if (this.state !== 'open') return Promise.reject(stateError(this.state));
    this.state = 'committing';
    this.commitPromise = (async () => {
      await Promise.allSettled([...this.writes]);
      if (this.state !== 'committing') throw this.failure ?? abortError();
      if (this.failure) throw this.failure;

      try {
        const result = await this.backend.commit();
        if (this.state !== 'committing') {
          await this.disposeBackend();
          throw this.failure ?? abortError();
        }
        this.state = 'committed';
        return result;
      } catch (error) {
        if (this.state === 'committing') {
          this.failure = error;
          this.state = 'aborted';
          try {
            await this.abortBackend(error);
          } catch {
            // Preserve the commit failure.
          }
        }
        throw this.failure ?? error;
      }
    })();
    return this.commitPromise;
  }

  save(): void {
    if (this.state === 'committed') this.backend.save();
  }

  abort(): Promise<void> {
    if (this.state === 'committed' || this.state === 'disposed') return Promise.resolve();
    if (this.state !== 'aborted') {
      this.failure = abortError();
      this.state = 'aborted';
    }
    const aborting = this.abortBackend(this.failure ?? abortError());
    return (async () => {
      await Promise.allSettled([...this.writes]);
      await aborting;
    })();
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      const previous = this.state;
      this.state = 'disposed';
      const aborting =
        previous === 'committed' ? Promise.resolve() : this.abortBackend(this.failure ?? abortError());
      this.disposePromise = (async () => {
        await Promise.allSettled([...this.writes]);
        await Promise.allSettled(this.commitPromise ? [this.commitPromise] : []);
        let lifecycleError: unknown = null;
        try {
          await aborting;
        } catch (error) {
          lifecycleError = error;
        }
        try {
          await this.disposeBackend();
        } catch (error) {
          lifecycleError ??= error;
        }
        if (lifecycleError) throw lifecycleError;
      })();
    }
    return this.disposePromise;
  }

  private abortBackend(reason: unknown): Promise<void> {
    this.abortBackendPromise ??= this.backend.abort(reason);
    return this.abortBackendPromise;
  }

  private disposeBackend(): Promise<void> {
    this.backendDisposePromise ??= this.backend.dispose();
    return this.backendDisposePromise;
  }
}

class WritableBackend implements DestinationBackend {
  private url: string | null = null;
  private preparedFile: File | null = null;

  constructor(
    private readonly writer: FileSystemWritableFileStream,
    private readonly filename: string,
    private readonly files: ExportFiles | null,
    private readonly internalName: string | null,
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    await this.writer.write(Uint8Array.from(bytes));
  }

  async commit(): Promise<'saved' | 'ready-to-save'> {
    await this.writer.close();
    if (!this.files || !this.internalName) return 'saved';

    this.preparedFile = await this.files.file(this.internalName);
    this.url = URL.createObjectURL(this.preparedFile);
    return 'ready-to-save';
  }

  save(): void {
    if (this.url) startDownload(this.url, this.filename);
  }

  async abort(reason: unknown): Promise<void> {
    await this.writer.abort(reason);
  }

  async dispose(): Promise<void> {
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.preparedFile = null;
    await this.files?.dispose();
  }
}

class BlobBackend implements DestinationBackend {
  private readonly chunks: Array<Uint8Array<ArrayBuffer>> = [];
  private bytes = 0;
  private url: string | null = null;
  private preparedFile: Blob | null = null;

  constructor(private readonly filename: string) {}

  async write(bytes: Uint8Array): Promise<void> {
    if (this.bytes + bytes.byteLength > CSV_BLOB_LIMIT_BYTES) {
      throw new Error('CSV export exceeds the 64 MiB browser limit; use a smaller query.');
    }
    const owned = Uint8Array.from(bytes);
    this.bytes += owned.byteLength;
    this.chunks.push(owned);
  }

  async commit(): Promise<'ready-to-save'> {
    this.preparedFile = new Blob(this.chunks, { type: 'text/csv;charset=utf-8' });
    this.url = URL.createObjectURL(this.preparedFile);
    return 'ready-to-save';
  }

  save(): void {
    if (this.url) startDownload(this.url, this.filename);
  }

  async abort(): Promise<void> {
    this.chunks.length = 0;
    this.bytes = 0;
  }

  async dispose(): Promise<void> {
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.preparedFile = null;
    this.chunks.length = 0;
    this.bytes = 0;
  }
}

const parquetUnsupported = (): Error => new Error('OPFS is required to export Parquet in this browser.');

export async function prepareDestination(filename: string, format: ExportFormat): Promise<ExportDestination> {
  if (format === 'parquet' && !hasOpfs()) throw parquetUnsupported();

  const picker = getSaveFilePicker();
  if (picker) {
    // This call intentionally precedes the first await so browser user activation is preserved.
    const pickerOutcome = settle(picker(pickerOptions(filename, format)));
    const parquetOpfs = format === 'parquet' ? settle(navigator.storage.getDirectory()) : null;
    const picked = await pickerOutcome;
    if (!picked.ok) throw picked.error;
    if (parquetOpfs) {
      const probed = await parquetOpfs;
      if (!probed.ok) {
        if (isOpfsUnavailable(probed.error)) throw parquetUnsupported();
        throw probed.error;
      }
    }
    const writer = await picked.value.createWritable();
    return new ManagedDestination(new WritableBackend(writer, filename, null, null));
  }

  if (hasOpfs()) {
    try {
      const files = await createExportFiles();
      const internalName = `${FALLBACK_FILE}.${format}`;
      try {
        const writer = await files.createWritable(internalName);
        return new ManagedDestination(new WritableBackend(writer, filename, files, internalName));
      } catch (error) {
        try {
          await files.dispose();
        } catch {
          // Preserve the writer acquisition failure.
        }
        throw error;
      }
    } catch (error) {
      if (!isOpfsUnavailable(error)) throw error;
    }
  }

  if (format === 'parquet') throw parquetUnsupported();
  return new ManagedDestination(new BlobBackend(filename));
}
