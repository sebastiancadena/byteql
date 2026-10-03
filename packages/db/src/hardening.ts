import type { AsyncDuckDB, AsyncDuckDBConnection, DuckDBBundle } from '@duckdb/duckdb-wasm';

// DuckDB-WASM loads parquet dynamically. ByteQL mirrors both signed platform variants under this
// same-origin repository; letting LOAD use DuckDB's default would leak a request to
// extensions.duckdb.org during startup. Set the repository before LOAD, then disable all further
// extension loading in `hardenConnection`.
const LOCAL_EXTENSION_REPOSITORY_PATH = '/duckdb-extensions';

/** The OPFS directories production lets DuckDB touch: the spill tier and result exports. */
export const PRODUCTION_ALLOWED_DIRECTORIES: readonly string[] = [
  'opfs://byteql-spill/',
  'opfs://byteql-exports/',
];

const quoteStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const loadLocalParquetStatement = (moduleUrl: string): string => {
  const platform = moduleUrl.includes('mvp') ? 'wasm_mvp' : 'wasm_eh';
  const extension = new URL(
    `${LOCAL_EXTENSION_REPOSITORY_PATH}/v1.5.4/${platform}/parquet.duckdb_extension.wasm`,
    location.origin,
  ).href;
  return `LOAD '${extension.replaceAll("'", "''")}';`;
};

/** @internal Resolves a (possibly gzip-compressed) bundled WASM module to an instantiable URL. */
export const prepareWasmModule = async (
  moduleUrl: string,
): Promise<{ readonly url: string; readonly release: () => void }> => {
  if (!moduleUrl.endsWith('.wasm.gz')) {
    return { url: moduleUrl, release: () => undefined };
  }

  const response = await fetch(moduleUrl);
  if (!response.ok) {
    throw new Error(`Failed to load compressed DuckDB-WASM module: HTTP ${response.status}.`);
  }
  if (!response.body) {
    throw new Error('Failed to load compressed DuckDB-WASM module: response body is unavailable.');
  }

  const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'));
  const blob = await new Response(decompressed, {
    headers: { 'Content-Type': 'application/wasm' },
  }).blob();
  const url = URL.createObjectURL(blob);
  return { url, release: () => URL.revokeObjectURL(url) };
};

/** The bundle fields the local-instantiation helper needs (probes pass the raw `LOCAL_BUNDLES` entries). */
export type LocalBundle = Pick<DuckDBBundle, 'mainModule'> & Partial<Pick<DuckDBBundle, 'pthreadWorker'>>;

/**
 * @internal Resolves a bundle's module URL against the page, for callers whose worker is not
 * served from the page origin path (a blob worker cannot resolve a root-relative URL).
 */
export const absoluteBundle = <T extends LocalBundle>(bundle: T): T => ({
  ...bundle,
  mainModule: new URL(bundle.mainModule, location.href).href,
});

/**
 * @internal Instantiates `database` from a local bundle, opens a connection, and loads the
 * same-origin parquet extension. Hardening is deliberately NOT applied here: LOAD must precede
 * it, and callers (probes) may need to do pre-lock work. `onConnection` fires as soon as the
 * connection exists, before LOAD, so a caller can own it for cleanup if a later step throws.
 */
export const openLocalConnection = async (
  database: AsyncDuckDB,
  bundle: LocalBundle,
  onConnection?: (connection: AsyncDuckDBConnection) => void,
): Promise<AsyncDuckDBConnection> => {
  const module = await prepareWasmModule(bundle.mainModule);
  try {
    await database.instantiate(module.url, bundle.pthreadWorker);
  } finally {
    module.release();
  }
  const connection = await database.connect();
  onConnection?.(connection);
  await connection.query(loadLocalParquetStatement(bundle.mainModule));
  return connection;
};

/**
 * @internal The one DuckDB lockdown routine. Order matters: `allowed_directories` must be set
 * BEFORE external access is disabled (DuckDB rejects changing it once external access is off),
 * then extension loading is disabled, then the configuration is locked.
 */
export const hardenConnection = async (
  connection: AsyncDuckDBConnection,
  options: { readonly allowedDirectories: readonly string[] },
): Promise<void> => {
  const allowed = options.allowedDirectories.map(quoteStringLiteral).join(', ');
  const statements = [
    `SET allowed_directories = [${allowed}];`,
    'SET enable_external_access = false;',
    'SET autoinstall_known_extensions = false;',
    'SET autoload_known_extensions = false;',
    'SET allow_community_extensions = false;',
    'SET lock_configuration = true;',
  ];
  for (const statement of statements) {
    await connection.query(statement);
  }
};
