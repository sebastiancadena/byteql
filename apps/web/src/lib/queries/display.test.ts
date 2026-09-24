import { describe, expect, it } from 'vitest';

import { defaultQueryName, fileStem, normalizeQueryName, relativeTime, sqlPreview } from './display.js';

describe('defaultQueryName', () => {
  it('uses the first non-comment line, whitespace collapsed', () => {
    expect(defaultQueryName('-- triage\n\n  select   src\nfrom ip')).toBe('select src');
  });

  it('truncates to 60 characters', () => {
    const name = defaultQueryName(`select ${'x'.repeat(80)}`);
    expect(name).toHaveLength(60);
    expect(name.endsWith('…')).toBe(true);
  });

  it('falls back when there is nothing but comments', () => {
    expect(defaultQueryName('-- only a comment\n')).toBe('Untitled query');
  });
});

describe('normalizeQueryName', () => {
  it('keeps one line and never returns an empty name', () => {
    expect(normalizeQueryName(' a\n b ')).toBe('a b');
    expect(normalizeQueryName('  ')).toBe('Untitled query');
  });
});

describe('sqlPreview', () => {
  it('shows the first meaningful line and marks that more follows', () => {
    expect(sqlPreview('-- note\nselect 1\nfrom t')).toBe('select 1 …');
    expect(sqlPreview('select 1')).toBe('select 1');
  });

  it('falls back to a comment line when the SQL is only comments', () => {
    expect(sqlPreview('-- just this')).toBe('-- just this');
  });
});

describe('relativeTime', () => {
  const now = 10_000_000_000;
  it.each([
    [now - 5_000, 'just now'],
    [now - 5 * 60_000, '5 min ago'],
    [now - 3 * 3_600_000, '3 h ago'],
  ])('formats %d', (then, expected) => {
    expect(relativeTime(then, now)).toBe(expected);
  });

  it('falls back to a date after a day', () => {
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe(new Date(now - 2 * 86_400_000).toLocaleDateString());
  });
});

describe('fileStem', () => {
  it('drops the extension only', () => {
    expect(fileStem('triage.queries.sql')).toBe('triage.queries');
    expect(fileStem('.sql')).toBe('.sql');
  });
});
