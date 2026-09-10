import { describe, expect, it } from 'vitest';

import { emptyPreferences } from './panel-layout.js';
import {
  LAYOUT_KEY,
  type LayoutStorage,
  readLayoutPreferences,
  writeLayoutPreferences,
} from './layout-preferences.js';

function memoryStorage(initial: Record<string, string> = {}): LayoutStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe('readLayoutPreferences', () => {
  it('returns empty preferences when there is no storage', () => {
    expect(readLayoutPreferences(null)).toEqual(emptyPreferences());
  });

  it('returns empty preferences when nothing is stored', () => {
    expect(readLayoutPreferences(memoryStorage())).toEqual(emptyPreferences());
  });

  it('imports a legacy height only when v1 is absent', () => {
    const data = new Map([['byteql.hexpane.height', '320']]);
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    expect(readLayoutPreferences(storage).dockHeight).toBe(320);
    writeLayoutPreferences(storage, emptyPreferences());
    expect(readLayoutPreferences(storage).dockHeight).toBeNull();
    expect(data.get('byteql.hexpane.height')).toBe('320');
  });

  it('rejects a legacy value that is not a finite positive number', () => {
    expect(readLayoutPreferences(memoryStorage({ 'byteql.hexpane.height': 'garbage' }))).toEqual(
      emptyPreferences(),
    );
    expect(readLayoutPreferences(memoryStorage({ 'byteql.hexpane.height': '0' }))).toEqual(
      emptyPreferences(),
    );
    expect(readLayoutPreferences(memoryStorage({ 'byteql.hexpane.height': '-40' }))).toEqual(
      emptyPreferences(),
    );
    expect(readLayoutPreferences(memoryStorage({ 'byteql.hexpane.height': '10001' }))).toEqual(
      emptyPreferences(),
    );
  });

  it('rejects bad fields without discarding valid fields', () => {
    const storage = {
      getItem: () =>
        JSON.stringify({ version: 1, sourcesWidth: '300', queryHeight: -8, dockHeight: 320, valuesWidth: 1e9 }),
      setItem: () => undefined,
    };
    expect(readLayoutPreferences(storage)).toEqual({ ...emptyPreferences(), dockHeight: 320 });
  });

  it('treats 0 as an invalid field value', () => {
    const storage = memoryStorage({
      [LAYOUT_KEY]: JSON.stringify({ version: 1, sourcesWidth: 0, queryHeight: 100, dockHeight: 200, valuesWidth: 300 }),
    });
    expect(readLayoutPreferences(storage).sourcesWidth).toBeNull();
  });

  it('rounds valid fractional field values', () => {
    const storage = memoryStorage({
      [LAYOUT_KEY]: JSON.stringify({ version: 1, sourcesWidth: 300.6, queryHeight: null, dockHeight: null, valuesWidth: null }),
    });
    expect(readLayoutPreferences(storage).sourcesWidth).toBe(301);
  });

  it('accepts huge but valid preference values at the upper bound', () => {
    const storage = memoryStorage({
      [LAYOUT_KEY]: JSON.stringify({
        version: 1,
        sourcesWidth: 10000,
        queryHeight: 10000,
        dockHeight: 10000,
        valuesWidth: 10000,
      }),
    });
    expect(readLayoutPreferences(storage)).toEqual({
      version: 1,
      sourcesWidth: 10000,
      queryHeight: 10000,
      dockHeight: 10000,
      valuesWidth: 10000,
    });
  });

  it('returns empty preferences for malformed JSON', () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: '{not valid json' });
    expect(readLayoutPreferences(storage)).toEqual(emptyPreferences());
  });

  it('returns empty preferences for an unsupported version', () => {
    const storage = memoryStorage({
      [LAYOUT_KEY]: JSON.stringify({ version: 2, sourcesWidth: 300, queryHeight: 100, dockHeight: 200, valuesWidth: 300 }),
    });
    expect(readLayoutPreferences(storage)).toEqual(emptyPreferences());
  });

  it('returns empty preferences when the stored JSON is an array', () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: JSON.stringify([1, 2, 3]) });
    expect(readLayoutPreferences(storage)).toEqual(emptyPreferences());
  });

  it('returns empty preferences when the stored JSON is null', () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: JSON.stringify(null) });
    expect(readLayoutPreferences(storage)).toEqual(emptyPreferences());
  });

  it('returns empty preferences when required fields are missing', () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: JSON.stringify({ version: 1 }) });
    expect(readLayoutPreferences(storage)).toEqual(emptyPreferences());
  });

  it('returns empty preferences when getItem throws', () => {
    const storage: LayoutStorage = {
      getItem: () => {
        throw new Error('boom');
      },
      setItem: () => undefined,
    };
    expect(readLayoutPreferences(storage)).toEqual(emptyPreferences());
  });
});

describe('writeLayoutPreferences', () => {
  it('writes a fresh whitelist object with exactly the five fields', () => {
    const data = new Map<string, string>();
    const storage: LayoutStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    };
    const malicious = {
      version: 1 as const,
      sourcesWidth: 300,
      queryHeight: 120,
      dockHeight: 240,
      valuesWidth: 260,
      // Extra properties an attacker or a stray spread might attach; must never be serialized.
      sql: "'; DROP TABLE users; --",
      filename: '/etc/passwd',
    };
    writeLayoutPreferences(storage, malicious);
    const stored = JSON.parse(data.get(LAYOUT_KEY) as string);
    expect(Object.keys(stored).sort()).toEqual(
      ['dockHeight', 'queryHeight', 'sourcesWidth', 'valuesWidth', 'version'].sort(),
    );
    expect(stored).toEqual({ version: 1, sourcesWidth: 300, queryHeight: 120, dockHeight: 240, valuesWidth: 260 });
  });

  it('does nothing when there is no storage', () => {
    expect(() => writeLayoutPreferences(null, emptyPreferences())).not.toThrow();
  });

  it('swallows a setItem failure', () => {
    const storage: LayoutStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    expect(() => writeLayoutPreferences(storage, emptyPreferences())).not.toThrow();
  });
});
