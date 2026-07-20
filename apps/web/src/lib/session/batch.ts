import { tableToIpc, type FormatPack, type TableOverview } from '@byteql/core';
import { Int32, Table, Uint64, Utf8, vectorFromArray } from 'apache-arrow';

import { PROBE_HEAD_BYTES, selectPack } from '../packs.js';

export interface BatchEntry {
  name: string;
  size: number;
  blob: Blob;
}

export interface PlannedFile {
  displayName: string;
  originalName: string;
  size: number;
  blob: Blob;
  status: 'ok' | 'skipped';
  error: string | null;
}

export interface BatchPlan {
  formatId: string | null;
  formatTitle: string | null;
  files: readonly PlannedFile[];
  totalSize: number;
}

/** Dedupes display names with ` (n)` suffixes inserted before the extension. */
export function dedupeDisplayNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  const counts = new Map<string, number>();
  return names.map((name) => {
    let candidate = name;
    let count = counts.get(name) ?? 1;
    while (taken.has(candidate)) {
      count += 1;
      if (/ \(\d+\)/.test(name)) {
        // Name already has a suffix pattern, just append
        candidate = `${name} (${count})`;
      } else {
        // Regular name, insert before extension
        const dot = name.lastIndexOf('.');
        candidate = dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
      }
    }
    counts.set(name, count);
    taken.add(candidate);
    return candidate;
  });
}

/**
 * Probes every entry's head bytes, elects the batch format from the first recognized file, and
 * marks mismatching or unrecognized files skipped. Pure planning — nothing is parsed yet.
 */
export async function planBatch(
  entries: readonly BatchEntry[],
  packs: readonly FormatPack[],
): Promise<BatchPlan> {
  const displayNames = dedupeDisplayNames(entries.map((entry) => entry.name));
  let elected: FormatPack | null = null;
  const files: PlannedFile[] = [];
  for (const [index, entry] of entries.entries()) {
    const head = new Uint8Array(await entry.blob.slice(0, PROBE_HEAD_BYTES).arrayBuffer());
    const pack = selectPack(packs, head);
    const base = {
      displayName: displayNames[index]!,
      originalName: entry.name,
      size: entry.size,
      blob: entry.blob,
    };
    if (!pack) {
      files.push({ ...base, status: 'skipped', error: 'No registered format recognizes this file.' });
    } else if (elected === null || pack.id === elected.id) {
      elected ??= pack;
      files.push({ ...base, status: 'ok', error: null });
    } else {
      files.push({
        ...base,
        status: 'skipped',
        error: `Format mismatch — this batch is ${elected.title}.`,
      });
    }
  }
  const totalSize = files.reduce((sum, file) => (file.status === 'ok' ? sum + file.size : sum), 0);
  return { formatId: elected?.id ?? null, formatTitle: elected?.title ?? null, files, totalSize };
}

export interface FilesRow {
  file: string;
  originalName: string;
  size: number;
  ingestOrder: number;
  status: 'ok' | 'skipped';
  error: string | null;
}

/** Builds the `_files` catalog batch (spec: file/original_name/size/ingest_order/status/error). */
export function buildFilesTableIpc(rows: readonly FilesRow[]): Uint8Array {
  return tableToIpc(
    new Table({
      file: vectorFromArray(rows.map((row) => row.file), new Utf8()),
      original_name: vectorFromArray(rows.map((row) => row.originalName), new Utf8()),
      size: vectorFromArray(rows.map((row) => BigInt(row.size)), new Uint64()),
      ingest_order: vectorFromArray(rows.map((row) => row.ingestOrder), new Int32()),
      status: vectorFromArray(rows.map((row) => row.status), new Utf8()),
      error: vectorFromArray(rows.map((row) => row.error), new Utf8()),
    }),
  );
}

/** Unions per-file parse overviews: row counts sum by name; first-seen order and columns win. */
export function mergeTableOverviews(
  perFile: readonly (readonly TableOverview[])[],
): TableOverview[] {
  const merged: TableOverview[] = [];
  const index = new Map<string, number>();
  for (const overviews of perFile) {
    for (const overview of overviews) {
      const position = index.get(overview.name);
      if (position === undefined) {
        index.set(overview.name, merged.length);
        merged.push({ ...overview });
      } else {
        const current = merged[position]!;
        merged[position] = { ...current, rowCount: current.rowCount + overview.rowCount };
      }
    }
  }
  return merged;
}
