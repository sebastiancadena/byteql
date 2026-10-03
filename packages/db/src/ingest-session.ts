import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { TableSchema } from '@byteql/core';
import { tableFromIPC } from 'apache-arrow';

import type { Catalog, CatalogKind } from './catalog.js';
import { ByteqlDbError } from './errors.js';
import { deleteSpillChunks, deleteSpillGeneration, isQuotaError, spillPath } from './spill-files.js';
import { quoteIdentifier, quoteString } from './sql.js';
import type { IngestSession, TableSummary } from './types.js';

/** Spill-tier rotation threshold: flush a table's staged batches to parquet past this size. */
export const ROTATION_THRESHOLD_BYTES = 96 * 1024 * 1024;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ARROW_TYPE_TO_DUCKDB_TYPE: Readonly<Record<string, string>> = {
  int8: 'TINYINT',
  int16: 'SMALLINT',
  int32: 'INTEGER',
  int64: 'BIGINT',
  uint8: 'UTINYINT',
  uint16: 'USMALLINT',
  uint32: 'UINTEGER',
  uint64: 'UBIGINT',
  float64: 'DOUBLE',
  bool: 'BOOLEAN',
  utf8: 'VARCHAR',
  binary: 'BLOB',
  timestamp_us: 'TIMESTAMP',
  src_ranges: 'STRUCT("start" UBIGINT, "end" UBIGINT)[]',
};

const duckdbColumnType = (type: string): string => {
  const mapped = ARROW_TYPE_TO_DUCKDB_TYPE[type];
  if (!mapped) {
    throw new Error(`Unsupported ingest column type: ${JSON.stringify(type)}`);
  }
  return mapped;
};

const stagingTableName = (generation: number, table: string): string => `__ingest_${generation}_${table}`;

type IngestState = 'open' | 'finalized' | 'aborted' | 'failed';

export type EnqueueFn = <T>(operation: (connection: AsyncDuckDBConnection) => Promise<T>) => Promise<T>;

/** The subset of `AsyncDuckDB` the spill tier needs: whitelisting an OPFS path as writable. */
export interface OpfsFileRegistrar {
  registerOPFSFileName(path: string): Promise<void>;
}

export interface IngestSessionOptions {
  readonly generation: number;
  readonly tier: 'memory' | 'spill';
  readonly rotationBytes: number;
  readonly opfs: OpfsFileRegistrar;
  readonly enqueue: EnqueueFn;
  /** The committed catalog this session's finalize swaps its tables into. */
  readonly catalog: Catalog;
  /** Fires once the session finalizes, fails, or aborts, so the database can admit the next one. */
  readonly onSettled: () => void;
}

export class IngestSessionImpl implements IngestSession {
  private state: IngestState = 'open';
  private readonly created = new Set<string>();
  private readonly rowCounts = new Map<string, number>();
  // Spill tier only: bytes staged since the last rotation, the next chunk index to write, and
  // every chunk path written so far. `chunkPaths` becomes the explicit `parquet_scan([...])`
  // array at finalize — never a glob (the Task 1 spike found opfs:// globs do not enumerate in
  // this duckdb-wasm build).
  private readonly stagedBytes = new Map<string, number>();
  private readonly chunkIndex = new Map<string, number>();
  private readonly chunkPaths = new Map<string, string[]>();
  // Per-file boundary tracking (multi-file batches): the display name of the file currently
  // being appended, the chunks rotated for it, and its per-table appended row counts.
  private currentFile: string | null = null;
  private readonly currentFileChunks = new Map<string, string[]>();
  private readonly currentFileRows = new Map<string, number>();

  private readonly generation: number;
  private readonly tier: 'memory' | 'spill';
  private readonly rotationBytes: number;
  private readonly opfs: OpfsFileRegistrar;
  private readonly enqueue: EnqueueFn;
  private readonly catalog: Catalog;
  private readonly onSettled: () => void;

  constructor(options: IngestSessionOptions) {
    this.generation = options.generation;
    this.tier = options.tier;
    this.rotationBytes = options.rotationBytes;
    this.opfs = options.opfs;
    this.enqueue = options.enqueue;
    this.catalog = options.catalog;
    this.onSettled = options.onSettled;
  }

  /** The set of tables this session is responsible for finalizing/aborting. */
  private sessionTables(): readonly string[] {
    return [...this.created];
  }

  /** Copies a staging table's currently-staged rows to the next parquet chunk and empties it. */
  private async rotateChunk(connection: AsyncDuckDBConnection, table: string): Promise<void> {
    const index = this.chunkIndex.get(table) ?? 0;
    const path = spillPath(this.generation, table, index);
    const stagingName = stagingTableName(this.generation, table);
    await this.opfs.registerOPFSFileName(path);
    await connection.query(`COPY ${quoteIdentifier(stagingName)} TO ${quoteString(path)} (FORMAT parquet);`);
    await connection.query(`DELETE FROM ${quoteIdentifier(stagingName)};`);
    this.chunkIndex.set(table, index + 1);
    this.chunkPaths.set(table, [...(this.chunkPaths.get(table) ?? []), path]);
    this.stagedBytes.set(table, 0);
    if (this.currentFile !== null) {
      this.currentFileChunks.set(table, [...(this.currentFileChunks.get(table) ?? []), path]);
    }
  }

  /** Best-effort drop of every staging table this session owns, outside a transaction. */
  private async dropStaging(connection: AsyncDuckDBConnection): Promise<void> {
    for (const table of this.sessionTables()) {
      const stagingName = stagingTableName(this.generation, table);
      try {
        await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(stagingName)};`);
      } catch {
        // Best-effort cleanup outside a transaction; ignore failures dropping staging tables.
      }
    }
  }

  async appendBatch(table: string, ipc: Uint8Array): Promise<void> {
    if (this.state !== 'open') {
      throw new Error(`Ingest session is ${this.state}; cannot append to ${JSON.stringify(table)}.`);
    }
    if (!IDENTIFIER.test(table)) {
      throw new Error(`Invalid table identifier: ${JSON.stringify(table)}`);
    }

    const rowCount = tableFromIPC(ipc).numRows;
    const copy = ipc.slice();
    // `insertArrowFromIPCStream` transfers `copy`'s underlying `ArrayBuffer` across the
    // duckdb-wasm worker boundary (structured clone with transfer, for a zero-copy handoff), so
    // `copy.byteLength` reads back as 0 once that call resolves — capture it up front instead.
    const byteLength = copy.byteLength;
    const stagingName = stagingTableName(this.generation, table);
    const create = !this.created.has(table);

    let quotaAborted = false;
    try {
      await this.enqueue(async (connection) => {
        if (this.state !== 'open') {
          throw new Error(`Ingest session is ${this.state}; cannot append to ${JSON.stringify(table)}.`);
        }
        await connection.insertArrowFromIPCStream(copy, { name: stagingName, create });
        this.created.add(table);
        this.rowCounts.set(table, (this.rowCounts.get(table) ?? 0) + rowCount);
        if (this.currentFile !== null) {
          this.currentFileRows.set(table, (this.currentFileRows.get(table) ?? 0) + rowCount);
        }

        if (this.tier !== 'spill') {
          return;
        }
        const staged = (this.stagedBytes.get(table) ?? 0) + byteLength;
        this.stagedBytes.set(table, staged);
        if (staged < this.rotationBytes) {
          return;
        }
        try {
          await this.rotateChunk(connection, table);
        } catch (error) {
          if (!isQuotaError(error)) {
            throw error;
          }
          quotaAborted = true;
          this.state = 'aborted';
          await this.dropStaging(connection);
          throw new ByteqlDbError(
            'SPILL_QUOTA_EXCEEDED',
            `SPILL_QUOTA_EXCEEDED: failed to spill ${JSON.stringify(table)} to OPFS.`,
            {
              cause: error,
            },
          );
        }
      });
    } catch (error) {
      if (quotaAborted) {
        await deleteSpillGeneration(this.generation);
        this.onSettled();
      }
      throw error;
    }
  }

  async beginFile(file: string): Promise<void> {
    if (this.state !== 'open') {
      throw new Error(`Ingest session is ${this.state}; cannot begin a file.`);
    }
    if (this.tier === 'spill') {
      // File-boundary flush: chunks must never mix files, so the previous file's residual
      // staged rows rotate out before this file's first append. Quota failures get the same
      // SPILL_QUOTA_EXCEEDED tagging as appendBatch so the controller's messaging applies, and
      // the same terminalization: abort the session, drop staging, and reclaim the generation.
      let quotaAborted = false;
      try {
        await this.enqueue(async (connection) => {
          for (const table of this.sessionTables()) {
            if (this.created.has(table) && (this.stagedBytes.get(table) ?? 0) > 0) {
              try {
                await this.rotateChunk(connection, table);
              } catch (error) {
                if (!isQuotaError(error)) {
                  throw error;
                }
                quotaAborted = true;
                this.state = 'aborted';
                await this.dropStaging(connection);
                throw new ByteqlDbError(
                  'SPILL_QUOTA_EXCEEDED',
                  `SPILL_QUOTA_EXCEEDED: failed to spill ${JSON.stringify(table)} to OPFS.`,
                  {
                    cause: error,
                  },
                );
              }
            }
          }
        });
      } catch (error) {
        if (quotaAborted) {
          await deleteSpillGeneration(this.generation);
          this.onSettled();
        }
        throw error;
      }
    }
    this.currentFile = file;
    this.currentFileChunks.clear();
    this.currentFileRows.clear();
  }

  async discardCurrentFile(): Promise<void> {
    if (this.state !== 'open' || this.currentFile === null) {
      return;
    }
    const file = this.currentFile;
    await this.enqueue(async (connection) => {
      for (const table of this.created) {
        const stagingName = stagingTableName(this.generation, table);
        if (this.tier === 'spill') {
          // Post-boundary staging only ever holds the current file's rows (see beginFile).
          await connection.query(`DELETE FROM ${quoteIdentifier(stagingName)};`);
          this.stagedBytes.set(table, 0);
        } else {
          await connection.query(
            `DELETE FROM ${quoteIdentifier(stagingName)} WHERE _src_file = ${quoteString(file)};`,
          );
        }
      }
    });
    const discardedChunks = [...this.currentFileChunks.entries()];
    for (const [table, chunks] of discardedChunks) {
      const kept = (this.chunkPaths.get(table) ?? []).filter((path) => !chunks.includes(path));
      if (kept.length > 0) this.chunkPaths.set(table, kept);
      else this.chunkPaths.delete(table);
    }
    await deleteSpillChunks(discardedChunks.flatMap(([, chunks]) => chunks));
    for (const [table, rows] of this.currentFileRows) {
      this.rowCounts.set(table, Math.max(0, (this.rowCounts.get(table) ?? 0) - rows));
    }
    this.currentFile = null;
    this.currentFileChunks.clear();
    this.currentFileRows.clear();
  }

  async finalize(backfillSchemas?: readonly TableSchema[]): Promise<readonly TableSummary[]> {
    if (this.state !== 'open') {
      throw new Error(`Ingest session is ${this.state}; cannot finalize.`);
    }
    this.state = 'finalized';
    try {
      if (this.tier === 'spill') {
        // Flush every table's residual (never-rotated) staged rows as one final chunk, outside
        // the swap transaction, so the transaction only ever touches metadata.
        await this.enqueue(async (connection) => {
          for (const table of this.sessionTables()) {
            if (this.created.has(table) && (this.stagedBytes.get(table) ?? 0) > 0) {
              try {
                await this.rotateChunk(connection, table);
              } catch (error) {
                if (!isQuotaError(error)) {
                  throw error;
                }
                // Same tagging as appendBatch's mid-ingest rotation (Trivia 2), so the controller
                // shows its clear "ran out of space" message instead of a raw DB/OS error string.
                throw new ByteqlDbError(
                  'SPILL_QUOTA_EXCEEDED',
                  `SPILL_QUOTA_EXCEEDED: failed to spill ${JSON.stringify(table)} to OPFS.`,
                  {
                    cause: error,
                  },
                );
              }
            }
          }
        });
      }

      // A pack schema for a table this session never saw an `appendBatch` for (e.g. no `tcp`
      // packets in this capture). Backfilled so the table still exists — callers (like a UNION ALL
      // overview query) assume every pack table exists, not just the ones this particular file
      // happened to populate.
      const backfillByName = new Map((backfillSchemas ?? []).map((schema) => [schema.name, schema]));
      const schemaFor = (table: string): TableSchema | undefined => backfillByName.get(table);
      const finalizeTables: readonly string[] = [...new Set([...this.created, ...backfillByName.keys()])];

      const committed = await this.enqueue(async (connection) => {
        await connection.query('BEGIN TRANSACTION;');
        try {
          await this.catalog.dropFinals(connection);

          const finalKinds = new Map<string, CatalogKind>();
          const summaries: TableSummary[] = [];
          for (const table of finalizeTables) {
            const stagingName = stagingTableName(this.generation, table);
            const chunks = this.chunkPaths.get(table) ?? [];
            if (this.tier === 'spill' && this.created.has(table) && chunks.length > 0) {
              // Explicit path array from the tracked chunk names — never a glob (spike finding).
              const pathList = chunks.map(quoteString).join(', ');
              await connection.query(
                `CREATE VIEW ${quoteIdentifier(table)} AS SELECT * FROM parquet_scan([${pathList}]);`,
              );
              await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(stagingName)};`);
              finalKinds.set(table, 'view');
            } else {
              if (!this.created.has(table)) {
                // A table that was never appended to: either a table backfilled from
                // `backfillSchemas`, or a spill-tier table with zero rotated/residual chunks.
                // Falls back to an empty TABLE rather than a view over nothing.
                const schema = schemaFor(table);
                if (!schema) {
                  throw new Error(`Missing schema for never-appended ingest table: ${JSON.stringify(table)}`);
                }
                const columnsDdl = schema.columns
                  .map((column) => `${quoteIdentifier(column.name)} ${duckdbColumnType(column.type)}`)
                  .join(', ');
                await connection.query(`CREATE TABLE ${quoteIdentifier(stagingName)} (${columnsDdl});`);
              }
              await connection.query(
                `ALTER TABLE ${quoteIdentifier(stagingName)} RENAME TO ${quoteIdentifier(table)};`,
              );
              finalKinds.set(table, 'table');
            }
            summaries.push({ name: table, rowCount: this.rowCounts.get(table) ?? 0 });
          }

          await connection.query('COMMIT;');
          return { summaries, finalKinds };
        } catch (error) {
          try {
            await connection.query('ROLLBACK;');
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Ingest finalize and rollback failed.', {
              cause: rollbackError,
            });
          }
          throw error;
        }
      });

      await this.catalog.swap(committed.finalKinds, this.tier === 'spill' ? this.generation : null);

      return committed.summaries;
    } catch (error) {
      this.state = 'failed';
      throw error;
    } finally {
      this.onSettled();
    }
  }

  async abort(): Promise<void> {
    if (this.state !== 'open' && this.state !== 'failed') {
      return;
    }
    this.state = 'aborted';
    try {
      await this.enqueue((connection) => this.dropStaging(connection));
      if (this.tier === 'spill') {
        await deleteSpillGeneration(this.generation);
      }
    } finally {
      this.onSettled();
    }
  }
}
