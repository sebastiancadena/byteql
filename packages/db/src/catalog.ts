import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';

import { deleteSpillGeneration } from './spill-files.js';
import { quoteIdentifier } from './sql.js';

/** The DuckDB catalog kind a committed final was created as; drives which typed DROP applies. */
export type CatalogKind = 'table' | 'view';

/**
 * Issues exactly one type-correct drop for a recorded final. DuckDB (even pinned 1.33.1-dev57.0)
 * throws a Catalog Error on `DROP VIEW IF EXISTS t` when `t` is a table (and vice versa), so the
 * blind "drop both" pattern is never safe against a real database — only a single, kind-correct
 * drop is.
 */
const dropFinal = async (
  connection: AsyncDuckDBConnection,
  name: string,
  kind: CatalogKind,
): Promise<void> => {
  const keyword = kind === 'view' ? 'DROP VIEW IF EXISTS' : 'DROP TABLE IF EXISTS';
  await connection.query(`${keyword} ${quoteIdentifier(name)};`);
};

/**
 * The committed state of the queryable catalog: every final table/view name with the kind it was
 * created as, and the spill generation whose OPFS parquet payload backs the committed views.
 */
export class Catalog {
  private finals: ReadonlyMap<string, CatalogKind> = new Map();
  private generation: number | null = null;

  /** The committed final names, in creation order. */
  names(): readonly string[] {
    return [...this.finals.keys()];
  }

  /** The generation currently backing committed spill views, or `null` when none does. */
  get spillGeneration(): number | null {
    return this.generation;
  }

  /**
   * Drops every committed final, one kind-correct DROP each. Run inside the caller's swap
   * transaction: an old final may be a view (a prior spill generation) or a table (a prior memory
   * generation), and its recorded kind says exactly which single drop applies.
   */
  async dropFinals(connection: AsyncDuckDBConnection): Promise<void> {
    for (const [name, kind] of this.finals) {
      await dropFinal(connection, name, kind);
    }
  }

  /**
   * Records a committed finalize: its finals and the spill generation backing them (`null` for a
   * memory-tier finalize). The displaced generation's OPFS payload is orphaned at this point — a
   * memory-tier finalize's DROP already replaced any spill-backed views with plain tables — so it
   * is reclaimed now rather than left for the next launch's orphan sweep or database dispose.
   */
  async swap(finals: ReadonlyMap<string, CatalogKind>, generation: number | null): Promise<void> {
    this.finals = new Map(finals);
    const previousGeneration = this.generation;
    this.generation = generation;
    if (previousGeneration !== null) {
      await deleteSpillGeneration(previousGeneration);
    }
  }
}
