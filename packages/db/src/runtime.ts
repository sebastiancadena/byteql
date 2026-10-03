import {
  AsyncDuckDB,
  VoidLogger,
  selectBundle,
  type AsyncDuckDBConnection,
  type DuckDBBundle,
  type Logger,
} from '@duckdb/duckdb-wasm';

import { LOCAL_BUNDLES } from './bundles.js';
import { hardenConnection, openLocalConnection, PRODUCTION_ALLOWED_DIRECTORIES } from './hardening.js';

const disposedError = (): Error => new Error('ByteQL database has been disposed.');

/**
 * The DuckDB-WASM instance behind a `BrowserDatabase`: lazy, hardened initialization of its one
 * connection, the serialized operation queue every statement runs through, and teardown.
 */
export class DuckdbRuntime {
  private connection: AsyncDuckDBConnection | null = null;
  private initializePromise: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private terminatePromise: Promise<void> | null = null;
  private disposeRequested = false;

  constructor(
    readonly database: AsyncDuckDB,
    readonly bundle: DuckDBBundle,
  ) {}

  /** Whether teardown has been requested; once true, no further operation is accepted. */
  get disposed(): boolean {
    return this.disposeRequested;
  }

  /** Refuses every later `initialize`/`enqueue`. Teardown itself is driven by the caller. */
  markDisposed(): void {
    this.disposeRequested = true;
  }

  initialize(): Promise<void> {
    if (this.disposeRequested) {
      return Promise.reject(disposedError());
    }
    this.initializePromise ??= this.initializeInternal();
    return this.initializePromise;
  }

  /** Runs `operation` on the connection after every previously queued operation has settled. */
  enqueue<T>(operation: (connection: AsyncDuckDBConnection) => Promise<T>): Promise<T> {
    if (this.disposeRequested) {
      return Promise.reject(disposedError());
    }

    const result = this.operationTail.then(async () => {
      if (this.disposeRequested) {
        throw disposedError();
      }
      await this.initialize();
      if (this.disposeRequested) {
        throw disposedError();
      }
      return operation(this.getConnection());
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves once every operation queued so far has settled, whatever its outcome. */
  idle(): Promise<void> {
    return this.operationTail;
  }

  /** Waits for an in-flight initialization, if any; its failure is already cleaned up. */
  async settleInitialization(): Promise<void> {
    if (this.initializePromise) {
      try {
        await this.initializePromise;
      } catch {
        // Initialization performs its own best-effort cleanup.
      }
    }
  }

  closeConnection(): Promise<void> {
    if (!this.connection) {
      return Promise.resolve();
    }
    this.closePromise ??= this.connection.close();
    return this.closePromise;
  }

  terminate(): Promise<void> {
    this.terminatePromise ??= this.database.terminate();
    return this.terminatePromise;
  }

  private async initializeInternal(): Promise<void> {
    try {
      const connection = await openLocalConnection(this.database, this.bundle, (opened) => {
        this.connection = opened;
      });
      await hardenConnection(connection, { allowedDirectories: PRODUCTION_ALLOWED_DIRECTORIES });
    } catch (error) {
      await this.cleanupAfterInitializationFailure();
      throw error;
    }
  }

  private getConnection(): AsyncDuckDBConnection {
    if (!this.connection) {
      throw new Error('ByteQL database is not initialized.');
    }
    return this.connection;
  }

  private async cleanupAfterInitializationFailure(): Promise<void> {
    try {
      await this.closeConnection();
    } catch {
      // Preserve the initialization error.
    }
    try {
      await this.terminate();
    } catch {
      // Preserve the initialization error.
    }
  }
}

/** Selects the same-origin bundle and starts its worker; nothing touches the database yet. */
export const createDuckdbRuntime = async (logger: Logger | undefined): Promise<DuckdbRuntime> => {
  const bundle = await selectBundle(LOCAL_BUNDLES);
  if (!bundle.mainWorker) {
    throw new Error('DuckDB-WASM did not select a browser worker.');
  }

  const worker = new Worker(bundle.mainWorker);
  try {
    const database = new AsyncDuckDB(logger ?? new VoidLogger(), worker);
    return new DuckdbRuntime(database, bundle);
  } catch (error) {
    worker.terminate();
    throw error;
  }
};
