import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const templatesDir = fileURLToPath(new URL('../templates/', import.meta.url));

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** Every regular file under `base`, recursively, as absolute paths. */
const walk = async (base) => {
  const entries = await readdir(base, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(base, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
};

/**
 * `byteql-pack new <id>`: scaffolds a new format pack at `<dir>/<id>/`, copying every file
 * under `templates/` with `__ID__` substituted for `id` in both file/directory names and file
 * contents. Rejects an `id` that isn't a bare identifier and a `<dir>/<id>` that already exists.
 * Returns the created pack directory's absolute path.
 */
export const newPack = async (dir, id) => {
  if (typeof id !== 'string' || !identifierPattern.test(id)) {
    throw new Error(`byteql-pack new: "${id ?? ''}" must be an identifier (e.g. "my_format")`);
  }
  const target = join(dir, id);
  if (await exists(target)) {
    throw new Error(`byteql-pack new: ${target} already exists`);
  }
  const files = await walk(templatesDir);
  for (const file of files) {
    const relPath = relative(templatesDir, file).split('__ID__').join(id);
    const destPath = join(target, relPath);
    const content = (await readFile(file, 'utf8')).split('__ID__').join(id);
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, content);
  }
  return target;
};
