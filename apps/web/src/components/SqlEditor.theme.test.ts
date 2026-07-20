import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import editorSource from './SqlEditor.svelte?raw';

const appCss = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

const editorColorTokens = [
  '--color-editor-text',
  '--color-editor-background',
  '--color-editor-caret',
  '--color-editor-selection',
  '--color-editor-gutter-text',
  '--color-editor-gutter-background',
  '--color-editor-border',
  '--color-editor-active-line',
  '--color-syntax-keyword',
  '--color-syntax-string',
  '--color-syntax-number',
  '--color-syntax-comment',
  '--color-syntax-operator',
  '--color-syntax-name',
  '--color-syntax-invalid',
] as const;

const commandDeckTokens = [
  '--color-canvas',
  '--color-surface',
  '--color-surface-inset',
  '--color-surface-raised',
  '--color-accent',
  '--color-accent-dim',
  '--color-evidence',
] as const;

describe('SQL editor color contract', () => {
  it('sources every CodeMirror theme and token color from app CSS custom properties', () => {
    expect(editorSource).not.toMatch(/#[\da-f]{3,8}\b/iu);

    for (const token of editorColorTokens) {
      expect(editorSource, token).toContain(`var(${token})`);
      expect(appCss, token).toMatch(new RegExp(`${token}:\\s*#[\\da-f]{6}`, 'iu'));
    }
  });

  it('defines the Command Deck shell without the former mint accent', () => {
    for (const token of commandDeckTokens) expect(appCss).toContain(`${token}:`);
    expect(appCss).not.toContain('#55d8be');
  });
});
