import { AsyncDuckDB, VoidLogger, selectBundle } from '@duckdb/duckdb-wasm';

// reuse LOCAL_BUNDLES by exporting it from browser.ts (internal export)
import { LOCAL_BUNDLES } from './browser.js';

export interface SpillProbeReport {
  opfsAvailable: boolean;
  copyToOpfs: boolean;
  allowedDirectories: boolean;
  /** Verifies reading multiple registered OPFS parquet parts via an explicit path array — not
   *  an actual glob: this duckdb-wasm build's `opfs://` globs don't enumerate files (see below). */
  parquetScanGlob: boolean;
  fileStatistics: boolean;
  detail: string;
}

export async function probeSpillCapability(): Promise<SpillProbeReport> {
  const report: SpillProbeReport = {
    opfsAvailable: false,
    copyToOpfs: false,
    allowedDirectories: false,
    parquetScanGlob: false,
    fileStatistics: false,
    detail: '',
  };
  const notes: string[] = [];
  report.opfsAvailable = typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  if (!report.opfsAvailable) {
    report.detail = 'navigator.storage.getDirectory missing';
    return report;
  }

  const bundle = await selectBundle(LOCAL_BUNDLES);
  if (!bundle.mainWorker) {
    report.detail = 'DuckDB-WASM did not select a browser worker.';
    return report;
  }
  const worker = new Worker(bundle.mainWorker);
  const db = new AsyncDuckDB(new VoidLogger(), worker);
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();
    const path = 'opfs://byteql-spill/__probe__/t/0.parquet';
    const secondPath = 'opfs://byteql-spill/__probe__/t/1.parquet';
    try {
      await db.registerOPFSFileName(path);
      await conn.query(`CREATE TABLE __probe AS SELECT 1 AS a, 2 AS b, 3 AS c;`);
      await conn.query(`COPY __probe TO '${path}' (FORMAT parquet);`);
      report.copyToOpfs = true;
    } catch (error) {
      notes.push(`copyToOpfs: ${String(error)}`);
    }
    if (report.copyToOpfs) {
      // duckdb-wasm 1.33.1-dev57.0 does not implement real directory enumeration for
      // opfs:// glob patterns (SQL glob syntax and db.globFiles() both find nothing even
      // though the file exists — verified empirically). The spill design never needed SQL
      // glob anyway: the writer already knows every part-file name it created while
      // rotating, so this probes the mechanism the design actually uses instead — reading
      // multiple registered OPFS parquet parts as one relation via an explicit path array.
      try {
        await db.registerOPFSFileName(secondPath);
        await conn.query(`COPY __probe TO '${secondPath}' (FORMAT parquet);`);
        const multi = await conn.query(
          `SELECT count(*) AS n FROM parquet_scan(['${path}', '${secondPath}']);`,
        );
        report.parquetScanGlob = Number(multi.getChildAt(0)?.get(0)) === 2;
      } catch (error) {
        notes.push(`parquetScanGlob: ${String(error)}`);
      }
      try {
        await db.collectFileStatistics(path, true);
        await conn.query(`SELECT a FROM parquet_scan('${path}');`);
        await db.exportFileStatistics(path);
        report.fileStatistics = true;
      } catch (error) {
        notes.push(`fileStatistics: ${String(error)}`);
      }
    }
    try {
      await conn.query(`SET allowed_directories = ['opfs://byteql-spill/'];`);
      await conn.query(`SET enable_external_access = false;`);
      // whitelisted path must still work, non-whitelisted must fail:
      await conn.query(`SELECT count(*) FROM parquet_scan('${path}');`);
      let leaked = false;
      try {
        await conn.query(`SELECT * FROM parquet_scan('opfs://elsewhere/x.parquet');`);
        leaked = true;
      } catch {
        /* expected */
      }
      report.allowedDirectories = report.copyToOpfs && !leaked;
    } catch (error) {
      notes.push(`allowedDirectories: ${String(error)}`);
    }
    await conn.close();
  } finally {
    // best-effort probe cleanup
    try {
      await db.dropFiles();
    } catch {
      /* ignore */
    }
    try {
      await db.terminate();
    } catch {
      /* ignore */
    }
    try {
      const root = await navigator.storage.getDirectory();
      const spill = await root.getDirectoryHandle('byteql-spill');
      await spill.removeEntry('__probe__', { recursive: true });
    } catch {
      /* ignore */
    }
  }
  report.detail = notes.join(' | ');
  return report;
}
