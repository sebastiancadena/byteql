// A table reference is `from`/`join` followed by an (optionally quoted) identifier that is NOT
// immediately followed by `(` — the negative lookahead excludes table functions such as
// `from unnest(...)` or `from range(...)`, which this lint does not attempt to validate.
const TABLE_REF = /\b(?:from|join)\s+("?)([A-Za-z_][A-Za-z0-9_]*)\1(?!\s*\()/giu;
const CTE_NAME = /(?:\bwith\s+(?:recursive\s+)?|,\s*)([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/giu;
const ENGINE_TABLES = ['errors', '_files'];

/**
 * Validates a parsed `queries.yaml` (`{ version, queries }`, `format` tolerated and ignored)
 * against the pack's own spec tables plus the engine/app tables every pack may reference.
 * Returns the query list on success; throws `Error` with a `file: queries.N: message` prefix
 * on the first problem found.
 */
export const lintQueries = (queryPack, { tables, capabilities, file }) => {
  if (!queryPack || queryPack.version !== '0.1' || !Array.isArray(queryPack.queries)) {
    throw new Error(`${file}: must declare version '0.1' and a queries list`);
  }
  const ids = new Set();
  queryPack.queries.forEach((query, index) => {
    const at = `${file}: queries.${index}`;
    for (const key of ['id', 'title', 'kind', 'sql']) {
      if (typeof query?.[key] !== 'string') throw new Error(`${at}: ${key} must be a string`);
    }
    if (ids.has(query.id)) throw new Error(`${at}: duplicate id "${query.id}"`);
    ids.add(query.id);
    if (!['grid', 'playback'].includes(query.kind)) throw new Error(`${at}: unknown kind "${query.kind}"`);
    if (query.kind === 'playback' && !capabilities.includes('audio')) {
      throw new Error(`${at}: kind "playback" requires capability "audio"`);
    }
    const ctes = new Set([...query.sql.matchAll(CTE_NAME)].map((m) => m[1].toLowerCase()));
    for (const match of query.sql.matchAll(TABLE_REF)) {
      const name = match[2].toLowerCase();
      if (!tables.has(name) && !ctes.has(name) && !ENGINE_TABLES.includes(name)) {
        throw new Error(`${at}: unknown table "${match[2]}"`);
      }
    }
  });
  return queryPack.queries;
};

/** The lower-cased table names a compiled `ProjectionSpec` exposes to queries: declared tables
 * plus every stream's `segments_table` (a stream's `table` is itself a declared table already). */
export const specTableNames = (spec) =>
  new Set([
    ...spec.tables.map((t) => t.name.toLowerCase()),
    ...(spec.streams ?? []).map((s) => s.segments_table.toLowerCase()),
  ]);
