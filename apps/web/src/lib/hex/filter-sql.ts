/**
 * Wraps the current query with the byte-overlap predicate for selection [start, end).
 * `_src_end` is exclusive engine-side, hence strict/strict comparisons.
 */
export function wrapFilterSql(sql: string, range: { start: number; end: number }): string {
  const inner = sql.trim().replace(/;\s*$/u, '');
  return `select * from (\n${inner}\n) where _src_start < ${range.end} and _src_end > ${range.start};`;
}
