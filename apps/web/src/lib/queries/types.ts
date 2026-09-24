/** A named query the user deliberately saved, scoped to the format pack active at save time. */
export interface SavedQuery {
  id: string;
  /** `FormatPack` id, e.g. `pcap`. */
  format: string;
  /** Single line; not unique. */
  name: string;
  sql: string;
  createdAt: number;
  updatedAt: number;
}

/** One executed query. Kept in memory per tab; stored only while history persistence is on. */
export interface HistoryEntry {
  id: string;
  format: string;
  sql: string;
  ranAt: number;
  status: 'ok' | 'error';
  /** Null on error, or when the result was not fully loaded. */
  rowCount: number | null;
}

export interface QuerySettings {
  persistHistory: boolean;
  /** Maximum history entries across all formats. */
  historyLimit: number;
}

export const DEFAULT_SETTINGS: QuerySettings = Object.freeze({
  persistHistory: false,
  historyLimit: 100,
});
