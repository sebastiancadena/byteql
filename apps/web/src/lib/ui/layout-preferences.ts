import { emptyPreferences, type LayoutPreferences } from './panel-layout.js';

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LAYOUT_KEY = 'byteql.ui.layout.v1';

/** Pre-v1 storage held a single hex pane height under this key. */
const LEGACY_HEIGHT_KEY = 'byteql.hexpane.height';

const MIN_FIELD = 0;
const MAX_FIELD = 10000;

/** A stored field is only trusted when it is a finite number in `(0, 10000]`; it is rounded to
 * the nearest pixel. Anything else — the wrong type, an out-of-range or non-finite number —
 * resolves to `null`, which falls back to the viewport default. */
function validField(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= MIN_FIELD || value > MAX_FIELD) return null;
  return Math.round(value);
}

function parseV1(raw: string): LayoutPreferences {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return emptyPreferences();
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return emptyPreferences();
  return {
    version: 1,
    sourcesWidth: validField(record.sourcesWidth),
    queryHeight: validField(record.queryHeight),
    dockHeight: validField(record.dockHeight),
    valuesWidth: validField(record.valuesWidth),
  };
}

function parseLegacyHeight(raw: string | null): LayoutPreferences {
  const height = validField(raw === null || raw.trim() === '' ? Number.NaN : Number(raw));
  return { ...emptyPreferences(), dockHeight: height };
}

/** Reads persisted layout preferences. A v1 record is validated field by field; when it is
 * absent, a legacy single-height record is imported once. Any storage failure, malformed JSON,
 * or unsupported shape falls back to `emptyPreferences()`. */
export function readLayoutPreferences(storage: LayoutStorage | null): LayoutPreferences {
  if (!storage) return emptyPreferences();
  try {
    const raw = storage.getItem(LAYOUT_KEY);
    if (raw !== null) return parseV1(raw);
    return parseLegacyHeight(storage.getItem(LEGACY_HEIGHT_KEY));
  } catch {
    return emptyPreferences();
  }
}

/** Writes a freshly constructed whitelist object with exactly the five known fields — never the
 * caller's object, so stray extra properties can never reach storage. Failures are swallowed;
 * the preference is optional. */
export function writeLayoutPreferences(
  storage: LayoutStorage | null,
  preferences: LayoutPreferences,
): void {
  if (!storage) return;
  const whitelisted: LayoutPreferences = {
    version: 1,
    sourcesWidth: preferences.sourcesWidth,
    queryHeight: preferences.queryHeight,
    dockHeight: preferences.dockHeight,
    valuesWidth: preferences.valuesWidth,
  };
  try {
    storage.setItem(LAYOUT_KEY, JSON.stringify(whitelisted));
  } catch {
    // Preference is optional.
  }
}
