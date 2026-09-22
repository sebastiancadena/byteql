import type { Schema } from 'apache-arrow';

import { isSourceRangesType, resultColumnIndex } from '@byteql/db/result-columns';

import { sqlStringLiteral } from '../sql-literal.js';

/**
 * Wraps the current query with the file-scoped byte-overlap predicate for selection
 * [start, end) in `file`. `_src_end` is exclusive engine-side, hence strict/strict comparisons.
 * When the result carries exact `_src_ranges`, a bounded row matches only if one of its pieces
 * overlaps the selection — bytes inside its span but outside every piece are not its content.
 */
export function wrapFilterSql(
  sql: string,
  selection: { file: string; start: number; end: number },
  schema: Schema | null,
): string {
  const inner = sql.trim().replace(/;\s*$/u, '');
  const rangesIndex = schema ? resultColumnIndex(schema, '_src_ranges') : null;
  const exact =
    schema && rangesIndex !== null && isSourceRangesType(schema.fields[rangesIndex]!.type)
      ? ` and (_src_ranges is null or len(list_filter(_src_ranges, lambda r: r.start < ${selection.end} and r."end" > ${selection.start})) > 0)`
      : '';
  return `select * from (\n${inner}\n) where _src_file = ${sqlStringLiteral(selection.file)} and _src_start < ${selection.end} and _src_end > ${selection.start}${exact};`;
}
