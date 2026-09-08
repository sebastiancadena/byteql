const EXPORT_ROOT = 'byteql-exports';
const LOCK_PREFIX = 'byteql-exports';
const GENERATED_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

export interface ExportFiles {
  path(name: string): string;
  file(name: string): Promise<File>;
  createWritable(name: string): Promise<FileSystemWritableFileStream>;
  dispose(): Promise<void>;
}

type ReleaseLock = () => Promise<void>;

const tabId = crypto.randomUUID();

const errorName = (error: unknown): unknown =>
  error instanceof Error ? error.name : (error as { name?: unknown } | null)?.name;

const isNotFound = (error: unknown): boolean => errorName(error) === 'NotFoundError';

const lockName = (owner: string, exportId: string): string => `${LOCK_PREFIX}:${owner}:${exportId}`;

const assertBasename = (name: string): void => {
  if (!GENERATED_BASENAME.test(name) || name === '.' || name === '..') {
    throw new TypeError('Export file name must be an internally generated basename.');
  }
};

const getLockManager = (): LockManager | null => {
  if (typeof navigator === 'undefined') return null;
  const locks = navigator.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
};

const holdLock = async (locks: LockManager, name: string): Promise<ReleaseLock> => {
  let acquiredResolve!: () => void;
  let acquiredReject!: (error: unknown) => void;
  let releaseResolve!: () => void;
  const acquired = new Promise<void>((resolve, reject) => {
    acquiredResolve = resolve;
    acquiredReject = reject;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const request = locks
    .request(name, { mode: 'exclusive' }, async (lock) => {
      if (!lock) throw new Error(`Failed to acquire export ownership lock ${name}.`);
      acquiredResolve();
      await released;
    })
    .catch((error: unknown) => {
      acquiredReject(error);
      throw error;
    });
  void request.catch(() => undefined);
  await acquired;

  let releasedOnce = false;
  return async () => {
    if (!releasedOnce) {
      releasedOnce = true;
      releaseResolve();
    }
    await request;
  };
};

const sweepOrphans = async (exportRoot: FileSystemDirectoryHandle, locks: LockManager): Promise<void> => {
  for await (const [owner, ownerHandle] of (exportRoot as IterableDirectoryHandle).entries()) {
    if (ownerHandle.kind !== 'directory' || !UUID.test(owner)) continue;
    const ownerRoot = ownerHandle as FileSystemDirectoryHandle;
    for await (const [exportId, exportHandle] of (ownerRoot as IterableDirectoryHandle).entries()) {
      if (exportHandle.kind !== 'directory' || !UUID.test(exportId)) continue;
      try {
        await locks.request(
          lockName(owner, exportId),
          { mode: 'exclusive', ifAvailable: true },
          async (lock) => {
            if (!lock) return;
            try {
              await ownerRoot.removeEntry(exportId, { recursive: true });
            } catch (error) {
              if (!isNotFound(error)) throw error;
            }
          },
        );
      } catch {
        // Orphan collection is best-effort and must not block a new export.
      }
    }
  }
};

class OpfsExportFiles implements ExportFiles {
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(
    private readonly ownerRoot: FileSystemDirectoryHandle,
    private readonly ownedRoot: FileSystemDirectoryHandle,
    private readonly owner: string,
    private readonly exportId: string,
    private readonly releaseLock: ReleaseLock | null,
  ) {}

  path(name: string): string {
    this.assertOpen();
    assertBasename(name);
    return `opfs://${EXPORT_ROOT}/${this.owner}/${this.exportId}/${name}`;
  }

  async file(name: string): Promise<File> {
    this.assertOpen();
    assertBasename(name);
    return (await this.ownedRoot.getFileHandle(name, { create: false })).getFile();
  }

  async createWritable(name: string): Promise<FileSystemWritableFileStream> {
    this.assertOpen();
    assertBasename(name);
    const handle = await this.ownedRoot.getFileHandle(name, { create: true });
    this.assertOpen();
    return handle.createWritable();
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposed = true;
      this.disposePromise = (async () => {
        let cleanupError: unknown = null;
        try {
          try {
            await this.ownerRoot.removeEntry(this.exportId, { recursive: true });
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
        } catch (error) {
          cleanupError = error;
        } finally {
          try {
            await this.releaseLock?.();
          } catch (error) {
            cleanupError ??= error;
          }
        }
        if (cleanupError) throw cleanupError;
      })();
    }
    return this.disposePromise;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Export files are disposed.');
  }
}

export async function createExportFiles(): Promise<ExportFiles> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new DOMException('Origin-private file system is unavailable.', 'NotSupportedError');
  }

  const exportId = crypto.randomUUID();
  const locks = getLockManager();
  const releaseLock = locks ? await holdLock(locks, lockName(tabId, exportId)) : null;
  let ownerRoot: FileSystemDirectoryHandle | undefined;
  try {
    const root = await navigator.storage.getDirectory();
    const exportRoot = await root.getDirectoryHandle(EXPORT_ROOT, { create: true });
    ownerRoot = await exportRoot.getDirectoryHandle(tabId, { create: true });
    const ownedRoot = await ownerRoot.getDirectoryHandle(exportId, { create: true });

    // Without Web Locks, sweeping another tab cannot be race-free. In that environment each
    // instance removes only the exact resources it created, so crash leftovers may persist.
    if (locks) await sweepOrphans(exportRoot, locks);

    return new OpfsExportFiles(ownerRoot, ownedRoot, tabId, exportId, releaseLock);
  } catch (error) {
    if (ownerRoot) {
      try {
        await ownerRoot.removeEntry(exportId, { recursive: true });
      } catch {
        // Preserve the setup error.
      }
    }
    try {
      await releaseLock?.();
    } catch {
      // Preserve the setup error.
    }
    throw error;
  }
}
