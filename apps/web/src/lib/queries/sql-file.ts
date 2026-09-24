export const QUERY_FILE_MAX_BYTES = 1024 * 1024;
export const QUERY_SQL_MAX_BYTES = 64 * 1024;

const HEADER = '-- byteql-queries v1';
const UNTITLED = 'Untitled query';
const NAME_MARKER = /^[ \t]*--[ \t]*name:(.*)$/u;
const FORMAT_MARKER = /^[ \t]*--[ \t]*format:(.*)$/u;
/**
 * A line that reads as a marker, optionally already escaped with backslashes after `--`.
 * Export adds one backslash to every such line inside SQL; import removes one from every line
 * that has at least one. A literal `--\ name:` in SQL therefore round-trips too.
 */
const MARKER_LIKE = /^([ \t]*)--(\\*)([ \t]*(?:name|format):)/u;
const ESCAPED_MARKER = /^([ \t]*)--\\(\\*)([ \t]*(?:name|format):)/u;

export class QueryFileError extends Error {
  override name = 'QueryFileError';
}

export interface QueryFileEntry {
  name: string;
  sql: string;
}

export interface RejectedBlock {
  name: string;
  reason: 'empty' | 'too-large' | 'unnamed';
}

export interface ParsedQueryFile {
  format: string | null;
  queries: QueryFileEntry[];
  rejected: RejectedBlock[];
}

const singleLine = (name: string): string => name.replace(/\s+/gu, ' ').trim() || UNTITLED;

/** A line that carries no real content: blank, or a `--` comment (which also covers the header
 * and `-- format:` lines, so this alone decides whether a preamble is "nothing but comments"). */
const isCommentOrBlank = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('--');
};

/** CRLF to LF, leading blank lines dropped, trailing whitespace trimmed. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/\r\n?/gu, '\n')
    .replace(/^(?:[ \t]*\n)+/u, '')
    .trimEnd();
}

const escapeLine = (line: string): string =>
  line.replace(
    MARKER_LIKE,
    (_match, indent: string, slashes: string, rest: string) => `${indent}--\\${slashes}${rest}`,
  );

const unescapeLine = (line: string): string =>
  line.replace(
    ESCAPED_MARKER,
    (_match, indent: string, slashes: string, rest: string) => `${indent}--${slashes}${rest}`,
  );

export function decodeQueryFile(bytes: Uint8Array): string {
  if (bytes.byteLength > QUERY_FILE_MAX_BYTES) {
    throw new QueryFileError('The file is larger than 1 MiB.');
  }
  try {
    // `ignoreBOM: false` (the default) strips a leading UTF-8 BOM.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new QueryFileError('The file is not valid UTF-8 text.');
  }
}

export function serializeQueryFile(format: string, queries: readonly QueryFileEntry[]): string {
  let text = `${HEADER}\n-- format: ${singleLine(format)}\n`;
  for (const query of queries) {
    const body = normalizeSql(query.sql).split('\n').map(escapeLine).join('\n');
    text += `\n-- name: ${singleLine(query.name)}\n${body}\n`;
  }
  return text;
}

function addBlock(result: ParsedQueryFile, name: string, raw: string): void {
  const sql = normalizeSql(raw);
  if (sql.trim() === '') {
    result.rejected.push({ name, reason: 'empty' });
  } else if (new TextEncoder().encode(sql).byteLength > QUERY_SQL_MAX_BYTES) {
    result.rejected.push({ name, reason: 'too-large' });
  } else {
    result.queries.push({ name, sql });
  }
}

export function parseQueryFile(text: string, fallbackName: string): ParsedQueryFile {
  const lines = text
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .split('\n');
  const result: ParsedQueryFile = { format: null, queries: [], rejected: [] };
  const firstName = lines.findIndex((line) => NAME_MARKER.test(line));
  const preamble = firstName === -1 ? lines : lines.slice(0, firstName);
  const isLibraryFile = preamble.find((line) => line.trim() !== '')?.trim() === HEADER;

  // A plain no-marker .sql file never has a `-- format:` comment interpreted.
  if (firstName !== -1 || isLibraryFile) {
    for (const line of preamble) {
      const match = FORMAT_MARKER.exec(line);
      if (match) {
        result.format = match[1]!.trim() || null;
        break;
      }
    }
  }

  if (firstName === -1) {
    // A library file with no blocks is a genuinely empty export only when nothing besides its
    // header/format comments is present; anything else with no `-- name:` markers — including a
    // header-like file that turns out to carry real SQL — is imported whole, as one query,
    // rather than dropped.
    if (!(isLibraryFile && lines.every(isCommentOrBlank))) {
      addBlock(result, singleLine(fallbackName), lines.join('\n'));
    }
    return result;
  }

  // Non-blank, non-comment text before the first `-- name:` marker (beyond the header/format
  // lines) is never imported silently and never dropped silently: it becomes one rejected block.
  if (preamble.some((line) => !isCommentOrBlank(line))) {
    result.rejected.push({ name: singleLine(fallbackName), reason: 'unnamed' });
  }

  let name: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (name !== null) addBlock(result, name, body.map(unescapeLine).join('\n'));
  };
  for (const line of lines.slice(firstName)) {
    const match = NAME_MARKER.exec(line);
    if (match) {
      flush();
      name = singleLine(match[1]!);
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return result;
}
