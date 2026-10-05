/** Quotes a DuckDB identifier, doubling any embedded double quote. */
export const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** Quotes a DuckDB string literal, doubling any embedded single quote. */
export const quoteString = (value: string): string => `'${value.replaceAll("'", "''")}'`;
