// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { applyTheme, readTheme, THEME_KEY } from './theme.js';

describe('appearance preference', () => {
  it('defaults to light when no storage is available', () => {
    expect(readTheme(null)).toBe('light');
  });

  it('reads a stored dark preference', () => {
    expect(readTheme({ getItem: () => 'dark' })).toBe('dark');
  });

  it('falls back to light for an unsupported stored value', () => {
    expect(readTheme({ getItem: () => 'system' })).toBe('light');
    expect(readTheme({ getItem: () => null })).toBe('light');
  });

  it('falls back to light when storage access throws', () => {
    expect(
      readTheme({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('light');
  });

  it('applies the appearance to the root element and persists it', () => {
    const root = document.createElement('html');
    const written: [string, string][] = [];
    applyTheme('dark', root, { setItem: (key, value) => written.push([key, value]) });
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(written).toEqual([[THEME_KEY, 'dark']]);
  });

  it('applies the appearance even when persistence throws', () => {
    const root = document.createElement('html');
    expect(() =>
      applyTheme('light', root, {
        setItem: () => {
          throw new Error('blocked');
        },
      }),
    ).not.toThrow();
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
  });

  it('applies the appearance without any storage', () => {
    const root = document.createElement('html');
    applyTheme('dark', root, null);
    expect(root.dataset.theme).toBe('dark');
  });

  it('suppresses transitions across the swap and releases them on the next frame', async () => {
    const root = document.createElement('html');
    applyTheme('dark', root, null);
    // Set in the same tick as the palette change, so nothing cross-fades.
    expect(root.dataset.themeSwitching).toBe('');

    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.dataset.themeSwitching).toBeUndefined();
    expect(root.dataset.theme).toBe('dark');
  });
});
