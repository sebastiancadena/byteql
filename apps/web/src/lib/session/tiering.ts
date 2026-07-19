/** Files at or above this size use the OPFS-backed spill tier instead of the in-memory tier. */
export const TIER_THRESHOLD_BYTES = 64 * 1024 * 1024;

/** Picks the ingest tier for a source of `size` bytes; `size >= threshold` spills. */
export function chooseTier(size: number, threshold: number = TIER_THRESHOLD_BYTES): 'memory' | 'spill' {
  return size >= threshold ? 'spill' : 'memory';
}
