/**
 * OPFS lifecycle helpers for the DuckDB spill tier.
 *
 * DuckDB-WASM's `opfs://` glob syntax does not enumerate files in this build (verified by the
 * Task 1 capability probe — see `spill-probe.ts`), so spill views are always built from an
 * explicit, session-tracked `parquet_scan([...])` path array, never a glob. These helpers only
 * manage the OPFS directory tree itself (composing paths, deleting generations, sweeping
 * orphans); they never read or enumerate the parquet files DuckDB writes.
 */

const SPILL_ROOT = 'byteql-spill';

/** Composes the documented spill chunk layout: opfs://byteql-spill/<generation>/<table>/<n>.parquet */
export const spillPath = (generation: number, table: string, n: number): string =>
  `opfs://${SPILL_ROOT}/${generation}/${table}/${n}.parquet`;

/** A `FileSystemDirectoryHandle` with the async-iterable `entries()` method current DOM libs omit. */
type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

const opfsAvailable = (): boolean => typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

/** Resolves the spill root directory handle, or `null` if OPFS or the directory is unavailable. */
const getSpillRoot = async (): Promise<FileSystemDirectoryHandle | null> => {
  if (!opfsAvailable()) {
    return null;
  }
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(SPILL_ROOT, { create: false });
  } catch {
    // No spill data has ever been written, or OPFS is unavailable; treat as empty.
    return null;
  }
};

/** Deletes a generation's spill directory recursively. Tolerates a missing directory. */
export const deleteSpillGeneration = async (generation: number): Promise<void> => {
  const spillRoot = await getSpillRoot();
  if (!spillRoot) {
    return;
  }
  try {
    await spillRoot.removeEntry(String(generation), { recursive: true });
  } catch {
    // Already absent, or removed concurrently; deletion is best-effort.
  }
};

/** Deletes every generation directory under the spill root that is not listed in `keep`. */
export const sweepSpillOrphans = async (keep: readonly number[]): Promise<void> => {
  const spillRoot = await getSpillRoot();
  if (!spillRoot) {
    return;
  }
  const keepNames = new Set(keep.map(String));
  const orphans: string[] = [];
  for await (const [name] of (spillRoot as IterableDirectoryHandle).entries()) {
    if (!keepNames.has(name)) {
      orphans.push(name);
    }
  }
  await Promise.all(
    orphans.map(async (name) => {
      try {
        await spillRoot.removeEntry(name, { recursive: true });
      } catch {
        // Removed concurrently; sweeping is best-effort.
      }
    }),
  );
};

const QUOTA_MESSAGE_PATTERN = /quota exceeded|no space left/i;

/** Matches a `QuotaExceededError` (DOM or duck-typed) or DuckDB/OS quota-exhaustion message text. */
export const isQuotaError = (error: unknown): boolean => {
  const name = error instanceof Error ? error.name : (error as { name?: unknown } | null)?.name;
  if (name === 'QuotaExceededError') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return QUOTA_MESSAGE_PATTERN.test(message);
};
