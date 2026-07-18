import { Table } from 'apache-arrow';
import type { Vector } from 'apache-arrow';
import type { ArrowTypeName } from '../projection/spec.js';
import { columnVector } from './build.js';

export interface BatchBuilderOptions {
  readonly flushRowThreshold?: number;
}

const DEFAULT_FLUSH_ROW_THRESHOLD = 65_536;

export class TableBatchBuilder {
  readonly #name: string;
  readonly #types: Readonly<Record<string, ArrowTypeName>>;
  readonly #columnNames: readonly string[];
  readonly #threshold: number;
  #pending: Record<string, unknown[]>;
  #pendingRows = 0;
  #chunks: Table[] = [];
  #rowCount = 0;

  constructor(
    name: string,
    types: Readonly<Record<string, ArrowTypeName>>,
    options: BatchBuilderOptions = {},
  ) {
    this.#name = name;
    this.#types = types;
    this.#columnNames = Object.keys(types);
    this.#threshold = Math.max(1, options.flushRowThreshold ?? DEFAULT_FLUSH_ROW_THRESHOLD);
    this.#pending = this.#emptyPending();
  }

  get rowCount(): number {
    return this.#rowCount + this.#pendingRows;
  }

  appendRow(values: Readonly<Record<string, unknown>>): void {
    for (const column of this.#columnNames) {
      this.#pending[column]!.push(column in values ? (values[column] ?? null) : null);
    }
    this.#pendingRows += 1;
    if (this.#pendingRows >= this.#threshold) this.#seal();
  }

  finish(): Table {
    if (this.#pendingRows > 0 || this.#chunks.length === 0) this.#seal();
    const batches = this.#chunks.flatMap((chunk) => chunk.batches);
    // With apache-arrow 21 even an all-empty chunk contributes one zero-row
    // RecordBatch, so this fallback is unreachable today; it stays as a guard
    // so the schema survives if a future arrow version drops empty batches.
    return batches.length > 0 ? new Table(batches) : this.#chunks[0]!;
  }

  #emptyPending(): Record<string, unknown[]> {
    return Object.fromEntries(this.#columnNames.map((column) => [column, []]));
  }

  #seal(): void {
    const vectors: Record<string, Vector> = {};
    for (const column of this.#columnNames) {
      vectors[column] = columnVector(this.#pending[column]!, this.#types[column]!, this.#name, column);
    }
    this.#chunks.push(new Table(vectors));
    this.#rowCount += this.#pendingRows;
    this.#pending = this.#emptyPending();
    this.#pendingRows = 0;
  }
}
