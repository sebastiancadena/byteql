import { sqlStringLiteral } from '../sql-literal.js';

/**
 * Wraps the current query with the file-scoped byte-overlap predicate for selection
 * [start, end) in `file`. `_src_end` is exclusive engine-side, hence strict/strict comparisons.
 */
export function wrapFilterSql(sql: string, selection: { file: string; start: number; end: number }): string {
  const inner = sql.trim().replace(/;\s*$/u, '');
  return `select * from (\n${inner}\n) where _src_file = ${sqlStringLiteral(selection.file)} and _src_start < ${selection.end} and _src_end > ${selection.start};`;
}
